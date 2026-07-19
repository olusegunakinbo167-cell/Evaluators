// src/components/llm/judgeProvider.ts
/**
 * Strongly typed LLM-as-a-Judge provider interface.
 * Completely abstracts underlying language model execution.
 */

import { JudgeRequest, JudgeResult, JudgeProviderConfig, RubricScores, getRubricKeys } from "../../types";

/** Abstract judge provider — all LLM backends implement this. */
export interface JudgeProvider {
  readonly name: string;
  score(request: JudgeRequest, config?: JudgeProviderConfig): Promise<JudgeResult>;
}

/**
 * Validates that a score payload strictly maps to the active rubric keys
 * and that all values are within the declared bounds.
 *
 * @returns validated RubricScores or throws
 */
export function validateJudgeScores(
  candidate: unknown,
  minScore = 0,
  maxScore = 10
): RubricScores {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Judge scores payload is not an object");
  }

  const obj = candidate as Record<string, unknown>;
  const rubricKeys = getRubricKeys();
  const validated: Partial<RubricScores> = {};

  for (const key of rubricKeys) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Judge score for "${key}" is not a finite number (got ${String(v)})`);
    }
    if (v < minScore || v > maxScore) {
      throw new Error(`Judge score for "${key}" out of bounds [${minScore}, ${maxScore}]: ${v}`);
    }
    // Clamp to integer rubric scale
    (validated as any)[key] = Math.round(v * 10) / 10;
  }

  // Ensure no extra keys are required — we already covered all rubricKeys
  return validated as RubricScores;
}

/** Default fallback scores — neutral midpoint across all rubric dimensions. */
export function getFallbackScores(): RubricScores {
  return {
    correctness: 5,
    efficiency: 5,
    readability: 5,
    security: 5,
    promptAdherence: 5,
  };
}

/** Build a fallback JudgeResult when the provider fails. */
export function buildFallbackResult(
  responseId: string,
  latencyMs: number,
  reason?: string
): JudgeResult {
  return {
    responseId,
    scores: getFallbackScores(),
    justification: reason
      ? `Judge fallback activated: ${reason}. Neutral baseline scores applied.`
      : "Judge fallback activated: provider payload unparseable or timed out. Neutral baseline scores applied.",
    fallbackUsed: true,
    latencyMs,
  };
}

// ─── Retry / backoff ─────────────────────────────────────────────────────────

export interface JudgeRetryOptions {
  /** Maximum retry attempts (not counting the initial try). Default from LLM_MAX_RETRIES env, fallback 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default from LLM_RETRY_BASE_MS env, fallback 250. */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in ms. Default from LLM_RETRY_MAX_MS env, fallback 8000. */
  maxDelayMs?: number;
  /** Jitter factor 0–1 (random additional delay proportion). Default 0.25. */
  jitterFactor?: number;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve retry options from explicit config + environment variables. */
export function getRetryOptions(overrides?: JudgeRetryOptions): Required<JudgeRetryOptions> {
  return {
    maxRetries: overrides?.maxRetries ?? envInt("LLM_MAX_RETRIES", 3),
    baseDelayMs: overrides?.baseDelayMs ?? envInt("LLM_RETRY_BASE_MS", 250),
    maxDelayMs: overrides?.maxDelayMs ?? envInt("LLM_RETRY_MAX_MS", 8000),
    jitterFactor: overrides?.jitterFactor ?? envFloat("LLM_RETRY_JITTER", 0.25),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delay with random jitter.
 * delay = min(maxDelay, base * 2^attempt) * (1 + jitter * rand)
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterFactor: number
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = 1 + jitterFactor * Math.random();
  return Math.floor(exponential * jitter);
}

/**
 * Determine whether a judge failure is retryable.
 * Retryable: 429 / rate_limit, 5xx, timeouts, network errors, and provider
 * fallbacks that mention rate limiting / 429 / timeout / overloaded.
 */
export function isRetryableJudgeError(err: unknown, result?: JudgeResult): boolean {
  const msg = String(
    (err as any)?.message ?? err ?? result?.justification ?? ""
  ).toLowerCase();

  // Explicit retryable markers — these also match fallback justifications
  // like "Judge fallback activated: 429 rate limit..."
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("too many requests") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    /\b5\d{2}\b/.test(msg)  // 5xx
  );
}

/**
 * Execute a provider score call with exponential backoff + jitter retry.
 *
 * Retries on 429 / rate limits, 5xx, timeouts, and network errors.
 * Non-retryable errors (e.g. validation failures, 4xx auth) fail fast
 * to the provider's own fallback result.
 *
 * @returns JudgeResult — either a successful score, or the last fallback
 *          result if all retries are exhausted.
 */
export async function scoreWithRetry(
  provider: JudgeProvider,
  request: JudgeRequest,
  config?: JudgeProviderConfig,
  retryOptions?: JudgeRetryOptions
): Promise<JudgeResult> {
  const opts = getRetryOptions(retryOptions);
  let lastResult: JudgeResult | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await provider.score(request, config);
      lastResult = result;

      // Success — no fallback, return immediately
      if (!result.fallbackUsed) {
        return result;
      }

      // Fallback was used — check if it's retryable
      if (attempt < opts.maxRetries && isRetryableJudgeError(null, result)) {
        const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitterFactor);
        await sleep(delay);
        continue;
      }

      // Non-retryable fallback, or out of retries — return as-is
      return result;
    } catch (err) {
      lastError = err;

      if (attempt < opts.maxRetries && isRetryableJudgeError(err)) {
        const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitterFactor);
        await sleep(delay);
        continue;
      }

      // Non-retryable or exhausted — break to fallback
      break;
    }
  }

  // All retries exhausted — return last provider result if we have one,
  // otherwise synthesize a fallback
  if (lastResult) {
    return lastResult;
  }

  return buildFallbackResult(
    request.responseId,
    0,
    `Judge retry exhausted after ${opts.maxRetries} retries: ${String((lastError as any)?.message ?? lastError ?? "unknown error")}`
  );
}
