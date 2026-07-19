// tests/openaiProvider.test.ts

import { OpenAIJudgeProvider } from "../src/components/llm/openaiProvider";
import { RUBRIC_DIMENSIONS, JudgeRequest } from "../src/types";

const baseRequest: JudgeRequest = {
  taskPrompt: "test",
  responseId: "R1",
  code: "const x = 1",
  language: "javascript",
  rubricDimensions: RUBRIC_DIMENSIONS,
};

describe("OpenAIJudgeProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch as any;
    delete process.env.OPENAI_API_KEY;
  });

  it("falls back when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: undefined });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toContain("OPENAI_API_KEY not configured");
  });

  it("falls back on HTTP error", async () => {
    global.fetch = async () => ({
      ok: false, status: 500,
      text: async () => "server error",
    } as any);

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test" });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toContain("HTTP 500");
  });

  it("falls back on invalid JSON", async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json {{{" } }] }),
    } as any);

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test" });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toContain("JSON parse failed");
  });

  it("falls back on score validation failure", async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          scores: { correctness: 999, efficiency: 0, readability: 0, security: 0, promptAdherence: 0 },
          justification: "bad",
        }) } }],
      }),
    } as any);

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test" });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toContain("Score validation failed");
  });

  it("falls back when message content is missing", async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    } as any);

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test" });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toContain("missing message content");
  });

  it("successfully parses valid structured output", async () => {
    const payload = {
      scores: { correctness: 8, efficiency: 7, readability: 9, security: 6, promptAdherence: 8 },
      justification: "Well structured, minor security note.",
    };
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as any);

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test" });
    expect(r.fallbackUsed).toBe(false);
    expect(r.scores.correctness).toBe(8);
    expect(r.justification).toBe(payload.justification);
    expect(r.rawProviderOutput).toEqual(payload);
  });

  it("falls back on fetch abort / timeout", async () => {
    global.fetch = async (_url: any, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as any).name = "AbortError";
          reject(e);
        });
      });
    };

    const p = new OpenAIJudgeProvider();
    const r = await p.score(baseRequest, { apiKey: "sk-test", timeoutMs: 10 });
    expect(r.fallbackUsed).toBe(true);
    expect(r.justification).toMatch(/timed out|abort/i);
  });
});
