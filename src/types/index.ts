// src/types/index.ts

export enum Confidence {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export interface RubricScores {
  correctness: number;       // 0-10
  efficiency: number;        // 0-10
  readability: number;       // 0-10
  security: number;          // 0-10
  promptAdherence: number;   // 0-10
}

export type RubricDimensionKey = keyof RubricScores;

export interface RubricDimension {
  key: RubricDimensionKey;
  label: string;
  description: string;
  minScore: number;
  maxScore: number;
  weight: number;
}

export interface RubricWeights {
  correctness: number;
  efficiency: number;
  readability: number;
  security: number;
  promptAdherence: number;
}

export const RUBRIC_DIMENSIONS: RubricDimension[] = [
  {
    key: "correctness",
    label: "Correctness",
    description: "Does the code solve the stated problem accurately? Functional completeness, edge case handling, logical accuracy.",
    minScore: 0,
    maxScore: 10,
    weight: 0.30,
  },
  {
    key: "efficiency",
    label: "Efficiency",
    description: "Is time and space complexity appropriate for the use case? Avoids unnecessary computation, uses optimal data structures.",
    minScore: 0,
    maxScore: 10,
    weight: 0.20,
  },
  {
    key: "readability",
    label: "Readability",
    description: "Clear naming, comments where needed, logical structure, consistent formatting, and maintainability.",
    minScore: 0,
    maxScore: 10,
    weight: 0.20,
  },
  {
    key: "security",
    label: "Security",
    description: "No obvious vulnerabilities, safe input handling, no hardcoded secrets, proper authentication/authorization.",
    minScore: 0,
    maxScore: 10,
    weight: 0.20,
  },
  {
    key: "promptAdherence",
    label: "Prompt Adherence",
    description: "Does the implementation match the exact requirements, constraints, and interface given in the prompt?",
    minScore: 0,
    maxScore: 10,
    weight: 0.10,
  },
];

export const DEFAULT_WEIGHTS: RubricWeights = {
  correctness: 0.30,
  efficiency: 0.20,
  readability: 0.20,
  security: 0.20,
  promptAdherence: 0.10,
};

export function getRubricDimension(key: RubricDimensionKey, dimensions: RubricDimension[] = RUBRIC_DIMENSIONS): RubricDimension {
  const dim = dimensions.find(d => d.key === key);
  if (!dim) throw new Error(`Unknown rubric dimension: ${key}`);
  return dim;
}

export function getRubricKeys(dimensions: RubricDimension[] = RUBRIC_DIMENSIONS): RubricDimensionKey[] {
  return dimensions.map(d => d.key);
}

export function buildWeights(dimensions: RubricDimension[]): RubricWeights {
  const w: Partial<RubricWeights> = {};
  for (const d of dimensions) {
    (w as any)[d.key] = d.weight;
  }
  return w as RubricWeights;
}

/**
 * Stable fingerprint of the active rubric schema — used for cache invalidation.
 * Bump RUBRIC_VERSION when dimension semantics change.
 */
export const RUBRIC_VERSION = "1.0.0";

export function getRubricFingerprint(dimensions: RubricDimension[] = RUBRIC_DIMENSIONS): string {
  return dimensions
    .map(d => `${d.key}:${d.minScore}-${d.maxScore}:${d.weight}:${d.label}`)
    .join("|");
}

/**
 * Validate a rubric definition.
 * - All 5 standard keys must be present exactly once
 * - Weights should sum to ~1.0 (±0.001)
 * - minScore < maxScore for each dimension
 */
export function validateRubric(dimensions: RubricDimension[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const expectedKeys: RubricDimensionKey[] = ["correctness", "efficiency", "readability", "security", "promptAdherence"];
  const seen = new Set<string>();

  for (const d of dimensions) {
    if (seen.has(d.key)) errors.push(`Duplicate rubric key: ${d.key}`);
    seen.add(d.key);
    if (!expectedKeys.includes(d.key)) errors.push(`Unknown rubric key: ${d.key}`);
    if (d.minScore >= d.maxScore) errors.push(`${d.key}: minScore (${d.minScore}) >= maxScore (${d.maxScore})`);
    if (d.weight < 0) errors.push(`${d.key}: negative weight ${d.weight}`);
    if (!d.label?.trim()) errors.push(`${d.key}: missing label`);
  }

  for (const k of expectedKeys) {
    if (!seen.has(k)) errors.push(`Missing required rubric key: ${k}`);
  }

  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 0.001) {
    errors.push(`Rubric weights sum to ${totalWeight}, expected 1.0`);
  }

  return { valid: errors.length === 0, errors };
}

export interface SecurityFlag {
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  lineHint?: string;
  description: string;
}

export interface CodeResponse {
  id: string;
  code: string;
  language: string;
}

export interface EvaluatedResponse {
  rank: number;
  responseId: string;
  weightedScore: number;
  scores: RubricScores;
  securityFlags: SecurityFlag[];
  justification: string;
}

export interface EvaluationTelemetry {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  cacheHits: number;
  cacheMisses: number;
  totalLatencyMs: number;
  /** Estimated cost in USD (OpenAI gpt-4o pricing: $2.50/1M input, $10/1M output). */
  estimatedCostUsd: number;
  /** Estimated cost saved via cache hits, USD. */
  estimatedSavingsUsd: number;
}

export interface EvaluationResult {
  taskId: string;
  prompt: string;
  evaluator: string;
  timestamp: string;
  rankings: EvaluatedResponse[];
  preferred: string;
  confidence: Confidence;
  notes?: string;
  /** Execution telemetry (populated when LLM judge is used). */
  telemetry?: EvaluationTelemetry;
  /** Rubric used for this evaluation (if custom). */
  rubric?: RubricDimension[];
}

export interface EvaluationInput {
  taskId: string;
  prompt: string;
  evaluator: string;
  responses: CodeResponse[];
  /** Manual rubric scores — if omitted, the LLM judge will auto-score. */
  manualScores?: Record<string, RubricScores>;
  /** Manual justifications — if omitted, the LLM judge will generate them. */
  justifications?: Record<string, string>;
  confidence?: Confidence;
  notes?: string;
  /** Enable LLM-as-a-Judge auto-scoring. Defaults to true when manualScores are missing. */
  autoJudge?: boolean;
  /** Optional judge provider override. */
  judgeProvider?: "openai" | "mock";
  /** Custom rubric dimensions. Defaults to RUBRIC_DIMENSIONS. */
  rubric?: RubricDimension[];
}

// ─── LLM Judge Types ─────────────────────────────────────────────────────────

export interface JudgeScorePayload {
  scores: RubricScores;
  justification: string;
}

export interface JudgeRequest {
  taskPrompt: string;
  responseId: string;
  code: string;
  language: string;
  rubricDimensions: RubricDimension[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface JudgeResult {
  responseId: string;
  scores: RubricScores;
  justification: string;
  rawProviderOutput?: unknown;
  fallbackUsed: boolean;
  latencyMs: number;
  /** Token usage (if reported by provider). */
  tokens?: TokenUsage;
  /** Whether this result was served from cache. */
  cacheHit: boolean;
  /** Estimated cost in USD for this single judgment. */
  costUsd?: number;
}

export interface JudgeProviderConfig {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

export interface JudgeProvider {
  readonly name: string;
  score(request: JudgeRequest, config?: JudgeProviderConfig): Promise<JudgeResult>;
}

// ─── Config / Suite Runner Types ─────────────────────────────────────────────

export interface EvaluatorSuiteConfig {
  /** Human-readable suite name (used in aggregated reports). */
  name: string;
  /** Glob(s) matching EvaluationInput JSON files. */
  inputs: string | string[];
  /** Path to a custom rubric JSON file (array of RubricDimension). */
  rubric?: string;
  /** Minimum weighted score threshold — failing responses cause exit code 1. */
  minScore?: number;
  /** Maximum allowed regression per dimension vs baseline. */
  maxRegression?: number;
  /** Path to baseline EvaluationResult JSON for regression comparison. */
  baseline?: string;
}

export interface EvaluatorConfig {
  /** List of evaluation suites to run. */
  suites: EvaluatorSuiteConfig[];
  /** Output directory for exported files. Default: ./output */
  outputDir?: string;
  /** Export format for suite results. Default: "md" */
  exportFormat?: "json" | "csv" | "md" | "markdown";
  /** Stop on first failing suite (default false — run all suites). */
  failFast?: boolean;
  /** Max concurrent suites (default unlimited — LLM_MAX_CONCURRENCY still throttles API calls). */
  maxConcurrency?: number;
}
