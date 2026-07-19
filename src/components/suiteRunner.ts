// src/components/suiteRunner.ts
/**
 * Multi-suite evaluation runner.
 * Runs suites concurrently, aggregates results into a unified report.
 */

import * as fs from "fs";
import {
  EvaluationInput,
  EvaluationResult,
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
import { ResolvedSuiteConfig } from "../utils/config";

export interface SuiteRunResult {
  suiteName: string;
  inputFile: string;
  result: EvaluationResult;
  thresholdViolations: ThresholdViolation[];
  regressionViolations: RegressionViolation[];
  failed: boolean;
  error?: string;
}

export interface SuiteAggregateResult {
  suiteName: string;
  runs: SuiteRunResult[];
  passed: number;
  failed: number;
  total: number;
}

export interface MultiSuiteResult {
  aggregates: SuiteAggregateResult[];
  totalPassed: number;
  totalFailed: number;
  totalRuns: number;
  failed: boolean;
}

export interface SuiteRunOptions {
  minScore?: number;
  maxRegression?: number;
  baseline?: string;
  failFast?: boolean;
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

    // Inject suite rubric if provided
    if (rubric) {
      input.rubric = rubric;
    }

    const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
    const result = hasScores ? evaluate(input) : await evaluateAuto(input);

    let thresholdViolations: ThresholdViolation[] = [];
    let regressionViolations: RegressionViolation[] = [];
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
      } catch (e: any) {
        return {
          suiteName,
          inputFile,
          result,
          thresholdViolations: [],
          regressionViolations: [],
          failed: true,
          error: `Baseline load failed: ${e?.message ?? e}`,
        };
      }
    }

    return {
      suiteName,
      inputFile,
      result,
      thresholdViolations,
      regressionViolations,
      failed,
    };
  } catch (err: any) {
    // Synthesize a minimal failed result
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
        confidence: "low" as any,
      },
      thresholdViolations: [],
      regressionViolations: [],
      failed: true,
      error: err?.message ?? String(err),
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

  return {
    suiteName: suite.name,
    runs,
    passed: runs.length - failedCount,
    failed: failedCount,
    total: runs.length,
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
  const aggregates: SuiteAggregateResult[] = [];

  // Simple concurrency-limited execution
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= suites.length) break;
      const agg = await runSuite(suites[i], cliOverrides);
      aggregates[i] = agg;
      if (cliOverrides.failFast && agg.failed > 0) {
        // Mark remaining suites as skipped
        idx = suites.length;
        break;
      }
    }
  }

  const workers = Array(Math.min(concurrency, suites.length))
    .fill(0)
    .map(() => worker());
  await Promise.all(workers);

  const totalPassed = aggregates.reduce((s, a) => s + a.passed, 0);
  const totalFailed = aggregates.reduce((s, a) => s + a.failed, 0);
  const totalRuns = aggregates.reduce((s, a) => s + a.total, 0);

  return {
    aggregates: aggregates.filter(Boolean),
    totalPassed,
    totalFailed,
    totalRuns,
    failed: totalFailed > 0,
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

  // Aggregate telemetry
  let totalTokens = 0, cacheHits = 0, cacheMisses = 0, totalCost = 0;
  for (const agg of result.aggregates) {
    for (const run of agg.runs) {
      const t = run.result.telemetry;
      if (!t) continue;
      totalTokens += t.totalTokens;
      cacheHits += t.cacheHits;
      cacheMisses += t.cacheMisses;
      totalCost += t.estimatedCostUsd;
    }
  }
  if (totalTokens > 0 || cacheHits + cacheMisses > 0) {
    lines.push("---");
    lines.push("");
    lines.push(`<sub>Aggregate telemetry — Tokens: ${totalTokens.toLocaleString()} | Cache: ${cacheHits}/${cacheHits + cacheMisses} | Cost: $${totalCost.toFixed(4)}</sub>`);
    lines.push("");
  }

  return lines.join("\n");
}
