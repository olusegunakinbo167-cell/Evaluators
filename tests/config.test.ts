// tests/config.test.ts

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expandInputs,
  loadRubricFile,
  loadEvaluatorConfig,
  applyCliOverrides,
} from "../src/utils/config";
import { RUBRIC_DIMENSIONS } from "../src/types";
import { runSuites, buildAggregatedMarkdown } from "../src/components/suiteRunner";

describe("expandInputs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-config-"));
    fs.mkdirSync(path.join(tmpDir, "evals", "api"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "evals", "ui"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "evals", "api", "a.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "evals", "api", "b.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "evals", "ui", "c.json"), "{}");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expands single glob", () => {
    const files = expandInputs("evals/api/*.json", tmpDir);
    expect(files).toHaveLength(2);
    expect(files.some(f => f.endsWith("a.json"))).toBe(true);
    expect(files.some(f => f.endsWith("b.json"))).toBe(true);
  });

  it("expands ** recursive glob", () => {
    const files = expandInputs("evals/**/*.json", tmpDir);
    expect(files).toHaveLength(3);
  });

  it("expands array of globs and dedupes", () => {
    const files = expandInputs(
      ["evals/api/*.json", "evals/**/*.json"],
      tmpDir
    );
    expect(files).toHaveLength(3); // a, b, c — no dupes
  });

  it("handles literal file paths", () => {
    const file = path.join(tmpDir, "evals", "api", "a.json");
    const files = expandInputs(file, tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.resolve(file));
  });

  it("returns empty array for non-matching glob", () => {
    const files = expandInputs("nonexistent/**/*.json", tmpDir);
    expect(files).toEqual([]);
  });
});

describe("loadRubricFile", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("loads and validates a correct rubric", () => {
    const rubricPath = path.join(tmpDir, "rubric.json");
    fs.writeFileSync(rubricPath, JSON.stringify(RUBRIC_DIMENSIONS));
    const rubric = loadRubricFile(rubricPath);
    expect(rubric).toHaveLength(5);
    expect(rubric[0].key).toBe("correctness");
  });

  it("rejects rubric with missing keys", () => {
    const rubricPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(rubricPath, JSON.stringify(RUBRIC_DIMENSIONS.slice(0, 3)));
    expect(() => loadRubricFile(rubricPath)).toThrow(/Missing required rubric key/);
  });

  it("rejects rubric with invalid weights sum", () => {
    const bad = RUBRIC_DIMENSIONS.map(d => ({ ...d, weight: 1 }));
    const rubricPath = path.join(tmpDir, "bad2.json");
    fs.writeFileSync(rubricPath, JSON.stringify(bad));
    expect(() => loadRubricFile(rubricPath)).toThrow(/weights sum to 5/);
  });

  it("throws on missing file", () => {
    expect(() => loadRubricFile(path.join(tmpDir, "nope.json"))).toThrow(/not found/);
  });
});

describe("loadEvaluatorConfig", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cfg-"));
    fs.mkdirSync(path.join(tmpDir, "inputs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "inputs", "test1.json"), JSON.stringify({
      taskId: "T1", prompt: "p", evaluator: "e",
      responses: [{ id: "A", code: "x", language: "js" }],
      manualScores: { A: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 } },
      justifications: { A: "" },
    }));
    fs.writeFileSync(path.join(tmpDir, "inputs", "test2.json"), "{}");
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("parses config with glob inputs and threshold overrides", () => {
    const configPath = path.join(tmpDir, "evaluators.config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      suites: [{
        name: "smoke",
        inputs: "inputs/*.json",
        minScore: 7.5,
        maxRegression: 0.2,
      }],
      outputDir: "./out",
      exportFormat: "md",
      failFast: true,
    }));
    const cfg = loadEvaluatorConfig(configPath);
    expect(cfg.suites).toHaveLength(1);
    expect(cfg.suites[0].name).toBe("smoke");
    expect(cfg.suites[0].inputFiles).toHaveLength(2);
    expect(cfg.suites[0].minScore).toBe(7.5);
    expect(cfg.suites[0].maxRegression).toBe(0.2);
    expect(cfg.outputDir).toBe("./out");
    expect(cfg.exportFormat).toBe("md");
    expect(cfg.failFast).toBe(true);
  });

  it("loads custom rubric and validates it", () => {
    const rubricPath = path.join(tmpDir, "my-rubric.json");
    const customRubric = RUBRIC_DIMENSIONS.map(d => ({ ...d, description: d.description + " (custom)" }));
    fs.writeFileSync(rubricPath, JSON.stringify(customRubric));

    const configPath = path.join(tmpDir, "cfg.json");
    fs.writeFileSync(configPath, JSON.stringify({
      suites: [{ name: "s", inputs: "inputs/test1.json", rubric: "./my-rubric.json" }],
    }));

    const cfg = loadEvaluatorConfig(configPath);
    expect(cfg.suites[0].rubric).toBeDefined();
    expect(cfg.suites[0].rubric![0].description).toContain("(custom)");
  });

  it("throws on empty suites array", () => {
    const configPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(configPath, JSON.stringify({ suites: [] }));
    expect(() => loadEvaluatorConfig(configPath)).toThrow(/non-empty array/);
  });

  it("throws when inputs glob matches 0 files", () => {
    const configPath = path.join(tmpDir, "bad2.json");
    fs.writeFileSync(configPath, JSON.stringify({
      suites: [{ name: "x", inputs: "nothing/**/*.json" }],
    }));
    expect(() => loadEvaluatorConfig(configPath)).toThrow(/matched 0 files/);
  });
});

