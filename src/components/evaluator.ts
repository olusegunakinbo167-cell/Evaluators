// src/components/evaluator.ts

import {
  EvaluationInput,
  EvaluationResult,
  EvaluatedResponse,
  DEFAULT_WEIGHTS,
  RubricScores,
  RubricDimensionKey,
  getRubricKeys,
  RUBRIC_DIMENSIONS,
  JudgeProviderConfig,
  EvaluationTelemetry,
} from "../types";
import {
  computeWeightedScore,
  validateScores,
  rankResponses,
  deriveConfidence,
  applySecurityPenalty,
} from "../utils/scorer";
import { scanForSecurityIssues } from "./securityScanner";
import { judgeResponses, extractJudgeScores, aggregateTelemetry, JudgeOptions } from "./llm/judge";
import { JudgeProvider } from "./llm/judgeProvider";

/**
 * Core synchronous evaluation — rubric scores must be provided.
 * Used internally after auto-judging, and exposed for manual-score workflows.
 */
export function evaluate(
  input: EvaluationInput,
  telemetry?: EvaluationTelemetry
): EvaluationResult {
  const scoresMap = input.manualScores ?? {};
  const justificationsMap = input.justifications ?? {};

  const partialRankings: Omit<EvaluatedResponse, "rank">[] = [];

  for (const response of input.responses) {
    const scores = scoresMap[response.id];

    if (!scores) {
      throw new Error(`No rubric scores provided for response ID: ${response.id}`);
    }

    if (!validateScores(scores)) {
      const bounds = RUBRIC_DIMENSIONS.map(d => `${d.key} [${d.minScore}-${d.maxScore}]`).join(", ");
      throw new Error(
        `Invalid scores for response "${response.id}": expected ${bounds}.`
      );
    }

    const securityFlags = scanForSecurityIssues(response.code);
    const rawWeightedScore = computeWeightedScore(scores, DEFAULT_WEIGHTS);
    const penalizedScore = applySecurityPenalty(rawWeightedScore, securityFlags);

    partialRankings.push({
      responseId: response.id,
      weightedScore: penalizedScore,
      scores,
      securityFlags,
      justification: justificationsMap[response.id] || "(no justification provided)",
    });
  }

  const rankings = rankResponses(partialRankings);
  const preferred = rankings[0]?.responseId ?? "N/A";
  const effectiveConfidence = input.confidence ?? deriveConfidence(rankings);

  return {
    taskId: input.taskId,
    prompt: input.prompt,
    evaluator: input.evaluator,
    timestamp: new Date().toISOString(),
    rankings,
    preferred,
    confidence: effectiveConfidence,
    notes: input.notes,
    telemetry,
  };
}

/**
 * LLM-as-a-Judge automated evaluation.
 *
 * 1. Checks local evaluation cache (.eval-cache.json) before hitting provider
 * 2. Runs the configured JudgeProvider against each code response with
 *    concurrency throttling (LLM_MAX_CONCURRENCY, default 3)
 * 3. Retries transient failures with exponential backoff + jitter
 *    (LLM_MAX_RETRIES, default 3)
 * 4. Validates returned JSON strictly maps to active rubric keys
 * 5. Falls back to baseline schema defaults on unparseable/timeout
 * 6. Captures token usage, latency, cache hit/miss, and cost telemetry
 * 7. Feeds judge scores into the standard evaluation pipeline
 *
 * When manualScores are supplied they take precedence (judge is bypassed).
 * Set input.autoJudge = false to explicitly disable auto-scoring.
 * Set LLM_DISABLE_CACHE=true to force clean runs.
 */
export async function evaluateAuto(
  input: EvaluationInput,
  provider?: JudgeProvider,
  judgeConfig?: JudgeProviderConfig,
  judgeOptions?: JudgeOptions
): Promise<EvaluationResult> {
  const autoJudgeEnabled =
    input.autoJudge !== false && (!input.manualScores || Object.keys(input.manualScores).length === 0);

  let scoresMap = input.manualScores ?? {};
  let justificationsMap = input.justifications ?? {};
  let telemetry: EvaluationTelemetry | undefined;

  if (autoJudgeEnabled) {
    const judgeResults = await judgeResponses(
      input.prompt,
      input.responses,
      provider,
      judgeConfig,
      judgeOptions
    );
    const extracted = extractJudgeScores(judgeResults);
    scoresMap = extracted.scores;
    justificationsMap = extracted.justifications;
    telemetry = aggregateTelemetry(judgeResults);
  }

  return evaluate(
    {
      ...input,
      manualScores: scoresMap,
      justifications: justificationsMap,
    },
    telemetry
  );
}

/** Validate a complete RubricScores object against the live rubric schema. */
export function validateRubricPayload(candidate: unknown): candidate is RubricScores {
  if (typeof candidate !== "object" || candidate === null) return false;
  const obj = candidate as Record<string, unknown>;
  for (const key of getRubricKeys() as RubricDimensionKey[]) {
    const dim = RUBRIC_DIMENSIONS.find(d => d.key === key)!;
    const v = obj[key];
    if (typeof v !== "number" || v < dim.minScore || v > dim.maxScore) return false;
  }
  return true;
}

// Re-export judge options for callers
export type { JudgeOptions } from "./llm/judge";
