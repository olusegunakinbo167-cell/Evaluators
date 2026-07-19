// src/components/llm/mockProvider.ts
/**
 * Deterministic mock judge provider for test suites.
 */

import { JudgeRequest, JudgeResult, JudgeProviderConfig, RubricScores } from "../../types";
import { JudgeProvider } from "./judgeProvider";

export class MockJudgeProvider implements JudgeProvider {
  readonly name = "mock";

  constructor(private scoresById: Record<string, RubricScores> = {}) {}

  async score(request: JudgeRequest, _config?: JudgeProviderConfig): Promise<JudgeResult> {
    const scores = this.scoresById[request.responseId] ?? {
      correctness: 7,
      efficiency: 7,
      readability: 7,
      security: 7,
      promptAdherence: 7,
    };

    return {
      responseId: request.responseId,
      scores,
      justification: `Mock judge scored ${request.responseId}`,
      fallbackUsed: false,
      latencyMs: 1,
      rawProviderOutput: { scores },
    };
  }
}
