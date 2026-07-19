// tests/cache.test.ts

import * as fs from "fs";
import * as path from "path";
import {
  computeCacheKey,
  getCached,
  setCached,
  clearCache,
  getCacheStats,
  cachedToJudgeResult,
} from "../src/components/llm/cache";
import { JudgeRequest, JudgeResult, RUBRIC_DIMENSIONS, getRubricFingerprint } from "../src/types";

const CACHE_PATH = ".eval-cache.test.json";

beforeEach(() => {
  process.env.LLM_CACHE_PATH = CACHE_PATH;
  process.env.LLM_DISABLE_CACHE = "false";
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
});

afterEach(() => {
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  delete process.env.LLM_CACHE_PATH;
  delete process.env.LLM_DISABLE_CACHE;
});

function makeRequest(code = "const x = 1", prompt = "test"): JudgeRequest {
  return {
    taskPrompt: prompt,
    responseId: "R1",
    code,
    language: "javascript",
    rubricDimensions: RUBRIC_DIMENSIONS,
  };
}

function makeResult(responseId = "R1"): JudgeResult {
  return {
    responseId,
    scores: { correctness: 8, efficiency: 7, readability: 9, security: 6, promptAdherence: 8 },
    justification: "test",
    fallbackUsed: false,
    latencyMs: 123,
    cacheHit: false,
    tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costUsd: 0.00075,
  };
}

describe("cache key generation", () => {
  it("is deterministic for identical inputs", () => {
    const req = makeRequest("foo", "bar");
    const k1 = computeCacheKey(req, "gpt-4o");
    const k2 = computeCacheKey(req, "gpt-4o");
    expect(k1).toBe(k2);
  });

  it("changes when code changes", () => {
    const k1 = computeCacheKey(makeRequest("code A"), "m");
    const k2 = computeCacheKey(makeRequest("code B"), "m");
    expect(k1).not.toBe(k2);
  });

  it("changes when prompt changes", () => {
    const k1 = computeCacheKey(makeRequest("x", "prompt A"), "m");
    const k2 = computeCacheKey(makeRequest("x", "prompt B"), "m");
    expect(k1).not.toBe(k2);
  });

  it("changes when model changes", () => {
    const req = makeRequest();
    const k1 = computeCacheKey(req, "gpt-4o");
    const k2 = computeCacheKey(req, "gpt-3.5");
    expect(k1).not.toBe(k2);
  });

  it("changes when rubric schema changes", () => {
    const req1 = makeRequest();
    const req2 = { ...req1, rubricDimensions: [
      ...RUBRIC_DIMENSIONS.slice(0, -1),
      { ...RUBRIC_DIMENSIONS[RUBRIC_DIMENSIONS.length - 1], weight: 0.99 },
    ]};
    const k1 = computeCacheKey(req1, "m");
    const k2 = computeCacheKey(req2, "m");
    expect(k1).not.toBe(k2);
  });
});

describe("cache read/write", () => {
  it("misses on empty cache", () => {
    expect(getCached(makeRequest(), "m")).toBeNull();
  });

  it("stores and retrieves a cached evaluation", () => {
    const req = makeRequest();
    const result = makeResult();
    setCached(req, result, "test-model");

    const cached = getCached(req, "test-model");
    expect(cached).not.toBeNull();
    expect(cached!.scores.correctness).toBe(8);
    expect(cached!.justification).toBe("test");
    expect(cached!.tokens?.promptTokens).toBe(100);
  });

  it("returns null when LLM_DISABLE_CACHE=true", () => {
    const req = makeRequest();
    setCached(req, makeResult(), "m");
    process.env.LLM_DISABLE_CACHE = "true";
    expect(getCached(req, "m")).toBeNull();
  });

  it("setCached is no-op when cache disabled", () => {
    process.env.LLM_DISABLE_CACHE = "true";
    setCached(makeRequest(), makeResult(), "m");
    process.env.LLM_DISABLE_CACHE = "false";
    expect(getCached(makeRequest(), "m")).toBeNull();
  });

  it("invalidates on rubric version/fingerprint mismatch", () => {
    const req = makeRequest();
    setCached(req, makeResult(), "m");
    // Tamper with cache file to simulate old rubric
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    const key = Object.keys(raw.entries)[0];
    raw.entries[key].rubricFingerprint = "stale-fingerprint";
    fs.writeFileSync(CACHE_PATH, JSON.stringify(raw));
    expect(getCached(req, "m")).toBeNull();
  });
});

describe("cachedToJudgeResult", () => {
  it("converts cache entry to JudgeResult with cacheHit=true", () => {
    const req = makeRequest();
    const result = makeResult();
    setCached(req, result, "m");
    const entry = getCached(req, "m")!;
    const jr = cachedToJudgeResult(entry, "R1");
    expect(jr.cacheHit).toBe(true);
    expect(jr.latencyMs).toBe(0);
    expect(jr.costUsd).toBe(0);
    expect(jr.scores.correctness).toBe(8);
  });
});

describe("cache management", () => {
  it("clearCache removes all entries", () => {
    setCached(makeRequest("a"), makeResult("A"), "m");
    setCached(makeRequest("b"), makeResult("B"), "m");
    expect(getCacheStats().entries).toBe(2);
    const n = clearCache();
    expect(n).toBe(2);
    expect(getCacheStats().entries).toBe(0);
  });

  it("getCacheStats reports disabled state", () => {
    process.env.LLM_DISABLE_CACHE = "true";
    const stats = getCacheStats();
    expect(stats.disabled).toBe(true);
  });
});

describe("telemetry aggregation", () => {
  it("aggregates tokens, cache hits, latency, and cost", async () => {
    const { aggregateTelemetry } = await import("../src/components/llm/judge");
    const results: Record<string, JudgeResult> = {
      A: {
        responseId: "A",
        scores: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 },
        justification: "x",
        fallbackUsed: false,
        latencyMs: 100,
        cacheHit: false,
        tokens: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
        costUsd: 0.001,
      },
      B: {
        responseId: "B",
        scores: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 },
        justification: "cached",
        fallbackUsed: false,
        latencyMs: 0,
        cacheHit: true,
        tokens: { promptTokens: 150, completionTokens: 40, totalTokens: 190 },
        costUsd: 0,
      },
    };

    const tel = aggregateTelemetry(results);
    expect(tel.totalPromptTokens).toBe(350);
    expect(tel.totalCompletionTokens).toBe(90);
    expect(tel.totalTokens).toBe(440);
    expect(tel.cacheHits).toBe(1);
    expect(tel.cacheMisses).toBe(1);
    expect(tel.totalLatencyMs).toBe(100);
    expect(tel.estimatedCostUsd).toBeCloseTo(0.001, 6);
    expect(tel.estimatedSavingsUsd).toBeGreaterThan(0);
  });
});
