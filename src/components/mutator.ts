/**
 * Synthetic Mutation Engine — tests LLM judge robustness.
 *
 * Generates intentionally corrupted code variants to verify the judge
 * actually catches regressions (security bugs, logic errors, etc.)
 * rather than giving inflated scores.
 */

import { CodeResponse, RubricScores, RubricDimensionKey } from "../types";

/** Mutation strategy categories. */
export type MutationKind =
  | "security"
  | "syntax"
  | "logic"
  | "performance"
  | "prompt_drift"
  | "fluff";

/** A single code mutation. */
export interface CodeMutation {
  id: string;
  kind: MutationKind;
  description: string;
  /** Expected rubric score degradation vs original (0-10 per dimension). */
  expectedPenalty: Partial<RubricScores>;
  /** Function that transforms source code. */
  mutate: (code: string, language: string) => string;
}

/** Result of applying a mutation. */
export interface MutationResult {
  mutationId: string;
  kind: MutationKind;
  description: string;
  originalResponseId: string;
  mutatedResponse: CodeResponse;
  expectedPenalty: Partial<RubricScores>;
}

/** Judge robustness assessment after evaluating mutations. */
export interface RobustnessReport {
  totalMutations: number;
  detectedMutations: number;
  /** Detection rate 0-1. */
  detectionRate: number;
  /** Robustness score 0-10 (detection rate * 10, adjusted by severity). */
  robustnessScore: number;
  /** Per-kind breakdown. */
  byKind: Record<MutationKind, {
    total: number;
    detected: number;
    detectionRate: number;
  }>;
  /** Mutations the judge failed to catch (score drop < threshold). */
  undetected: Array<{
    mutationId: string;
    kind: MutationKind;
    description: string;
    responseId: string;
    originalScore: number;
    mutatedScore: number;
    scoreDrop: number;
  }>;
}

// ─── Mutation Strategies ─────────────────────────────────────────────────────

