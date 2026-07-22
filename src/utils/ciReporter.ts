/**
 * CI Reporter — GitHub Actions integration for variance, token/cost,
 * and judge calibration reporting.
 */

import { SuiteRunResult, VarianceViolation, MultiSuiteResult, CalibrationViolation, RobustnessViolation } from "../components/suiteRunner";

/**
 * Emit GitHub Actions ::error:: annotations for high-variance responses.
 *
 * Format: ::error file=<inputFile>,title=High variance::Response <id> variance <x> exceeds threshold <y>
 */
export function emitVarianceAnnotations(
  violations: VarianceViolation[],
  inputFile: string
): void {
  for (const v of violations) {
    const safeFile = inputFile.replace(/[\r\n]/g, " ");
    console.error(
      `::error file=${safeFile},title=High variance::` +
      `Response ${v.responseId} variance ${v.stddev} exceeds threshold ${v.maxAllowed}`
    );
  }
}

/**
 * Emit variance annotations for all failed runs in a MultiSuiteResult.
 * Returns the number of annotations emitted.
 */
export function emitVarianceAnnotationsForResult(result: MultiSuiteResult): number {
  let count = 0;
  for (const agg of result.aggregates) {
    for (const run of agg.runs) {
      if (run.varianceViolations.length > 0) {
        emitVarianceAnnotations(run.varianceViolations, run.inputFile);
        count += run.varianceViolations.length;
      }
    }
  }
  return count;
}

/**
 * Emit GitHub Actions ::error:: annotations for calibration failures.
 */
export function emitCalibrationAnnotations(
  violations: CalibrationViolation[],
  inputFile: string
): void {
  for (const v of violations) {
    const safeFile = inputFile.replace(/[\r\n]/g, " ");
    console.error(
      `::error file=${safeFile},title=Judge calibration failed::` +
      `Task ${v.taskId} correlation r=${v.correlation.toFixed(4)} ` +
      `below threshold ${v.minCorrelation} (MAE=${v.mae.toFixed(2)})`
    );
  }
}

/**
 * Emit calibration annotations for all failed runs in a MultiSuiteResult.
 * Returns the number of annotations emitted.
 */
export function emitCalibrationAnnotationsForResult(result: MultiSuiteResult): number {
  let count = 0;
  for (const agg of result.aggregates) {
    for (const run of agg.runs) {
      if (run.calibrationViolations.length > 0) {
        emitCalibrationAnnotations(run.calibrationViolations, run.inputFile);
        count += run.calibrationViolations.length;
      }
    }
  }
  return count;
}

/**
 * Emit GitHub Actions ::error:: annotations for robustness failures.
 */
export function emitRobustnessAnnotations(
  violations: RobustnessViolation[],
  inputFile: string
): void {
  for (const v of violations) {
    const safeFile = inputFile.replace(/[\r\n]/g, " ");
    console.error(
      `::error file=${safeFile},title=Judge robustness failed::` +
      `Task ${v.taskId} robustness score ${v.robustnessScore.toFixed(2)}/10 ` +
      `below threshold ${v.minRobustness} (detection rate ${(v.detectionRate * 100).toFixed(1)}%)`
    );
  }
}

/**
 * Emit robustness annotations for all failed runs in a MultiSuiteResult.
 * Returns the number of annotations emitted.
 */
export function emitRobustnessAnnotationsForResult(result: MultiSuiteResult): number {
  let count = 0;
  for (const agg of result.aggregates) {
    for (const run of agg.runs) {
      if (run.robustnessViolations.length > 0) {
        emitRobustnessAnnotations(run.robustnessViolations, run.inputFile);
        count += run.robustnessViolations.length;
      }
    }
  }
  return count;
}

/**
 * Render token / cost statistics as a Markdown table for CI step summaries.
 */
