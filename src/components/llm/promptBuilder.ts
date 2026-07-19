// src/components/llm/promptBuilder.ts
/**
 * Dynamic prompt generation for LLM-as-a-Judge.
 * Extracts active rubric schema, dimension keys, scoring bounds, and label text
 * into clean system instructions.
 */

import { RubricDimension, JudgeRequest } from "../../types";

export interface BuiltPrompt {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
}

/**
 * Build a structured-output judge prompt from an active rubric.
 */
export function buildJudgePrompt(request: JudgeRequest): BuiltPrompt {
  const { rubricDimensions, taskPrompt, code, language, responseId } = request;

  const rubricTable = rubricDimensions.map(d =>
    `  - ${d.key} (${d.label}): ${d.description}  [${d.minScore}–${d.maxScore}, weight=${d.weight}]`
  ).join("\n");

  const scoreKeys = rubricDimensions.map(d => `      "${d.key}": <number ${d.minScore}-${d.maxScore}>`).join(",\n");

  const system = [
    "You are an expert code quality evaluator for RLHF / preference-ranking data labeling.",
    "",
    "Your job: score a single AI-generated code response against a structured rubric.",
    "",
    "RUBRIC DIMENSIONS",
    rubricTable,
    "",
    "SCORING RULES",
    "  - Each dimension is scored on its declared min–max range (inclusive).",
    "  - Be calibrated and consistent. Use the full scale.",
    "  - Justify your scores with specific, code-grounded reasoning.",
    "  - Do NOT score on dimensions outside the rubric.",
    "  - Return STRICTLY valid JSON matching the provided schema.",
    "",
    "OUTPUT SCHEMA",
    '  {',
    '    "scores": {',
    scoreKeys,
    '    },',
    '    "justification": "<concise technical justification referencing specific code behaviors, 1-3 sentences>"',
    '  }',
  ].join("\n");

  const user = [
    `Task prompt: ${taskPrompt}`,
    "",
    `Response ID: ${responseId}`,
    `Language: ${language}`,
    "",
    "Code under evaluation:",
    "```" + language,
    code,
    "```",
    "",
    "Return your evaluation as JSON only."
  ].join("\n");

  // OpenAI Structured Outputs JSON Schema
  const properties: Record<string, { type: string; minimum?: number; maximum?: number }> = {};
  for (const dim of rubricDimensions) {
    properties[dim.key] = {
      type: "number",
      minimum: dim.minScore,
      maximum: dim.maxScore,
    };
  }

  const jsonSchema = {
    name: "CodeQualityJudgement",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scores: {
          type: "object",
          additionalProperties: false,
          properties,
          required: rubricDimensions.map(d => d.key),
        },
        justification: { type: "string" },
      },
      required: ["scores", "justification"],
    },
  };

  return { system, user, jsonSchema };
}
