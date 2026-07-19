// src/components/llm/openaiProvider.ts
/**
 * OpenAI concrete JudgeProvider — uses Structured Outputs for type safety.
 */

import { JudgeRequest, JudgeResult, JudgeProviderConfig, RubricScores, TokenUsage } from "../../types";
import { JudgeProvider, validateJudgeScores, buildFallbackResult, estimateCostUsd } from "./judgeProvider";
import { buildJudgePrompt } from "./promptBuilder";

const DEFAULT_MODEL = "gpt-4o-2024-08-06";
const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenAIJudgeProvider implements JudgeProvider {
  readonly name = "openai";

  async score(request: JudgeRequest, config?: JudgeProviderConfig): Promise<JudgeResult> {
    const started = Date.now();
    const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY;
    const model = config?.model ?? process.env.OPENAI_JUDGE_MODEL ?? DEFAULT_MODEL;
    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!apiKey) {
      return buildFallbackResult(
        request.responseId,
        Date.now() - started,
        "OPENAI_API_KEY not configured"
      );
    }

    const prompt = buildJudgePrompt(request);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: config?.temperature ?? 0,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: prompt.jsonSchema,
          },
        }),
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return buildFallbackResult(
          request.responseId,
          Date.now() - started,
          `OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`
        );
      }

      const body = await res.json() as any;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return buildFallbackResult(
          request.responseId,
          Date.now() - started,
          "OpenAI response missing message content"
        );
      }

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (e: any) {
        return buildFallbackResult(
          request.responseId,
          Date.now() - started,
          `JSON parse failed: ${e?.message ?? e}`
        );
      }

      let scores: RubricScores;
      try {
        scores = validateJudgeScores(parsed.scores, request.rubricDimensions);
      } catch (e: any) {
        return buildFallbackResult(
          request.responseId,
          Date.now() - started,
          `Score validation failed: ${e?.message ?? e}`
        );
      }

      const justification =
        typeof parsed.justification === "string" && parsed.justification.trim().length > 0
          ? parsed.justification.trim()
          : "LLM judge returned no justification.";

      // Token usage telemetry
      const usage = body?.usage;
      let tokens: TokenUsage | undefined;
      let costUsd: number | undefined;
      if (usage && typeof usage.prompt_tokens === "number") {
        tokens = {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0)),
        };
        costUsd = estimateCostUsd(tokens);
      }

      return {
        responseId: request.responseId,
        scores,
        justification,
        rawProviderOutput: parsed,
        fallbackUsed: false,
        latencyMs: Date.now() - started,
        cacheHit: false,
        tokens,
        costUsd,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      const isTimeout = err?.name === "AbortError";
      return buildFallbackResult(
        request.responseId,
        Date.now() - started,
        isTimeout ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err))
      );
    }
  }
}
