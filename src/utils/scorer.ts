// src/utils/scorer.ts

import {
  RubricScores,
  RubricWeights,
  DEFAULT_WEIGHTS,
  EvaluatedResponse,
  SecurityFlag,
  RUBRIC_DIMENSIONS,
  Confidence,
  RubricDimension,
  buildWeights,
} from "../types";

/**
 * Computes a weighted score from a rubric score object.
 * If weights is omitted, they are derived from the provided rubric dimensions,
 * falling back to DEFAULT_WEIGHTS.
 */
export function computeWeightedScore(
  scores: RubricScores,
  weights?: RubricWeights,
  dimensions: RubricDimension[] = RUBRIC_DIMENSIONS
): number {
  const w = weights ?? buildWeights(dimensions);
  let total = 0;
  for (const dim of dimensions) {
    total += (scores[dim.key] ?? 0) * (w as any)[dim.key];
  }
  return parseFloat(total.toFixed(2));
}

/**
 * Validates that all rubric scores are within their declared bounds.
 */
export function validateScores(
  scores: RubricScores,
  dimensions: RubricDimension[] = RUBRIC_DIMENSIONS
): boolean {
  for (const dim of dimensions) {
    const v = scores[dim.key];
    if (typeof v !== "number" || v < dim.minScore || v > dim.maxScore) {
      return false;
    }
  }
  return true;
}

/**
 * Ranks evaluated responses by weighted score (descending).
 */
export function rankResponses(
  responses: Array<{ responseId: string; weightedScore: number; scores: RubricScores; securityFlags: SecurityFlag[]; justification: string }>
): EvaluatedResponse[] {
  const sorted = [...responses].sort((a, b) => b.weightedScore - a.weightedScore);
  return sorted.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

/**
 * Determines confidence level based on score spread between top two responses.
 */
export function deriveConfidence(ranked: EvaluatedResponse[]): Confidence {
  if (ranked.length < 2) return Confidence.HIGH;
  const spread = ranked[0].weightedScore - ranked[1].weightedScore;
  if (spread >= 2.0) return Confidence.HIGH;
  if (spread >= 0.8) return Confidence.MEDIUM;
  return Confidence.LOW;
}

/**
 * Applies a security penalty: each CRITICAL flag reduces score by 1.5,
 * HIGH by 0.8, MEDIUM by 0.3, LOW by 0.1 (capped at 0).
 */
export function applySecurityPenalty(
  score: number,
  flags: SecurityFlag[]
): number {
  const penaltyMap: Record<string, number> = {
    CRITICAL: 1.5,
    HIGH: 0.8,
    MEDIUM: 0.3,
    LOW: 0.1,
  };

  const totalPenalty = flags.reduce(
    (acc, flag) => acc + (penaltyMap[flag.severity] || 0),
    0
  );

  return parseFloat(Math.max(0, score - totalPenalty).toFixed(2));
}
