// tests/github.test.ts

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isGitHubActions,
  formatWorkflowAnnotation,
  emitThresholdAnnotations,
  emitRegressionAnnotations,
  appendStepSummary,
  buildPrCommentBody,
  postPrComment,
} from "../src/utils/github";
import { EvaluationResult, Confidence } from "../src/types";
import { ThresholdViolation, RegressionViolation } from "../src/components/evaluator";

function makeResult(): EvaluationResult {
  return {
    taskId: "GH-TEST",
    prompt: "test",
    evaluator: "ci",
    timestamp: "2024-01-01T00:00:00Z",
    preferred: "A",
    confidence: Confidence.HIGH,
    rankings: [{
      rank: 1, responseId: "A", weightedScore: 8.5,
      scores: { correctness: 8, efficiency: 8, readability: 9, security: 9, promptAdherence: 8 },
      securityFlags: [], justification: "good",
    }],
    telemetry: {
      totalPromptTokens: 500,
      totalCompletionTokens: 100,
      totalTokens: 600,
      cacheHits: 1,
      cacheMisses: 2,
      totalLatencyMs: 300,
      estimatedCostUsd: 0.00225,
      estimatedSavingsUsd: 0.001,
    },
  };
}

describe("isGitHubActions", () => {
  const OLD = process.env.GITHUB_ACTIONS;
  afterEach(() => { if (OLD === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = OLD; });

  it("detects true/1", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(isGitHubActions()).toBe(true);
    process.env.GITHUB_ACTIONS = "1";
    expect(isGitHubActions()).toBe(true);
  });

  it("returns false when unset", () => {
    delete process.env.GITHUB_ACTIONS;
    expect(isGitHubActions()).toBe(false);
  });
});

describe("formatWorkflowAnnotation", () => {
  it("formats error with file and line", () => {
    const out = formatWorkflowAnnotation("error", "Score dropped", { file: "src/foo.ts", line: 42 });
    expect(out).toBe("::error file=src/foo.ts,line=42::Score dropped");
  });

  it("escapes newlines and special chars in message", () => {
    const out = formatWorkflowAnnotation("warning", "a\nb\rc", {});
    expect(out).toContain("a%0Ab%0Dc");
  });

  it("escapes colons and commas in file property", () => {
    const out = formatWorkflowAnnotation("error", "x", { file: "a:b,c", title: "t:t" });
    expect(out).toContain("file=a%3Ab%2Cc");
    expect(out).toContain("title=t%3At");
  });

  it("includes optional col/endLine/endColumn/title", () => {
    const out = formatWorkflowAnnotation("notice", "m", {
      file: "f", line: 1, endLine: 2, col: 3, endColumn: 4, title: "hi",
    });
    expect(out).toContain("file=f");
    expect(out).toContain("line=1");
    expect(out).toContain("endLine=2");
    expect(out).toContain("col=3");
    expect(out).toContain("endColumn=4");
    expect(out).toContain("title=hi");
  });
});

describe("emitThresholdAnnotations / emitRegressionAnnotations", () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => { logSpy = jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it("emits ::error for threshold violations", () => {
    const violations: ThresholdViolation[] = [
      { responseId: "A", weightedScore: 5, minScore: 7.5, delta: -2.5 },
    ];
    emitThresholdAnnotations(violations, "eval.json");
    expect(logSpy).toHaveBeenCalled();
    const call = logSpy.mock.calls[0][0] as string;
    expect(call).toContain("::error");
    expect(call).toContain("file=eval.json");
    expect(call).toContain("Threshold violation");
    expect(call).toContain("A");
  });

  it("emits ::error for regression violations", () => {
    const violations: RegressionViolation[] = [{
      responseId: "B", dimension: "security", current: 4, baseline: 9,
      delta: -5, allowedRegression: 0,
    }];
    emitRegressionAnnotations(violations, "x.json");
    const call = logSpy.mock.calls[0][0] as string;
    expect(call).toContain("::error");
    expect(call).toContain("Regression");
    expect(call).toContain("security");
  });
});

