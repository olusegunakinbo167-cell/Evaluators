// src/components/llm/judge.ts
/**
 * LLM Judge orchestration layer.
 * Executes the model against incoming code artifacts, validates JSON against
 * the active rubric, and falls back gracefully on failure.
 *
 * Includes concurrency throttling and exponential backoff retry to handle
 * CI batch evaluations safely under rate limits.
 */

import {
  CodeResponse,
  JudgeRequest,
  JudgeResult,
  RubricScores,
  RUBRIC_DIMENSIONS,
  JudgeProviderConfig,
} from "../../types";
import { JudgeProvider, JudgeRetryOptions, scoreWithRetry } from "./judgeProvider";
import { OpenAIJudgeProvider } from "./openaiProvider";

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
 * Score a set of code responses using the configured LLM judge.
 *
 * Features:
 * - Concurrency throttling via LLM_MAX_CONCURRENCY (default 3)
 * - Exponential backoff retry with jitter via LLM_MAX_RETRIES (default 3)
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
      const result = await scoreWithRetry(p, req, config, options?.retry);
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

// Re-export retry utilities for direct use in evaluator / tests
export {
  scoreWithRetry,
  isRetryableJudgeError,
  backoffDelay,
  getRetryOptions,
  type JudgeRetryOptions,
} from "./judgeProvider";
