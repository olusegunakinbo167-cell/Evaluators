/**
 * Evaluator config file loader with glob support.
 */

import * as fs from "fs";
import * as path from "path";
import {
  EvaluatorConfig,
  EvaluatorSuiteConfig,
  LlmEndpointConfig,
  RubricDimension,
  validateRubric,
} from "../types";

export interface ResolvedSuiteConfig extends Omit<EvaluatorSuiteConfig, "inputs" | "rubric"> {
  name: string;
  inputFiles: string[];
  rubricPath?: string;
  rubric?: RubricDimension[];
  /** Resolved LLM endpoint config (suite-level overrides global). */
  llm?: LlmEndpointConfig;
}

export interface ResolvedEvaluatorConfig {
  suites: ResolvedSuiteConfig[];
  outputDir: string;
  exportFormat: "json" | "csv" | "md" | "markdown";
  failFast: boolean;
  maxConcurrency?: number;
  /** Global LLM endpoint config. */
  llm?: LlmEndpointConfig;
}

/**
 * Simple glob matcher — supports * and ** patterns.
 * For a production system you'd use fast-glob, but we keep deps minimal.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function walkFiles(dir: string, baseDir: string = dir): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(full, baseDir));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(path.relative(baseDir, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function expandGlob(pattern: string, cwd: string): string[] {
  // Simple glob expansion — handles *, **, and literal paths
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const full = path.resolve(cwd, pattern);
    return fs.existsSync(full) ? [full] : [];
  }

  const absPattern = path.resolve(cwd, pattern);
  const baseDir = absPattern.split("*")[0].replace(/\/[^/]*$/, "") || cwd;
  const searchDir = fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()
    ? baseDir
    : cwd;

  const allFiles = walkFiles(searchDir, searchDir).map(f => path.join(searchDir, f));
  const re = globToRegExp(absPattern);

  return allFiles.filter(f => re.test(f));
}

export function expandInputs(
  inputs: string | string[],
  cwd: string = process.cwd()
): string[] {
  const patterns = Array.isArray(inputs) ? inputs : [inputs];
  const files = new Set<string>();
  for (const pat of patterns) {
    for (const f of expandGlob(pat, cwd)) {
      files.add(path.resolve(f));
    }
  }
  return Array.from(files).sort();
}

export function loadRubricFile(rubricPath: string): RubricDimension[] {
  const full = path.resolve(rubricPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Rubric file not found: ${rubricPath}`);
  }
  const raw = fs.readFileSync(full, "utf-8");
  const data = JSON.parse(raw) as RubricDimension[];
  const { valid, errors } = validateRubric(data);
  if (!valid) {
    throw new Error(`Invalid rubric at ${rubricPath}:\n  - ${errors.join("\n  - ")}`);
  }
  return data;
}

/**
 * Merge two LLM endpoint configs — child overrides parent.
 * Headers are deep-merged (child keys override parent keys).
 */
export function mergeLlmConfig(
  parent?: LlmEndpointConfig,
  child?: LlmEndpointConfig
): LlmEndpointConfig | undefined {
  if (!parent && !child) return undefined;
  return {
    ...parent,
    ...child,
    headers: {
      ...(parent?.headers ?? {}),
      ...(child?.headers ?? {}),
    },
  };
}

/**
 * Validate an LLM endpoint config object.
 * Returns an array of error messages (empty = valid).
 */
export function validateLlmConfig(
  llm: LlmEndpointConfig | undefined,
  context: string
): string[] {
  if (!llm) return [];
  const errors: string[] = [];

  if (llm.baseURL !== undefined) {
    try {
      const u = new URL(llm.baseURL);
      if (!["http:", "https:"].includes(u.protocol)) {
        errors.push(`${context}: llm.baseURL must be http:// or https:// (got ${llm.baseURL})`);
      }
    } catch {
      errors.push(`${context}: llm.baseURL is not a valid URL: ${llm.baseURL}`);
    }
  }

  if (llm.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/i.test(llm.apiKeyEnv)) {
    errors.push(`${context}: llm.apiKeyEnv must be a valid environment variable name`);
  }

  if (llm.headers !== undefined) {
    if (typeof llm.headers !== "object" || Array.isArray(llm.headers)) {
      errors.push(`${context}: llm.headers must be an object`);
    } else {
      for (const [k, v] of Object.entries(llm.headers)) {
        if (typeof v !== "string") {
          errors.push(`${context}: llm.headers["${k}"] must be a string`);
        }
      }
    }
  }

  if (llm.timeoutMs !== undefined && (llm.timeoutMs < 100 || llm.timeoutMs > 600_000)) {
    errors.push(`${context}: llm.timeoutMs must be between 100 and 600000`);
  }

  if (llm.maxRetries !== undefined && (llm.maxRetries < 0 || llm.maxRetries > 20)) {
    errors.push(`${context}: llm.maxRetries must be between 0 and 20`);
  }

  return errors;
}