describe("appendStepSummary", () => {
  const OLD_ENV = { ...process.env };
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `gh-summary-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, "");
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_STEP_SUMMARY = tmpFile;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */}
  });

  it("appends markdown to $GITHUB_STEP_SUMMARY when in GH Actions", () => {
    const ok = appendStepSummary("## Hello\nTest content");
    expect(ok).toBe(true);
    const content = fs.readFileSync(tmpFile, "utf-8");
    expect(content).toContain("Hello");
    expect(content).toContain("Test content");
  });

  it("returns false when GITHUB_ACTIONS is not set", () => {
    delete process.env.GITHUB_ACTIONS;
    expect(appendStepSummary("x")).toBe(false);
  });

  it("returns false when GITHUB_STEP_SUMMARY is missing", () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(appendStepSummary("x")).toBe(false);
  });
});

describe("buildPrCommentBody", () => {
  it("includes rankings table and telemetry", () => {
    const result = makeResult();
    const body = buildPrCommentBody(result, [], []);
    expect(body).toContain("AI Code Evaluator");
    expect(body).toContain("GH-TEST");
    expect(body).toContain("| Rank | Response | Score |");
    expect(body).toContain("✅"); // status emoji
    expect(body).toContain("Tokens: 600");
    expect(body).toContain("Cache:");
  });

  it("includes threshold failure callout", () => {
    const result = makeResult();
    const body = buildPrCommentBody(result, [
      { responseId: "A", weightedScore: 4, minScore: 7, delta: -3 },
    ], []);
    expect(body).toContain("❌");
    expect(body).toContain("Threshold violations");
    expect(body).toContain("A");
  });

  it("includes regression failure callout", () => {
    const result = makeResult();
    const body = buildPrCommentBody(result, [], [{
      responseId: "X", dimension: "readability", current: 3, baseline: 8,
      delta: -5, allowedRegression: 0,
    }]);
    expect(body).toContain("Regression violations");
    expect(body).toContain("readability");
  });
});

describe("postPrComment", () => {
  const OLD_ENV = { ...process.env };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("should be mocked per test");
    });
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    fetchMock.mockRestore();
    jest.restoreAllMocks();
  });

  it("returns null when GITHUB_TOKEN is missing", async () => {
    delete process.env.GITHUB_TOKEN;
    const url = await postPrComment("test body", {
      repository: "owner/repo",
      prNumber: 123,
      token: undefined,
    });
    expect(url).toBeNull();
  });

  it("returns null when repo/PR context is missing", async () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_EVENT_PATH;
    const url = await postPrComment("x", { token: "gh_test" });
    expect(url).toBeNull();
  });

  it("creates new comment when no existing evaluator comment found", async () => {
    fetchMock.mockImplementation(async (url: any, opts: any) => {
      const u = String(url);
      if (opts?.method === "POST" && u.includes("/issues/42/comments")) {
        return { ok: true, json: async () => ({ html_url: "https://github.com/o/r/pull/42#issuecomment-1" }) } as any;
      }
      // list comments — empty
      if (u.includes("/issues/42/comments") && (!opts?.method || opts.method === "GET")) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: false } as any;
    });

    const url = await postPrComment("test body", {
      token: "gh_test",
      repository: "owner/repo",
      prNumber: 42,
    });
    expect(url).toContain("issuecomment");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("updates existing comment instead of creating new one", async () => {
    fetchMock.mockImplementation(async (url: any, opts: any) => {
      const u = String(url);
      if (u.includes("/issues/comments/999")) {
        expect(opts?.method).toBe("PATCH");
        const body = JSON.parse(opts.body);
        expect(body.body).toContain("<!-- evaluators-pr-comment -->");
        return { ok: true, json: async () => ({ html_url: "https://github.com/o/r/pull/5#issuecomment-999" }) } as any;
      }
      if (u.includes("/issues/5/comments")) {
        return { ok: true, json: async () => [
          { id: 999, body: "<!-- evaluators-pr-comment -->\nold", user: { type: "Bot", login: "x" } },
        ] } as any;
      }
      return { ok: false } as any;
    });

    const url = await postPrComment("new body", {
      token: "t", repository: "o/r", prNumber: 5,
    });
    expect(url).toContain("issuecomment-999");
  });

  it("detects PR number from GITHUB_EVENT_PATH", async () => {
    const eventFile = path.join(os.tmpdir(), `gh-event-${Date.now()}.json`);
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 77 } }));
    process.env.GITHUB_EVENT_PATH = eventFile;
    process.env.GITHUB_REPOSITORY = "acme/widgets";

    fetchMock.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/issues/77/comments")) {
        return { ok: true, json: async () => [] } as any;
      }
      if (u.includes("/acme/widgets/issues/77/comments")) {
        return { ok: true, json: async () => ({ html_url: "http://x" }) } as any;
      }
      return { ok: false } as any;
    });

    await postPrComment("x", { token: "t" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/acme/widgets/issues/77/comments"),
      expect.anything()
    );
    fs.unlinkSync(eventFile);
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_REPOSITORY;
  });
});