/** Security bug injections. */
const SECURITY_MUTATIONS: CodeMutation[] = [
  {
    id: "sec-sql-injection",
    kind: "security",
    description: "Inject SQL injection vulnerability (string concatenation)",
    expectedPenalty: { security: 7, correctness: 2 },
    mutate: (code) => {
      // Replace parameterized queries with string concat
      return code
        .replace(/(\w+)\.prepare\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
          (_m, obj, sql) => `${obj}.query("${sql.replace(/\?/g, '" + userInput + "')}")`)
        .replace(/query\s*\(\s*["'`](SELECT|INSERT|UPDATE|DELETE)[^"'`]*\?\s*["'`]\s*,\s*\[([^\]]+)\]\s*\)/gi,
          'query("$1 ... " + $2)')
        // Fallback: inject a blatant SQLi comment if no match
        + (code.includes("SELECT") || code.includes("query")
          ? "\n// TODO: sanitize input\nconst query = `SELECT * FROM users WHERE id = '${userId}'`; // direct concat"
          : "");
    },
  },
  {
    id: "sec-xss",
    kind: "security",
    description: "Inject XSS vulnerability (innerHTML / unescaped output)",
    expectedPenalty: { security: 6 },
    mutate: (code) => {
      if (code.includes("innerHTML") || code.includes("dangerouslySetInnerHTML")) return code;
      // Inject innerHTML usage
      const injection = `
  // Render user content
  element.innerHTML = userInput; // XSS risk
`;
      return code + "\n" + injection;
    },
  },
  {
    id: "sec-command-injection",
    kind: "security",
    description: "Inject command injection (shell exec with user input)",
    expectedPenalty: { security: 8 },
    mutate: (code) => {
      const payload = `
// Execute user command
const { exec } = require('child_process');
exec('ls ' + userInput, (err, stdout) => console.log(stdout));
`;
      return code + payload;
    },
  },
  {
    id: "sec-hardcoded-secret",
    kind: "security",
    description: "Inject hardcoded API key / password",
    expectedPenalty: { security: 5 },
    mutate: (code) => {
      const secret = `\nconst API_KEY = "sk_live_" + "REDACTED_FAKE_KEY_FOR_TESTING"; // prod key\nconst DB_PASSWORD = "P@ssw0rd123!";\n`;
      // Insert near top, after imports
      const lines = code.split("\n");
      const insertAt = lines.findIndex(l => l.trim() && !l.trim().startsWith("import") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"));
      if (insertAt > 0) {
        lines.splice(insertAt, 0, secret);
        return lines.join("\n");
      }
      return secret + code;
    },
  },
  {
    id: "sec-path-traversal",
    kind: "security",
    description: "Inject path traversal vulnerability",
    expectedPenalty: { security: 6 },
    mutate: (code) => {
      return code + `\n// Read user-specified file\nconst fs = require('fs');\nconst data = fs.readFileSync('./uploads/' + req.params.filename, 'utf8');\n`;
    },
  },
  {
    id: "sec-eval",
    kind: "security",
    description: "Inject eval() / Function constructor with user input",
    expectedPenalty: { security: 7 },
    mutate: (code) => {
      return code + `\n// Dynamic parsing\nconst result = eval(userInput);\n`;
    },
  },
];

/** Syntax / runtime error injections. */
const SYNTAX_MUTATIONS: CodeMutation[] = [
  {
    id: "syntax-undefined-var",
    kind: "syntax",
    description: "Reference undefined variable",
    expectedPenalty: { correctness: 8 },
    mutate: (code) => {
      // Insert undefined variable reference
      return code.replace(
        /return\s+([^;}\n]+)([;}\n])/,
        (_m, expr, end) => `const _x = undefinedVariable123 * 2;\n  return ${expr}${end}`
      );
    },
  },
  {
    id: "syntax-missing-return",
    kind: "syntax",
    description: "Remove / break return statement",
    expectedPenalty: { correctness: 7 },
    mutate: (code) => {
      // Comment out first return
      return code.replace(/(\s+return\s+[^\n;]+;?)/, (_m, ret) => `\n  // ${ret.trim()} // BUG: missing return\n`);
    },
  },
  {
    id: "syntax-type-mismatch",
    kind: "syntax",
    description: "Introduce type mismatch / null dereference",
    expectedPenalty: { correctness: 5 },
    mutate: (code) => {
      return code + `\nconst crash = null;\nconsole.log(crash.foo.bar);\n`;
    },
  },
];

/** Logic bug injections. */
const LOGIC_MUTATIONS: CodeMutation[] = [
  {
    id: "logic-off-by-one",
    kind: "logic",
    description: "Off-by-one error in loop bounds",
    expectedPenalty: { correctness: 5 },
    mutate: (code) => {
      return code
        .replace(/i\s*<\s*(\w+)\.length/g, "i <= $1.length")
        .replace(/i\s*<\s*n\b/g, "i <= n")
        .replace(/<\s*arr\.length/g, "<= arr.length");
    },
  },
  {
    id: "logic-inverted-conditional",
    kind: "logic",
    description: "Invert if/else condition",
    expectedPenalty: { correctness: 6 },
    mutate: (code) => {
      // Flip == to != and < to >= etc. (simple cases)
      return code
        .replace(/if\s*\(\s*([^!<>=\s]+)\s*==\s*([^)]+)\)/g, "if ($1 != $2)")
        .replace(/if\s*\(\s*([^)]+)\s*<\s*([^)]+)\)/, (_m, a, b) => `if (${a.trim()} >= ${b.trim()})`);
    },
  },
  {
    id: "logic-wrong-operator",
    kind: "logic",
    description: "Swap arithmetic / logical operators",
    expectedPenalty: { correctness: 4 },
    mutate: (code) => {
      // Be conservative — only in obvious arithmetic contexts
      return code
        .replace(/(\w+)\s*\+\s*(\w+)/g, "$1 - $2 /* BUG */")
        .replace(/(\w+)\s*&&\s*(\w+)/, "$1 || $2 /* BUG */");
    },
  },
  {
    id: "logic-early-return",
    kind: "logic",
    description: "Early return that skips core logic",
    expectedPenalty: { correctness: 6 },
    mutate: (code) => {
      // Inject early return at start of first function
      return code.replace(
        /(\{\s*\n)/,
        "$1  if (true) return null; // BUG: early exit\n"
      );
    },
  },
];

