// tests/judge.retry.test.ts

import {
  backoffDelay,
  isRetryableJudgeError,
  getRetryOptions,
  scoreWithRetry,
  JudgeProvider,
} from "../src/components/llm/judgeProvider";
import { judgeResponses } from "../src/components/llm/judge";
import { JudgeRequest, JudgeResult, RUBRIC_DIMENSIONS } from "../src/types";

const baseScores = {
  correctness: 7, efficiency: 7, readability: 7, security: 7, promptAdherence: 7,
};

function mockResult(id: string, fallback = false, justification = "ok"): JudgeResult {
  return {
    responseId: id,
    scores: baseScores,
    justification,
    fallbackUsed: fallback,
    latencyMs: 1,
  };
}

describe("backoffDelay", () => {
  beforeEach(() => {
    jest.spyOn(global.Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exponential growth", () => {
    expect(backoffDelay(0, 100, 10000, 0)).toBe(100);
    expect(backoffDelay(1, 100, 10000, 0)).toBe(200);
    expect(backoffDelay(2, 100, 10000, 0)).toBe(400);
    expect(backoffDelay(3, 100, 10000, 0)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    expect(backoffDelay(10, 100, 500, 0)).toBe(500);
  });

  it("applies jitter", () => {
    jest.spyOn(global.Math, "random").mockReturnValue(1.0);
    const d = backoffDelay(1, 100, 10000, 0.25);
    // 200 * (1 + 0.25*1) = 250
    expect(d).toBe(250);
  });
});

describe("isRetryableJudgeError", () => {
  const retryable = [
    "429 Too Many Requests",
    "rate_limit exceeded",
    "rate limit hit",
    "too many requests",
    "server overloaded",
    "timeout after 30000ms",
    "ETIMEDOUT",
    "ECONNRESET",
    "fetch failed",
    "HTTP 500 Internal Server Error",
    "HTTP 502 Bad Gateway",
    "HTTP 503 Service Unavailable",
  ];
  test.each(retryable)("marks '%s' as retryable", (msg) => {
    expect(isRetryableJudgeError(new Error(msg))).toBe(true);
  });

  const nonRetryable = [
    "invalid_api_key",
    "401 Unauthorized",
    "403 Forbidden",
    "JSON parse failed",
    "Score validation failed",
  ];
  test.each(nonRetryable)("marks '%s' as NOT retryable", (msg) => {
    expect(isRetryableJudgeError(new Error(msg))).toBe(false);
  });

  it("retries fallback results with transient reason", () => {
    const r = mockResult("X", true, "Judge fallback activated: 429 rate limit");
    expect(isRetryableJudgeError(null, r)).toBe(true);
  });

  it("does NOT retry fallback results with permanent reason", () => {
    const r = mockResult("X", true, "Judge fallback activated: invalid JSON");
    expect(isRetryableJudgeError(null, r)).toBe(false);
  });
});

describe("getRetryOptions", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });
  afterAll(() => { process.env = OLD_ENV; });

  it("uses env vars", () => {
    process.env.LLM_MAX_RETRIES = "5";
    process.env.LLM_RETRY_BASE_MS = "50";
    process.env.LLM_RETRY_MAX_MS = "1234";
    process.env.LLM_RETRY_JITTER = "0.1";
    const opts = getRetryOptions({});
    expect(opts.maxRetries).toBe(5);
    expect(opts.baseDelayMs).toBe(50);
    expect(opts.maxDelayMs).toBe(1234);
    expect(opts.jitterFactor).toBe(0.1);
  });

  it("falls back to defaults", () => {
    delete process.env.LLM_MAX_RETRIES;
    delete process.env.LLM_RETRY_BASE_MS;
    delete process.env.LLM_RETRY_MAX_MS;
    delete process.env.LLM_RETRY_JITTER;
    const opts = getRetryOptions({});
    expect(opts.maxRetries).toBe(3);
    expect(opts.baseDelayMs).toBe(250);
    expect(opts.maxDelayMs).toBe(8000);
  });
});

