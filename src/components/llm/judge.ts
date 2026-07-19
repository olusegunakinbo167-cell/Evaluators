// src/components/llm/judge.ts
/**
 * LLM Judge orchestration layer.
 * Executes the model against incoming code artifacts, validates JSON against
 * the active rubric, and falls back gracefully on failure.
 *
 * Includes concurrency throttling, exponential backoff retry, local evaluation
 * cache, and token telemetry to handle CI batch evaluations safely.
 */

import {
  CodeResponse,
  JudgeRequest,
  JudgeResult,
  RubricScores,
  RUBRIC_DIMENSIONS,
  JudgeProviderConfig,
  EvaluationTelemetry,
} from "../../types";
import { JudgeProvider, JudgeRetryOptions, scoreWithRetry, estimateCostUsd } from "./judgeProvider";
import { OpenAIJudgeProvider } from "./openaiProvider";
import { getCached, setCached, cachedToJudgeResult } from "./cache";

function getDefaultProvider(): JudgeProvider {
  // Test environment or explicit mock flag -> use mock
  if (process.env.JUDGE_PROVIDER === "mock") {
    const { MockJudgeProvider } = require("./mockProvider");
    return new MockJudgeProvider((globalThis as any).__MOCK_JUDGE_SCORES__ || {});
  }
  return new OpenAIJudgeProvider();
}

export interface JudgeOptions {
  /** Max concurrent outbound judge requests. Default from LLM_MAX_CONCURRENCY env, fallback 3. */
  concurrency?: number;
  /** Retry configuration — passed through to scoreWithRetry. */
  retry?: JudgeRetryOptions;
  /** Disable cache for this run (overrides LLM_DISABLE_CACHE env). */
  disableCache?: boolean;
}

function getConcurrencyLimit(override?: number): number {
  if (typeof override === "number" && override > 0) return Math.floor(override);
  const env = process.env.LLM_MAX_CONCURRENCY;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

/**
 * Simple concurrency-limited map.
 * Runs mapper over items with at most `concurrency` promises in flight.
 */
async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let active = 0;

  return new Promise<R[]>((resolve, reject) => {
    const launch = () => {
      if (nextIndex >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && nextIndex < items.length) {
        const idx = nextIndex++;
        active++;
        Promise.resolve(mapper(items[idx], idx))
          .then(res => { results[idx] = res; })
          .catch(reject)
          .finally(() => { active--; launch(); });
      }
    };
    launch();
  });
}

/**
 * Score a single response with cache lookup.
 */
async function scoreWithCache(
  provider: JudgeProvider,
  request: JudgeRequest,
  config?: JudgeProviderConfig,
  retryOptions?: JudgeRetryOptions,
  disableCache = false
): Promise<JudgeResult> {
  const model = config?.model ?? process.env.OPENAI_JUDGE_MODEL ?? "gpt-4o-2024-08-06";

  // Temporarily override cache disable env for this call if requested
  const oldDisable = process.env.LLM_DISABLE_CACHE;
  if (disableCache) process.env.LLM_DISABLE_CACHE = "true";

  try {
    const cached = getCached(request, model);
    if (cached) {
      return cachedToJudgeResult(cached, request.responseId);
    }

    const result = await scoreWithRetry(provider, request, config, retryOptions);

    // Only cache successful (non-fallback) results
    if (!result.fallbackUsed) {
      setCached(request, result, model);
    }

    return result;
  } finally {
    if (disableCache) {
      if (oldDisable === undefined) delete process.env.LLM_DISABLE_CACHE;
      else process.env.LLM_DISABLE_CACHE = oldDisable;
    }
  }
}

/**
 * Score a set of code responses using the configured LLM judge.
 *
 * Features:
 * - Local evaluation cache (.eval-cache.json) — deterministic hash of
 *   code + prompt + rubric schema + model
 * - Concurrency throttling via LLM_MAX_CONCURRENCY (default 3)
 * - Exponential backoff retry with jitter via LLM_MAX_RETRIES (default 3)
 * - Token usage / cost telemetry
 * - Graceful fallback to baseline scores on permanent failure
 *
 * @returns map of responseId → JudgeResult
 */
export async function judgeResponses(
  taskPrompt: string,
  responses: CodeResponse[],
  provider?: JudgeProvider,
  config?: JudgeProviderConfig,
  options?: JudgeOptions
): Promise<Record<string, JudgeResult>> {
  const p = provider ?? getDefaultProvider();
  const concurrency = getConcurrencyLimit(options?.concurrency);

  const results = await pMap(
    responses,
    async (r) => {
      const req: JudgeRequest = {
        taskPrompt,
        responseId: r.id,
        code: r.code,
        language: r.language,
        rubricDimensions: RUBRIC_DIMENSIONS,
      };
      const result = await scoreWithCache(p, req, config, options?.retry, options?.disableCache ?? false);
      return { id: r.id, result };
    },
    concurrency
  );

  return Object.fromEntries(results.map(x => [x.id, x.result]));
}

/**
 * Extract plain RubricScores and justifications from judge results,
 * for drop-in use by the existing evaluator pipeline.
 */
export function extractJudgeScores(
  judgeResults: Record<string, JudgeResult>
): { scores: Record<string, RubricScores>; justifications: Record<string, string> } {
  const scores: Record<string, RubricScores> = {};
  const justifications: Record<string, string> = {};

  for (const [id, result] of Object.entries(judgeResults)) {
    scores[id] = result.scores;
    justifications[id] = result.justification;
  }

  return { scores, justifications };
}

/**
 * Aggregate telemetry across all judge results.
 */
export function aggregateTelemetry(
  judgeResults: Record<string, JudgeResult>
): EvaluationTelemetry {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalLatencyMs = 0;
  let estimatedCostUsd = 0;
  let estimatedSavingsUsd = 0;

  for (const result of Object.values(judgeResults)) {
    totalLatencyMs += result.latencyMs;

    if (result.cacheHit) {
      cacheHits++;
      // Estimate savings: what WOULD this request have cost?
      // costUsd is 0 for cache hits, so use token-based estimate
      if (result.tokens) {
        estimatedSavingsUsd += estimateCostUsd(result.tokens);
      } else {
        estimatedSavingsUsd += 0.0007; // ~165 tokens @ gpt-4o pricing
      }
    } else {
      cacheMisses++;
    }

    if (result.tokens) {
      totalPromptTokens += result.tokens.promptTokens;
      totalCompletionTokens += result.tokens.completionTokens;
    }
    if (result.costUsd) {
      estimatedCostUsd += result.costUsd;
    }
  }

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    cacheHits,
    cacheMisses,
    totalLatencyMs,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
    estimatedSavingsUsd: Math.round(estimatedSavingsUsd * 1_000_000) / 1_000_000,
  };
}

// Re-export retry / cache utilities for direct use in evaluator / tests
export {
  scoreWithRetry,
  isRetryableJudgeError,
  backoffDelay,
  getRetryOptions,
  estimateCostUsd,
  type JudgeRetryOptions,
} from "./judgeProvider";

export {
  computeCacheKey,
  getCached,
  setCached,
  clearCache,
  getCacheStats,
} from "./cache";
