// src/index.ts

import app from "./api/server";
import { evaluate, evaluateAuto } from "./components/evaluator";
import { exportToJSON, exportToCSV } from "./utils/exporter";
import { EvaluationInput, Confidence } from "./types";
import { MockJudgeProvider } from "./components/llm/mockProvider";

const PORT = process.env.PORT || 3000;
const AUTO_JUDGE = (process.env.AUTO_JUDGE ?? "true").toLowerCase() !== "false";

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

  const jsonPath = exportToJSON(result, "./output");
  const csvPath = exportToCSV(result, "./output");
  console.log(`\n✅ Exported JSON: ${jsonPath}`);
  console.log(`✅ Exported CSV:  ${csvPath}`);
}

// CLI mode: node dist/index.js --eval <input.json>
// or: node dist/index.js --eval <input.json> --export csv
async function runCli() {
  const args = process.argv.slice(2);
  const evalIdx = args.indexOf("--eval");
  if (evalIdx === -1) return false;

  const inputPath = args[evalIdx + 1];
  if (!inputPath) {
    console.error("Usage: node dist/index.js --eval <input.json> [--export json|csv]");
    process.exit(1);
  }

  const fs = await import("fs");
  const raw = fs.readFileSync(inputPath, "utf-8");
  const input: EvaluationInput = JSON.parse(raw);

  const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
  const result = hasScores ? evaluate(input) : await evaluateAuto(input);

  console.log(JSON.stringify(result, null, 2));

  const exportIdx = args.indexOf("--export");
  if (exportIdx !== -1) {
    const format = args[exportIdx + 1] ?? "json";
    const filepath = format === "csv" ? exportToCSV(result) : exportToJSON(result);
    console.log(`\n✅ Exported: ${filepath}`);
  }
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
    console.log(`   POST /evaluate/export — evaluate + export to file`);
    console.log(`   GET  /health         — health check`);
  });
})();