export function loadEvaluatorConfig(configPath?: string): ResolvedEvaluatorConfig {
  const candidates = [
    configPath,
    "evaluators.config.json",
    ".evaluators.json",
  ].filter(Boolean) as string[];

  let foundPath: string | undefined;
  for (const p of candidates) {
    if (fs.existsSync(p)) { foundPath = p; break; }
  }

  if (!foundPath) {
    throw new Error(
      `Config file not found. Tried: ${candidates.join(", ")}\n` +
      `Run with --eval <input.json> for single-file mode, or create evaluators.config.json`
    );
  }

  const configDir = path.dirname(path.resolve(foundPath));
  const raw = fs.readFileSync(foundPath, "utf-8");
  const config = JSON.parse(raw) as EvaluatorConfig;

  if (!Array.isArray(config.suites) || config.suites.length === 0) {
    throw new Error(`Config ${foundPath}: "suites" must be a non-empty array`);
  }

  // Validate global LLM config
  const globalLlmErrors = validateLlmConfig(config.llm, "config.llm");
  if (globalLlmErrors.length > 0) {
    throw new Error(`Config ${foundPath} LLM validation failed:\n  - ${globalLlmErrors.join("\n  - ")}`);
  }

  const suites: ResolvedSuiteConfig[] = [];

  for (const [idx, suite] of config.suites.entries()) {
    if (!suite.name) throw new Error(`Suite[${idx}]: missing "name"`);
    if (!suite.inputs) throw new Error(`Suite "${suite.name}": missing "inputs"`);

    const inputFiles = expandInputs(suite.inputs, configDir);
    if (inputFiles.length === 0) {
      throw new Error(`Suite "${suite.name}": inputs glob matched 0 files: ${JSON.stringify(suite.inputs)}`);
    }

    let rubric: RubricDimension[] | undefined;
    if (suite.rubric) {
      const rubricPath = path.resolve(configDir, suite.rubric);
      rubric = loadRubricFile(rubricPath);
    }

    // Validate suite-level LLM config
    const suiteLlmErrors = validateLlmConfig(suite.llm, `suites["${suite.name}"].llm`);
    if (suiteLlmErrors.length > 0) {
      throw new Error(`Config ${foundPath} LLM validation failed:\n  - ${suiteLlmErrors.join("\n  - ")}`);
    }

    // Merge global LLM config with suite-level override
    const llm = mergeLlmConfig(config.llm, suite.llm);

    suites.push({
      name: suite.name,
      inputFiles,
      rubricPath: suite.rubric,
      rubric,
      minScore: suite.minScore,
      maxRegression: suite.maxRegression,
      baseline: suite.baseline ? path.resolve(configDir, suite.baseline) : undefined,
      samples: suite.samples,
      maxVariance: suite.maxVariance,
      llm,
    });
  }

  return {
    suites,
    outputDir: config.outputDir ?? "./output",
    exportFormat: (config.exportFormat ?? "md") as "json" | "csv" | "md" | "markdown",
    failFast: config.failFast ?? false,
    maxConcurrency: config.maxConcurrency,
    llm: config.llm,
  };
}

/**
 * Merge CLI flag overrides into a resolved suite config.
 * CLI flags take precedence over config file values.
 */
export function applyCliOverrides(
  suite: ResolvedSuiteConfig,
  overrides: {
    minScore?: number;
    maxRegression?: number;
    baseline?: string;
    samples?: number;
    maxVariance?: number;
    llm?: LlmEndpointConfig;
  }
): ResolvedSuiteConfig {
  return {
    ...suite,
    minScore: overrides.minScore ?? suite.minScore,
    maxRegression: overrides.maxRegression ?? suite.maxRegression,
    baseline: overrides.baseline ?? suite.baseline,
    samples: overrides.samples ?? suite.samples,
    maxVariance: overrides.maxVariance ?? suite.maxVariance,
    llm: mergeLlmConfig(suite.llm, overrides.llm),
  };
}
