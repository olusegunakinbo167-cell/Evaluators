/**
 * Quality Gate — Judge calibration enforcement for CI.
 *
 * Validates that the LLM judge's scores correlate sufficiently with
 * ground-truth human scores. Fails the pipeline if correlation drifts.
 */

import * as fs from "fs";
import {
  RubricDimensionKey,
  GroundTruthFile,
  GroundTruthEntry,
  CalibrationDelta,
  CalibrationReport,
  EvaluationResult,
} from "../types";

const DEFAULT_MIN_CORRELATION = 0.75;
const DEFAULT_AGREEMENT_TOLERANCE = 1.0;

/**
 * Load a ground-truth JSON file.
 * Expected format: GroundTruthFile = GroundTruthEntry[]
 */
export function loadGroundTruth(groundTruthPath: string): GroundTruthFile {
  if (!fs.existsSync(groundTruthPath)) {
    throw new Error(`Ground-truth file not found: ${groundTruthPath}`);
  }
  const raw = fs.readFileSync(groundTruthPath, "utf-8");
  const data = JSON.parse(raw) as GroundTruthFile;

  if (!Array.isArray(data)) {
    throw new Error(`Ground-truth file ${groundTruthPath} must be an array of entries`);
  }

  for (const [idx, entry] of data.entries()) {
    if (!entry.taskId || !entry.responseId || !entry.scores) {
      throw new Error(
        `Ground-truth entry[${idx}] missing required fields (taskId, responseId, scores)`
      );
    }
  }

  return data;
}

/**
 * Pearson correlation coefficient (r).
 * Returns NaN if n < 2 or zero variance.
 */
export function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n !== ys.length || n < 2) return NaN;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return NaN;
  return num / den;
}

/**
 * Calculate judge calibration against ground truth.
 *
 * Compares judge scores in an EvaluationResult against human ground-truth
 * scores, producing Pearson r, MAE, and agreement %.
 */
export function calibrateJudge(
  result: EvaluationResult,
  groundTruth: GroundTruthFile,
  agreementTolerance = DEFAULT_AGREEMENT_TOLERANCE
): CalibrationReport {
  // Build lookup: taskId → responseId → scores
  const gtMap = new Map<string, Map<string, GroundTruthEntry>>();
  for (const entry of groundTruth) {
    if (entry.taskId !== result.taskId) continue;
    if (!gtMap.has(entry.taskId)) {
      gtMap.set(entry.taskId, new Map());
    }
    gtMap.get(entry.taskId)!.set(entry.responseId, entry);
  }

  const taskGt = gtMap.get(result.taskId);
  if (!taskGt || taskGt.size === 0) {
    // No ground truth for this task — return empty calibrated report
    return {
      pearsonR: NaN,
      mae: NaN,
      agreementPct: 0,
      agreementTolerance,
      n: 0,
      deltas: [],
      byDimension: {
        correctness: { pearsonR: NaN, mae: NaN, n: 0 },
        efficiency: { pearsonR: NaN, mae: NaN, n: 0 },
        readability: { pearsonR: NaN, mae: NaN, n: 0 },
        security: { pearsonR: NaN, mae: NaN, n: 0 },
        promptAdherence: { pearsonR: NaN, mae: NaN, n: 0 },
      },
    };
  }

  const deltas: CalibrationDelta[] = [];
  const judgeScores: number[] = [];
  const gtScores: number[] = [];

  const dimBuckets: Record<RubricDimensionKey, { judge: number[]; gt: number[] }> = {
    correctness: { judge: [], gt: [] },
    efficiency: { judge: [], gt: [] },
    readability: { judge: [], gt: [] },
    security: { judge: [], gt: [] },
    promptAdherence: { judge: [], gt: [] },
  };

  for (const ranked of result.rankings) {
    const gtEntry = taskGt.get(ranked.responseId);
    if (!gtEntry) continue;

    const dimensions: RubricDimensionKey[] = [
      "correctness",
      "efficiency",
      "readability",
      "security",
      "promptAdherence",
    ];

    for (const dim of dimensions) {
      const judgeScore = ranked.scores[dim];
      const groundTruthScore = gtEntry.scores[dim];
      const delta = judgeScore - groundTruthScore;

      deltas.push({
        taskId: result.taskId,
        responseId: ranked.responseId,
        dimension: dim,
        judgeScore,
        groundTruthScore,
        delta: parseFloat(delta.toFixed(2)),
        absDelta: parseFloat(Math.abs(delta).toFixed(2)),
      });

      judgeScores.push(judgeScore);
      gtScores.push(groundTruthScore);
      dimBuckets[dim].judge.push(judgeScore);
      dimBuckets[dim].gt.push(groundTruthScore);
    }
  }

  const n = judgeScores.length;
  const r = pearsonR(judgeScores, gtScores);
  const mae = n > 0
    ? deltas.reduce((s, d) => s + d.absDelta, 0) / n
    : NaN;
  const agreements = deltas.filter(d => d.absDelta <= agreementTolerance).length;
  const agreementPct = n > 0 ? (agreements / n) * 100 : 0;

  const byDimension = {} as CalibrationReport["byDimension"];
  for (const dim of Object.keys(dimBuckets) as RubricDimensionKey[]) {
    const bucket = dimBuckets[dim];
    const dimN = bucket.judge.length;
    const dimR = pearsonR(bucket.judge, bucket.gt);
    const dimMae = dimN > 0
      ? deltas
          .filter(d => d.dimension === dim)
          .reduce((s, d) => s + d.absDelta, 0) / dimN
      : NaN;
    byDimension[dim] = {
      pearsonR: parseFloat(Number.isFinite(dimR) ? dimR.toFixed(4) : "NaN"),
      mae: parseFloat(Number.isFinite(dimMae) ? dimMae.toFixed(4) : "NaN"),
      n: dimN,
    };
  }

  return {
    pearsonR: parseFloat(Number.isFinite(r) ? r.toFixed(4) : "NaN"),
    mae: parseFloat(Number.isFinite(mae) ? mae.toFixed(4) : "NaN"),
    agreementPct: parseFloat(agreementPct.toFixed(2)),
    agreementTolerance,
    n,
    deltas,
    byDimension,
  };
}

