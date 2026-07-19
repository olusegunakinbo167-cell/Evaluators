// src/utils/exporter.ts

import * as fs from "fs";
import * as path from "path";
import { EvaluationResult, EvaluationTelemetry } from "../types";

/**
 * Exports an evaluation result to a JSON file.
 */
export function exportToJSON(result: EvaluationResult, outputDir: string = "./output"): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${result.taskId}-${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(result, null, 2), "utf-8");
  return filepath;
}

/**
 * Exports an evaluation result to a CSV file (one row per ranked response).
 */
export function exportToCSV(result: EvaluationResult, outputDir: string = "./output"): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const headers = [
    "task_id",
    "timestamp",
    "evaluator",
    "prompt",
    "rank",
    "response_id",
    "weighted_score",
    "correctness",
    "efficiency",
    "readability",
    "security",
    "prompt_adherence",
    "security_flags_count",
    "justification",
    "preferred",
    "confidence",
  ];

  const rows = result.rankings.map((r) => [
    result.taskId,
    result.timestamp,
    result.evaluator,
    `"${result.prompt.replace(/"/g, "'")}"`,
    r.rank,
    r.responseId,
    r.weightedScore,
    r.scores.correctness,
    r.scores.efficiency,
    r.scores.readability,
    r.scores.security,
    r.scores.promptAdherence,
    r.securityFlags.length,
    `"${r.justification.replace(/"/g, "'")}"`,
    result.preferred,
    result.confidence,
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

  const filename = `${result.taskId}-${Date.now()}.csv`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, csvContent, "utf-8");
  return filepath;
}

/**
 * Exports an evaluation result to a Markdown report with telemetry breakdown.
 * Ideal for CI logs and pull request summaries.
 */
export function exportToMarkdown(result: EvaluationResult, outputDir: string = "./output"): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const lines: string[] = [];

  lines.push(`# Evaluation Report — ${result.taskId}`);
  lines.push("");
  lines.push(`**Prompt:** ${result.prompt}`);
  lines.push(`**Evaluator:** ${result.evaluator}`);
  lines.push(`**Timestamp:** ${result.timestamp}`);
  lines.push(`**Preferred:** \`${result.preferred}\` | **Confidence:** ${result.confidence}`);
  if (result.notes) {
    lines.push(`**Notes:** ${result.notes}`);
  }
  lines.push("");

  // Rankings table
  lines.push("## Rankings");
  lines.push("");
  lines.push("| Rank | Response | Score | Correctness | Efficiency | Readability | Security | Prompt Adh. | Flags |");
  lines.push("|------|----------|-------|-------------|------------|-------------|----------|-------------|-------|");
  for (const r of result.rankings) {
    lines.push(
      `| ${r.rank} | ${r.responseId} | ${r.weightedScore} | ${r.scores.correctness} | ${r.scores.efficiency} | ${r.scores.readability} | ${r.scores.security} | ${r.scores.promptAdherence} | ${r.securityFlags.length} |`
    );
  }
  lines.push("");

  // Justifications
  lines.push("## Justifications");
  lines.push("");
  for (const r of result.rankings) {
    lines.push(`### ${r.responseId} (rank ${r.rank}, score ${r.weightedScore})`);
    lines.push("");
    lines.push(r.justification);
    lines.push("");
    if (r.securityFlags.length > 0) {
      lines.push("**Security flags:**");
      for (const f of r.securityFlags) {
        lines.push(`- [${f.severity}] ${f.type}: ${f.description}`);
      }
      lines.push("");
    }
  }

  // Telemetry
  if (result.telemetry) {
    const t = result.telemetry;
    const totalRequests = t.cacheHits + t.cacheMisses;
    const hitRate = totalRequests > 0 ? ((t.cacheHits / totalRequests) * 100).toFixed(1) : "0";
    const avgLatency = totalRequests > 0 ? (t.totalLatencyMs / totalRequests).toFixed(0) : "0";

    lines.push("## Execution Telemetry");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Prompt tokens | ${t.totalPromptTokens.toLocaleString()} |`);
    lines.push(`| Completion tokens | ${t.totalCompletionTokens.toLocaleString()} |`);
    lines.push(`| Total tokens | ${t.totalTokens.toLocaleString()} |`);
    lines.push(`| Cache hits | ${t.cacheHits} |`);
    lines.push(`| Cache misses | ${t.cacheMisses} |`);
    lines.push(`| Cache hit rate | ${hitRate}% |`);
    lines.push(`| Total latency | ${t.totalLatencyMs} ms |`);
    lines.push(`| Avg latency / request | ${avgLatency} ms |`);
    lines.push(`| Estimated cost | $${t.estimatedCostUsd.toFixed(6)} |`);
    lines.push(`| Estimated savings (cache) | $${t.estimatedSavingsUsd.toFixed(6)} |`);
    lines.push("");
    lines.push(`> Token pricing: gpt-4o — $2.50 / 1M input, $10.00 / 1M output (override with \`LLM_INPUT_COST_PER_M\` / \`LLM_OUTPUT_COST_PER_M\`)`);
    lines.push("");
  }

  const content = lines.join("\n");
  const filename = `${result.taskId}-${Date.now()}.md`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, content, "utf-8");
  return filepath;
}

/**
 * Generic export dispatcher.
 */
export function exportResult(
  result: EvaluationResult,
  format: "json" | "csv" | "md" | "markdown" = "json",
  outputDir = "./output"
): string {
  switch (format) {
    case "csv": return exportToCSV(result, outputDir);
    case "md":
    case "markdown": return exportToMarkdown(result, outputDir);
    default: return exportToJSON(result, outputDir);
  }
}
