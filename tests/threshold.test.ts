// tests/threshold.test.ts

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  checkMinScore,
  checkRegression,
  loadBaseline,
  formatThresholdFailures,
  formatRegressionFailures,
} from "../src/components/evaluator";
import { EvaluationResult, Confidence } from "../src/types";

function makeResult(scores: { correctness: number; efficiency: number; readability: number; security: number; promptAdherence: number }, weightedScore = 7): EvaluationResult {
  return {
    taskId: "T",
    prompt: "p",
    evaluator: "e",
    timestamp: "2024-01-01T00:00:00Z",
    preferred: "A",
    confidence: Confidence.HIGH,
    rankings: [{
      rank: 1, responseId: "A", weightedScore,
      scores,
      securityFlags: [],
      justification: "x",
    }],
  };
}

describe("checkMinScore", () => {
  it("passes when score >= min", () => {
    const r = makeResult({ correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 }, 8.0);
    expect(checkMinScore(r, 7.5)).toEqual([]);
  });

  it("fails when score < min", () => {
    const r = makeResult({ correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 }, 5.0);
    const v = checkMinScore(r, 7.5);
    expect(v).toHaveLength(1);
    expect(v[0].responseId).toBe("A");
    expect(v[0].weightedScore).toBe(5.0);
    expect(v[0].minScore).toBe(7.5);
    expect(v[0].delta).toBeCloseTo(-2.5);
  });

  it("reports all failing responses", () => {
    const r: EvaluationResult = {
      taskId: "T", prompt: "p", evaluator: "e",
      timestamp: "x", preferred: "A", confidence: Confidence.LOW,
      rankings: [
        { rank: 1, responseId: "A", weightedScore: 6, scores: { correctness: 6, efficiency: 6, readability: 6, security: 6, promptAdherence: 6 }, securityFlags: [], justification: "" },
        { rank: 2, responseId: "B", weightedScore: 4, scores: { correctness: 4, efficiency: 4, readability: 4, security: 4, promptAdherence: 4 }, securityFlags: [], justification: "" },
      ],
    };
    const v = checkMinScore(r, 7);
    expect(v).toHaveLength(2);
    expect(v.map(x => x.responseId).sort()).toEqual(["A", "B"]);
  });
});

describe("checkRegression", () => {
  const baseScores = { correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 };

  it("passes when no regression", () => {
    const baseline = makeResult(baseScores, 8.0);
    const current = makeResult(baseScores, 8.0);
    expect(checkRegression(current, baseline, 0)).toEqual([]);
  });

  it("detects weighted_score regression", () => {
    const baseline = makeResult(baseScores, 8.5);
    const current = makeResult(baseScores, 7.0);
    const v = checkRegression(current, baseline, 0);
    expect(v.find(x => x.dimension === "weightedScore")).toBeDefined();
    expect(v[0].delta).toBeCloseTo(-1.5);
  });

  it("detects per-dimension regression", () => {
    const baseline = makeResult({ ...baseScores, correctness: 9 }, 8);
    const current = makeResult({ ...baseScores, correctness: 6 }, 8);
    const v = checkRegression(current, baseline, 0);
    const corr = v.find(x => x.dimension === "correctness");
    expect(corr).toBeDefined();
    expect(corr!.current).toBe(6);
    expect(corr!.baseline).toBe(9);
    expect(corr!.delta).toBe(-3);
  });

  it("allows regression within maxRegression budget", () => {
    const baseline = makeResult({ ...baseScores, security: 9 }, 8);
    const current = makeResult({ ...baseScores, security: 8.6 }, 8);
    // drop of 0.4, allow 0.5 → pass
    expect(checkRegression(current, baseline, 0.5)).toEqual([]);
    // allow 0.3 → fail
    expect(checkRegression(current, baseline, 0.3)).toHaveLength(1);
  });

  it("matches responses by responseId", () => {
    const baseline: EvaluationResult = {
      taskId: "T", prompt: "p", evaluator: "e",
      timestamp: "x", preferred: "B", confidence: Confidence.HIGH,
      rankings: [
        { rank: 1, responseId: "B", weightedScore: 9, scores: baseScores, securityFlags: [], justification: "" },
        { rank: 2, responseId: "A", weightedScore: 7, scores: baseScores, securityFlags: [], justification: "" },
      ],
    };
    const current: EvaluationResult = {
      ...baseline,
      rankings: [
        { rank: 1, responseId: "A", weightedScore: 6, scores: { ...baseScores, correctness: 5 }, securityFlags: [], justification: "" },
        { rank: 2, responseId: "B", weightedScore: 9, scores: baseScores, securityFlags: [], justification: "" },
      ],
    };
    const v = checkRegression(current, baseline, 0);
    // A regressed from 7→6, B stayed same
    expect(v.some(x => x.responseId === "A")).toBe(true);
    expect(v.some(x => x.responseId === "B")).toBe(false);
  });

  it("skips responses missing from baseline", () => {
    const baseline = makeResult(baseScores, 8);
    baseline.rankings[0].responseId = "OLD";
    const current = makeResult(baseScores, 1); // would fail if compared
    current.rankings[0].responseId = "NEW";
    expect(checkRegression(current, baseline, 0)).toEqual([]);
  });
});