describe("scoreWithRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function flakyProvider(failures: number, errorMsg = "429 rate limit"): JudgeProvider {
    let calls = 0;
    return {
      name: "flaky",
      async score(req: JudgeRequest): Promise<JudgeResult> {
        calls++;
        (flakyProvider as any)._calls = calls;
        if (calls <= failures) {
          throw new Error(errorMsg);
        }
        return mockResult(req.responseId);
      },
    };
  }

  it("retries transient errors with exponential backoff", async () => {
    const provider = flakyProvider(2, "429 rate limit");
    const req: JudgeRequest = {
      taskPrompt: "t", responseId: "R", code: "x", language: "js",
      rubricDimensions: RUBRIC_DIMENSIONS,
    };

    const p = scoreWithRetry(provider, req, undefined, {
      maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10000, jitterFactor: 0,
    });

    // Advance timers through backoff delays: 100ms, 200ms
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    const result = await p;
    expect(result.fallbackUsed).toBe(false);
    expect((flakyProvider as any)._calls).toBe(3); // 1 initial + 2 retries
  });

  it("gives up after maxRetries and returns fallback", async () => {
    const provider: JudgeProvider = {
      name: "always-fail",
      async score(req) {
        throw new Error("429 rate limit");
      },
    };

    const req: JudgeRequest = {
      taskPrompt: "t", responseId: "R", code: "x", language: "js",
      rubricDimensions: RUBRIC_DIMENSIONS,
    };

    const p = scoreWithRetry(provider, req, undefined, {
      maxRetries: 2, baseDelayMs: 10, maxDelayMs: 1000, jitterFactor: 0,
    });

    await jest.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.fallbackUsed).toBe(true);
    expect(result.justification).toContain("retry exhausted");
  });

  it("does NOT retry non-retryable errors", async () => {
    let calls = 0;
    const provider: JudgeProvider = {
      name: "bad-auth",
      async score() { calls++; throw new Error("401 Unauthorized"); },
    };
    const req: JudgeRequest = {
      taskPrompt: "t", responseId: "R", code: "x", language: "js",
      rubricDimensions: RUBRIC_DIMENSIONS,
    };

    const p = scoreWithRetry(provider, req, undefined, {
      maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0,
    });

    const result = await p;
    expect(calls).toBe(1); // no retries
    expect(result.fallbackUsed).toBe(true);
  });

  it("retries on fallback results with retryable reason", async () => {
    let calls = 0;
    const provider: JudgeProvider = {
      name: "flaky-fallback",
      async score(req) {
        calls++;
        if (calls < 2) {
          return mockResult(req.responseId, true, "fallback: 429 rate limit");
        }
        return mockResult(req.responseId, false);
      },
    };
    const req: JudgeRequest = {
      taskPrompt: "t", responseId: "R", code: "x", language: "js",
      rubricDimensions: RUBRIC_DIMENSIONS,
    };

    const p = scoreWithRetry(provider, req, undefined, {
      maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitterFactor: 0,
    });

    await jest.advanceTimersByTimeAsync(10);
    const result = await p;

    expect(calls).toBe(2);
    expect(result.fallbackUsed).toBe(false);
  });
});

describe("judgeResponses concurrency", () => {
  it("respects LLM_MAX_CONCURRENCY cap", async () => {
    const OLD_ENV = process.env.LLM_MAX_CONCURRENCY;
    process.env.LLM_MAX_CONCURRENCY = "2";

    let inFlight = 0;
    let maxInFlight = 0;

    const provider: JudgeProvider = {
      name: "slow",
      async score(req) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
        return mockResult(req.responseId);
      },
    };

    const responses = Array.from({ length: 6 }, (_, i) => ({
      id: `R${i}`, code: "x", language: "js",
    }));

    await judgeResponses("test", responses, provider, undefined, {});

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2); // should saturate

    if (OLD_ENV === undefined) delete process.env.LLM_MAX_CONCURRENCY;
    else process.env.LLM_MAX_CONCURRENCY = OLD_ENV;
  });

  it("allows concurrency override via JudgeOptions", async () => {
    let maxInFlight = 0;
    let inFlight = 0;

    const provider: JudgeProvider = {
      name: "slow",
      async score(req) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return mockResult(req.responseId);
      },
    };

    const responses = Array.from({ length: 5 }, (_, i) => ({
      id: `R${i}`, code: "x", language: "js",
    }));

    await judgeResponses("test", responses, provider, undefined, { concurrency: 1 });
    expect(maxInFlight).toBe(1);
  });

  it("propagates retry options through judgeResponses", async () => {
    const attempts = new Map<string, number>();

    const provider: JudgeProvider = {
      name: "flaky",
      async score(req) {
        const n = (attempts.get(req.responseId) ?? 0) + 1;
        attempts.set(req.responseId, n);
        if (n === 1) throw new Error("429 rate limit");
        return mockResult(req.responseId);
      },
    };

    jest.useFakeTimers();
    const p = judgeResponses(
      "test",
      [{ id: "A", code: "x", language: "js" }],
      provider,
      undefined,
      { retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 } }
    );
    await jest.advanceTimersByTimeAsync(50);
    const results = await p;
    jest.useRealTimers();

    expect(results.A.fallbackUsed).toBe(false);
    expect(attempts.get("A")).toBe(2);
  });
});
