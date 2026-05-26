# wealthfolio-ai

LLM orchestration for the Wealthfolio assistant. Chat streaming, tool registry,
provider catalog, and the eval framework that keeps the agent honest.

Built on [`rig-core`](https://crates.io/crates/rig-core) for provider
abstraction (OpenAI / Anthropic / Gemini / Groq / Ollama / OpenRouter).

## Crate layout

```
crates/ai/
├── src/
│   ├── chat/                    Chat streaming subsystem (split for clarity)
│   │   ├── mod.rs               ChatService + ChatConfig (public surface)
│   │   ├── streaming.rs         Agent build + stream loop, ThinkTagParser
│   │   ├── provider_clients.rs  Per-provider rig-client constructors + Ollama preflight
│   │   ├── attachments.rs       SessionAttachmentCache + validators
│   │   ├── working_context.rs   "Known App Context" extraction for the preamble
│   │   └── history.rs           build_user_prompt + build_history
│   ├── tools/                   Tool implementations (one file per tool)
│   ├── env/                     AiEnvironment trait + MockEnvironment
│   │   ├── mod.rs               Trait surface (~95 lines)
│   │   └── test_env.rs          MockEnvironment (test-utils gated)
│   ├── providers.rs             Provider catalog + ProviderService
│   ├── system_prompt.txt        Global agent persona / tool-pair / display rules
│   ├── live_evals/              Live-model eval harness (test-utils gated)
│   └── bin/eval.rs              Runner binary (eval feature gated)
├── tests/                       Cross-module integration tests (no LLM)
│   ├── allowlist.rs             DEFAULT_TOOLS_ALLOWLIST + normalize_tools_allowlist coverage
│   └── system_prompt.rs         Persona, confirmation utterance, no-fabricate, etc.
└── evals/                       Live-model eval suites (TOML)
    ├── README.md                Run instructions + TOML schema reference
    └── cases/*.toml             Suites grouped by feature area
```

## Three layers of automated checks

| Layer | Where | What it tests | LLM in loop? | Run with |
|---|---|---|---|---|
| **Unit tests** | `src/**/tests` | Pure functions, helpers, schema contracts | No | `cargo test -p wealthfolio-ai --lib` |
| **Integration tests** | `tests/` | Cross-module contracts (allowlist, system prompt) | No | `cargo test -p wealthfolio-ai --tests` |
| **Live evals** | `evals/cases/*.toml` | Agent behavior against a real model | Yes | `cargo run -p wealthfolio-ai --bin eval --features eval` |

The first two are what most projects call "tests" — fast, deterministic,
~1 second total, run on every commit. The third is what the AI community calls
**"evals"** in the strict sense — they actually call a model and assert on the
trace it produces. Different goals, different cadences.

## Running tests (no LLM, fast)

```bash
# Everything in this crate, ~1s
cargo test -p wealthfolio-ai

# Just unit tests
cargo test -p wealthfolio-ai --lib

# Just integration tests (the contract suite)
cargo test -p wealthfolio-ai --tests

# A specific test by name substring
cargo test -p wealthfolio-ai merge_unknown_category_key

# Snapshot tests (gated on test-utils)
cargo test -p wealthfolio-ai --features test-utils --test tool_schemas
```

### Snapshot tests

`tests/tool_schemas.rs` snapshots every tool's `Tool::definition().parameters`
JSON via [insta](https://insta.rs). When you intentionally change a tool
schema:

```bash
INSTA_UPDATE=always cargo test -p wealthfolio-ai --features test-utils --test tool_schemas
# Or interactively:
cargo install cargo-insta
cargo insta review
```

These tests run in CI on every commit. Catch:

- Tool `NAME` constants drifting out of `DEFAULT_TOOLS_ALLOWLIST`.
- Tool JSON schema changes (e.g. `categoryKey` → `category_key`).
- System-prompt deletions (confirmation utterance, fabrication guard, etc.).
- Helper function regressions (`normalize_payee`, `truncate_notes`, `merge_ai_proposals`, etc.).

## Running live evals (LLM, slower)

Live evals drive `ChatService` against a real provider and assert on the
resulting tool-call trace. They catch what unit tests can't: the model
forgetting to call a tool, hallucinating, drifting after a model upgrade.

### Quick start (Ollama default)

```bash
# 1. Have Ollama running and pull the default eval model
ollama pull gemma4:e4b

# 2. Run the suite
cargo run -p wealthfolio-ai --bin eval --features eval
```

### Switching the model or provider

```bash
# Different local model
WF_EVAL_MODEL=qwen2.5:7b-instruct cargo run -p wealthfolio-ai --bin eval --features eval

# Cloud provider (costs money)
WF_EVAL_PROVIDER=anthropic WF_EVAL_MODEL=claude-haiku-4-5 \
  ANTHROPIC_API_KEY=... \
  cargo run -p wealthfolio-ai --bin eval --features eval

# Filter to one case for fast iteration
WF_EVAL_FILTER=hint_promotes cargo run -p wealthfolio-ai --bin eval --features eval
```

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `WF_EVAL_PROVIDER` | `ollama` | Any rig provider id: `ollama`, `openai`, `anthropic`, `gemini`, `groq`, `openrouter`. |
| `WF_EVAL_MODEL` | `gemma4:e4b` | Model name as the provider expects it. |
| `WF_EVAL_PROVIDER_URL` | `http://localhost:11434` for ollama, else provider default | Override the API base URL. |
| `WF_EVAL_FILTER` | (none) | Substring match on case `id`. |
| `WF_EVAL_CASES_DIR` | `crates/ai/evals/cases/` | Override case directory. |

### Exit codes

- `0` — all `P0` cases passed (`P1`/`P2` failures still printed but don't fail the run).
- `1` — at least one `P0` case failed.
- `2` — couldn't load any case files.

### Adding an eval case

Edit any `.toml` file under `evals/cases/`:

```toml
[[case]]
id = "my_new_case"
description = "What this verifies"
prompt = "What the user types"
severity = "P1"            # P0 = blocking, P1 = soft, P2 = polish
tags = ["regression"]

[[case.expected_tools]]
name = "tool_that_must_fire"
[case.expected_tools.args]
some_arg = "not_empty"     # sentinels: not_empty / absent_or_empty / present
other    = { contains = "X" }   # or { exact = ... } / { regex = "..." }

[case.forbidden_tools]
tool_that_must_not_fire = "reason shown in failure message"

[case.max_tool_calls]
some_tool = 1              # at most N occurrences
```

Full schema reference: [`evals/README.md`](./evals/README.md).

### When to run

| Cadence | Suite | Cost | Why |
|---|---|---|---|
| Every commit (CI) | `cargo test` | $0 | Catches code regressions instantly. |
| Pre-merge or nightly (CI) | `cargo run --bin eval` against Ollama | $0 | Catches agent behavior regressions. |
| Pre-release / weekly | Same suite against a real cloud model | ~$0.50/run | Catches drift on the model your users actually run. |

## Adding a new tool

1. Create `src/tools/your_tool.rs` implementing `rig::tool::Tool`.
2. Add `pub mod your_tool;` and `pub use your_tool::YourTool;` to `src/tools/mod.rs`.
3. Add a field on `ToolSet` and construct it in `ToolSet::new`.
4. Add the tool's `NAME` to `DEFAULT_TOOLS_ALLOWLIST` in `src/types.rs`.
5. Wire its allowlist branch in `src/chat/mod.rs` (the `is_allowed("your_tool")` check).
6. Wire its access-control group in `apps/frontend/src/features/ai-assistant/components/provider-settings-card.tsx`.
7. Add unit tests at the bottom of `src/tools/your_tool.rs`.
8. **Add an eval case** in `evals/cases/<feature>.toml` covering the happy path and one negative-intent case.

`cargo test -p wealthfolio-ai` will catch most wiring mistakes (the
`tool_names_are_exactly_the_strings_used_by_allowlist` test checks every
registered tool's `NAME` is in the allowlist).

## Public surface

```rust
pub use chat::{ChatConfig, ChatService};
pub use env::AiEnvironment;
pub use error::AiError;
pub use providers::ProviderService;
pub use tools::{ToolSet, /* individual tools */};
pub use types::{/* DTOs, events, allowlist constants */};
pub const SYSTEM_PROMPT: &str;     // raw system_prompt.txt content
```

`MockEnvironment` is exposed under the `test-utils` feature flag; the
`live_evals` module + `eval` binary are gated on the same feature.

## Architecture: how a chat turn flows

```
SendMessageRequest
  └→ ChatService::send_message
       ├→ validate_attachments (chat::attachments)
       ├→ session attachment cache resolve
       ├→ build_user_prompt (chat::history) — text + image + pdf parts
       ├→ ChatWorkingContext::from_messages_and_attachments (chat::working_context)
       └→ spawn_chat_stream (chat::streaming)
            ├→ provider client construction (chat::provider_clients)
            ├→ system_prompt + dynamic context preamble
            ├→ tool allowlist filter (types::normalize_tools_allowlist)
            ├→ rig agent.stream_completion
            ├→ stream_agent_response: rig events → AiStreamEvent
            └→ post-stream: title generation
```

Every box is one file. The eval framework subscribes to the `AiStreamEvent`
stream from the boundary of `ChatService::send_message` to capture the
tool-call trace.

## Why this layout

The chat subsystem started life as a single 2,800-line `chat.rs`. It got
unwieldy. The split into `chat/{streaming, attachments, working_context,
history, provider_clients}` mirrors how features actually evolve — most
debugging in this codebase is provider-specific (one file), attachment-cache
behavior (one file), or stream-loop reshaping (one file). You rarely need to
read the whole subsystem at once, so we don't make you scroll past it.

The `live_evals/` module + `evals/cases/` data are deliberately separate from
unit/integration tests. Tests prove the *code* still does what it did. Evals
prove the *model* still does what it did. They detect different bug classes,
run on different cadences, and have different cost profiles. Keeping them
visually distinct prevents the common mistake of treating "the test suite is
green" as evidence the agent works.

## See also

- [`evals/README.md`](./evals/README.md) — full TOML schema for eval cases, run examples.
- [`src/system_prompt.txt`](./src/system_prompt.txt) — the agent's persona +
  global rules. Modifying this file is observable to all tests in
  `tests/system_prompt.rs` and to all live evals.