describe("formatThresholdFailures / formatRegressionFailures", () => {
  it("formats threshold failures to stderr-readable output", () => {
    const out = formatThresholdFailures([{
      responseId: "A", weightedScore: 5, minScore: 7.5, delta: -2.5,
    }]);
    expect(out).toContain("THRESHOLD CHECK FAILED");
    expect(out).toContain("A");
    expect(out).toContain("5 <");
    expect(out).toContain("7.5");
  });

  it("formats regression failures", () => {
    const out = formatRegressionFailures([{
      responseId: "X", dimension: "security", current: 4, baseline: 9,
      delta: -5, allowedRegression: 0,
    }]);
    expect(out).toContain("REGRESSION CHECK FAILED");
    expect(out).toContain("X / security");
    expect(out).toContain("4 < 9");
  });

  it("returns empty string when no violations", () => {
    expect(formatThresholdFailures([])).toBe("");
    expect(formatRegressionFailures([])).toBe("");
  });
});

describe("loadBaseline", () => {
  it("loads EvaluationResult JSON", () => {
    const tmp = path.join(os.tmpdir(), `baseline-${Date.now()}.json`);
    const data = makeResult({ correctness: 9, efficiency: 9, readability: 9, security: 9, promptAdherence: 9 }, 9);
    fs.writeFileSync(tmp, JSON.stringify(data));
    try {
      const loaded = loadBaseline(tmp);
      expect(loaded.taskId).toBe("T");
      expect(loaded.rankings[0].weightedScore).toBe(9);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe("CLI exit codes (integration)", () => {
  const distIndex = path.join(__dirname, "..", "dist", "index.js");

  beforeAll(() => {
    // Build the project
    execSync("npm run build", { cwd: path.join(__dirname, ".."), stdio: "ignore" });
  });

  function runCli(args: string[], inputJson: object): { exitCode: number | null; stdout: string; stderr: string } {
    const tmp = path.join(os.tmpdir(), `eval-input-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(inputJson));
    try {
      const stdout = execSync(`node "${distIndex}" --eval "${tmp}" ${args.join(" ")} 2>&1`, {
        encoding: "utf-8",
        env: { ...process.env, OPENAI_API_KEY: "", AUTO_JUDGE: "false" },
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  const goodInput = {
    taskId: "CLI-TEST", prompt: "p", evaluator: "cli",
    responses: [{ id: "A", code: "x", language: "js" }],
    manualScores: { A: { correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 } },
    justifications: { A: "ok" },
  };

  const badInput = {
    ...goodInput,
    manualScores: { A: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 } },
  };

  it("exits 0 when min-score passes", () => {
    const r = runCli(["--min-score", "7"], goodInput);
    expect(r.exitCode).toBe(0);
  });

  it("exits 1 when min-score fails, dumps to stderr", () => {
    const r = runCli(["--min-score", "7.5"], badInput);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("THRESHOLD CHECK FAILED");
  });

  it("exits 1 on regression beyond allowance", () => {
    // Write baseline file with high scores
    const baselinePath = path.join(os.tmpdir(), `baseline-${Date.now()}.json`);
    const baseline = {
      taskId: "CLI-TEST", prompt: "p", evaluator: "cli",
      timestamp: new Date().toISOString(),
      preferred: "A", confidence: "high",
      rankings: [{
        rank: 1, responseId: "A", weightedScore: 8.5,
        scores: { correctness: 9, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 },
        securityFlags: [], justification: "x",
      }],
    };
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      // Current run: security drops 8 → 5 (delta -3)
      const regressedInput = {
        ...goodInput,
        manualScores: { A: { correctness: 9, efficiency: 8, readability: 8, security: 5, promptAdherence: 8 } },
      };
      const r = runCli(["--baseline", baselinePath, "--max-regression", "0.5"], regressedInput);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("REGRESSION CHECK FAILED");
      expect(r.stdout).toContain("security");
    } finally {
      fs.unlinkSync(baselinePath);
    }
  });

  it("exits 0 when regression is within allowance", () => {
    const baselinePath = path.join(os.tmpdir(), `baseline-${Date.now()}.json`);
    const baseline = {
      taskId: "CLI-TEST", prompt: "p", evaluator: "cli",
      timestamp: new Date().toISOString(),
      preferred: "A", confidence: "high",
      rankings: [{
        rank: 1, responseId: "A", weightedScore: 8.0,
        scores: { correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 },
        securityFlags: [], justification: "x",
      }],
    };
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      // Small drop: 8.0 → 7.7, allow 0.5
      const slight = {
        ...goodInput,
        manualScores: { A: { correctness: 8, efficiency: 8, readability: 8, security: 7.5, promptAdherence: 8 } },
      };
      const r = runCli(["--baseline", baselinePath, "--max-regression", "0.5"], slight);
      expect(r.exitCode).toBe(0);
    } finally {
      fs.unlinkSync(baselinePath);
    }
  });
});
