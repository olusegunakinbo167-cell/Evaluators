// src/components/securityScanner.ts

import { SecurityFlag } from "../types";

interface ScanRule {
  pattern: RegExp;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
}

const SCAN_RULES: ScanRule[] = [
  {
    pattern: /`.*SELECT.*\$\{.*\}.*`|`.*INSERT.*\$\{.*\}.*`|`.*DELETE.*\$\{.*\}.*`/i,
    type: "SQL_INJECTION",
    severity: "CRITICAL",
    description: "SQL query built with string interpolation — SQL injection risk.",
  },
  {
    pattern: /password\s*=\s*["'][^"']{3,}["']/i,
    type: "HARDCODED_PASSWORD",
    severity: "CRITICAL",
    description: "Hardcoded password detected in source code.",
  },
  {
    pattern: /api[_-]?key\s*=\s*["'][A-Za-z0-9]{8,}["']/i,
    type: "HARDCODED_API_KEY",
    severity: "CRITICAL",
    description: "Hardcoded API key detected — should use environment variables.",
  },
  {
    pattern: /\beval\s*\(/,
    type: "UNSAFE_EVAL",
    severity: "HIGH",
    description: "Use of eval() is dangerous and may allow arbitrary code execution.",
  },
  {
    pattern: /innerHTML\s*=\s*[^"'`]/,
    type: "XSS_RISK",
    severity: "HIGH",
    description: "Unsanitized innerHTML assignment — potential XSS vulnerability.",
  },
  {
    pattern: /console\.log\s*\(.*password|console\.log\s*\(.*token|console\.log\s*\(.*secret/i,
    type: "SENSITIVE_LOG",
    severity: "MEDIUM",
    description: "Sensitive data (password/token/secret) may be logged to console.",
  },
  {
    pattern: /http:\/\/(?!localhost)/i,
    type: "INSECURE_HTTP",
    severity: "MEDIUM",
    description: "Insecure HTTP protocol used — prefer HTTPS.",
  },
  {
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    type: "EMPTY_CATCH",
    severity: "LOW",
    description: "Empty catch block swallows errors silently.",
  },
  {
    pattern: /Math\.random\(\)/,
    type: "WEAK_RANDOM",
    severity: "LOW",
    description: "Math.random() is not cryptographically secure — use crypto.randomBytes() for tokens.",
  },
];

/**
 * Scans a code string for security issues using pattern matching.
 * Returns an array of SecurityFlag objects.
 */
export function scanForSecurityIssues(code: string): SecurityFlag[] {
  const flags: SecurityFlag[] = [];

  for (const rule of SCAN_RULES) {
    const match = code.match(rule.pattern);
    if (match) {
      flags.push({
        type: rule.type,
        severity: rule.severity,
        lineHint: match[0].trim().substring(0, 80),
        description: rule.description,
      });
    }
  }

  return flags;
}

/**
 * Returns a human-readable summary of all security flags.
 */
export function formatSecurityReport(flags: SecurityFlag[]): string {
  if (flags.length === 0) return "✅ No security issues detected.";

  return flags
    .map(
      (f) =>
        `[${f.severity}] ${f.type}: ${f.description}` +
        (f.lineHint ? `\n   → Near: "${f.lineHint}"` : "")
    )
    .join("\n");
}
