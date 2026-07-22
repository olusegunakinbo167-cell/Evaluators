// src/components/suiteRunner.ts
/**
 * Multi-suite evaluation runner.
 * Runs suites concurrently, aggregates results into a unified report.
 */

import * as fs from "fs";
import {
  Confidence,
  EvaluationInput,
  EvaluationResult,
  EvaluationTelemetry,
  LlmEndpointConfig,
  ResponseVariance,
  VarianceReport,
  GroundTruthFile
} from "../types";
import {
  evaluate,
  evaluateAuto,
  checkMinScore,
  checkRegression,
  loadBaseline,
  ThresholdViolation,
  RegressionViolation,
} from "./evaluator";
import { calibrateJudge, loadGroundTruth } from "../utils/qualityGate";

import { ResolvedSuiteConfig } from "../utils/config";

export interface VarianceOptions {
  samples?: number;
  maxVariance?: number;
}

export interface VarianceViolation {
  responseId: string;
  stddev: number;
  maxAllowed: number;
}

export interface CalibrationViolation {
  taskId: string;
  correlation: number;
  minCorrelation: number;
  mae: number;
}

export interface SuiteRunResult {
  suiteName: string;
  inputFile: string;
  result: EvaluationResult;
  thresholdViolations: ThresholdViolation[];
  regressionViolations: RegressionViolation[];
  varianceViolations: VarianceViolation[];
  calibrationViolations: CalibrationViolation[];
  failed: boolean;
  error?: string;
}

