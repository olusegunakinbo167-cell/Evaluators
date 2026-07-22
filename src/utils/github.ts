// src/utils/github.ts
/**
 * GitHub Actions integration: step summaries, PR comments, workflow annotations.
 */

import * as fs from "fs";
import { EvaluationResult } from "../types";
import { ThresholdViolation, RegressionViolation } from "../components/evaluator";

export function isGitHubActions(): boolean {
  const v = (process.env.GITHUB_ACTIONS || "").toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Append markdown to the GitHub Actions step summary.
 * No-op if not running in GitHub Actions or GITHUB_STEP_SUMMARY is unset.
 */
export function appendStepSummary(markdown: string): boolean {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!isGitHubActions() || !summaryPath) return false;
  try {
    fs.appendFileSync(summaryPath, markdown + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ─── Workflow annotations ────────────────────────────────────────────────────

export interface WorkflowAnnotationOptions {
  file?: string;
  line?: number;
  endLine?: number;
  col?: number;
  endColumn?: number;
  title?: string;
}

function escapeWorkflowData(s: string): string {
  return s.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeWorkflowProperty(s: string): string {
  return s
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * Format a GitHub Actions workflow annotation command.
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions#setting-an-error-message
 *
 * @example
 *   formatWorkflowAnnotation("error", "Score dropped", {file:"src/foo.ts",line:1})
 *   // ::error file=src/foo.ts,line=1::Score dropped
 */
export function formatWorkflowAnnotation(
  level: "error" | "warning" | "notice",
  message: string,
  opts: WorkflowAnnotationOptions = {}
): string {
  const props: string[] = [];
  if (opts.file) props.push(`file=${escapeWorkflowProperty(opts.file)}`);
  if (opts.line !== undefined) props.push(`line=${opts.line}`);
  if (opts.endLine !== undefined) props.push(`endLine=${opts.endLine}`);
  if (opts.col !== undefined) props.push(`col=${opts.col}`);
  if (opts.endColumn !== undefined) props.push(`endColumn=${opts.endColumn}`);
  if (opts.title) props.push(`title=${escapeWorkflowProperty(opts.title)}`);

  const propStr = props.length > 0 ? " " + props.join(",") : "";
  return `::${level}${propStr}::${escapeWorkflowData(message)}`;
}

/**
 * Emit workflow annotations for threshold violations.
 * Prints to stdout — GitHub Actions picks these up as inline annotations.
 */
export function emitThresholdAnnotations(
  violations: ThresholdViolation[],
  fileHint = "evaluation.json"
): void {
  for (const v of violations) {
    const msg = `Threshold violation: ${v.responseId} scored ${v.weightedScore} < min ${v.minScore} (delta ${v.delta})`;
    console.log(formatWorkflowAnnotation("error", msg, { file: fileHint, line: 1, title: "Evaluation threshold failed" }));
  }
}

/**
 * Emit workflow annotations for regression violations.
 */
export function emitRegressionAnnotations(
  violations: RegressionViolation[],
  fileHint = "evaluation.json"
): void {
  for (const v of violations) {
    const dim = v.dimension === "weightedScore" ? "weighted_score" : v.dimension;
    const msg = `Regression: ${v.responseId}/${dim} dropped ${v.baseline} → ${v.current} (delta ${v.delta}, allowed ≥ ${-v.allowedRegression})`;
    console.log(formatWorkflowAnnotation("error", msg, { file: fileHint, line: 1, title: "Evaluation regression detected" }));
  }
}

// ─── PR comments ─────────────────────────────────────────────────────────────

const PR_COMMENT_MARKER = "<!-- evaluators-pr-comment -->";

export interface PrCommentOptions {
  token?: string;           // defaults to GITHUB_TOKEN env
  repository?: string;      // "owner/repo", defaults to GITHUB_REPOSITORY env
  prNumber?: number;        // defaults to auto-detect from GITHUB_EVENT_PATH
  /** Update existing comment instead of creating new ones (default true). */
  updateExisting?: boolean;
}

function getPrNumber(): number | undefined {
  // Explicit override
  const envPr = process.env.PR_NUMBER || process.env.PULL_REQUEST_NUMBER;
  if (envPr) {
    const n = parseInt(envPr, 10);
    if (Number.isFinite(n)) return n;
  }

  // GITHUB_EVENT_PATH (standard in Actions)
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
      const pr =
        event?.pull_request?.number ??
        event?.number;
      if (typeof pr === "number") return pr;
    } catch { /* ignore */}
  }

  return undefined;
}

function getRepository(): { owner: string; repo: string } | undefined {
  const repoStr = process.env.GITHUB_REPOSITORY;
  if (!repoStr) return undefined;
  const [owner, repo] = repoStr.split("/");
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

interface GitHubComment {
  id: number;
  body: string;
  user: { type: string; login: string };
}

/**
 * Post (or update) a PR comment with the evaluation summary.
 * Looks for an existing comment containing PR_COMMENT_MARKER and updates it
 * to avoid spamming the thread.
 *
 * @returns comment HTML URL, or null if posting was skipped/failed
 */
export async function postPrComment(
  bodyMarkdown: string,
  opts: PrCommentOptions = {}
): Promise<string | null> {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (!token) return null;

  const repo = opts.repository
    ? (() => { const [owner, repo] = opts.repository!.split("/"); return { owner, repo }; })()
    : getRepository();
  if (!repo) return null;

  const prNumber = opts.prNumber ?? getPrNumber();
  if (!prNumber) return null;

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "ai-code-evaluator",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  const baseUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${prNumber}/comments`;
  const bodyWithMarker = `${PR_COMMENT_MARKER}\n${bodyMarkdown}`;

  try {
    // Find existing evaluator comment
    if (opts.updateExisting !== false) {
      const listRes = await fetch(baseUrl, { headers });
      if (listRes.ok) {
        const comments = (await listRes.json()) as GitHubComment[];
        const existing = comments.find(c => c.body.includes(PR_COMMENT_MARKER));
        if (existing) {
          const patchRes = await fetch(
            `https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/comments/${existing.id}`,
            { method: "PATCH", headers, body: JSON.stringify({ body: bodyWithMarker }) }
          );
          if (patchRes.ok) {
            const updated = await patchRes.json() as { html_url: string };
            return updated.html_url;
          }
        }
      }
    }

    // Create new comment
    const postRes = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: bodyWithMarker }),
    });
    if (!postRes.ok) return null;
    const created = await postRes.json() as { html_url: string };
    return created.html_url;
  } catch {
    return null;
  }
}

/**
 * Build a PR comment body from an evaluation result.
 * Includes status emoji, rankings table, telemetry, and failure callouts.
 */
export function buildPrCommentBody(
  result: EvaluationResult,
  thresholdViolations: ThresholdViolation[] = [],
  regressionViolations: RegressionViolation[] = []
): string {
  const failed = thresholdViolations.length > 0 || regressionViolations.length > 0;
  const statusEmoji = failed ? "❌" : "✅";
  const statusText = failed ? "Evaluation failed" : "Evaluation passed";

  const lines: string[] = [];
  lines.push(`## ${statusEmoji} AI Code Evaluator — ${result.taskId}`);
  lines.push("");
  lines.push(`**Preferred:** \`${result.preferred}\` | **Confidence:** ${result.confidence}`);
  lines.push("");

  if (failed) {
    lines.push(`> **${statusText}**`);
    lines.push("");
  }

  // Threshold failures
  if (thresholdViolations.length > 0) {
    lines.push("<details><summary>❌ Threshold violations</summary>");
    lines.push("");
    for (const v of thresholdViolations) {
      lines.push(`- \`${v.responseId}\`: score ${v.weightedScore} < min ${v.minScore} (delta ${v.delta})`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // Regression failures
  if (regressionViolations.length > 0) {
    lines.push("<details><summary>❌ Regression violations</summary>");
    lines.push("");
    for (const v of regressionViolations) {
      const dim = v.dimension === "weightedScore" ? "weighted_score" : v.dimension;
      lines.push(`- \`${v.responseId} / ${dim}\`: ${v.current} < ${v.baseline} (delta ${v.delta}, allowed ≥ ${-v.allowedRegression})`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // Rankings table
  lines.push("| Rank | Response | Score | Correctness | Efficiency | Readability | Security | Prompt |");
  lines.push("|------|----------|-------|-------------|------------|-------------|----------|--------|");
  for (const r of result.rankings) {
    lines.push(
      `| ${r.rank} | ${r.responseId} | ${r.weightedScore} | ${r.scores.correctness} | ${r.scores.efficiency} | ${r.scores.readability} | ${r.scores.security} | ${r.scores.promptAdherence} |`
    );
  }
  lines.push("");

  // Telemetry (compact)
  if (result.telemetry) {
    const t = result.telemetry;
    const totalReqs = t.cacheHits + t.cacheMisses;
    const hitRate = totalReqs > 0 ? ((t.cacheHits / totalReqs) * 100).toFixed(0) : "0";
    lines.push(
      `<sub>Tokens: ${t.totalTokens.toLocaleString()} | ` +
      `Cache: ${t.cacheHits}/${totalReqs} (${hitRate}%) | ` +
      `Latency: ${t.totalLatencyMs}ms | ` +
      `Cost: $${t.estimatedCostUsd.toFixed(4)}` +
      (t.estimatedSavingsUsd > 0 ? ` | Saved: $${t.estimatedSavingsUsd.toFixed(4)}` : "") +
      `</sub>`
    );
    lines.push("");
  }

  lines.push(`<sub>Generated at ${result.timestamp} — <a href="https://github.com/olusegunakinbo167-cell/Evaluators">ai-code-evaluator</a></sub>`);
  return lines.join("\n");
}
// Append to src/utils/github.ts after buildPrCommentBody

/**
 * Build a PR comment body from a MultiSuiteResult.
 * Includes variance, calibration, cost, and robustness summaries with
 * pass/fail badges and collapsible details for undetected mutations.
 */
export function buildMultiSuitePrCommentBody(
  result: import("../components/suiteRunner").MultiSuiteResult,
  options: {
    markdown?: string;
    includeMutations?: boolean;
  } = {}
): string {
  const { totalPassed, totalFailed, totalRuns } = result;
  const failed = totalFailed > 0;
  const statusEmoji = failed ? "❌" : "✅";

  const lines: string[] = [];
  lines.push(`## ${statusEmoji} AI Code Evaluator — ${totalPassed}/${totalRuns} passed`);
  lines.push("");

  const badges: string[] = [];
  badges.push(failed ? "❌ **FAILED**" : "✅ **PASSED**");

  if (result.tokenStats) {
    const ts = result.tokenStats;
    badges.push(`💰 $${ts.totalCostUsd.toFixed(4)}`);
    badges.push(`🔤 ${ts.totalTokens.toLocaleString()} tokens`);
    if (ts.cacheHits + ts.cacheMisses > 0) {
      const hitRate = ((ts.cacheHits / (ts.cacheHits + ts.cacheMisses)) * 100).toFixed(0);
      badges.push(`⚡ ${hitRate}% cache`);
    }
  }

  const allRuns = result.aggregates.flatMap(a => a.runs);
  const varianceRuns = allRuns.filter(r => r.result.varianceReport);
  if (varianceRuns.length > 0) {
    const maxStddev = Math.max(...varianceRuns.map(r => r.result.varianceReport!.maxStddev));
    const meanStddev = varianceRuns.reduce((s, r) => s + r.result.varianceReport!.meanStddev, 0) / varianceRuns.length;
    const varIcon = maxStddev > 1.0 ? "⚠️" : "📊";
    badges.push(`${varIcon} σ max=${maxStddev.toFixed(3)} mean=${meanStddev.toFixed(3)}`);
  }

  const calRuns = allRuns.filter(r => r.result.calibrationReport && r.result.calibrationReport.n > 0);
  if (calRuns.length > 0) {
    const correlations = calRuns.map(r => r.result.calibrationReport!.pearsonR).filter(Number.isFinite);
    const meanR = correlations.length > 0 ? correlations.reduce((a, b) => a + b, 0) / correlations.length : NaN;
    const minR = correlations.length > 0 ? Math.min(...correlations) : NaN;
    const calIcon = Number.isFinite(minR) && minR >= 0.75 ? "🎯" : "⚠️";
    const rStr = Number.isFinite(meanR) ? meanR.toFixed(3) : "N/A";
    badges.push(`${calIcon} r=${rStr}`);
  }

  const robRuns = allRuns.filter(r => r.result.robustnessReport);
  if (robRuns.length > 0) {
    const scores = robRuns.map(r => r.result.robustnessReport!.robustnessScore);
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const minScore = Math.min(...scores);
    const detectionRates = robRuns.map(r => r.result.robustnessReport!.detectionRate);
    const meanDetection = detectionRates.reduce((a, b) => a + b, 0) / detectionRates.length;
    const robIcon = minScore >= 6.0 ? "🛡️" : "⚠️";
    badges.push(`${robIcon} robustness ${meanScore.toFixed(1)}/10 (${(meanDetection * 100).toFixed(0)}% detected)`);
  }

  lines.push(badges.join(" · "));
  lines.push("");

  lines.push("| Suite | Passed | Failed | Total | Status |");
  lines.push("|-------|--------|--------|-------|--------|");
  for (const agg of result.aggregates) {
    const icon = agg.failed > 0 ? "❌" : "✅";
    lines.push(`| ${agg.suiteName} | ${agg.passed} | ${agg.failed} | ${agg.total} | ${icon} |`);
  }
  lines.push("");

  if (calRuns.length > 0) {
    lines.push("<details><summary>🎯 Judge Calibration</summary>");
    lines.push("");
    lines.push("| Task | Correlation r | MAE | Agreement | N | Status |");
    lines.push("|------|----------------|-----|-----------|---|--------|");
    for (const run of calRuns) {
      const cr = run.result.calibrationReport!;
      const failed = run.calibrationViolations.length > 0;
      const icon = failed ? "❌" : "✅";
      const rStr = Number.isFinite(cr.pearsonR) ? cr.pearsonR.toFixed(3) : "N/A";
      lines.push(`| ${run.result.taskId} | ${rStr} | ${cr.mae.toFixed(2)} | ${cr.agreementPct.toFixed(1)}% | ${cr.n} | ${icon} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (robRuns.length > 0) {
    lines.push("<details><summary>🛡️ Judge Robustness (Mutation Testing)</summary>");
    lines.push("");
    lines.push("| Task | Score | Detection | Mutations | Status |");
    lines.push("|------|-------|-----------|-----------|--------|");
    for (const run of robRuns) {
      const rr = run.result.robustnessReport!;
      const failed = run.robustnessViolations.length > 0;
      const icon = failed ? "❌" : "✅";
      lines.push(
        `| ${run.result.taskId} | ${rr.robustnessScore.toFixed(1)}/10 | ${(rr.detectionRate * 100).toFixed(0)}% | ${rr.detectedMutations}/${rr.totalMutations} | ${icon} |`
      );
    }
    lines.push("");

    const allUndetected = robRuns.flatMap(run =>
      (run.result.robustnessReport?.undetected ?? []).map(u => ({ ...u, taskId: run.result.taskId }))
    );

    if (allUndetected.length > 0 && options.includeMutations !== false) {
      lines.push("<details><summary>⚠️ Undetected Mutations (click to expand)</summary>");
      lines.push("");
      lines.push("| Task | Mutation | Kind | Orig | Mut | Drop |");
      lines.push("|------|----------|------|------|-----|------|");
      const sorted = allUndetected.sort((a, b) => a.scoreDrop - b.scoreDrop).slice(0, 20);
      for (const u of sorted) {
        lines.push(
          `| ${u.taskId} | ${u.mutationId} | ${u.kind} | ${u.originalScore} | ${u.mutatedScore} | ${u.scoreDrop.toFixed(2)} |`
        );
      }
      if (allUndetected.length > sorted.length) {
        lines.push("");
        lines.push(`_…and ${allUndetected.length - sorted.length} more — see full CI report_`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }

    lines.push("</details>");
    lines.push("");
  }

  if (varianceRuns.length > 0) {
    lines.push("<details><summary>📊 Variance Report</summary>");
    lines.push("");
    lines.push("| Task | Response | Samples | Mean | σ | Min | Max |");
    lines.push("|------|----------|---------|------|---|-----|-----|");
    for (const run of varianceRuns) {
      const vr = run.result.varianceReport!;
      for (const resp of vr.responses.slice(0, 10)) {
        lines.push(
          `| ${run.result.taskId} | ${resp.responseId} | ${resp.samples} | ${resp.mean} | ${resp.stddev} | ${resp.min} | ${resp.max} |`
        );
      }
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (result.tokenStats) {
    const ts = result.tokenStats;
    const totalReqs = ts.cacheHits + ts.cacheMisses;
    const hitRate = totalReqs > 0 ? ((ts.cacheHits / totalReqs) * 100).toFixed(0) : "0";
    lines.push(
      `<sub>💰 Cost: $${ts.totalCostUsd.toFixed(4)} · 🔤 Tokens: ${ts.totalTokens.toLocaleString()} · ⚡ Cache: ${ts.cacheHits}/${totalReqs} (${hitRate}%)</sub>`
    );
    lines.push("");
  }

  lines.push(`<sub>Generated by <a href="https://github.com/olusegunakinbo167-cell/Evaluators">ai-code-evaluator</a> — ${new Date().toISOString()}</sub>`);
  return lines.join("\n");
}
