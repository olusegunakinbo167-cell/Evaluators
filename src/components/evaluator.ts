// src/components/evaluator.ts

import * as fs from "fs";
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

// ─── Threshold / regression enforcement ──────────────────────────────────────

export interface ThresholdViolation {
  responseId: string;
  weightedScore: number;
  minScore: number;
  delta: number; // score - minScore (negative = violation)
}

export interface RegressionViolation {
  responseId: string;
  dimension: RubricDimensionKey | "weightedScore";
  current: number;
  baseline: number;
  delta: number; // current - baseline (negative = regression)
  allowedRegression: number;
}

/**
 * Check if any ranked response falls below the minimum weighted score threshold.
 * Returns a list of violations (empty = pass).
 */
export function checkMinScore(
  result: EvaluationResult,
  minScore: number
): ThresholdViolation[] {
  const violations: ThresholdViolation[] = [];
  for (const r of result.rankings) {
    if (r.weightedScore < minScore) {
      violations.push({
        responseId: r.responseId,
        weightedScore: r.weightedScore,
        minScore,
        delta: parseFloat((r.weightedScore - minScore).toFixed(4)),
      });
    }
  }
  return violations;
}

/**
 * Load a baseline EvaluationResult from a JSON file.
 */
export function loadBaseline(baselinePath: string): EvaluationResult {
  const raw = fs.readFileSync(baselinePath, "utf-8");
  return JSON.parse(raw) as EvaluationResult;
}

/**
 * Compare current evaluation against a baseline run.
 * Checks weighted score AND every rubric dimension per response.
 *
 * Responses are matched by responseId. Responses present in current
 * but missing from baseline are skipped with a warning (not a failure).
 *
 * @param maxRegression — allowed score drop (default 0 = no regression allowed).
 *                        E.g. 0.5 allows scores to drop by up to 0.5 points.
 * @returns list of regression violations (empty = pass)
 */
export function checkRegression(
  current: EvaluationResult,
  baseline: EvaluationResult,
  maxRegression = 0
): RegressionViolation[] {
  const violations: RegressionViolation[] = [];

  const baselineById = new Map(
    baseline.rankings.map(r => [r.responseId, r])
  );

  for (const curr of current.rankings) {
    const base = baselineById.get(curr.responseId);
    if (!base) continue; // new response, no baseline to compare

    // Check weighted score
    const wsDelta = curr.weightedScore - base.weightedScore;
    if (wsDelta < -maxRegression) {
      violations.push({
        responseId: curr.responseId,
        dimension: "weightedScore",
        current: curr.weightedScore,
        baseline: base.weightedScore,
        delta: parseFloat(wsDelta.toFixed(4)),
        allowedRegression: maxRegression,
      });
    }

    // Check each rubric dimension
    for (const dim of getRubricKeys()) {
      const c = curr.scores[dim];
      const b = base.scores[dim];
      const delta = c - b;
      if (delta < -maxRegression) {
        violations.push({
          responseId: curr.responseId,
          dimension: dim,
          current: c,
          baseline: b,
          delta: parseFloat(delta.toFixed(4)),
          allowedRegression: maxRegression,
        });
      }
    }
  }

  return violations;
}

/**
 * Format threshold violations for console / CI output.
 */
export function formatThresholdFailures(violations: ThresholdViolation[]): string {
  if (violations.length === 0) return "";
  const lines = ["", "❌ THRESHOLD CHECK FAILED", ""];
  for (const v of violations) {
    lines.push(
      `  ${v.responseId}: weighted_score=${v.weightedScore} < min_score=${v.minScore} (delta ${v.delta > 0 ? "+" : ""}${v.delta})`
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Format regression violations for console / CI output.
 */
export function formatRegressionFailures(violations: RegressionViolation[]): string {
  if (violations.length === 0) return "";
  const lines = ["", "❌ REGRESSION CHECK FAILED", ""];
  for (const v of violations) {
    const dim = v.dimension === "weightedScore" ? "weighted_score" : v.dimension;
    lines.push(
      `  ${v.responseId} / ${dim}: ${v.current} < ${v.baseline} ` +
      `(delta ${v.delta > 0 ? "+" : ""}${v.delta}, allowed ≥ ${-v.allowedRegression})`
    );
  }
  lines.push("");
  return lines.join("\n");
}

// Re-export judge options for callers
export type { JudgeOptions } from "./llm/judge";
