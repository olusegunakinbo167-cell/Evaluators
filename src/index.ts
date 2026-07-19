// src/index.ts

import * as fs from "fs";
import * as path from "path";
import app from "./api/server";
import {
  evaluate,
  evaluateAuto,
  checkMinScore,
  checkRegression,
  loadBaseline,
  formatThresholdFailures,
  formatRegressionFailures,
  type ThresholdViolation,
  type RegressionViolation,
} from "./components/evaluator";
import { exportResult, exportToJSON, exportToCSV, exportToMarkdown, writeGitHubStepSummary } from "./utils/exporter";
import {
  isGitHubActions,
  emitThresholdAnnotations,
  emitRegressionAnnotations,
  postPrComment,
  buildPrCommentBody,
  appendStepSummary,
} from "./utils/github";
import { loadEvaluatorConfig, applyCliOverrides } from "./utils/config";
import { runSuites, buildAggregatedMarkdown, type MultiSuiteResult } from "./components/suiteRunner";
import { EvaluationInput, Confidence, EvaluationResult } from "./types";
import { MockJudgeProvider } from "./components/llm/mockProvider";
import { getCacheStats } from "./components/llm/judge";

const PORT = process.env.PORT || 3000;
const AUTO_JUDGE = (process.env.AUTO_JUDGE ?? "true").toLowerCase() !== "false";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function getArgFloat(args: string[], flag: string): number | undefined {
  const v = getArg(args, flag);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ─── Demo: run a sample evaluation on startup ────────────────────────────────

const sampleInputManual: EvaluationInput = {
  taskId: "VOX-DEMO-001",
  prompt: "Write a Node.js function to fetch a user by ID from PostgreSQL",
  evaluator: "IT Expert",
  confidence: Confidence.HIGH,
  notes: "Response A uses parameterized query; Response B uses string interpolation.",
  responses: [
    {
      id: "A",
      language: "javascript",
      code: `
async function getUserById(id) {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.error('DB error:', err);
    throw err;
  }
}
      `.trim(),
    },
    {
      id: "B",
      language: "javascript",
      code: `
async function getUserById(id) {
  const result = await pool.query(
    \`SELECT * FROM users WHERE id = \${id}\`
  );
  return result.rows[0];
}
      `.trim(),
    },
  ],
  manualScores: {
    A: {
      correctness: 9,
      efficiency: 8,
      readability: 9,
      security: 9,
      promptAdherence: 10,
    },
    B: {
      correctness: 7,
      efficiency: 7,
      readability: 6,
      security: 3,
      promptAdherence: 8,
    },
  },
  justifications: {
    A: "Uses parameterized queries (prevents SQL injection), proper error handling with try/catch, returns null when user not found.",
    B: "Uses string interpolation in SQL query — critical SQL injection vulnerability. No error handling. Undefined return on missing user.",
  },
};

async function runDemo() {
  console.log("\n=== AI Code Evaluator — Demo Result ===\n");

  const cacheStats = getCacheStats();
  if (!cacheStats.disabled && cacheStats.entries > 0) {
    console.log(`📦 Cache: ${cacheStats.entries} entries at ${cacheStats.path}\n`);
  }

  let result;
  if (AUTO_JUDGE && !process.env.OPENAI_API_KEY) {
    console.log("ℹ️  OPENAI_API_KEY not set — running demo with MockJudgeProvider\n");
    const { responses, taskId, prompt, evaluator, notes } = sampleInputManual;
    const mockProvider = new MockJudgeProvider({
      A: { correctness: 9, efficiency: 8, readability: 9, security: 9, promptAdherence: 10 },
      B: { correctness: 7, efficiency: 7, readability: 6, security: 3, promptAdherence: 8 },
    });
    result = await evaluateAuto(
      { taskId, prompt, evaluator, responses, notes, autoJudge: true },
      mockProvider
    );
  } else if (AUTO_JUDGE) {
    console.log("🤖 LLM-as-a-Judge: auto-scoring enabled (OpenAI)\n");
    const { responses, taskId, prompt, evaluator, notes } = sampleInputManual;
    result = await evaluateAuto(
      { taskId, prompt, evaluator, responses, notes, autoJudge: true }
    );
  } else {
    result = evaluate(sampleInputManual);
  }

  console.log(JSON.stringify(result, null, 2));

  if (result.telemetry) {
    const t = result.telemetry;
    console.log("\n--- Telemetry ---");
    console.log(`Tokens: ${t.totalPromptTokens} prompt + ${t.totalCompletionTokens} completion = ${t.totalTokens} total`);
    console.log(`Cache: ${t.cacheHits} hits / ${t.cacheMisses} misses`);
    console.log(`Latency: ${t.totalLatencyMs}ms  |  Cost: $${t.estimatedCostUsd.toFixed(6)}  |  Savings: $${t.estimatedSavingsUsd.toFixed(6)}`);
  }

  const jsonPath = exportToJSON(result, "./output");
  const csvPath = exportToCSV(result, "./output");
  const mdPath = exportToMarkdown(result, "./output");
  console.log(`\n✅ Exported JSON:     ${jsonPath}`);
  console.log(`✅ Exported CSV:     ${csvPath}`);
  console.log(`✅ Exported Markdown: ${mdPath}`);
}

// ─── Single-file CLI mode ────────────────────────────────────────────────────

async function runSingleEval(
  inputPath: string,
  args: string[]
): Promise<{ result: EvaluationResult; failed: boolean; thresholdViolations: ThresholdViolation[]; regressionViolations: RegressionViolation[] }> {
  const raw = fs.readFileSync(inputPath, "utf-8");
  const input: EvaluationInput = JSON.parse(raw);

  const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
  const result = hasScores ? evaluate(input) : await evaluateAuto(input);

  console.log(JSON.stringify(result, null, 2));

  if (result.telemetry) {
    const t = result.telemetry;
    console.error(
      `\n# Telemetry: tokens=${t.totalTokens} cache=${t.cacheHits}/${t.cacheHits + t.cacheMisses} ` +
      `latency=${t.totalLatencyMs}ms cost=$${t.estimatedCostUsd.toFixed(6)} savings=$${t.estimatedSavingsUsd.toFixed(6)}`
    );
  }

  let failed = false;
  let thresholdViolations: ThresholdViolation[] = [];
  let regressionViolations: RegressionViolation[] = [];

  const minScore = getArgFloat(args, "--min-score");
  if (minScore !== undefined) {
    thresholdViolations = checkMinScore(result, minScore);
    if (thresholdViolations.length > 0) {
      console.error(formatThresholdFailures(thresholdViolations));
      failed = true;
      if (isGitHubActions()) {
        emitThresholdAnnotations(thresholdViolations, inputPath);
      }
    }
  }

  const baselinePath = getArg(args, "--baseline");
  if (baselinePath) {
    const maxRegression = getArgFloat(args, "--max-regression") ?? 0;
    try {
      const baseline = loadBaseline(baselinePath);
      regressionViolations = checkRegression(result, baseline, maxRegression);
      if (regressionViolations.length > 0) {
        console.error(formatRegressionFailures(regressionViolations));
        failed = true;
        if (isGitHubActions()) {
          emitRegressionAnnotations(regressionViolations, inputPath);
        }
      }
    } catch (err: any) {
      console.error(`\n❌ Failed to load baseline from ${baselinePath}: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  }

  return { result, failed, thresholdViolations, regressionViolations };
}

// ─── Config / multi-suite CLI mode ───────────────────────────────────────────

async function runConfigMode(args: string[]): Promise<boolean> {
  const configPath = getArg(args, "--config");
  let config;
  try {
    config = loadEvaluatorConfig(configPath);
  } catch (err: any) {
    console.error(`\n❌ Config load failed: ${err?.message ?? err}\n`);
    process.exit(1);
  }

  console.error(`\n🔧 Loaded config with ${config.suites.length} suite(s)\n`);

  // CLI overrides apply to all suites
  const cliOverrides = {
    minScore: getArgFloat(args, "--min-score"),
    maxRegression: getArgFloat(args, "--max-regression"),
    baseline: getArg(args, "--baseline"),
  };

  // Apply CLI overrides to each suite
  const suites = config.suites.map(s => applyCliOverrides(s, cliOverrides));

  const multiResult = await runSuites(suites, {
    minScore: cliOverrides.minScore,
    maxRegression: cliOverrides.maxRegression,
    baseline: cliOverrides.baseline,
    failFast: config.failFast,
  }, config.maxConcurrency);

  // Print summary
  console.log(`\n=== Suite Results: ${multiResult.totalPassed}/${multiResult.totalRuns} passed ===\n`);
  for (const agg of multiResult.aggregates) {
    const icon = agg.failed > 0 ? "❌" : "✅";
    console.log(`  ${icon} ${agg.suiteName}: ${agg.passed}/${agg.total} passed`);
  }
  console.log("");

  // Build unified Markdown report
  const aggregatedMarkdown = buildAggregatedMarkdown(multiResult);

  // Export unified report
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  const reportPath = path.join(config.outputDir, `suite-report-${Date.now()}.md`);
  fs.writeFileSync(reportPath, aggregatedMarkdown, "utf-8");
  console.log(`✅ Aggregated report: ${reportPath}\n`);

  // GitHub Actions step summary
  if (isGitHubActions()) {
    const wrote = appendStepSummary(aggregatedMarkdown);
    if (wrote) console.error("📝 Wrote aggregated summary to $GITHUB_STEP_SUMMARY");
  }

  // PR comment — aggregate across all suites
  if (hasFlag(args, "--gh-pr-comment")) {
    // Build a combined PR comment from all failed runs, or a success summary
    const failedRuns = multiResult.aggregates.flatMap(a => a.runs.filter(r => r.failed));
    let prBody = `## ${multiResult.failed ? "❌" : "✅"} Evaluation Suites — ${multiResult.totalPassed}/${multiResult.totalRuns} passed\n\n`;
    prBody += "| Suite | Passed | Failed | Total |\n|-------|--------|--------|-------|\n";
    for (const agg of multiResult.aggregates) {
      prBody += `| ${agg.suiteName} | ${agg.passed} | ${agg.failed} | ${agg.total} |\n`;
    }
    prBody += "\n" + aggregatedMarkdown.split("\n").slice(0, 80).join("\n");
    if (aggregatedMarkdown.length > 4000) prBody += "\n\n_…full report truncated, see CI artifacts_";

    try {
      const url = await postPrComment(prBody);
      if (url) console.error(`\n💬 Posted PR comment: ${url}`);
      else console.error("\n⚠️  --gh-pr-comment set but could not post (missing GITHUB_TOKEN / PR context?)");
    } catch (err: any) {
      console.error(`\n⚠️  PR comment failed: ${err?.message ?? err}`);
    }
  }

  // Export individual suite results if requested
  const exportFormat = getArg(args, "--export") as "json" | "csv" | "md" | "markdown" | undefined;
  if (exportFormat && exportFormat !== "md" && exportFormat !== "markdown") {
    // Markdown aggregate already written; for json/csv export each run individually
    console.error("⚠️  --export json/csv in config mode exports the aggregated markdown report only. Individual run exports are not yet supported.");
  }

  return multiResult.failed;
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

async function runCli() {
  const args = process.argv.slice(2);

  // Config mode: --config <path>  (also auto-detect evaluators.config.json)
  const hasConfigFlag = hasFlag(args, "--config");
  const hasEvalFlag = hasFlag(args, "--eval");
  const configExists = fs.existsSync("evaluators.config.json") || fs.existsSync(".evaluators.json");

  if (hasConfigFlag || (!hasEvalFlag && configExists)) {
    const failed = await runConfigMode(args);
    if (failed) process.exit(1);
    return true;
  }

  // Single-file mode: --eval <input.json>
  const evalIdx = args.indexOf("--eval");
  if (evalIdx === -1) return false;

  const inputPath = args[evalIdx + 1];
  if (!inputPath) {
    console.error(
      "Usage:\n" +
      "  node dist/index.js --eval <input.json> [--export json|csv|md] [--min-score <float>] [--baseline <path> --max-regression <float>] [--gh-pr-comment]\n" +
      "  node dist/index.js --config <evaluators.config.json> [--export md] [--min-score <float>] [--max-regression <float>] [--gh-pr-comment]"
    );
    process.exit(1);
  }

  const { result, failed, thresholdViolations, regressionViolations } = await runSingleEval(inputPath, args);

  // GitHub Actions step summary
  if (isGitHubActions()) {
    const wrote = writeGitHubStepSummary(result, {
      thresholdViolations,
      regressionViolations,
      includeJustifications: false,
    });
    if (wrote) console.error("\n📝 Wrote evaluation summary to $GITHUB_STEP_SUMMARY");
  }

  // PR comment
  if (hasFlag(args, "--gh-pr-comment")) {
    try {
      const url = await postPrComment(
        buildPrCommentBody(result, thresholdViolations, regressionViolations)
      );
      if (url) console.error(`\n💬 Posted PR comment: ${url}`);
      else console.error("\n⚠️  --gh-pr-comment set but could not post (missing GITHUB_TOKEN / PR context?)");
    } catch (err: any) {
      console.error(`\n⚠️  PR comment failed: ${err?.message ?? err}`);
    }
  }

  // Export
  const exportFormat = getArg(args, "--export") as "json" | "csv" | "md" | "markdown" | undefined;
  if (exportFormat) {
    const filepath = exportResult(result, exportFormat, "./output", {
      thresholdViolations,
      regressionViolations,
    });
    console.log(`\n✅ Exported: ${filepath}`);
  }

  if (failed) process.exit(1);
  return true;
}

// ─── Entry ──────────────────────────────────────────────────────────────────

(async () => {
  const ranCli = await runCli();
  if (ranCli) process.exit(0);

  await runDemo();

  // ─── Start API server ───────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`\n🚀 API server running at http://localhost:${PORT}`);
    console.log(`   POST /evaluate       — submit an evaluation (auto-judge if manualScores omitted)`);
    console.log(`   POST /evaluate/export — evaluate + export to file (format=json|csv|md)`);
    console.log(`   GET  /health         — health check`);
  });
})();
