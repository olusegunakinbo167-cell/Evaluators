// src/utils/exporter.ts

import * as fs from "fs";
import * as path from "path";
import { EvaluationResult } from "../types";

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
