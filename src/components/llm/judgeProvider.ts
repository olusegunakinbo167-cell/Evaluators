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
