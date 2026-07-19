// tests/scorer.test.ts

import {
  computeWeightedScore,
  validateScores,
  rankResponses,
  deriveConfidence,
  applySecurityPenalty,
} from "../src/utils/scorer";
import { RubricScores, SecurityFlag, Confidence } from "../src/types";

const perfectScores: RubricScores = {
  correctness: 10,
  efficiency: 10,
  readability: 10,
  security: 10,
  promptAdherence: 10,
};

const weakScores: RubricScores = {
  correctness: 4,
  efficiency: 3,
  readability: 5,
  security: 2,
  promptAdherence: 6,
};

describe("computeWeightedScore", () => {
  it("returns 10 for perfect scores", () => {
    expect(computeWeightedScore(perfectScores)).toBe(10);
  });

  it("correctly weights scores", () => {
    // 4*0.3 + 3*0.2 + 5*0.2 + 2*0.2 + 6*0.1 = 1.2 + 0.6 + 1.0 + 0.4 + 0.6 = 3.8
    expect(computeWeightedScore(weakScores)).toBe(3.8);
  });
});

describe("validateScores", () => {
  it("accepts valid scores in range 0-10", () => {
    expect(validateScores(perfectScores)).toBe(true);
  });

  it("rejects scores above 10", () => {
    const invalid = { ...perfectScores, correctness: 11 };
    expect(validateScores(invalid)).toBe(false);
  });

  it("rejects negative scores", () => {
    const invalid = { ...weakScores, security: -1 };
    expect(validateScores(invalid)).toBe(false);
  });
});

describe("rankResponses", () => {
  it("ranks by weighted score descending", () => {
    const responses = [
      { responseId: "B", weightedScore: 5.0, scores: weakScores, securityFlags: [], justification: "" },
      { responseId: "A", weightedScore: 8.5, scores: perfectScores, securityFlags: [], justification: "" },
    ];
    const ranked = rankResponses(responses);
    expect(ranked[0].responseId).toBe("A");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].responseId).toBe("B");
    expect(ranked[1].rank).toBe(2);
  });
});

describe("deriveConfidence", () => {
  it("returns high when spread >= 2", () => {
    const ranked = [
      { rank: 1, responseId: "A", weightedScore: 9.0, scores: perfectScores, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 6.0, scores: weakScores, securityFlags: [], justification: "" },
    ];
    expect(deriveConfidence(ranked)).toBe(Confidence.HIGH);
  });

  it("returns medium for moderate spread", () => {
    const ranked = [
      { rank: 1, responseId: "A", weightedScore: 7.5, scores: perfectScores, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 6.5, scores: weakScores, securityFlags: [], justification: "" },
    ];
    expect(deriveConfidence(ranked)).toBe(Confidence.MEDIUM);
  });

  it("returns low when scores are very close", () => {
    const ranked = [
      { rank: 1, responseId: "A", weightedScore: 7.1, scores: perfectScores, securityFlags: [], justification: "" },
      { rank: 2, responseId: "B", weightedScore: 7.0, scores: weakScores, securityFlags: [], justification: "" },
    ];
    expect(deriveConfidence(ranked)).toBe(Confidence.LOW);
  });
});

describe("applySecurityPenalty", () => {
  it("reduces score by 1.5 per CRITICAL flag", () => {
    const flags: SecurityFlag[] = [
      { type: "SQL_INJECTION", severity: "CRITICAL", description: "SQL injection" },
    ];
    expect(applySecurityPenalty(8.0, flags)).toBe(6.5);
  });

  it("does not go below 0", () => {
    const flags: SecurityFlag[] = [
      { type: "SQL_INJECTION", severity: "CRITICAL", description: "" },
      { type: "HARDCODED_PASSWORD", severity: "CRITICAL", description: "" },
      { type: "UNSAFE_EVAL", severity: "HIGH", description: "" },
    ];
    expect(applySecurityPenalty(2.0, flags)).toBe(0);
  });

  it("returns unchanged score when no flags", () => {
    expect(applySecurityPenalty(7.5, [])).toBe(7.5);
  });
});