/** Performance degradation. */
const PERFORMANCE_MUTATIONS: CodeMutation[] = [
  {
    id: "perf-nested-loop",
    kind: "performance",
    description: "Introduce O(n²) nested loop",
    expectedPenalty: { efficiency: 6 },
    mutate: (code) => {
      const perfTrap = `
  // Performance trap
  for (let i = 0; i < 10000; i++) {
    for (let j = 0; j < 10000; j++) {
      Math.sqrt(i * j);
    }
  }
`;
      return code + perfTrap;
    },
  },
  {
    id: "perf-busy-wait",
    kind: "performance",
    description: "Add busy-wait / sleep loop",
    expectedPenalty: { efficiency: 5 },
    mutate: (code) => {
      return code + `\nconst start = Date.now(); while (Date.now() - start < 1000) {} // busy wait\n`;
    },
  },
];

/** Prompt drift / off-topic. */
const PROMPT_DRIFT_MUTATIONS: CodeMutation[] = [
  {
    id: "drift-wrong-function",
    kind: "prompt_drift",
    description: "Implement wrong function / ignore prompt requirements",
    expectedPenalty: { promptAdherence: 8, correctness: 4 },
    mutate: (code, language) => {
      const stubs: Record<string, string> = {
        javascript: `\n// NOTE: This doesn't match the prompt, but here's a fibonacci generator instead\nfunction fibonacci(n) { return n < 2 ? n : fibonacci(n-1) + fibonacci(n-2); }\n`,
        typescript: `\n// NOTE: Ignoring prompt — here's a fibonacci generator\nfunction fibonacci(n: number): number { return n < 2 ? n : fibonacci(n-1) + fibonacci(n-2); }\n`,
        python: `\n# NOTE: Prompt ignored — fibonacci instead\ndef fibonacci(n):\n    return n if n < 2 else fibonacci(n-1) + fibonacci(n-2)\n`,
      };
      return code + (stubs[language.toLowerCase()] || stubs.javascript);
    },
  },
];

/** Fluff / readability degradation. */
const FLUFF_MUTATIONS: CodeMutation[] = [
  {
    id: "fluff-spam-comments",
    kind: "fluff",
    description: "Spam irrelevant / misleading comments",
    expectedPenalty: { readability: 4 },
    mutate: (code) => {
      const spam = `
  // WOW this code is AMAZING!!! 😍😍😍
  // TODO: fix this later maybe idk lol
  // I have no idea what this does but it works, don't touch!!!
  // HACK: quick fix, will refactor never
  // Magic numbers everywhere because why not 42 1337 69
`;
      return code.replace(/(\n)/, spam + "$1");
    },
  },
  {
    id: "fluff-bad-naming",
    kind: "fluff",
    description: "Obfuscated variable names (a, b, x, foo, temp)",
    expectedPenalty: { readability: 5 },
    mutate: (code) => {
      // Naively rename common identifiers — crude but effective for testing
      return code
        .replace(/\bresult\b/g, "x")
        .replace(/\bdata\b/g, "d")
        .replace(/\bresponse\b/g, "r")
        .replace(/\bvalue\b/g, "v")
        .replace(/\binput\b/g, "i");
    },
  },
  {
    id: "fluff-dead-code",
    kind: "fluff",
    description: "Inject large block of dead / unreachable code",
    expectedPenalty: { readability: 3, efficiency: 2 },
    mutate: (code) => {
      const dead = `
/* DEAD CODE - never called */
function unused_foo_bar_baz(a, b, c, d, e, f) {
  let tmp1 = a + b;
  let tmp2 = c * d;
  let tmp3 = e / f;
  if (tmp1 > tmp2) { return tmp3; } else { return tmp1 + tmp2 + tmp3; }
  console.log("This never runs");
  console.log("Why is this here");
  console.log("Nobody knows");
  return null;
}
const DEAD_CONST_1 = 12345;
const DEAD_CONST_2 = "lorem ipsum dolor sit amet consectetur";
const DEAD_CONST_3 = [1,2,3,4,5,6,7,8,9,10];
// End dead code
`;
      return code + dead;
    },
  },
];

