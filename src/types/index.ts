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

export function getRubricDimension(key: RubricDimensionKey): RubricDimension {
  const dim = RUBRIC_DIMENSIONS.find(d => d.key === key);
  if (!dim) throw new Error(`Unknown rubric dimension: ${key}`);
  return dim;
}

export function getRubricKeys(): RubricDimensionKey[] {
  return RUBRIC_DIMENSIONS.map(d => d.key);
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
