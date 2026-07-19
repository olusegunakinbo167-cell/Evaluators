// tests/securityScanner.extended.test.ts

import { scanForSecurityIssues, formatSecurityReport } from "../src/components/securityScanner";

describe("securityScanner extended", () => {
  const cases: Array<[string, string, string]> = [
    ["SQL_INJECTION", 'pool.query(`SELECT * FROM users WHERE id = ${id}`)', "CRITICAL"],
    ["HARDCODED_PASSWORD", 'const password = "abc123"', "CRITICAL"],
    ["HARDCODED_API_KEY", 'const api_key = "ABCDEFGH12345678"', "CRITICAL"],
    ["UNSAFE_EVAL", "eval(userInput)", "HIGH"],
    ["XSS_RISK", "el.innerHTML = userData", "HIGH"],
    ["SENSITIVE_LOG", "console.log('password:', pw)", "MEDIUM"],
    ["INSECURE_HTTP", 'fetch("http://example.com")', "MEDIUM"],
    ["EMPTY_CATCH", "catch (e) {}", "LOW"],
    ["WEAK_RANDOM", "const token = Math.random()", "LOW"],
  ];

  test.each(cases)("%s detection", (type, code, severity) => {
    const flags = scanForSecurityIssues(code);
    const found = flags.find(f => f.type === type);
    expect(found).toBeDefined();
    expect(found!.severity).toBe(severity);
  });

  it("returns empty for localhost http", () => {
    const flags = scanForSecurityIssues('fetch("http://localhost:3000")');
    expect(flags.find(f => f.type === "INSECURE_HTTP")).toBeUndefined();
  });

  it("formatSecurityReport clean output", () => {
    expect(formatSecurityReport([])).toContain("No security issues");
    const report = formatSecurityReport([
      { type: "X", severity: "HIGH", description: "bad", lineHint: "foo" },
    ]);
    expect(report).toContain("[HIGH]");
    expect(report).toContain("bad");
    expect(report).toContain("foo");
  });
});