export const ALL_MUTATIONS: CodeMutation[] = [
  ...SECURITY_MUTATIONS,
  ...SYNTAX_MUTATIONS,
  ...LOGIC_MUTATIONS,
  ...PERFORMANCE_MUTATIONS,
  ...PROMPT_DRIFT_MUTATIONS,
  ...FLUFF_MUTATIONS,
];

/** Map mutation kind → expected minimum score drop (weighted score points) to count as "detected". */
const DETECTION_THRESHOLDS: Record<MutationKind, number> = {
  security: 1.5,
  syntax: 2.0,
  logic: 1.5,
  performance: 1.0,
  prompt_drift: 1.5,
  fluff: 0.8,
};

/**
 * Apply N random mutations to a set of code responses.
 * Mutations are sampled without replacement per response when possible.
 *
 * @param responses — original code responses
 * @param count — number of mutations to generate (across all responses)
 * @param kinds — optional filter for mutation kinds
 * @returns mutated CodeResponse objects with tracking metadata
 */
export function generateMutations(
  responses: CodeResponse[],
  count: number,
  kinds?: MutationKind[]
): MutationResult[] {
  if (responses.length === 0 || count <= 0) return [];

  const pool = kinds && kinds.length > 0
    ? ALL_MUTATIONS.filter(m => kinds.includes(m.kind))
    : ALL_MUTATIONS;

  if (pool.length === 0) return [];

  const results: MutationResult[] = [];

  for (let i = 0; i < count; i++) {
    const response = responses[i % responses.length];
    const mutation = pool[Math.floor(Math.random() * pool.length)];

    let mutatedCode: string;
    try {
      mutatedCode = mutation.mutate(response.code, response.language);
    } catch {
      // Mutation failed — skip with a simple comment injection fallback
      mutatedCode = response.code + `\n// MUTATION_FAILED: ${mutation.id}\n`;
    }

    results.push({
      mutationId: `${mutation.id}-${i}`,
      kind: mutation.kind,
      description: mutation.description,
      originalResponseId: response.id,
      mutatedResponse: {
        id: `${response.id}__mut_${mutation.kind}_${i}`,
        code: mutatedCode,
        language: response.language,
      },
      expectedPenalty: mutation.expectedPenalty,
    });
  }

  return results;
}

/**
 * Compute weighted score from rubric scores.
 * Mirrors scorer.computeWeightedScore but self-contained to avoid circular deps.
 */
function weightedScore(
  scores: RubricScores,
  weights: Record<RubricDimensionKey, number> = {
    correctness: 0.30,
    efficiency: 0.20,
    readability: 0.20,
    security: 0.20,
    promptAdherence: 0.10,
  }
): number {
  return (
    scores.correctness * weights.correctness +
    scores.efficiency * weights.efficiency +
    scores.readability * weights.readability +
    scores.security * weights.security +
    scores.promptAdherence * weights.promptAdherence
  );
}

