// tests/exporter.test.ts
import * as fs from "fs";
import * as path from "path";
import { exportToJSON, exportToCSV, exportToMarkdown } from "../src/utils/exporter";
import { EvaluationResult, Confidence } from "../src/types";

const result: EvaluationResult = {
  taskId: "EXP-TEST",
  prompt: "test",
  evaluator: "tester",
  timestamp: "2024-01-01T00:00:00.000Z",
  preferred: "A",
  confidence: Confidence.HIGH,
  rankings: [{
    rank: 1, responseId: "A", weightedScore: 8.5,
    scores: { correctness: 8, efficiency: 8, readability: 9, security: 9, promptAdherence: 8 },
    securityFlags: [], justification: "good",
  }],
  telemetry: {
    totalPromptTokens: 1200,
    totalCompletionTokens: 300,
    totalTokens: 1500,
    cacheHits: 2,
    cacheMisses: 1,
    totalLatencyMs: 450,
    estimatedCostUsd: 0.006,
    estimatedSavingsUsd: 0.004,
  },
};

const outDir = "./output-test";

afterAll(() => {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
});

describe("exporter", () => {
  it("exports JSON", () => {
    const p = exportToJSON(result, outDir);
    expect(fs.existsSync(p)).toBe(true);
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(data.taskId).toBe("EXP-TEST");
  });

  it("exports CSV", () => {
    const p = exportToCSV(result, outDir);
    expect(fs.existsSync(p)).toBe(true);
    const csv = fs.readFileSync(p, "utf-8");
    expect(csv).toContain("task_id");
    expect(csv).toContain("EXP-TEST");
    expect(csv).toContain("A");
  });

  it("exports Markdown with telemetry table", () => {
    const p = exportToMarkdown(result, outDir);
    expect(fs.existsSync(p)).toBe(true);
    const md = fs.readFileSync(p, "utf-8");
    expect(md).toContain("# Evaluation Report");
    expect(md).toContain("EXP-TEST");
    expect(md).toContain("Execution Telemetry");
    expect(md).toContain("Prompt tokens");
    expect(md).toContain("1,200");
    expect(md).toContain("Cache hits");
    expect(md).toContain("Estimated cost");
    expect(md).toContain("0.006");
  });

  it("creates output dir if missing", () => {
    const dir = path.join(outDir, "nested");
    const p = exportToJSON(result, dir);
    expect(fs.existsSync(p)).toBe(true);
  });
});
