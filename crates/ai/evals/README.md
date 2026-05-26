# Live-model evals

Behavioral evals that drive `ChatService` against a **real LLM provider** and
assert on the resulting tool-call trace. Distinct from `cargo test`, which
runs deterministic schema/contract checks (no LLM).

These catch **real model drift** that no unit test can detect:
- "Did the agent call `propose_transaction_categories` with `aiProposals`?"
- "Did the agent call `record_activity` when the user just asked a question?"
- "Did the agent fabricate numbers when the data tool returned empty?"

## Running

```bash
# Default: Ollama at localhost:11434, model = gemma4:e4b
cargo run -p wealthfolio-ai --bin eval --features eval

# Override the model
WF_EVAL_MODEL=qwen2.5:7b-instruct cargo run -p wealthfolio-ai --bin eval --features eval

# Filter to a single case
WF_EVAL_FILTER=hint_promotes cargo run -p wealthfolio-ai --bin eval --features eval

# Cloud provider (costs money)
WF_EVAL_PROVIDER=anthropic WF_EVAL_MODEL=claude-haiku-4-5 \
  ANTHROPIC_API_KEY=... \
  cargo run -p wealthfolio-ai --bin eval --features eval
```

Exit code:
- `0` — all P0 cases passed (P1/P2 failures still printed but don't fail the run).
- `1` — at least one P0 case failed.
- `2` — couldn't load case files.

## Prerequisites

For Ollama (default):

```bash
# Install ollama from ollama.com, then pull the model
ollama pull gemma4:e4b

# Verify it's reachable
ollama list
curl http://localhost:11434/api/tags
```

## TOML schema

One file per suite under `cases/`. Each file has zero or more `[[case]]` entries.

### Case fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique handle for filtering / reports. |
| `description` | string | yes | One-line human description. |
| `prompt` | string | yes | The user message that drives the turn. |
| `severity` | `"P0"` / `"P1"` / `"P2"` | no, default `P1` | P0 fails the run; P1/P2 only log. |
| `tags` | array of strings | no | Free-form tags for filtering (`"smoke"`, `"regression"`). |
| `fixture` | string | no | (Reserved) name of a fixture under `evals/fixtures/`. |
| `expected_tools` | array | no | Tools that MUST fire, in order, with optional arg assertions. |
| `forbidden_tools` | table | no | Tools that MUST NOT fire. Map value = reason for failure message. |
| `max_tool_calls` | table | no | Per-tool max occurrence cap. |
| `expected_response.rubric` | string | no | LLM-judge criteria for the agent's final text. *(not yet implemented)* |

### Argument assertions

Inside an `[[case.expected_tools]]` block:

```toml
[[case.expected_tools]]
name = "propose_transaction_categories"
[case.expected_tools.args]
aiProposals = "not_empty"            # sentinel
accountIds  = "absent_or_empty"      # sentinel
taxonomyId  = "spending_categories"  # exact string match
categoryKey = "groceries"            # sentinel = exact string match
quantity    = { exact = 20 }         # exact value
pattern     = { contains = "T&T" }   # JSON-stringified contains
symbol      = { regex = "(?i)tesla" } # regex against JSON-stringified value
```

Sentinels:
- `"not_empty"` — value is a non-empty array/string/object.
- `"absent_or_empty"` — key is missing, null, or an empty array/string/object.
- `"present"` — key exists and is non-null.
- Any other string → exact string match.

### Forbidden tools (negative assertion)

```toml
[case.forbidden_tools]
record_activity = "read-only intent should never trigger an activity draft"
import_csv      = "no CSV mentioned"
```

The map value is shown in the failure message — keep it actionable.

### Frequency caps

```toml
[case.max_tool_calls]
list_categorization_context = 1     # tool may fire 0 or 1 times, never twice
record_activity = 1
```

## Suite layout

```
crates/ai/evals/
├── README.md             ← this file
└── cases/
    ├── safety.toml       ← read-only intents must not trigger mutations
    ├── categorization.toml ← spending categorization two-tool flow + hint promotion
    ├── recording.toml    ← BUY/SELL/DIVIDEND drafting flows
    └── data_queries.toml ← right tool for the right question, no fabrication
```

## What's NOT covered yet

- **Fixtures**: cases that need pre-seeded portfolio/transaction data fail because
  `MockEnvironment` returns empty results for most services. Adding canned
  fixture data is on the roadmap (`evals/fixtures/*.json` + a fixture loader
  that overrides specific service mocks).
- **LLM-as-judge** for `expected_response.rubric` — the schema is in place;
  the runner currently logs a warning and skips. Wiring up a judge model is
  next on the runner's TODO.
- **Spending-tool evals** that need real `cash_activity_service` /
  `taxonomy_service` data. The mock currently `unimplemented!()`s those —
  cases that hit them will fail until the mock is extended.

## When to run

| Cadence | What |
|---|---|
| Every commit (CI) | `cargo test` — schema/contract tests, no LLM, ~1s. |
| Pre-merge (CI) | `cargo run --bin eval --features eval` against Ollama. ~1-3 min depending on model + suite size. |
| Nightly / weekly | Same eval suite against a real cloud model (Claude/GPT) for drift signal. Costs ~$0.50/run. |
| Pre-release | Full suite + manual exploratory testing. |

## Distinctions from sibling concepts

| | Lives in | LLM in loop? | What it catches |
|---|---|---|---|
| Unit tests | `crates/ai/src/**/tests` | No | Pure-function bugs. |
| Integration tests | `crates/ai/tests/` | No | Schema/allowlist/system-prompt drift. |
| Snapshot tests | `crates/ai/tests/tool_schemas.rs` | No | Silent tool-schema drift (insta). |
| **Live evals** *(this dir)* | `crates/ai/src/live_evals/` + `evals/cases/` | **Yes** | **Real model drift, prompt regression, fabrication.** |

> `crates/ai/src/eval/` (singular) holds stream-event-ordering and guardrail
> assertion helpers + `GoldenScenario` definitions, but no harness drives
> them against a stub LLM today. If you ever need deterministic CI coverage
> of the agent flow, that's the seam to extend; for now, code-flow regressions
> are caught by integration + snapshot tests, and behavior regressions by
> live evals.