export interface SuiteAggregateResult {
  suiteName: string;
  runs: SuiteRunResult[];
  passed: number;
  failed: number;
  total: number;
  /** Aggregated token / cost telemetry across all runs in this suite. */
  tokenStats?: {
    totalTokens: number;
    totalCostUsd: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export interface MultiSuiteResult {
  aggregates: SuiteAggregateResult[];
  totalPassed: number;
  totalFailed: number;
  totalRuns: number;
  failed: boolean;
  /** Global token / cost telemetry. */
  tokenStats?: {
    totalTokens: number;
    totalCostUsd: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export interface SuiteRunOptions {
  minScore?: number;
  maxRegression?: number;
  baseline?: string;
  failFast?: boolean;
  samples?: number;
  maxVariance?: number;
  disableCache?: boolean;
  llm?: LlmEndpointConfig;
  groundTruth?: string | GroundTruthFile;
  minCorrelation?: number;
}

function sumTelemetry(results: EvaluationResult[]): EvaluationTelemetry {
  const out: EvaluationTelemetry = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalLatencyMs: 0,
    estimatedCostUsd: 0,
    estimatedSavingsUsd: 0,
  };
  for (const r of results) {
    const t = r.telemetry;
    if (!t) continue;
    out.totalPromptTokens += t.totalPromptTokens;
    out.totalCompletionTokens += t.totalCompletionTokens;
    out.totalTokens += t.totalTokens;
    out.cacheHits += t.cacheHits;
    out.cacheMisses += t.cacheMisses;
    out.totalLatencyMs += t.totalLatencyMs;
    out.estimatedCostUsd += t.estimatedCostUsd;
    out.estimatedSavingsUsd += t.estimatedSavingsUsd;
  }
  out.estimatedCostUsd = Math.round(out.estimatedCostUsd * 1_000_000) / 1_000_000;
  out.estimatedSavingsUsd = Math.round(out.estimatedSavingsUsd * 1_000_000) / 1_000_000;
  return out;
}

function computeVarianceStats(
  samples: EvaluationResult[]
): VarianceReport {
  const scoresByResponse = new Map<string, number[]>();

  for (const sample of samples) {
    for (const ranked of sample.rankings) {
      const arr = scoresByResponse.get(ranked.responseId) ?? [];
      arr.push(ranked.weightedScore);
      scoresByResponse.set(ranked.responseId, arr);
    }
  }

  const responses: ResponseVariance[] = [];
  for (const [responseId, scores] of scoresByResponse.entries()) {
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const variance = scores.reduce((acc, s) => acc + (s - mean) * (s - mean), 0) / n;
    const stddev = Math.sqrt(variance);
    responses.push({
      responseId,
      samples: n,
      mean: parseFloat(mean.toFixed(4)),
      min: parseFloat(min.toFixed(4)),
      max: parseFloat(max.toFixed(4)),
      stddev: parseFloat(stddev.toFixed(4)),
      variance: parseFloat(variance.toFixed(4)),
      scores: scores.map(s => parseFloat(s.toFixed(4))),
    });
  }

  const stddevs = responses.map(r => r.stddev);
  const maxStddev = stddevs.length ? Math.max(...stddevs) : 0;
  const meanStddev = stddevs.length
    ? stddevs.reduce((a, b) => a + b, 0) / stddevs.length
    : 0;

  return {
    samples: samples.length,
    responses,
    maxStddev: parseFloat(maxStddev.toFixed(4)),
    meanStddev: parseFloat(meanStddev.toFixed(4)),
    highVarianceResponses: [],
  };
}

/**
 * Run a single evaluation input with optional multi-pass variance sampling.
 * When samples > 1, runs evaluateAuto N times, aggregates scores,
 * computes variance statistics, and sums token/cost telemetry.
 */
async function runWithVariance(
  input: EvaluationInput,
  samples: number,
  disableCache: boolean,
  llmConfig?: LlmEndpointConfig
): Promise<{ result: EvaluationResult; allResults: EvaluationResult[] }> {
  if (samples <= 1) {
    const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
    const result = hasScores
      ? evaluate(input)
      : await evaluateAuto(input, undefined, llmConfig, { disableCache });
    return { result, allResults: [result] };
  }

  const allResults: EvaluationResult[] = [];
  for (let i = 0; i < samples; i++) {
    const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
    const r = hasScores
      ? evaluate(input)
      : await evaluateAuto(input, undefined, llmConfig, { disableCache: true });
    allResults.push(r);
  }

  const varianceReport = computeVarianceStats(allResults);

  // Average the rankings for the primary result
  const baseResult = allResults[0];
  const meanScores = new Map(
    varianceReport.responses.map(v => [v.responseId, v.mean] as const)
  );

  const averagedRankings = baseResult.rankings.map(rr => ({
    ...rr,
    weightedScore: meanScores.get(rr.responseId) ?? rr.weightedScore,
  })).sort((a, b) => b.weightedScore - a.weightedScore)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const telemetry = sumTelemetry(allResults);

  const result: EvaluationResult = {
    ...baseResult,
    rankings: averagedRankings,
    preferred: averagedRankings[0]?.responseId ?? baseResult.preferred,
    telemetry,
    varianceReport,
  };

  return { result, allResults };
}

function checkVariance(
  varianceReport: VarianceReport | undefined,
  maxVariance: number | undefined
): VarianceViolation[] {
  if (!varianceReport || maxVariance === undefined) return [];
  const violations: VarianceViolation[] = [];
  for (const r of varianceReport.responses) {
    if (r.stddev > maxVariance) {
      violations.push({
        responseId: r.responseId,
        stddev: r.stddev,
        maxAllowed: maxVariance,
      });
    }
  }
  return violations;
}

async function runSingleInput(
  inputFile: string,
  suiteName: string,
  opts: SuiteRunOptions,
  rubric?: import("../types").RubricDimension[]
): Promise<SuiteRunResult> {
  try {
    const raw = fs.readFileSync(inputFile, "utf-8");
    const input = JSON.parse(raw) as EvaluationInput;

    if (rubric) {
      input.rubric = rubric;
    }

    const samples = Math.max(1, Math.floor(opts.samples ?? 1));
    const disableCache = opts.disableCache ?? samples > 1;

    const { result } = await runWithVariance(input, samples, disableCache, opts.llm);

    let thresholdViolations: ThresholdViolation[] = [];
    let regressionViolations: RegressionViolation[] = [];
    let varianceViolations: VarianceViolation[] = [];
    let failed = false;

    if (opts.minScore !== undefined) {
      thresholdViolations = checkMinScore(result, opts.minScore);
      if (thresholdViolations.length > 0) failed = true;
    }

    if (opts.baseline) {
      try {
        const baseline = loadBaseline(opts.baseline);
        const maxReg = opts.maxRegression ?? 0;
        regressionViolations = checkRegression(result, baseline, maxReg);
        if (regressionViolations.length > 0) failed = true;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          suiteName,
          inputFile,
          result,
          thresholdViolations: [],
          regressionViolations: [],
          varianceViolations: [],
          calibrationViolations: [],
          failed: true,
          error: `Baseline load failed: ${msg}`,
        };
      }
    }

    if (opts.maxVariance !== undefined && result.varianceReport) {
      varianceViolations = checkVariance(result.varianceReport, opts.maxVariance);
      if (varianceViolations.length > 0) {
        failed = true;
        result.varianceReport.highVarianceResponses = varianceViolations.map(v => v.responseId);
      }
    }

    // Calibration / ground-truth check
    const calibrationViolations: CalibrationViolation[] = [];
    if (opts.groundTruth) {
      try {
        const gt: GroundTruthFile = typeof opts.groundTruth === "string"
          ? loadGroundTruth(opts.groundTruth)
          : opts.groundTruth;
        const calibrationReport = calibrateJudge(result, gt);
        result.calibrationReport = calibrationReport;

        const minCorr = opts.minCorrelation ?? 0.75;
        if (calibrationReport.n > 0 && Number.isFinite(calibrationReport.pearsonR)) {
          if (calibrationReport.pearsonR < minCorr) {
            calibrationViolations.push({
              taskId: result.taskId,
              correlation: calibrationReport.pearsonR,
              minCorrelation: minCorr,
              mae: calibrationReport.mae,
            });
            failed = true;
          }
        }
      } catch (e) {
        // Ground-truth load failed — don't fail the run, just skip calibration
      }
    }

    return {
      suiteName,
      inputFile,
      result,
      thresholdViolations,
      regressionViolations,
      varianceViolations,
      calibrationViolations,
      failed,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      suiteName,
      inputFile,
      result: {
        taskId: "error",
        prompt: "",
        evaluator: "",
        timestamp: new Date().toISOString(),
        rankings: [],
        preferred: "",
        confidence: Confidence.LOW,
      },
      thresholdViolations: [],
      regressionViolations: [],
      varianceViolations: [],
      calibrationViolations: [],
      failed: true,
      error: msg,
    };
  }
}

async function runSuite(
  suite: ResolvedSuiteConfig,
  cliOverrides: SuiteRunOptions = {}
): Promise<SuiteAggregateResult> {
  const opts: SuiteRunOptions = {
    minScore: cliOverrides.minScore ?? suite.minScore,
    maxRegression: cliOverrides.maxRegression ?? suite.maxRegression,
    baseline: cliOverrides.baseline ?? suite.baseline,
    failFast: cliOverrides.failFast,
    samples: cliOverrides.samples ?? suite.samples,
    maxVariance: cliOverrides.maxVariance ?? suite.maxVariance,
    disableCache: cliOverrides.disableCache,
    llm: { ...(suite.llm ?? {}), ...(cliOverrides.llm ?? {}) },
    groundTruth: cliOverrides.groundTruth ?? suite.groundTruth,
    minCorrelation: cliOverrides.minCorrelation ?? suite.minCorrelation ?? 0.75,
  };

  const runs: SuiteRunResult[] = [];
  let failedCount = 0;

  for (const inputFile of suite.inputFiles) {
    const run = await runSingleInput(inputFile, suite.name, opts, suite.rubric);
    runs.push(run);
    if (run.failed) {
      failedCount++;
      if (opts.failFast) break;
    }
  }

  // Aggregate token stats
  let totalTokens = 0;
  let totalCostUsd = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const run of runs) {
    const t = run.result.telemetry;
    if (!t) continue;
    totalTokens += t.totalTokens;
    totalCostUsd += t.estimatedCostUsd;
    cacheHits += t.cacheHits;
    cacheMisses += t.cacheMisses;
  }

  return {
    suiteName: suite.name,
    runs,
    passed: runs.length - failedCount,
    failed: failedCount,
    total: runs.length,
    tokenStats: {
      totalTokens,
      totalCostUsd,
      cacheHits,
      cacheMisses,
    },
  };
}

/**
 * Run multiple evaluation suites concurrently.
 * LLM-level concurrency is still throttled by LLM_MAX_CONCURRENCY.
 */
export async function runSuites(
  suites: ResolvedSuiteConfig[],
  cliOverrides: SuiteRunOptions = {},
  maxConcurrency?: number
): Promise<MultiSuiteResult> {
  const concurrency = maxConcurrency && maxConcurrency > 0 ? maxConcurrency : suites.length;
  const aggregates: SuiteAggregateResult[] = new Array(suites.length);

  // Simple concurrency-limited execution
  let idx = 0;
  async function worker(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = idx++;
      if (i >= suites.length) break;
      const agg = await runSuite(suites[i], cliOverrides);
      aggregates[i] = agg;
      if (cliOverrides.failFast && agg.failed > 0) {
        idx = suites.length;
        break;
      }
    }
  }

