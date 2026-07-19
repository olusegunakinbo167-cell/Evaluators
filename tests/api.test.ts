// tests/api.test.ts
import request from "supertest";
import app from "../src/api/server";

describe("POST /evaluate", () => {
  it("evaluates with manual scores", async () => {
    const res = await request(app).post("/evaluate").send({
      taskId: "T", prompt: "p", evaluator: "e",
      responses: [{ id: "A", code: "x", language: "js" }],
      manualScores: { A: { correctness: 5, efficiency: 5, readability: 5, security: 5, promptAdherence: 5 } },
      justifications: { A: "" },
    });
    expect(res.status).toBe(200);
    expect(res.body.preferred).toBe("A");
  });

  it("400 on missing fields", async () => {
    const res = await request(app).post("/evaluate").send({ taskId: "x" });
    expect(res.status).toBe(400);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
