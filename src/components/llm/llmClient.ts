/**
 * OpenAI-compatible LLM HTTP client.
 * Supports custom baseURL for Ollama, vLLM, OpenRouter, and other
 * OpenAI-compatible endpoints.
 */

import { LlmEndpointConfig } from "../../types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Resolved LLM endpoint configuration with defaults applied. */
export interface ResolvedLlmConfig {
  baseURL: string;
  apiKey?: string;
  headers: Record<string, string>;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

/**
 * Resolve LLM endpoint config, applying defaults and resolving apiKeyEnv.
 */
export function resolveLlmConfig(config?: LlmEndpointConfig): ResolvedLlmConfig {
  const apiKeyEnv = config?.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = config?.apiKey ?? process.env[apiKeyEnv];

  return {
    baseURL: (config?.baseURL ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey,
    headers: { ...(config?.headers ?? {}) },
    model: config?.model ?? process.env.OPENAI_JUDGE_MODEL ?? "gpt-4o-2024-08-06",
    timeoutMs: config?.timeoutMs ?? (parseInt(process.env.LLM_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS),
    temperature: config?.temperature ?? 0,
    maxRetries: config?.maxRetries ?? (parseInt(process.env.LLM_MAX_RETRIES ?? "", 10) || 3),
    retryBaseMs: config?.retryBaseMs ?? (parseInt(process.env.LLM_RETRY_BASE_MS ?? "", 10) || 500),
    retryMaxMs: config?.retryMaxMs ?? (parseInt(process.env.LLM_RETRY_MAX_MS ?? "", 10) || 8000),
  };
}

/** OpenAI-compatible chat completion request. */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  response_format?: unknown;
  [key: string]: unknown;
}

/** OpenAI-compatible chat completion response (minimal). */
export interface ChatCompletionResponse {
  id?: string;
  choices: Array<{
    message?: { content?: string; role?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

export interface LlmClientError extends Error {
  status?: number;
  retryable: boolean;
  body?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // Add jitter: 0.75x - 1.25x
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.floor(exponential * jitter);
}

function isRetryableStatus(status: number): boolean {
  // 429 rate limit, 5xx server errors, 408 timeout, 502/503/504 gateway errors
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function isRetryableError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}

/**
 * POST to {baseURL}/chat/completions with exponential backoff retry.
 *
 * Handles local endpoint timeouts / cold starts (Ollama, vLLM) with
 * configurable retries.
 *
 * @throws LlmClientError on permanent failure or exhausted retries
 */
export async function chatCompletions(
  request: ChatCompletionRequest,
  config?: LlmEndpointConfig
): Promise<ChatCompletionResponse> {
  const cfg = resolveLlmConfig(config);
  const url = `${cfg.baseURL}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cfg.headers,
  };

  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  let lastError: LlmClientError | undefined;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(request),
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const body = await res.json() as ChatCompletionResponse;
        return body;
      }

      // HTTP error — read body for diagnostics
      const bodyText = await res.text().catch(() => "");
      const retryable = isRetryableStatus(res.status);

      const err = new Error(
        `LLM HTTP ${res.status}: ${bodyText.slice(0, 300)}`
      ) as LlmClientError;
      err.status = res.status;
      err.retryable = retryable;
      err.body = bodyText;
      lastError = err;

      if (!retryable || attempt >= cfg.maxRetries) {
        throw err;
      }

      // Retry with backoff
      const delay = backoffDelay(attempt, cfg.retryBaseMs, cfg.retryMaxMs);
      await sleep(delay);
      continue;
    } catch (err: any) {
      clearTimeout(timeoutId);

      // If already classified, use that
      if ((err as LlmClientError).retryable !== undefined) {
        lastError = err as LlmClientError;
        if (!(err as LlmClientError).retryable || attempt >= cfg.maxRetries) {
          throw err;
        }
      } else {
        // Network / timeout error
        const isTimeout = err?.name === "AbortError";
        const retryable = isTimeout || isRetryableError(err);

        const clientErr = new Error(
          isTimeout
            ? `LLM request timed out after ${cfg.timeoutMs}ms (attempt ${attempt + 1}/${cfg.maxRetries + 1})`
            : `LLM request failed: ${err?.message ?? String(err)}`
        ) as LlmClientError;
        clientErr.retryable = retryable;
        lastError = clientErr;

        if (!retryable || attempt >= cfg.maxRetries) {
          throw clientErr;
        }
      }

      // Retry with backoff
      const delay = backoffDelay(attempt, cfg.retryBaseMs, cfg.retryMaxMs);
      await sleep(delay);
    }
  }

  // Should be unreachable — we throw inside the loop
  throw lastError ?? new Error("LLM request failed after retries");
}
