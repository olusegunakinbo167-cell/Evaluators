// src/components/llm/openaiProvider.ts
/**
 * OpenAI-compatible JudgeProvider — uses Structured Outputs for type safety.
 * Supports custom baseURL for Ollama, vLLM, OpenRouter, etc.
 */

import { JudgeRequest, JudgeResult, JudgeProviderConfig, RubricScores, LlmEndpointConfig } from "../../types";
import { JudgeProvider, validateJudgeScores, buildFallbackResult, estimateCostUsd } from "./judgeProvider";
import { buildJudgePrompt } from "./promptBuilder";
import { chatCompletions, resolveLlmConfig } from "./llmClient";

export class OpenAIJudgeProvider implements JudgeProvider {
  readonly name = "openai";

  async score(request: JudgeRequest, config?: JudgeProviderConfig): Promise<JudgeResult> {
    const started = Date.now();

    // Resolve full LLM config (baseURL, apiKey, headers, retries, etc.)
    const llmConfig = resolveLlmConfig(config as LlmEndpointConfig | undefined);

    // API key is optional for local endpoints (Ollama, etc.)
    const needsAuth = llmConfig.baseURL.includes("openai.com") ||
                      llmConfig.baseURL.includes("openrouter.ai");

    if (needsAuth && !llmConfig.apiKey) {
      const keyEnv = (config as LlmEndpointConfig | undefined)?.apiKeyEnv ?? "OPENAI_API_KEY";
      return buildFallbackResult(
        request.responseId,
        Date.now() - started,
        `${keyEnv} not configured for ${llmConfig.baseURL}`
      );
    }

    const prompt = buildJudgePrompt(request);

    try {
      const body = await chatCompletions(
        {
          model: llmConfig.model,
          temperature: llmConfig.temperature,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: prompt.jsonSchema,
          },
        },
        config
      );

      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return buildFallbackResult(
          request.responseId,
          Date.now() - started,
          "LLM response missing message content"
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
      let tokens;
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
      // llmClient already exhausted retries at the HTTP layer
      const msg = err?.message ?? String(err);
      return buildFallbackResult(
        request.responseId,
        Date.now() - started,
        `LLM request failed: ${msg}`
      );
    }
  }
}