export function renderTokenCostMarkdown(
  totalTokens: number,
  totalCostUsd: number,
  cacheHits: number,
  cacheMisses: number
): string {
  const totalRequests = cacheHits + cacheMisses;
  const hitRate = totalRequests > 0
    ? ((cacheHits / totalRequests) * 100).toFixed(1)
    : "0.0";

  return [
    "## Token / Cost Stats",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total tokens | ${totalTokens.toLocaleString()} |`,
    `| Estimated cost | $${totalCostUsd.toFixed(4)} |`,
    `| Cache hits | ${cacheHits} |`,
    `| Cache misses | ${cacheMisses} |`,
    `| Cache hit rate | ${hitRate}% |`,
    "",
  ].join("\n");
}

/**
 * Render token / cost stats from a MultiSuiteResult.
 */
export function renderSuiteTokenCostMarkdown(result: MultiSuiteResult): string {
  const ts = result.tokenStats;
  if (!ts) return "";
  return renderTokenCostMarkdown(
    ts.totalTokens,
    ts.totalCostUsd,
    ts.cacheHits,
    ts.cacheMisses
  );
}

/**
 * Render variance summary as Markdown.
 */
export function renderVarianceSummary(runs: SuiteRunResult[]): string {
  const withVariance = runs.filter(r => r.result.varianceReport);
  if (withVariance.length === 0) return "";

  const lines = [
    "## Variance Report",
    "",
    "| Input | Response | Samples | Mean | Stddev | Min | Max |",
    "|-------|----------|---------|------|--------|-----|-----|",
  ];

  for (const run of withVariance) {
    const vr = run.result.varianceReport;
    if (!vr) continue;
    for (const resp of vr.responses) {
      lines.push(
        `| ${run.inputFile} | ${resp.responseId} | ${resp.samples} | ` +
        `${resp.mean} | ${resp.stddev} | ${resp.min} | ${resp.max} |`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render judge calibration summary as Markdown.
 * Includes per-task correlation, MAE, agreement %, and score delta table.
 */
export function renderCalibrationSummary(runs: SuiteRunResult[]): string {
  const withCalibration = runs.filter(r => r.result.calibrationReport && r.result.calibrationReport.n > 0);
  if (withCalibration.length === 0) return "";

  const lines: string[] = [];

  lines.push("## Judge Calibration Report");
  lines.push("");

  // Summary table per task
  lines.push("| Task | Correlation r | MAE | Agreement % | N | Status |");
  lines.push("|------|----------------|-----|-------------|---|--------|");

  for (const run of withCalibration) {
    const cr = run.result.calibrationReport!;
    const failed = run.calibrationViolations.length > 0;
    const icon = failed ? "❌" : "✅";
    const rStr = Number.isFinite(cr.pearsonR) ? cr.pearsonR.toFixed(4) : "N/A";
    lines.push(
      `| ${run.result.taskId} | ${rStr} | ${cr.mae.toFixed(2)} | ` +
      `${cr.agreementPct.toFixed(1)}% | ${cr.n} | ${icon} |`
    );
  }
  lines.push("");

  // Per-dimension breakdown
  lines.push("### Per-Dimension Calibration");
  lines.push("");
  lines.push("| Task | Dimension | r | MAE | N |");
  lines.push("|------|-----------|---|-----|---|");

  for (const run of withCalibration) {
    const cr = run.result.calibrationReport!;
    for (const [dim, stats] of Object.entries(cr.byDimension)) {
      const rStr = Number.isFinite(stats.pearsonR) ? stats.pearsonR.toFixed(4) : "N/A";
      const maeStr = Number.isFinite(stats.mae) ? stats.mae.toFixed(2) : "N/A";
      lines.push(`| ${run.result.taskId} | ${dim} | ${rStr} | ${maeStr} | ${stats.n} |`);
    }
  }
  lines.push("");

  // Per-task score delta table
  lines.push("### Score Deltas (Judge − Ground Truth)");
  lines.push("");
  lines.push("| Task | Response | Dimension | Judge | GT | Δ |");
  lines.push("|------|----------|-----------|-------|----|---|");

  for (const run of withCalibration) {
    const cr = run.result.calibrationReport!;
    // Sort by abs delta descending, show top 20 per task
    const sorted = [...cr.deltas].sort((a, b) => b.absDelta - a.absDelta).slice(0, 20);
    for (const d of sorted) {
      const deltaStr = d.delta >= 0 ? `+${d.delta.toFixed(1)}` : d.delta.toFixed(1);
      lines.push(
        `| ${d.taskId} | ${d.responseId} | ${d.dimension} | ` +
        `${d.judgeScore} | ${d.groundTruthScore} | ${deltaStr} |`
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Render judge robustness / mutation testing summary as Markdown.
 * Includes detection rate, robustness score, and undetected mutations table.
 */
export function renderRobustnessSummary(runs: SuiteRunResult[]): string {
  const withRobustness = runs.filter(r => r.result.robustnessReport);
  if (withRobustness.length === 0) return "";

  const lines: string[] = [];

  lines.push("## Judge Robustness Report (Mutation Testing)");
  lines.push("");

  // Summary table per task
  lines.push("| Task | Robustness | Detection Rate | Mutations | Detected | Status |");
  lines.push("|------|------------|----------------|-----------|----------|--------|");

  for (const run of withRobustness) {
    const rr = run.result.robustnessReport!;
    const failed = run.robustnessViolations.length > 0;
    const icon = failed ? "❌" : "✅";
    lines.push(
      `| ${run.result.taskId} | ${rr.robustnessScore.toFixed(2)}/10 | ${(rr.detectionRate * 100).toFixed(1)}% | ${rr.totalMutations} | ${rr.detectedMutations} | ${icon} |`
    );
  }
  lines.push("");

  // Per-kind breakdown
  lines.push("### Detection Rate by Mutation Kind");
  lines.push("");
  lines.push("| Task | Kind | Detected | Total | Rate |");
  lines.push("|------|------|----------|-------|------|");

  for (const run of withRobustness) {
    const rr = run.result.robustnessReport!;
    for (const [kind, stats] of Object.entries(rr.byKind)) {
      if (stats.total === 0) continue;
      lines.push(
        `| ${run.result.taskId} | ${kind} | ${stats.detected} | ${stats.total} | ${(stats.detectionRate * 100).toFixed(1)}% |`
      );
    }
  }
  lines.push("");

  // Undetected mutations table
  const allUndetected = withRobustness.flatMap(run =>
    (run.result.robustnessReport?.undetected ?? []).map(u => ({ ...u, taskId: run.result.taskId }))
  );

  if (allUndetected.length > 0) {
    lines.push("### ⚠️ Undetected Mutations");
    lines.push("");
    lines.push("| Task | Mutation | Kind | Original | Mutated | Drop |");
    lines.push("|------|----------|------|----------|---------|------|");

    // Sort by score drop ascending (worst misses first), limit to 30
    const sorted = allUndetected.sort((a, b) => a.scoreDrop - b.scoreDrop).slice(0, 30);
    for (const u of sorted) {
      lines.push(
        `| ${u.taskId} | ${u.mutationId} | ${u.kind} | ${u.originalScore} | ${u.mutatedScore} | ${u.scoreDrop.toFixed(2)} |`
      );
    }
    lines.push("");
    lines.push(`_Showing ${sorted.length} of ${allUndetected.length} undetected mutations_`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build a complete CI Markdown summary including token/cost stats,
 * variance information, and calibration results.
 */
export function buildCiSummaryMarkdown(result: MultiSuiteResult): string {
  const parts: string[] = [];
  const tokenMd = renderSuiteTokenCostMarkdown(result);
  if (tokenMd) parts.push(tokenMd);

  const allRuns = result.aggregates.flatMap(a => a.runs);

  const robustnessMd = renderRobustnessSummary(allRuns);
  if (robustnessMd) parts.push(robustnessMd);

  const calibrationMd = renderCalibrationSummary(allRuns);
  if (calibrationMd) parts.push(calibrationMd);

  const varianceMd = renderVarianceSummary(allRuns);
  if (varianceMd) parts.push(varianceMd);

  return parts.join("\n");
}