describe("applyCliOverrides", () => {
  it("CLI flags override config file values", () => {
    const suite = {
      name: "s",
      inputFiles: ["a.json"],
      minScore: 7,
      maxRegression: 0.1,
      baseline: "/old/baseline.json",
    };
    const overridden = applyCliOverrides(suite, {
      minScore: 8.5,
      maxRegression: 0.5,
      baseline: "/new/baseline.json",
    });
    expect(overridden.minScore).toBe(8.5);
    expect(overridden.maxRegression).toBe(0.5);
    expect(overridden.baseline).toBe("/new/baseline.json");
  });

  it("undefined CLI flags keep config values", () => {
    const suite = { name: "s", inputFiles: ["a.json"], minScore: 6, maxRegression: 0.2, baseline: "/b.json" };
    const overridden = applyCliOverrides(suite, {});
    expect(overridden.minScore).toBe(6);
    expect(overridden.maxRegression).toBe(0.2);
    expect(overridden.baseline).toBe("/b.json");
  });
});

describe("runSuites / buildAggregatedMarkdown", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-run-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeInput(name: string, score: number) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify({
      taskId: name, prompt: "p", evaluator: "e",
      responses: [{ id: "A", code: "x", language: "js" }],
      manualScores: { A: { correctness: score, efficiency: score, readability: score, security: score, promptAdherence: score } },
      justifications: { A: "" },
    }));
    return p;
  }

  it("runs multiple suites and aggregates results", async () => {
    const f1 = writeInput("pass.json", 8);
    const f2 = writeInput("fail.json", 4);

    const result = await runSuites([
      { name: "suite-a", inputFiles: [f1], minScore: 7 },
      { name: "suite-b", inputFiles: [f2], minScore: 7 },
    ]);

    expect(result.totalRuns).toBe(2);
    expect(result.totalPassed).toBe(1);
    expect(result.totalFailed).toBe(1);
    expect(result.failed).toBe(true);
    expect(result.aggregates[0].suiteName).toBe("suite-a");
    expect(result.aggregates[0].passed).toBe(1);
    expect(result.aggregates[1].failed).toBe(1);
  });

  it("respects failFast", async () => {
    const f1 = writeInput("fail.json", 3);
    const f2 = writeInput("pass.json", 9);

    const result = await runSuites([
      { name: "first", inputFiles: [f1], minScore: 7 },
      { name: "second", inputFiles: [f2], minScore: 7 },
    ], { minScore: 7, failFast: true }, 1);

    // With failFast and concurrency=1, second suite should not run
    expect(result.aggregates.length).toBe(1);
    expect(result.aggregates[0].suiteName).toBe("first");
  });

  it("CLI overrides apply to all suites", async () => {
    const f1 = writeInput("input.json", 6);
    const result = await runSuites(
      [{ name: "s", inputFiles: [f1], minScore: 5 }],
      { minScore: 7 } // CLI override — should fail
    );
    expect(result.totalFailed).toBe(1);
  });

  it("buildAggregatedMarkdown produces unified report", async () => {
    const f1 = writeInput("ok.json", 8);
    const result = await runSuites([
      { name: "test-suite", inputFiles: [f1], minScore: 7 },
    ]);
    const md = buildAggregatedMarkdown(result);
    expect(md).toContain("Evaluation Suites");
    expect(md).toContain("test-suite");
    expect(md).toContain("passed");
    expect(md).toContain("| Suite | Passed | Failed | Total |");
  });

  it("aggregated markdown includes failure details", async () => {
    const f1 = writeInput("bad.json", 3);
    const result = await runSuites([
      { name: "failing", inputFiles: [f1], minScore: 7 },
    ]);
    const md = buildAggregatedMarkdown(result);
    expect(md).toContain("❌");
    expect(md).toContain("failing");
    expect(md).toContain("Threshold violations");
  });
});
