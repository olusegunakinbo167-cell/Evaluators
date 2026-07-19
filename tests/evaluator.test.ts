// tests/evaluator.test.ts

import { evaluate, evaluateAuto, validateRubricPayload } from "../src/components/evaluator";
import { Confidence, EvaluationInput, RUBRIC_DIMENSIONS } from "../src/types";
import { MockJudgeProvider } from "../src/components/llm/mockProvider";

describe("evaluate (manual scores)", () => {
  it("ranks responses and applies security penalty", () => {
    const input: EvaluationInput = {
      taskId: "T1",
      prompt: "p",
      evaluator: "human",
      responses: [
        { id: "A", code: "safe", language: "js" },
        { id: "B", code: 'eval(userInput)', language: "js" },
      ],
      manualScores: {
        A: { correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 },
        B: { correctness: 8, efficiency: 8, readability: 8, security: 8, promptAdherence: 8 },
      },
      justifications: { A: "ok", B: "eval!" },
    };

    const result = evaluate(input);
    expect(result.rankings[0].responseId).toBe("A");
    // B gets a HIGH security flag penalty (0.8)
    expect(result.rankings.find(r => r.responseId === "B")!.weightedScore).toBeLessThan(8);
  });

  it("throws on missing scores", () => {
    expect(() => evaluate({
      taskId: "T", prompt: "p", evaluator: "e",
      responses: [{ id: "X", code: "", language: "js" }],
      manualScores: {},
      justifications: {},
    } as any)).toThrow(/No rubric scores provided/);
  });

  it("throws on out-of-bounds scores", () => {
    expect(() => evaluate({
      taskId: "T", prompt: "p", evaluator: "e",
      responses: [{ id: "X", code: "", language: "js" }],
      manualScores: { X: { correctness: 99, efficiency: 0, readability: 0, security: 0, promptAdherence: 0 } },
      justifications: { X: "" },
    } as any)).toThrow(/Invalid scores/);
  });

  it("derives confidence when not supplied", () => {
    const result = evaluate({
      taskId: "T", prompt: "p", evaluator: "e",
      responses: [
        { id: "A", code: "", language: "js" },
        { id: "B", code: "", language: "js" },
      ],
      manualScores: {
        A: { correctness: 9, efficiency: 9, readability: 9, security: 9, promptAdherence: 9 },
        B: { correctness: 4, efficiency: 4, readability: 4, security: 4, promptAdherence: 4 },
      },
      justifications: { A: "", B: "" },
    });
    expect(result.confidence).toBe(Confidence.HIGH);
  });

  it("respects explicit confidence override", () => {
    const result = evaluate({
      taskId: "T", prompt: "p", evaluator: "e",
      confidence: Confidence.LOW,
      responses: [{ id: "A", code: "", language: "js" }],
      manualScores: { A: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 } },
      justifications: { A: "" },
    });
    expect(result.confidence).toBe(Confidence.LOW);
  });
});

describe("evaluateAuto", () => {
  it("invokes judge for all responses", async () => {
    const provider = new MockJudgeProvider({
      A: { correctness: 6, efficiency: 6, readability: 6, security: 6, promptAdherence: 6 },
      B: { correctness: 7, efficiency: 7, readability: 7, security: 7, promptAdherence: 7 },
      C: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 },
    });
    const result = await evaluateAuto({
      taskId: "AUTO", prompt: "p", evaluator: "judge",
      responses: [
        { id: "A", code: "a", language: "js" },
        { id: "B", code: "b", language: "js" },
        { id: "C", code: "c", language: "js" },
      ],
    }, provider);
    expect(result.rankings.map(r => r.responseId)).toEqual(["B", "A", "C"]);
  });

  it("autoJudge=false forces manual-score path", async () => {
    await expect(evaluateAuto({
      taskId: "X", prompt: "p", evaluator: "e",
      responses: [{ id: "A", code: "", language: "js" }],
      autoJudge: false,
    } as any)).rejects.toThrow(/No rubric scores provided/);
  });
});

describe("validateRubricPayload edge cases", () => {
  it("rejects null / non-object", () => {
    expect(validateRubricPayload(null)).toBe(false);
    expect(validateRubricPayload("x")).toBe(false);
  });

  RUBRIC_DIMENSIONS.forEach(dim => {
    it(`rejects ${dim.key} below min`, () => {
      const payload: any = { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 };
      payload[dim.key] = dim.minScore - 1;
      expect(validateRubricPayload(payload)).toBe(false);
    });
    it(`rejects ${dim.key} above max`, () => {
      const payload: any = { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 };
      payload[dim.key] = dim.maxScore + 1;
      expect(validateRubricPayload(payload)).toBe(false);
    });
    it(`accepts ${dim.key} at min boundary`, () => {
      const payload: any = { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 };
      payload[dim.key] = dim.minScore;
      expect(validateRubricPayload(payload)).toBe(true);
    });
    it(`accepts ${dim.key} at max boundary`, () => {
      const payload: any = { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 };
      payload[dim.key] = dim.maxScore;
      expect(validateRubricPayload(payload)).toBe(true);
    });
  });
});