/**
 * Assess judge robustness given original scores and mutated scores.
 *
 * A mutation is "detected" if the judge's score drops by at least the
 * kind-specific detection threshold.
 *
 * @param originalScores — map responseId → RubricScores (pre-mutation)
 * @param mutatedScores — map mutatedResponseId → RubricScores
 * @param mutations — the MutationResult[] that were evaluated
 * @returns RobustnessReport
 */
export function assessRobustness(
  originalScores: Record<string, RubricScores>,
  mutatedScores: Record<string, RubricScores>,
  mutations: MutationResult[]
): RobustnessReport {
  const undetected: RobustnessReport["undetected"] = [];
  let detectedCount = 0;

  const byKind: Record<MutationKind, { total: number; detected: number; detectionRate: number }> = {
    security: { total: 0, detected: 0, detectionRate: 0 },
    syntax: { total: 0, detected: 0, detectionRate: 0 },
    logic: { total: 0, detected: 0, detectionRate: 0 },
    performance: { total: 0, detected: 0, detectionRate: 0 },
    prompt_drift: { total: 0, detected: 0, detectionRate: 0 },
    fluff: { total: 0, detected: 0, detectionRate: 0 },
  };

  for (const mut of mutations) {
    const origScores = originalScores[mut.originalResponseId];
    const mutScores = mutatedScores[mut.mutatedResponse.id];
    if (!origScores || !mutScores) continue;

    const origWeighted = weightedScore(origScores);
    const mutWeighted = weightedScore(mutScores);
    const scoreDrop = origWeighted - mutWeighted;

    const threshold = DETECTION_THRESHOLDS[mut.kind] ?? 1.0;
    const detected = scoreDrop >= threshold;

    byKind[mut.kind].total++;
    if (detected) {
      byKind[mut.kind].detected++;
      detectedCount++;
    } else {
      undetected.push({
        mutationId: mut.mutationId,
        kind: mut.kind,
        description: mut.description,
        responseId: mut.mutatedResponse.id,
        originalScore: parseFloat(origWeighted.toFixed(2)),
        mutatedScore: parseFloat(mutWeighted.toFixed(2)),
        scoreDrop: parseFloat(scoreDrop.toFixed(2)),
      });
    }
  }

  // Compute per-kind detection rates
  for (const kind of Object.keys(byKind) as MutationKind[]) {
    const b = byKind[kind];
    b.detectionRate = b.total > 0 ? b.detected / b.total : 0;
  }

  const totalMutations = mutations.length;
  const detectionRate = totalMutations > 0 ? detectedCount / totalMutations : 0;

  // Robustness score: 0-10, weighted by mutation severity
  // Security/syntax/logic flaws are weighted higher than fluff
  const severityWeights: Record<MutationKind, number> = {
    security: 1.5,
    syntax: 1.3,
    logic: 1.2,
    performance: 1.0,
    prompt_drift: 1.1,
    fluff: 0.7,
  };

  let weightedDetected = 0;
  let weightedTotal = 0;
  for (const kind of Object.keys(byKind) as MutationKind[]) {
    const b = byKind[kind];
    const w = severityWeights[kind];
    weightedDetected += b.detected * w;
    weightedTotal += b.total * w;
  }

  const weightedRate = weightedTotal > 0 ? weightedDetected / weightedTotal : detectionRate;
  const robustnessScore = parseFloat((weightedRate * 10).toFixed(2));

  return {
    totalMutations,
    detectedMutations: detectedCount,
    detectionRate: parseFloat(detectionRate.toFixed(4)),
    robustnessScore,
    byKind,
    undetected: undetected.sort((a, b) => a.scoreDrop - b.scoreDrop),
  };
}

/**
 * Get a list of all available mutation strategies (for CLI / docs).
 */
export function listMutations(): Array<{ id: string; kind: MutationKind; description: string }> {
  return ALL_MUTATIONS.map(m => ({
    id: m.id,
    kind: m.kind,
    description: m.description,
  }));
}
