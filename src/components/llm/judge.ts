// src/components/llm/judge.ts
/**
 * LLM Judge orchestration layer.
 * Executes the model against incoming code artifacts, validates JSON against
 * the active rubric, and falls back gracefully on failure.
 */

import {
  CodeResponse,
  JudgeRequest,
  JudgeResult,
  RubricScores,
  RUBRIC_DIMENSIONS,
  JudgeProviderConfig,
} from "../../types";
import { JudgeProvider } from "./judgeProvider";
import { OpenAIJudgeProvider } from "./openaiProvider";

function getDefaultProvider(): JudgeProvider {
  // Test environment or explicit mock flag -> use mock
  if (process.env.JUDGE_PROVIDER === "mock") {
    const { MockJudgeProvider } = require("./mockProvider");
    return new MockJudgeProvider((globalThis as any).__MOCK_JUDGE_SCORES__ || {});
  }
  return new OpenAIJudgeProvider();
}

/**
 * Score a set of code responses using the configured LLM judge.
 * Returns a map of responseId → JudgeResult.
 */
export async function judgeResponses(
  taskPrompt: string,
  responses: CodeResponse[],
  provider?: JudgeProvider,
  config?: JudgeProviderConfig
): Promise<Record<string, JudgeResult>> {
  const p = provider ?? getDefaultProvider();
  const results: Record<string, JudgeResult> = {};

  // Sequential scoring to respect rate limits — can be parallelized with a semaphore if needed
  for (const r of responses) {
    const req: JudgeRequest = {
      taskPrompt,
      responseId: r.id,
      code: r.code,
      language: r.language,
      rubricDimensions: RUBRIC_DIMENSIONS,
    };
    results[r.id] = await p.score(req, config);
  }

  return results;
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
