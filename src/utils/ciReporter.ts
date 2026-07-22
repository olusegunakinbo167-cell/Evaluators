/**
 * CI Reporter — GitHub Actions integration for variance and token/cost reporting.
 */

import { SuiteRunResult, VarianceViolation, MultiSuiteResult } from "../components/suiteRunner";

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
 * Build a complete CI Markdown summary including token/cost stats
 * and variance information.
 */
export function buildCiSummaryMarkdown(result: MultiSuiteResult): string {
  const parts: string[] = [];
  const tokenMd = renderSuiteTokenCostMarkdown(result);
  if (tokenMd) parts.push(tokenMd);

  const allRuns = result.aggregates.flatMap(a => a.runs);
  const varianceMd = renderVarianceSummary(allRuns);
  if (varianceMd) parts.push(varianceMd);

  return parts.join("\n");
}