  const workers = Array(Math.min(concurrency, suites.length))
    .fill(0)
    .map(() => worker());
  await Promise.all(workers);

  const filtered = aggregates.filter(Boolean);
  const totalPassed = filtered.reduce((s, a) => s + a.passed, 0);
  const totalFailed = filtered.reduce((s, a) => s + a.failed, 0);
  const totalRuns = filtered.reduce((s, a) => s + a.total, 0);

  // Global token stats
  let totalTokens = 0;
  let totalCostUsd = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const agg of filtered) {
    if (!agg.tokenStats) continue;
    totalTokens += agg.tokenStats.totalTokens;
    totalCostUsd += agg.tokenStats.totalCostUsd;
    cacheHits += agg.tokenStats.cacheHits;
    cacheMisses += agg.tokenStats.cacheMisses;
  }

  return {
    aggregates: filtered,
    totalPassed,
    totalFailed,
    totalRuns,
    failed: totalFailed > 0,
    tokenStats: {
      totalTokens,
      totalCostUsd,
      cacheHits,
      cacheMisses,
    },
  };
}

/**
 * Build a unified Markdown report aggregating all suites.
 */
export function buildAggregatedMarkdown(result: MultiSuiteResult): string {
  const lines: string[] = [];
  const { totalPassed, totalFailed, totalRuns } = result;
  const statusEmoji = totalFailed > 0 ? "❌" : "✅";

  lines.push(`# ${statusEmoji} Evaluation Suites — ${totalPassed}/${totalRuns} passed`);
  lines.push("");
  lines.push(`**Total:** ${totalPassed} passed, ${totalFailed} failed, ${totalRuns} runs`);
  lines.push(`**Timestamp:** ${new Date().toISOString()}`);
  lines.push("");

  // Summary table
  lines.push("| Suite | Passed | Failed | Total | Status |");
  lines.push("|-------|--------|--------|-------|--------|");
  for (const agg of result.aggregates) {
    const icon = agg.failed > 0 ? "❌" : "✅";
    lines.push(`| ${agg.suiteName} | ${agg.passed} | ${agg.failed} | ${agg.total} | ${icon} |`);
  }
  lines.push("");

  // Per-suite details
  for (const agg of result.aggregates) {
    lines.push(`## ${agg.suiteName} — ${agg.passed}/${agg.total} passed`);
    lines.push("");

    const failedRuns = agg.runs.filter(r => r.failed);
    if (failedRuns.length === 0) {
      lines.push("_All runs passed._");
      lines.push("");
      continue;
    }

    for (const run of failedRuns) {
      lines.push(`### ❌ ${run.inputFile}`);
      lines.push("");
      if (run.error) {
        lines.push(`**Error:** ${run.error}`);
        lines.push("");
        continue;
      }

      if (run.thresholdViolations.length > 0) {
        lines.push("**Threshold violations:**");
        for (const v of run.thresholdViolations) {
          lines.push(`- \`${v.responseId}\`: ${v.weightedScore} < ${v.minScore} (delta ${v.delta})`);
        }
        lines.push("");
      }

      if (run.regressionViolations.length > 0) {
        lines.push("**Regression violations:**");
        for (const v of run.regressionViolations) {
          const dim = v.dimension === "weightedScore" ? "weighted_score" : v.dimension;
          lines.push(`- \`${v.responseId} / ${dim}\`: ${v.current} < ${v.baseline} (delta ${v.delta})`);
        }
        lines.push("");
      }

      if (run.varianceViolations.length > 0) {
        lines.push("**Variance violations:**");
        for (const v of run.varianceViolations) {
          lines.push(`- \`${v.responseId}\`: stddev ${v.stddev} > max ${v.maxAllowed}`);
        }
        lines.push("");
      }

      if (run.calibrationViolations.length > 0) {
        lines.push("**Calibration violations:**");
        for (const v of run.calibrationViolations) {
          lines.push(`- Task \`${v.taskId}\`: r=${v.correlation.toFixed(4)} < min ${v.minCorrelation} (MAE=${v.mae.toFixed(2)})`);
        }
        lines.push("");
      }

      // Quick score table
      if (run.result.rankings.length > 0) {
        lines.push("| Response | Score | Correctness | Security |");
        lines.push("|----------|-------|-------------|----------|");
        for (const r of run.result.rankings) {
          lines.push(`| ${r.responseId} | ${r.weightedScore} | ${r.scores.correctness} | ${r.scores.security} |`);
        }
        lines.push("");
      }
    }
  }

  // Token / cost summary
  const ts = result.tokenStats;
  if (ts && (ts.totalTokens > 0 || ts.cacheHits + ts.cacheMisses > 0)) {
    lines.push("---");
    lines.push("");
    lines.push("## Token / Cost Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total tokens | ${ts.totalTokens.toLocaleString()} |`);
    lines.push(`| Cache hits | ${ts.cacheHits} |`);
    lines.push(`| Cache misses | ${ts.cacheMisses} |`);
    lines.push(`| Estimated cost | ${ts.totalCostUsd.toFixed(4)} |`);
    lines.push("");
  }

  // Calibration summary
  const allRuns = result.aggregates.flatMap(a => a.runs);
  const calibratedRuns = allRuns.filter(r => r.result.calibrationReport && r.result.calibrationReport.n > 0);
  if (calibratedRuns.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Judge Calibration Summary");
    lines.push("");
    lines.push("| Task | Correlation r | MAE | Agreement % | N | Status |");
    lines.push("|------|----------------|-----|-------------|---|--------|");
    for (const run of calibratedRuns) {
      const cr = run.result.calibrationReport!;
      const failed = run.calibrationViolations.length > 0;
      const icon = failed ? "❌" : "✅";
      const rStr = Number.isFinite(cr.pearsonR) ? cr.pearsonR.toFixed(4) : "N/A";
      lines.push(
        `| ${run.result.taskId} | ${rStr} | ${cr.mae.toFixed(2)} | ${cr.agreementPct.toFixed(1)}% | ${cr.n} | ${icon} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export { computeVarianceStats, checkVariance };
