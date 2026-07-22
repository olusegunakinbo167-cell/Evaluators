/**
 * Evaluation artifact save/load — for CI artifact archiving and baseline comparison.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  EvaluationResult,
  EvaluationArtifact,
  MultiSuiteArtifact,
  BaselineComparison,
} from "../types";
import { MultiSuiteResult } from "../components/suiteRunner";

const ARTIFACT_VERSION = "1.0";

function getGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Save an EvaluationResult as a full artifact JSON file.
 * Includes variance, calibration, robustness, token costs, git SHA, timestamp.
 */
export function saveArtifact(
  result: EvaluationResult,
  artifactPath: string,
  options: {
    suiteName?: string;
    inputFile?: string;
    cliFlags?: Record<string, unknown>;
  } = {}
): string {
  const artifact: EvaluationArtifact = {
    version: ARTIFACT_VERSION,
    timestamp: new Date().toISOString(),
    gitSha: getGitSha(),
    result,
    suiteName: options.suiteName,
    inputFile: options.inputFile,
    cliFlags: options.cliFlags,
  };

  const dir = path.dirname(artifactPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");
  return artifactPath;
}

/**
 * Load an evaluation artifact from disk.
 * Supports both new Artifact format and legacy raw EvaluationResult JSON.
 */
export function loadArtifact(artifactPath: string): EvaluationArtifact {
  const raw = fs.readFileSync(artifactPath, "utf-8");
  const data = JSON.parse(raw);

  // Detect format: new artifact has version + result, legacy is raw EvaluationResult
  if (data.version && data.result && data.timestamp) {
    return data as EvaluationArtifact;
  }

  // Legacy: wrap raw EvaluationResult
  if (data.taskId && data.rankings) {
    return {
      version: "0.9-legacy",
      timestamp: data.timestamp || new Date().toISOString(),
      result: data as EvaluationResult,
    };
  }

  throw new Error(`Unrecognized artifact format at ${artifactPath}`);
}

/**
 * Save a MultiSuiteResult as an artifact.
 */
export function saveMultiSuiteArtifact(
  multiResult: MultiSuiteResult,
  artifactPath: string,
  cliFlags?: Record<string, unknown>
): string {
  const artifact: MultiSuiteArtifact = {
    version: ARTIFACT_VERSION,
    timestamp: new Date().toISOString(),
    gitSha: getGitSha(),
    result: {
      totalPassed: multiResult.totalPassed,
      totalFailed: multiResult.totalFailed,
      totalRuns: multiResult.totalRuns,
      aggregates: multiResult.aggregates.map(agg => ({
        suiteName: agg.suiteName,
        passed: agg.passed,
        failed: agg.failed,
        total: agg.total,
        runs: agg.runs.map(r => ({
          inputFile: r.inputFile,
          taskId: r.result.taskId,
          failed: r.failed,
          result: r.result,
        })),
      })),
      tokenStats: multiResult.tokenStats,
    },
    cliFlags,
  };

  const dir = path.dirname(artifactPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");
  return artifactPath;
}

/**
 * Load a multi-suite artifact.
 */
export function loadMultiSuiteArtifact(artifactPath: string): MultiSuiteArtifact {
  const raw = fs.readFileSync(artifactPath, "utf-8");
  return JSON.parse(raw) as MultiSuiteArtifact;
}

/**
 * Compare current evaluation result against a baseline artifact.
 * Flags regressions in:
 * - Per-task weighted scores (beyond maxRegression)
 * - Ground-truth Pearson correlation (degradation)
 * - Cost / token usage increases
 * - Robustness score degradation
 */
export function compareBaseline(
  current: EvaluationResult,
  baseline: EvaluationResult,
  options: {
    maxRegression?: number;
    checkCorrelation?: boolean;
  } = {}
): BaselineComparison {
  const maxRegression = options.maxRegression ?? 0;
  const checkCorrelation = options.checkCorrelation ?? true;

  // Score deltas
  const scoreDeltas: BaselineComparison["scoreDeltas"] = [];
  const baselineByResponse = new Map(
    baseline.rankings.map(r => [r.responseId, r.weightedScore])
  );

  for (const curr of current.rankings) {
    const baseScore = baselineByResponse.get(curr.responseId);
    if (baseScore === undefined) continue;
    const delta = curr.weightedScore - baseScore;
    scoreDeltas.push({
      taskId: current.taskId,
      responseId: curr.responseId,
      currentScore: curr.weightedScore,
      baselineScore: baseScore,
      delta: parseFloat(delta.toFixed(4)),
      isRegression: delta < -maxRegression,
    });
  }

  // Correlation shift
  let correlationShift: BaselineComparison["correlationShift"] | undefined;
  const currCal = current.calibrationReport;
  const baseCal = baseline.calibrationReport;
  if (checkCorrelation && currCal && baseCal && Number.isFinite(currCal.pearsonR) && Number.isFinite(baseCal.pearsonR)) {
    const delta = currCal.pearsonR - baseCal.pearsonR;
    correlationShift = {
      currentR: currCal.pearsonR,
      baselineR: baseCal.pearsonR,
      delta: parseFloat(delta.toFixed(4)),
      isDegradation: delta < -0.01, // allow tiny float noise
    };
  }

  // Cost delta
  let costDelta: BaselineComparison["costDelta"] | undefined;
  const currCost = current.telemetry?.estimatedCostUsd ?? 0;
  const baseCost = baseline.telemetry?.estimatedCostUsd ?? 0;
  if (currCost > 0 || baseCost > 0) {
    const delta = currCost - baseCost;
    const pctChange = baseCost > 0 ? (delta / baseCost) * 100 : 0;
    costDelta = {
      currentCost: currCost,
      baselineCost: baseCost,
      delta: parseFloat(delta.toFixed(6)),
      pctChange: parseFloat(pctChange.toFixed(2)),
    };
  }

  // Token delta
  let tokenDelta: BaselineComparison["tokenDelta"] | undefined;
  const currTokens = current.telemetry?.totalTokens ?? 0;
  const baseTokens = baseline.telemetry?.totalTokens ?? 0;
  if (currTokens > 0 || baseTokens > 0) {
    const delta = currTokens - baseTokens;
    const pctChange = baseTokens > 0 ? (delta / baseTokens) * 100 : 0;
    tokenDelta = {
      currentTokens: currTokens,
      baselineTokens: baseTokens,
      delta,
      pctChange: parseFloat(pctChange.toFixed(2)),
    };
  }

  // Robustness delta
  let robustnessDelta: BaselineComparison["robustnessDelta"] | undefined;
  const currRob = current.robustnessReport;
  const baseRob = baseline.robustnessReport;
  if (currRob && baseRob) {
    const delta = currRob.robustnessScore - baseRob.robustnessScore;
    robustnessDelta = {
      currentScore: currRob.robustnessScore,
      baselineScore: baseRob.robustnessScore,
      delta: parseFloat(delta.toFixed(2)),
      isDegradation: delta < -0.1,
    };
  }

  const hasScoreRegressions = scoreDeltas.some(d => d.isRegression);
  const hasCorrelationDegradation = correlationShift?.isDegradation ?? false;
  const hasRobustnessDegradation = robustnessDelta?.isDegradation ?? false;
  const hasRegressions = hasScoreRegressions || hasCorrelationDegradation || hasRobustnessDegradation;

  const parts: string[] = [];
  const regCount = scoreDeltas.filter(d => d.isRegression).length;
  if (regCount > 0) parts.push(`${regCount} score regression(s)`);
  if (hasCorrelationDegradation && correlationShift) {
    parts.push(`correlation degraded ${correlationShift.baselineR.toFixed(3)} → ${correlationShift.currentR.toFixed(3)}`);
  }
  if (hasRobustnessDegradation && robustnessDelta) {
    parts.push(`robustness degraded ${robustnessDelta.baselineScore} → ${robustnessDelta.currentScore}`);
  }
  if (costDelta && Math.abs(costDelta.pctChange) >= 5) {
    const dir = costDelta.delta > 0 ? "increased" : "decreased";
    parts.push(`cost ${dir} ${costDelta.pctChange > 0 ? "+" : ""}${costDelta.pctChange.toFixed(1)}%`);
  }
  const summary = hasRegressions
    ? `Regressions detected: ${parts.join(", ")}`
    : "No regressions vs baseline";

  return {
    scoreDeltas,
    correlationShift,
    costDelta,
    tokenDelta,
    robustnessDelta,
    hasRegressions,
    summary,
  };
}

/**
 * Compare two MultiSuiteArtifacts and produce per-task comparisons.
 */
export function compareMultiSuiteBaseline(
  current: MultiSuiteArtifact,
  baseline: MultiSuiteArtifact,
  options: { maxRegression?: number } = {}
): Array<{ taskId: string; comparison: BaselineComparison }> {
  const results: Array<{ taskId: string; comparison: BaselineComparison }> = [];

  // Build baseline lookup: taskId → EvaluationResult
  const baselineByTask = new Map<string, EvaluationResult>();
  for (const agg of baseline.result.aggregates) {
    for (const run of agg.runs) {
      baselineByTask.set(run.taskId, run.result);
    }
  }

  // Compare each current task
  for (const agg of current.result.aggregates) {
    for (const run of agg.runs) {
      const baseResult = baselineByTask.get(run.taskId);
      if (!baseResult) continue;
      const comparison = compareBaseline(run.result, baseResult, options);
      results.push({ taskId: run.taskId, comparison });
    }
  }

  return results;
}
