// tests/securityScanner.test.ts

import { scanForSecurityIssues } from "../src/components/securityScanner";

describe("scanForSecurityIssues", () => {
  it("detects SQL injection via string interpolation", () => {
    const code = 'pool.query(`SELECT * FROM users WHERE id = ${id}`)';
    const flags = scanForSecurityIssues(code);
    expect(flags.some((f) => f.type === "SQL_INJECTION")).toBe(true);
    expect(flags.find((f) => f.type === "SQL_INJECTION")?.severity).toBe("CRITICAL");
  });

  it("detects hardcoded password", () => {
    const code = 'const password = "superSecret123";';
    const flags = scanForSecurityIssues(code);
    expect(flags.some((f) => f.type === "HARDCODED_PASSWORD")).toBe(true);
  });

  it("detects unsafe eval usage", () => {
    const code = "const result = eval(userInput);";
    const flags = scanForSecurityIssues(code);
    expect(flags.some((f) => f.type === "UNSAFE_EVAL")).toBe(true);
  });

  it("detects XSS risk with innerHTML", () => {
    const code = "element.innerHTML = userInput;";
    const flags = scanForSecurityIssues(code);
    expect(flags.some((f) => f.type === "XSS_RISK")).toBe(true);
  });

  it("detects insecure HTTP URL", () => {
    const code = 'fetch("http://api.example.com/data")';
    const flags = scanForSecurityIssues(code);
    expect(flags.some((f) => f.type === "INSECURE_HTTP")).toBe(true);
  });

  it("returns no flags for safe code", () => {
    const code = `
      async function getUser(id) {
        const result = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [id]
        );
        return result.rows[0] ?? null;
      }
    `;
    const flags = scanForSecurityIssues(code);
    expect(flags).toHaveLength(0);
  });

  it("detects multiple issues in one code block", () => {
    const code = `
      const password = "hardcoded123";
      const result = eval(input);
      pool.query(\`SELECT * FROM users WHERE id = \${id}\`);
    `;
    const flags = scanForSecurityIssues(code);
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});
