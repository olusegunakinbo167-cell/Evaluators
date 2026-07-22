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
import { checkVariance, type VarianceViolation, type CalibrationViolation } from "./components/suiteRunner";
import { exportResult, exportToJSON, exportToCSV, exportToMarkdown, writeGitHubStepSummary } from "./utils/exporter";
import {
  isGitHubActions,
  emitThresholdAnnotations,
  emitRegressionAnnotations,
  postPrComment,
  buildPrCommentBody,
  buildMultiSuitePrCommentBody,
  appendStepSummary,
} from "./utils/github";
import { loadEvaluatorConfig, applyCliOverrides } from "./utils/config";
import { runSuites, buildAggregatedMarkdown, type MultiSuiteResult } from "./components/suiteRunner";
import { EvaluationInput, Confidence, EvaluationResult, LlmEndpointConfig, MutationKind } from "./types";
import { emitVarianceAnnotations, emitVarianceAnnotationsForResult, emitCalibrationAnnotations, buildCiSummaryMarkdown } from "./utils/ciReporter";
import {
  calibrateJudge,
  loadGroundTruth,
  checkQualityGate,
  emitQualityGateAnnotations,
  formatQualityGateFailures,
} from "./utils/qualityGate";
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

function getArgInt(args: string[], flag: string): number | undefined {
  const v = getArg(args, flag);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getPrCommentOptions(args: string[]): { prNumber?: number; token?: string } {
  const prArg = getArg(args, "--github-pr");
  const tokenArg = getArg(args, "--github-token");
  const out: { prNumber?: number; token?: string } = {};
  if (prArg) {
    const n = parseInt(prArg, 10);
    if (Number.isFinite(n)) out.prNumber = n;
  }
  if (tokenArg) out.token = tokenArg;
  return out;
}

function parseLlmCliArgs(args: string[]): LlmEndpointConfig | undefined {
  const llm: LlmEndpointConfig = {};
  let hasAny = false;

  const baseURL = getArg(args, "--llm-base-url");
  if (baseURL) { llm.baseURL = baseURL; hasAny = true; }

  const model = getArg(args, "--llm-model");
  if (model) { llm.model = model; hasAny = true; }

  const apiKeyEnv = getArg(args, "--llm-api-key-env");
  if (apiKeyEnv) { llm.apiKeyEnv = apiKeyEnv; hasAny = true; }

  const apiKey = getArg(args, "--llm-api-key");
  if (apiKey) { llm.apiKey = apiKey; hasAny = true; }

  const timeout = getArgFloat(args, "--llm-timeout");
  if (timeout !== undefined) { llm.timeoutMs = Math.floor(timeout); hasAny = true; }

  const temp = getArgFloat(args, "--llm-temperature");
  if (temp !== undefined) { llm.temperature = temp; hasAny = true; }

  const retries = getArgInt(args, "--llm-retries");
  if (retries !== undefined) { llm.maxRetries = retries; hasAny = true; }

  // Parse --llm-header "Key: Value" (repeatable)
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--llm-header" && i + 1 < args.length) {
      const h = args[i + 1];
      const colonIdx = h.indexOf(":");
      if (colonIdx > 0) {
        const key = h.slice(0, colonIdx).trim();
        const value = h.slice(colonIdx + 1).trim();
        if (key) headers[key] = value;
      }
    }
  }
  if (Object.keys(headers).length > 0) {
    llm.headers = headers;
    hasAny = true;
  }

  return hasAny ? llm : undefined;
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
): Promise<{ result: EvaluationResult; failed: boolean; thresholdViolations: ThresholdViolation[]; regressionViolations: RegressionViolation[]; varianceViolations: VarianceViolation[]; calibrationViolations: CalibrationViolation[]; robustnessViolations: import("./components/suiteRunner").RobustnessViolation[] }> {
  const raw = fs.readFileSync(inputPath, "utf-8");
  const input: EvaluationInput = JSON.parse(raw);

  const samples = Math.max(1, getArgInt(args, "--samples") ?? 1);
  const maxVariance = getArgFloat(args, "--max-variance");
  const llmConfig = parseLlmCliArgs(args);
  const groundTruthPath = getArg(args, "--ground-truth");
  const minCorrelation = getArgFloat(args, "--min-correlation") ?? 0.75;
  const mutateCount = getArgInt(args, "--mutate") ?? 0;
  const minRobustness = getArgFloat(args, "--min-robustness") ?? 6.0;
  // Parse --mutate-kinds "security,syntax,logic" (comma-separated)
  const mutateKindsArg = getArg(args, "--mutate-kinds");
  const mutateKinds = mutateKindsArg
    ? mutateKindsArg.split(",").map(s => s.trim()).filter(Boolean) as MutationKind[]
    : undefined;

  const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;

  let result: EvaluationResult;
  if (samples > 1 && !hasScores) {
    // Multi-pass variance sampling
    const { computeVarianceStats } = await import("./components/suiteRunner.js");
    const allResults: EvaluationResult[] = [];
    for (let i = 0; i < samples; i++) {
      const r = await evaluateAuto(input, undefined, llmConfig, { disableCache: true, mutate: mutateCount || undefined, mutateKinds });
      allResults.push(r);
    }
    const varianceReport = computeVarianceStats(allResults);
    const baseResult = allResults[0];
    const meanScores = new Map(varianceReport.responses.map(v => [v.responseId, v.mean] as const));
    const averagedRankings = baseResult.rankings.map(rr => ({
      ...rr,
      weightedScore: meanScores.get(rr.responseId) ?? rr.weightedScore,
    })).sort((a, b) => b.weightedScore - a.weightedScore)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    let totalPromptTokens = 0, totalCompletionTokens = 0, totalTokens = 0;
    let cacheHits = 0, cacheMisses = 0, totalLatencyMs = 0;
    let estimatedCostUsd = 0, estimatedSavingsUsd = 0;
    for (const r of allResults) {
      const t = r.telemetry;
      if (!t) continue;
      totalPromptTokens += t.totalPromptTokens;
      totalCompletionTokens += t.totalCompletionTokens;
      totalTokens += t.totalTokens;
      cacheHits += t.cacheHits;
      cacheMisses += t.cacheMisses;
      totalLatencyMs += t.totalLatencyMs;
      estimatedCostUsd += t.estimatedCostUsd;
      estimatedSavingsUsd += t.estimatedSavingsUsd;
    }
    result = {
      ...baseResult,
      rankings: averagedRankings,
      preferred: averagedRankings[0]?.responseId ?? baseResult.preferred,
      telemetry: {
        totalPromptTokens, totalCompletionTokens, totalTokens,
        cacheHits, cacheMisses, totalLatencyMs,
        estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
        estimatedSavingsUsd: Math.round(estimatedSavingsUsd * 1_000_000) / 1_000_000,
      },
      varianceReport,
    };
  } else {
    result = hasScores ? evaluate(input) : await evaluateAuto(input, undefined, llmConfig, { mutate: mutateCount || undefined, mutateKinds });
  }

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
  let varianceViolations: VarianceViolation[] = [];
  let calibrationViolations: CalibrationViolation[] = [];
  let robustnessViolations: import("./components/suiteRunner").RobustnessViolation[] = [];

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Failed to load baseline from ${baselinePath}: ${msg}\n`);
      process.exit(1);
    }
  }

  // Variance check
  if (maxVariance !== undefined && result.varianceReport) {
    varianceViolations = checkVariance(result.varianceReport, maxVariance);
    if (varianceViolations.length > 0) {
      failed = true;
      console.error("\n❌ VARIANCE CHECK FAILED\n");
      for (const v of varianceViolations) {
        console.error(`  ${v.responseId}: stddev=${v.stddev} > max=${v.maxAllowed}`);
      }
      console.error("");
      if (isGitHubActions()) {
        emitVarianceAnnotations(varianceViolations, inputPath);
      }
    }
  }

  // Calibration / ground-truth check
  if (groundTruthPath) {
    try {
      const gt = loadGroundTruth(groundTruthPath);
      const calibrationReport = calibrateJudge(result, gt);
      result.calibrationReport = calibrationReport;

      const gateResult = checkQualityGate(calibrationReport, minCorrelation);
      if (!gateResult.passed) {
        failed = true;
        console.error(formatQualityGateFailures(gateResult));
        if (isGitHubActions()) {
          emitQualityGateAnnotations(gateResult, result.taskId);
        }
        // Populate calibrationViolations for return value
        calibrationViolations.push({
          taskId: result.taskId,
          correlation: gateResult.correlation,
          minCorrelation: gateResult.minCorrelation,
          mae: calibrationReport.mae,
        });
      } else if (calibrationReport.n > 0) {
        console.log(
          `\n📊 Calibration: r=${calibrationReport.pearsonR.toFixed(4)}, ` +
          `MAE=${calibrationReport.mae.toFixed(2)}, ` +
          `agreement=${calibrationReport.agreementPct.toFixed(1)}% (n=${calibrationReport.n})\n`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n⚠️  Ground-truth load failed: ${msg}\n`);
    }
  }


  // Robustness / mutation check
  if (result.robustnessReport) {
    if (result.robustnessReport.robustnessScore < minRobustness) {
      failed = true;
      console.error("\n❌ ROBUSTNESS CHECK FAILED\n");
      console.error(`  Robustness score ${result.robustnessReport.robustnessScore}/10 < min ${minRobustness}`);
      console.error(`  Detection rate: ${(result.robustnessReport.detectionRate * 100).toFixed(1)}%`);
      console.error("");
      robustnessViolations.push({
        taskId: result.taskId,
        robustnessScore: result.robustnessReport.robustnessScore,
        minRobustness,
        detectionRate: result.robustnessReport.detectionRate,
      });
      if (isGitHubActions()) {
        const { emitRobustnessAnnotations } = await import("./utils/ciReporter.js");
        emitRobustnessAnnotations(robustnessViolations, inputPath);
      }
    } else {
      console.log(
        `\n🛡️  Robustness: score=${result.robustnessReport.robustnessScore}/10, ` +
        `detection=${(result.robustnessReport.detectionRate * 100).toFixed(1)}% ` +
        `(${result.robustnessReport.detectedMutations}/${result.robustnessReport.totalMutations})\n`
      );
    }
  }

  return { result, failed, thresholdViolations, regressionViolations, varianceViolations, calibrationViolations, robustnessViolations };
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
  const mutateKindsArg = getArg(args, "--mutate-kinds");
  const mutateKinds = mutateKindsArg
    ? mutateKindsArg.split(",").map(s => s.trim()).filter(Boolean) as MutationKind[]
    : undefined;

  // CLI overrides apply to all suites
  const cliOverrides = {
    minScore: getArgFloat(args, "--min-score"),
    maxRegression: getArgFloat(args, "--max-regression"),
    baseline: getArg(args, "--baseline"),
    samples: getArgInt(args, "--samples"),
    maxVariance: getArgFloat(args, "--max-variance"),
    llm: parseLlmCliArgs(args),
    groundTruth: getArg(args, "--ground-truth"),
    minCorrelation: getArgFloat(args, "--min-correlation"),
    mutate: getArgInt(args, "--mutate"),
    minRobustness: getArgFloat(args, "--min-robustness"),
    mutateKinds,
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
  const ciExtraMarkdown = buildCiSummaryMarkdown(multiResult);
  const fullMarkdown = ciExtraMarkdown ? aggregatedMarkdown + "\n\n" + ciExtraMarkdown : aggregatedMarkdown;

  // Emit variance + calibration + robustness annotations in CI
  if (isGitHubActions()) {
    emitVarianceAnnotationsForResult(multiResult);
    const { emitCalibrationAnnotationsForResult, emitRobustnessAnnotationsForResult } = await import("./utils/ciReporter.js");
    emitCalibrationAnnotationsForResult(multiResult);
    emitRobustnessAnnotationsForResult(multiResult);
  }

  // Export unified report
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  const reportPath = path.join(config.outputDir, `suite-report-${Date.now()}.md`);
  fs.writeFileSync(reportPath, fullMarkdown, "utf-8");
  console.log(`✅ Aggregated report: ${reportPath}\n`);

  // GitHub Actions step summary
  if (isGitHubActions()) {
    const wrote = appendStepSummary(fullMarkdown);
    if (wrote) console.error("📝 Wrote aggregated summary to $GITHUB_STEP_SUMMARY");
  }

  // PR comment — aggregate across all suites
  if (hasFlag(args, "--gh-pr-comment")) {
    const prOpts = getPrCommentOptions(args);
    const prBody = buildMultiSuitePrCommentBody(multiResult, { includeMutations: true });

    try {
      const url = await postPrComment(prBody, prOpts);
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
      "  node dist/index.js --eval <input.json> [--export json|csv|md]\n" +
      "    [--min-score <float>] [--baseline <path> --max-regression <float>]\n" +
      "    [--samples <n> --max-variance <float>]\n" +
      "    [--ground-truth <path> --min-correlation <float>]\n" +
      "    [--mutate <n> --min-robustness <float> --mutate-kinds <kinds>]\n" +
      "    [--gh-pr-comment] [--github-pr <number>] [--github-token <token>]\n" +
      "    [--llm-base-url <url>] [--llm-model <name>] [--llm-api-key-env <VAR>] [--llm-api-key <key>]\n" +
      "    [--llm-timeout <ms>] [--llm-temperature <float>] [--llm-retries <n>] [--llm-header \"Key: Value\"]\n" +
      "  node dist/index.js --config <evaluators.config.json> [--export md]\n" +
      "    [--min-score <float>] [--max-regression <float>]\n" +
      "    [--samples <n> --max-variance <float>]\n" +
      "    [--ground-truth <path> --min-correlation <float>]\n" +
      "    [--mutate <n> --min-robustness <float> --mutate-kinds <kinds>]\n" +
      "    [--gh-pr-comment] [--github-pr <number>] [--github-token <token>]\n" +
      "    [--llm-base-url <url>] [--llm-model <name>] [--llm-api-key-env <VAR>] [--llm-api-key <key>]\n" +
      "    [--llm-timeout <ms>] [--llm-temperature <float>] [--llm-retries <n>] [--llm-header \"Key: Value\"]"
    );
    process.exit(1);
  }

  const { result, failed, thresholdViolations, regressionViolations, varianceViolations, calibrationViolations } = await runSingleEval(inputPath, args);

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
    const prOpts = getPrCommentOptions(args);
    try {
      const url = await postPrComment(
        buildPrCommentBody(result, thresholdViolations, regressionViolations),
        prOpts
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
