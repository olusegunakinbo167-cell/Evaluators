// tests/judge.test.ts

import { buildJudgePrompt } from "../src/components/llm/promptBuilder";
import { validateJudgeScores, getFallbackScores, buildFallbackResult } from "../src/components/llm/judgeProvider";
import { MockJudgeProvider } from "../src/components/llm/mockProvider";
import { judgeResponses, extractJudgeScores } from "../src/components/llm/judge";
import { evaluateAuto, validateRubricPayload } from "../src/components/evaluator";
import { RUBRIC_DIMENSIONS, CodeResponse } from "../src/types";

describe("promptBuilder", () => {
  it("injects rubric schema dimensions, keys, bounds, and labels into system prompt", () => {
    const prompt = buildJudgePrompt({
      taskPrompt: "test task",
      responseId: "A",
      code: "const x = 1",
      language: "javascript",
      rubricDimensions: RUBRIC_DIMENSIONS,
    });

    // Check all dimension keys appear
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(prompt.system).toContain(dim.key);
      expect(prompt.system).toContain(dim.label);
      expect(prompt.system).toContain(dim.description.slice(0, 20));
      expect(prompt.system).toContain(`[${dim.minScore}–${dim.maxScore}`);
      expect(prompt.system).toContain(`weight=${dim.weight}`);
    }

    // JSON schema matches rubric
    const schemaProps = (prompt.jsonSchema.schema as any).properties.scores.properties;
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(schemaProps[dim.key]).toBeDefined();
      expect(schemaProps[dim.key].minimum).toBe(dim.minScore);
      expect(schemaProps[dim.key].maximum).toBe(dim.maxScore);
    }
  });

  it("includes code artifact and task prompt in user message", () => {
    const prompt = buildJudgePrompt({
      taskPrompt: "Write a sort function",
      responseId: "R1",
      code: "function sort() {}",
      language: "typescript",
      rubricDimensions: RUBRIC_DIMENSIONS,
    });
    expect(prompt.user).toContain("Write a sort function");
    expect(prompt.user).toContain("function sort() {}");
    expect(prompt.user).toContain("R1");
  });
});

describe("judgeProvider validation", () => {
  it("accepts valid rubric-mapped scores", () => {
    const scores = validateJudgeScores({
      correctness: 8,
      efficiency: 7,
      readability: 9,
      security: 6,
      promptAdherence: 10,
    });
    expect(scores.correctness).toBe(8);
  });

  it("rejects scores with missing rubric keys", () => {
    expect(() => validateJudgeScores({ correctness: 5 })).toThrow(/not a finite number/);
  });

  it("rejects out-of-bounds scores", () => {
    expect(() => validateJudgeScores({
      correctness: 11,
      efficiency: 5,
      readability: 5,
      security: 5,
      promptAdherence: 5,
    })).toThrow(/out of bounds/);
  });

  it("rejects non-numeric scores", () => {
    expect(() => validateJudgeScores({
      correctness: "high" as any,
      efficiency: 5,
      readability: 5,
      security: 5,
      promptAdherence: 5,
    })).toThrow();
  });

  it("fallback scores cover all rubric keys with neutral baseline", () => {
    const fb = getFallbackScores();
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(fb[dim.key]).toBe(5);
    }
  });

  it("buildFallbackResult returns properly shaped JudgeResult", () => {
    const r = buildFallbackResult("X", 123, "test timeout");
    expect(r.responseId).toBe("X");
    expect(r.fallbackUsed).toBe(true);
    expect(r.latencyMs).toBe(123);
    expect(r.justification).toContain("test timeout");
  });
});

describe("MockJudgeProvider", () => {
  it("returns configured scores per responseId", async () => {
    const provider = new MockJudgeProvider({
      A: { correctness: 9, efficiency: 8, readability: 7, security: 6, promptAdherence: 5 },
    });
    const result = await provider.score({
      taskPrompt: "t", responseId: "A", code: "x", language: "js",
      rubricDimensions: RUBRIC_DIMENSIONS,
    });
    expect(result.scores.correctness).toBe(9);
    expect(result.fallbackUsed).toBe(false);
  });
});

describe("judgeResponses orchestration", () => {
  it("scores all responses and validates rubric mapping", async () => {
    const responses: CodeResponse[] = [
      { id: "A", code: "safe", language: "js" },
      { id: "B", code: "unsafe", language: "js" },
    ];
    const provider = new MockJudgeProvider({
      A: { correctness: 9, efficiency: 9, readability: 9, security: 9, promptAdherence: 9 },
      B: { correctness: 4, efficiency: 4, readability: 4, security: 2, promptAdherence: 4 },
    });

    const results = await judgeResponses("test", responses, provider);
    expect(results.A.scores.security).toBe(9);
    expect(results.B.scores.security).toBe(2);
    expect(results.A.fallbackUsed).toBe(false);
  });

  it("extractJudgeScores produces evaluator-compatible maps", async () => {
    const results = {
      X: {
        responseId: "X",
        scores: { correctness: 6, efficiency: 6, readability: 6, security: 6, promptAdherence: 6 },
        justification: "ok",
        fallbackUsed: false, cacheHit: false,
        latencyMs: 1,
      },
    };
    const { scores, justifications } = extractJudgeScores(results);
    expect(scores.X.correctness).toBe(6);
    expect(justifications.X).toBe("ok");
  });
});

describe("evaluateAuto integration", () => {
  it("auto-judges when manualScores are missing", async () => {
    const provider = new MockJudgeProvider({
      A: { correctness: 9, efficiency: 8, readability: 9, security: 9, promptAdherence: 10 },
      B: { correctness: 5, efficiency: 5, readability: 5, security: 2, promptAdherence: 5 },
    });

    const result = await evaluateAuto({
      taskId: "AUTO-1",
      prompt: "test",
      evaluator: "judge",
      responses: [
        { id: "A", code: "const x = 1", language: "ts" },
        { id: "B", code: "eval(x)", language: "ts" },
      ],
      autoJudge: true,
    }, provider);

    expect(result.rankings[0].responseId).toBe("A");
    expect(result.rankings[0].scores.correctness).toBe(9);
    expect(result.preferred).toBe("A");
  });

  it("manualScores bypass the judge", async () => {
    let judgeCalled = false;
    const spyingProvider = {
      name: "spy",
      score: async () => { judgeCalled = true; throw new Error("should not be called"); },
    } as any;

    const result = await evaluateAuto({
      taskId: "MANUAL-1",
      prompt: "test",
      evaluator: "human",
      responses: [{ id: "A", code: "x", language: "js" }],
      manualScores: {
        A: { correctness: 10, efficiency: 10, readability: 10, security: 10, promptAdherence: 10 },
      },
      justifications: { A: "perfect" },
      autoJudge: true,
    }, spyingProvider);

    expect(judgeCalled).toBe(false);
    expect(result.rankings[0].weightedScore).toBe(10);
  });
});

describe("validateRubricPayload", () => {
  it("accepts complete valid rubric payloads", () => {
    expect(validateRubricPayload({
      correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5,
    })).toBe(true);
  });

  it("rejects payloads missing keys", () => {
    expect(validateRubricPayload({ correctness: 5 })).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(validateRubricPayload({
      correctness: 99, efficiency: 5, readability: 5, security: 5, promptAdherence: 5,
    })).toBe(false);
  });
});