export interface QualityGateResult {
  passed: boolean;
  correlation: number;
  minCorrelation: number;
  violations: string[];
}

/**
 * Quality gate check — fails if judge correlation drops below threshold.
 *
 * @param minCorrelation — minimum Pearson r required (default 0.75)
 * @returns QualityGateResult with pass/fail and violation messages
 */
export function checkQualityGate(
  calibrationReport: CalibrationReport | undefined,
  minCorrelation = DEFAULT_MIN_CORRELATION
): QualityGateResult {
  const violations: string[] = [];

  if (!calibrationReport || calibrationReport.n === 0) {
    return {
      passed: true,
      correlation: NaN,
      minCorrelation,
      violations: [],
    };
  }

  const r = calibrationReport.pearsonR;

  if (!Number.isFinite(r)) {
    violations.push(
      `Calibration correlation is not finite (n=${calibrationReport.n}, ` +
      `check ground-truth variance)`
    );
  } else if (r < minCorrelation) {
    violations.push(
      `Judge correlation r=${r.toFixed(4)} below threshold ${minCorrelation.toFixed(2)} ` +
      `(MAE=${calibrationReport.mae}, agreement=${calibrationReport.agreementPct.toFixed(1)}%)`
    );
  }

  return {
    passed: violations.length === 0,
    correlation: r,
    minCorrelation,
    violations,
  };
}

/**
 * Emit GitHub Actions ::error:: annotations for quality gate failures.
 */
export function emitQualityGateAnnotations(
  gateResult: QualityGateResult,
  taskId: string
): void {
  for (const violation of gateResult.violations) {
    const safeTask = taskId.replace(/[\r\n]/g, " ");
    console.error(
      `::error title=Judge calibration failed::` +
      `Task ${safeTask}: ${violation}`
    );
  }
}

/**
 * Format quality gate failures for console output.
 */
export function formatQualityGateFailures(gateResult: QualityGateResult): string {
  if (gateResult.passed) return "";
  const lines = ["\n❌ QUALITY GATE FAILED — Judge calibration drift detected\n"];
  for (const v of gateResult.violations) {
    lines.push(`  ${v}`);
  }
  lines.push("");
  return lines.join("\n");
}

export { DEFAULT_MIN_CORRELATION, DEFAULT_AGREEMENT_TOLERANCE };
