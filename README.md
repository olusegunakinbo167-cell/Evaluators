# 🧠 AI Code Quality Evaluator

> An intelligent tool for ranking and evaluating AI-generated code responses — built for human-in-the-loop AI training workflows (RLHF, preference ranking, and code quality annotation). Now with **LLM-as-a-Judge** automation.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)
![License](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-active-brightgreen)

---

## 📌 Overview

`ai-code-evaluator` is a full-stack TypeScript tool designed to **systematically rank and compare AI-generated code snippets** across multiple quality dimensions. It is purpose-built for AI data labeling projects that require structured, rubric-based evaluation of model outputs — such as preference ranking tasks used in RLHF (Reinforcement Learning from Human Feedback) pipelines.

v1.1 introduces an **automated LLM-as-a-Judge layer**: OpenAI Structured Outputs produce type-safe rubric scores directly from code artifacts, with graceful fallback to baseline defaults on timeout or parse failure.

The system allows an IT evaluator to:
- Load pairs (or sets) of AI-generated code responses
- Auto-score each response via LLM judge, or supply manual rubric scores
- Generate a ranked output with justification logs
- Export annotated results to JSON/CSV for training data pipelines

---

## 🧩 Features

| Feature | Description |
|---|---|
| 🤖 **LLM-as-a-Judge** | OpenAI Structured Outputs auto-score code against a dynamic rubric — fully type-safe |
| 🔍 **Multi-criteria scoring** | Evaluate code on correctness, efficiency, readability, security, and adherence to prompt |
| ⚖️ **Pairwise comparison engine** | Compare N code responses head-to-head with weighted scoring |
| 📊 **Ranking report generator** | Outputs ranked results with scores and written justifications |
| 🔐 **Security flaw detector** | Static analysis pass flags common vulnerabilities (SQLi, XSS, hardcoded secrets) |
| 📁 **CSV / JSON export** | Annotated results ready for AI training data pipelines |
| 🧪 **Unit tested** | 131 passing tests with full provider mock coverage |

---

## 🗂️ Project Structure

```
ai-code-evaluator/
├── src/
│   ├── api/               # REST API endpoints (Express)
│   ├── components/
│   │   ├── evaluator.ts   # Core orchestration (manual + auto)
│   │   ├── securityScanner.ts
│   │   └── llm/           # LLM-as-a-Judge layer
│   │       ├── judgeProvider.ts    # Strongly typed provider interface
│   │       ├── openaiProvider.ts   # OpenAI Structured Outputs impl
│   │       ├── promptBuilder.ts    # Dynamic rubric → prompt
│   │       ├── judge.ts            # Orchestration + fallback
│   │       └── mockProvider.ts     # Test double
│   ├── utils/             # Helpers: scoring, export, formatting
│   ├── types/             # TypeScript interfaces and rubric schema
│   └── index.ts           # CLI + API entry point
├── tests/                 # Jest unit tests (131 passing)
├── samples/               # Sample AI-generated code pairs
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18
- npm >= 9
- OpenAI API key (optional — omit to use manual scoring or mock judge)

### Installation

```bash
git clone https://github.com/olusegunakinbo167-cell/Evaluators.git
cd Evaluators
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY
```

### Run in Development

```bash
npm run dev
```

### Build for Production

```bash
npm run build
npm start
```

### Run Tests

```bash
npm test                # full suite, 131 tests
npm run test:judge      # judge layer only
```

---

## 🤖 LLM-as-a-Judge

### Provider Interface

`src/components/llm/judgeProvider.ts` defines a strongly typed abstraction over any LLM backend:

```ts
interface JudgeProvider {
  readonly name: string;
  score(request: JudgeRequest, config?: JudgeProviderConfig): Promise<JudgeResult>;
}
```

The included `OpenAIJudgeProvider` uses **Structured Outputs (JSON Schema)** to guarantee type safety against the active rubric schema.

### Dynamic Prompt Generation

`promptBuilder.ts` extracts the live rubric at runtime:
- Dimension keys (`correctness`, `efficiency`, `readability`, `security`, `promptAdherence`)
- Scoring bounds (min/max per dimension)
- Label text and descriptions
- Weights

…and injects them cleanly into the LLM system instructions, along with an OpenAI JSON Schema that enforces the response shape.

### Runtime Flow

1. Code artifacts → `judgeResponses()` → `JudgeProvider.score()`
2. Structured JSON response validated against active rubric keys
3. Invalid / timeout / parse failure → graceful fallback to neutral baseline scores (5/10 per dimension)
4. Validated scores feed into the standard evaluation pipeline (weighted scoring, security penalty, ranking)

### Using the Judge

**API — auto-judge (omit `manualScores`):**
```bash
curl -X POST http://localhost:3000/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "TASK-1",
    "prompt": "Write a sort function",
    "evaluator": "llm-judge",
    "responses": [
      {"id": "A", "language": "typescript", "code": "..."}
    ]
  }'
