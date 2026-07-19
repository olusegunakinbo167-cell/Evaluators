// src/components/llm/cache.ts
/**
 * Local evaluation cache for the LLM judge.
 *
 * Generates a deterministic hash of: code artifact + task prompt +
 * active rubric schema + model name.
 *
 * Cache hits avoid provider API calls entirely, speeding up CI and
 * reducing costs.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  JudgeRequest,
  JudgeResult,
  RubricScores,
  TokenUsage,
  RUBRIC_VERSION,
  getRubricFingerprint,
} from "../../types";

export interface CachedEvaluation {
  scores: RubricScores;
  justification: string;
  tokens?: TokenUsage;
  costUsd?: number;
  timestamp: string;
  rubricVersion: string;
  rubricFingerprint: string;
  model: string;
}

export interface EvaluationCache {
  version: number;
  entries: Record<string, CachedEvaluation>;
}

const CACHE_VERSION = 1;

function getCachePath(): string {
  return process.env.LLM_CACHE_PATH || ".eval-cache.json";
}

function isCacheDisabled(): boolean {
  const v = (process.env.LLM_DISABLE_CACHE || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function loadCache(): EvaluationCache {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) {
    return { version: CACHE_VERSION, entries: {} };
  }
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as EvaluationCache;
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

function saveCache(cache: EvaluationCache): void {
  const cachePath = getCachePath();
  const dir = path.dirname(cachePath);
  if (dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * Compute a deterministic cache key for a judge request.
 * Includes: code, task prompt, language, rubric schema, model name.
 */
export function computeCacheKey(
  request: JudgeRequest,
  model = "default"
): string {
  const rubricFp = getRubricFingerprint(request.rubricDimensions);
  const payload = [
    "v" + CACHE_VERSION,
    "rubric:" + RUBRIC_VERSION + ":" + rubricFp,
    "model:" + model,
    "lang:" + request.language,
    "prompt:" + request.taskPrompt,
    "code:" + request.code,
  ].join("\n---\n");

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Look up a cached evaluation. Returns null on miss, disabled cache,
 * or rubric version mismatch.
 */
export function getCached(
  request: JudgeRequest,
  model = "default"
): CachedEvaluation | null {
  if (isCacheDisabled()) return null;

  const key = computeCacheKey(request, model);
  const cache = loadCache();
  const entry = cache.entries[key];
  if (!entry) return null;

  // Invalidate on rubric version / fingerprint mismatch
  const expectedFp = getRubricFingerprint(request.rubricDimensions);
  if (entry.rubricVersion !== RUBRIC_VERSION || entry.rubricFingerprint !== expectedFp) {
    return null;
  }

  return entry;
}

/**
 * Store an evaluation result in the cache.
 * No-op when LLM_DISABLE_CACHE is set.
 */
export function setCached(
  request: JudgeRequest,
  result: JudgeResult,
  model = "default"
): void {
  if (isCacheDisabled()) return;

  const key = computeCacheKey(request, model);
  const cache = loadCache();

  cache.entries[key] = {
    scores: result.scores,
    justification: result.justification,
    tokens: result.tokens,
    costUsd: result.costUsd,
    timestamp: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    rubricFingerprint: getRubricFingerprint(request.rubricDimensions),
    model,
  };

  saveCache(cache);
}

/**
 * Convert a cache entry back into a JudgeResult with cacheHit=true.
 */
export function cachedToJudgeResult(
  entry: CachedEvaluation,
  responseId: string
): JudgeResult {
  return {
    responseId,
    scores: entry.scores,
    justification: entry.justification,
    fallbackUsed: false,
    latencyMs: 0,
    tokens: entry.tokens,
    cacheHit: true,
    costUsd: 0, // cached — no API cost incurred
  };
}

/** Clear the entire evaluation cache. Returns number of entries removed. */
export function clearCache(): number {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) return 0;
  const cache = loadCache();
  const n = Object.keys(cache.entries).length;
  saveCache({ version: CACHE_VERSION, entries: {} });
  return n;
}

/** Get cache statistics. */
export function getCacheStats(): { entries: number; path: string; disabled: boolean } {
  const cache = isCacheDisabled() ? { entries: {} } : loadCache();
  return {
    entries: Object.keys(cache.entries).length,
    path: getCachePath(),
    disabled: isCacheDisabled(),
  };
}
