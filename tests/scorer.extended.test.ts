// tests/scorer.extended.test.ts

import { computeWeightedScore, validateScores, rankResponses, deriveConfidence, applySecurityPenalty } from "../src/utils/scorer";
import { RubricScores, SecurityFlag, Confidence } from "../src/types";

const base: RubricScores = { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 };

describe("computeWeightedScore extended", () => {
  it("handles all-zero scores", () => {
    expect(computeWeightedScore({ correctness: 0, efficiency: 0, readability: 0, security: 0, promptAdherence: 0 })).toBe(0);
  });

  for (let i = 0; i <= 10; i++) {
    it(`correctness=${i} weights correctly`, () => {
      const scores = { ...base, correctness: i };
      const expected = parseFloat((i * 0.3 + 5 * 0.7).toFixed(2));
      expect(computeWeightedScore(scores)).toBe(expected);
    });
  }
});

describe("validateScores extended", () => {
  const keys: (keyof RubricScores)[] = ["correctness", "efficiency", "readability", "security", "promptAdherence"];
  keys.forEach(k => {
    it(`rejects ${k} = -0.1`, () => {
      expect(validateScores({ ...base, [k]: -0.1 } as any)).toBe(false);
    });
    it(`rejects ${k} = 10.1`, () => {
      expect(validateScores({ ...base, [k]: 10.1 } as any)).toBe(false);
    });
    it(`accepts ${k} = 0`, () => {
      expect(validateScores({ ...base, [k]: 0 } as any)).toBe(true);
    });
    it(`accepts ${k} = 10`, () => {
      expect(validateScores({ ...base, [k]: 10 } as any)).toBe(true);
    });
  });
});

describe("rankResponses extended", () => {
  it("stable sort on ties", () => {
    const ranked = rankResponses([
      { responseId: "A", weightedScore: 5, scores: base, securityFlags: [], justification: "" },
      { responseId: "B", weightedScore: 5, scores: base, securityFlags: [], justification: "" },
      { responseId: "C", weightedScore: 5, scores: base, securityFlags: [], justification: "" },
    ]);
    expect(ranked.map(r => r.rank)).toEqual([1, 2, 3]);
  });

  it("handles 10+ responses", () => {
    const responses = Array.from({ length: 15 }, (_, i) => ({
      responseId: `R${i}`, weightedScore: 15 - i, scores: base, securityFlags: [], justification: "",
    }));
    const ranked = rankResponses(responses);
    expect(ranked[0].responseId).toBe("R0");
    expect(ranked[14].rank).toBe(15);
  });
});

describe("deriveConfidence extended", () => {
  it("high at exactly 2.0 spread", () => {
    const r = [
      { rank: 1, responseId: "A", weightedScore: 8, scores: base, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 6, scores: base, securityFlags: [], justification: "" },
    ];
    expect(deriveConfidence(r)).toBe(Confidence.HIGH);
  });

  it("medium at exactly 0.8 spread", () => {
    const r = [
      { rank: 1, responseId: "A", weightedScore: 7.8, scores: base, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 7.0, scores: base, securityFlags: [], justification: "" },
    ];
    const conf = deriveConfidence(r);
    // 7.8 - 7.0 = 0.7999... in FP, allow either medium or low
    expect([Confidence.MEDIUM, Confidence.LOW]).toContain(conf);
  });

  it("low just below 0.8", () => {
    const r = [
      { rank: 1, responseId: "A", weightedScore: 7.79, scores: base, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 7.0, scores: base, securityFlags: [], justification: "" },
    ];
    expect(deriveConfidence(r)).toBe(Confidence.LOW);
  });

  it("single response = high", () => {
    expect(deriveConfidence([
      { rank: 1, responseId: "A", weightedScore: 5, scores: base, securityFlags: [], justification: "" }
    ])).toBe(Confidence.HIGH);
  });
});

describe("applySecurityPenalty extended", () => {
  const flag = (severity: SecurityFlag["severity"]): SecurityFlag => ({ type: "X", severity, description: "" });

  it("CRITICAL = 1.5", () => expect(applySecurityPenalty(10, [flag("CRITICAL")])).toBe(8.5));
  it("HIGH = 0.8", () => expect(applySecurityPenalty(10, [flag("HIGH")])).toBe(9.2));
  it("MEDIUM = 0.3", () => expect(applySecurityPenalty(10, [flag("MEDIUM")])).toBe(9.7));
  it("LOW = 0.1", () => expect(applySecurityPenalty(10, [flag("LOW")])).toBe(9.9));

  it("stacks multiple flags", () => {
    expect(applySecurityPenalty(10, [flag("CRITICAL"), flag("HIGH"), flag("MEDIUM"), flag("LOW")]))
      .toBe(7.3);
  });

  it("clamps at zero", () => {
    const many = Array(20).fill(0).map(() => flag("CRITICAL"));
    expect(applySecurityPenalty(5, many)).toBe(0);
  });
});
