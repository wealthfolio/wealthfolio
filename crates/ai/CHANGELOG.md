# wealthfolio-ai changelog

Notable changes to the AI crate. Format roughly follows [Keep a
Changelog](https://keepachangelog.com); chronological newest-first.

## [Unreleased]

### Added

- **Spending categorization tools** — `propose_transaction_categories`,
  `list_categorization_context`, `create_categorization_rule`. Agent now
  follows a two-tool-pair workflow (mirrors `search_activities → record_activity`)
  to draft + apply transaction categories. Hint promotion: when the user
  says "X is Y", the agent persists a real `categorization_rule` so future
  passes pick it up deterministically.
- **`bulk_assign_categories` IPC + HTTP route** — atomic batch endpoint
  for assigning categories to many activities in one DB transaction.
  Used by both the AI categorization widget and the manual bulk action
  on the spending transactions page.
- **Live-model eval framework** — runs ChatService against a real LLM
  (Ollama default `gemma4:e4b`; cloud via `WF_EVAL_PROVIDER` /
  `WF_EVAL_MODEL`). 17 starter cases across `safety`, `categorization`,
  `recording`, `data_queries` suites. Cases use TOML schema with positive
  (`expected_tools`), negative (`forbidden_tools`), frequency
  (`max_tool_calls`), and rubric assertions. Runner retries transient
  failures up to 3× with backoff.
- **Tool-schema snapshot tests** (`tests/tool_schemas.rs`) — `insta`
  snapshots of every tool's JSON schema. CI fails on any silent drift in
  field names, required, or enum values until a maintainer runs
  `cargo insta review`.
- **Allowlist + system-prompt integration tests** (`tests/{allowlist,
  system_prompt}.rs`) — substring contract checks on
  `DEFAULT_TOOLS_ALLOWLIST`, `normalize_tools_allowlist` group expansion,
  and the persona / confirmation-utterance / fabrication-warning rules.
- **`SYSTEM_PROMPT` const** in `lib.rs` — exposed for integration tests
  to read without a relative path dance.
- **`test-utils` and `eval` Cargo features** — gate `MockEnvironment`,
  `live_evals` module, and the runner binary.

### Changed

- **chat.rs split into `chat/` subfolder** (~2,800 → 6 focused files):
  `mod.rs`, `streaming.rs`, `attachments.rs`, `working_context.rs`,
  `provider_clients.rs`, `history.rs`. Public API (`pub use chat::{
  ChatConfig, ChatService}`) unchanged.
- **env.rs split into `env/{mod,test_env}.rs`** — separates the trait
  (~95 lines) from the test mock (~1,355 lines).
- **`RECORD_ACTIVITY RULES` moved** from `system_prompt.txt` to
  `record_activity::definition()` description. Tool-specific rules now
  live with their tools (categorization tools already followed this
  convention).
- **Confirmation-utterance directive** added to system prompt — agent
  must briefly state intent before mutating-tool calls.
- **System prompt slimmed** by removing duplicated tool listings; tool
  definitions are the source of truth for per-tool rules.
- **`draftStatus` field** on `ProposeCategoriesOutput` — frontend
  patches to `"applied"` after Apply via `updateToolResult`.
- **Working-context tests** rehomed from `chat/mod.rs::tests` to
  `chat/working_context.rs::tests` (co-located with their target).

### Fixed

- **Schema deserialization for `aiProposals`** — `categoryKey` accepts
  both camelCase and snake_case via serde alias.
- **Latent `truncate_notes` bug** — char-vs-byte length-check
  inconsistency could spuriously truncate multi-byte UTF-8 notes.

### Known limitations

- `MockEnvironment`'s spending services are `unimplemented!()` — eval
  cases that hit `propose_transaction_categories` panic the runner
  thread. Fixture support is the next-up TODO.
- `expected_response.rubric` parsed but not evaluated — runner logs WARN
  and skips. Wiring up an LLM-judge is a follow-up.
- Initial baseline against `gemma4:e4b`: **10/17 pass** (4 P0 fail). The
  failures show real model behavior — gemma4 sometimes refuses to fire
  `record_activity`-style tools. Useful regression baseline for tracking
  drift as the model upgrades.