```

**CLI:**
```bash
npm run build
node dist/index.js --eval ./samples/sample-evaluation.json --export csv
```

**Programmatic:**
```ts
import { evaluateAuto } from "./components/evaluator";
const result = await evaluateAuto({
  taskId: "T1",
  prompt: "...",
  evaluator: "judge",
  responses: [...]
  // manualScores omitted → LLM judge runs automatically
});
```

---

## 📐 Evaluation Rubric

Each AI-generated code response is scored (0–10) on five dimensions:

| Criterion | Weight | Description |
|---|---|---|
| **Correctness** | 30% | Does the code solve the stated problem accurately? |
| **Efficiency** | 20% | Is time/space complexity appropriate for the use case? |
| **Readability** | 20% | Clear naming, comments, and logical structure |
| **Security** | 20% | No obvious vulnerabilities, safe input handling |
| **Prompt Adherence** | 10% | Does it match the exact requirements given? |

**Weighted Score** = Σ(criterion score × weight)

Rubric dimensions are defined in `src/types/index.ts` as `RUBRIC_DIMENSIONS` — the judge prompt is generated dynamically from this schema, so adding/removing dimensions requires zero prompt maintenance.

---

## 🔁 Workflow

```
Input: AI Code Responses (N-way)
         │
         ▼
  ┌─────────────────────┐
  │  LLM-as-a-Judge     │  ← OpenAI Structured Outputs
  │  auto-scores each   │     (fallback → baseline)
  │  response vs rubric │
  └─────────┬───────────┘
            │
            ▼
  Compute Weighted Total
            │
            ▼
  Security Scan Pass  (static analysis)
            │
            ▼
  Apply Security Penalty
            │
            ▼
  Rank + Confidence
            │
            ▼
  Export to JSON / CSV
```

---

## 📦 Sample Output

```json
{
  "task_id": "VOX-2024-0042",
  "prompt": "Write a Node.js function to fetch user data from PostgreSQL",
  "evaluator": "IT Expert",
  "timestamp": "2024-06-16T09:00:00Z",
  "rankings": [
    {
      "rank": 1,
      "response_id": "A",
      "weighted_score": 8.6,
      "scores": {
        "correctness": 9,
        "efficiency": 8,
        "readability": 9,
        "security": 8,
        "prompt_adherence": 10
      },
      "justification": "Response A uses parameterized queries preventing SQL injection, has clear variable naming, and handles async errors properly with try/catch."
    },
    {
      "rank": 2,
      "response_id": "B",
      "weighted_score": 5.9,
      "scores": {
        "correctness": 7,
        "efficiency": 6,
        "readability": 5,
        "security": 4,
        "prompt_adherence": 7
      },
      "justification": "Response B uses string interpolation in SQL query — SQL injection risk. Variable names are unclear and error handling is absent."
    }
  ],
  "preferred": "A",
  "confidence": "high"
}
```

---

## 🛡️ Security Scanner — Detected Patterns

The built-in static scanner flags:

- SQL injection (string-interpolated queries)
- Hardcoded credentials (`password = "..."`, `api_key = "..."`)
- Unsanitized `eval()` usage
- Missing input validation
- XSS vectors in DOM manipulation

---

## 🧪 Testing

```bash
npm test
```

131 passing tests covering:
- Scoring / weighting / ranking logic
- Security scanner pattern detection
- LLM judge prompt generation (rubric schema → system prompt)
- Score validation / fallback paths
- OpenAI provider: HTTP errors, JSON parse failures, timeout handling, validation failures
- Evaluator auto-judge integration with provider mocks
- API endpoints
- Export utilities (JSON/CSV)

Provider mocks keep the suite fast and deterministic — no API keys required for CI.

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push and open a Pull Request

---

## 📄 License

MIT © 2024 — Built for AI training data workflows
