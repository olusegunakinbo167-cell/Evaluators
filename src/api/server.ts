// src/api/server.ts

import express, { Request, Response, NextFunction } from "express";
import { evaluate, evaluateAuto } from "../components/evaluator";
import { exportToJSON, exportToCSV } from "../utils/exporter";
import { EvaluationInput } from "../types";

const app = express();
app.use(express.json());

/**
 * POST /evaluate
 * Body: EvaluationInput
 * Returns: EvaluationResult
 *
 * If manualScores are omitted, the LLM judge layer auto-scores the responses.
 */
app.post("/evaluate", async (req: Request, res: Response) => {
  try {
    const input: EvaluationInput = req.body;

    if (!input.taskId || !input.prompt || !input.responses?.length) {
      return res.status(400).json({
        error: "Missing required fields: taskId, prompt, responses",
      });
    }

    const hasScores = input.manualScores && Object.keys(input.manualScores).length > 0;
    const result = hasScores
      ? evaluate(input)
      : await evaluateAuto(input);

    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(422).json({ error: err.message });
  }
});

/**
 * POST /evaluate/export
 * Body: EvaluationInput + { format: "json" | "csv" }
 * Returns: { filepath, result }
 */
app.post("/evaluate/export", async (req: Request, res: Response) => {
  try {
    const { format = "json", ...input }: EvaluationInput & { format?: string } = req.body;
    const evalInput = input as EvaluationInput;

    const hasScores = evalInput.manualScores && Object.keys(evalInput.manualScores).length > 0;
    const result = hasScores
      ? evaluate(evalInput)
      : await evaluateAuto(evalInput);

    const filepath =
      format === "csv" ? exportToCSV(result) : exportToJSON(result);

    return res.status(200).json({ filepath, result });
  } catch (err: any) {
    return res.status(422).json({ error: err.message });
  }
});

/**
 * GET /health
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
