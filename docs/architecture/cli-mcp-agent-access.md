# Wealthfolio CLI and MCP Agent Access Design

## Overview

This document defines how external AI agents and command line workflows interact
with Wealthfolio. Two runtime scenarios are supported:

- **Desktop app**: Wealthfolio runs as the Tauri desktop app.
- **Docker/self-hosted web**: Wealthfolio runs as the Axum server.

Mobile is excluded from local MCP support. Mobile users use the in-app assistant
or connect through a synced desktop/server environment.

The shipped feature is surfaced in settings as **AI Agent Access**.

The core design decision: MCP access must go through an already-running
Wealthfolio runtime. No standalone process opens or migrates the SQLite database
directly.

A standalone CLI (`wealthfolio mcp serve` as an MCP stdio bridge) is a
**deferred / future item** — it is NOT built today (there is no `apps/cli`).
Both runtimes expose Streamable HTTP directly, which modern MCP clients support,
so the stdio bridge is a later compatibility add-on, not a shipped front door.

## Release Slicing

| Release      | Scope                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shipped**  | MCP on BOTH runtimes: agent-tools extraction, embedded Tauri MCP server, server `/mcp`, scoped Personal Access Tokens with **selectable scopes**, AI Agent Access settings UI. Read, draft, write/suggest, and CSV-import tools all shipped, scope-gated. |
| **Deferred** | CLI stdio bridge (`wealthfolio mcp serve`) for stdio-only MCP clients.                                                                                                                                                                                    |

Scoped PATs with selectable scopes shipped from the start — there was no
"read-only first, writes later" split. A token is created with whatever scopes
the operator selects (or a preset), and the tool catalog is filtered to what the
token's scopes can reach. The CLI bridge is deferred because both runtimes
expose Streamable HTTP directly, which modern MCP clients support; the bridge
would only be a compatibility add-on for stdio-only clients, not the front door.

The agent-tools extraction (Phase 1–2) is valuable standalone work even
independent of MCP adoption: it gives the in-app assistant scope enforcement and
audit logging it currently lacks.

## Goals

- Let AI agents query portfolio data through MCP.
- Let agents prepare and, where the token's scopes explicitly permit, record
  investment activities (drafts, commits, and CSV imports).
- Support MCP clients that speak Streamable HTTP directly. (A stdio bridge for
  stdio-only clients is deferred.)
- Reuse existing Wealthfolio business logic, validation, event handling, and
  security boundaries.
- Converge the in-app AI assistant and external agents on a single audited,
  scoped tool catalog.

## Non-Goals

- No direct `--db` local mode. All access flows through the desktop app or
  server runtime so event handling, auth, and audit logging stay consistent.
- No human-facing CLI commands (and no CLI at all today; see Deferred).
- No mobile-local MCP server.
- No raw SQL tools.
- No tools for secrets, addon installation, backups, updater, device pairing, or
  arbitrary file access.
- No unreviewed automatic classification writes.
- No separate user-facing MCP binary.

## Current Repository Context

What already exists (verified against the code):

- **`crates/ai` is already runtime-neutral.** It has no Tauri or Axum
  dependencies. Its `AiEnvironment` trait (`crates/ai/src/env/mod.rs`) already
  abstracts ~18 service handles — it is essentially the `AgentEnvironment` this
  design needs.
- **The real coupling is rig-core, not the runtimes.** All 19 existing assistant
  tools implement rig's `Tool` trait directly (`crates/ai/src/tools/`, ~10.4k
  lines). The extraction work is a dependency inversion: define our own
  `AgentTool` trait and adapt it _to_ rig, instead of tools implementing rig
  directly.
- **`AiEnvironment` needs a split, not a copy.** It currently exposes
  `secret_store()` and `chat_repository()`, which must not be reachable from
  agent tools. It also exposes three concrete (non-trait) services —
  `CashActivityService`, `ActivityTaxonomyAssignmentService`,
  `CategorizationRulesService` — which need trait extraction before mock-based
  tool tests are possible.
- **Service composition is ~90% duplicated** between Tauri's `ServiceContext`
  (`apps/tauri/src/context/providers.rs`, ~620 lines) and the server's
  `AppState` (`apps/server/src/main_lib.rs`, ~840 lines) — roughly 1,400
  duplicated lines wiring ~63 services. MCP adds a third consumer of this graph;
  see Phase 6.
- **Server auth is greenfield for PATs.** Today it is a single Argon2 password
  hash → JWT with cookie/bearer extraction (`apps/server/src/auth.rs`). There is
  no token table, no scopes, nothing to extend.
- **Addon permissions are declaration-only.** The 16 addon permission categories
  (`packages/addon-sdk/src/permissions.ts`) have no runtime enforcement, no
  read/write granularity, and no Rust enum. The agent scope system reuses their
  _names_ for coherence but shares no implementation.
- The Tauri app has no embedded HTTP server today. There is no MCP code anywhere
  in the repo.

Existing Tauri commands and web REST routes remain unchanged. `agent-tools` is a
new parallel agent surface, not a replacement.

## Repository Structure

CLI and MCP source live in the main monorepo. They move in lockstep with
`crates/core`, `crates/storage-sqlite`, migrations, and domain services. A
separate source repository would create schema and behavior drift.

If the deferred CLI ships later, a thin distribution-only npm wrapper package is
acceptable because it would only download and run the native binary.

**Binary name collision (resolved):** `@wealthfolio/addon-dev-tools` now ships
its CLI as `wealthfolio-addon`, keeping `wealthfolio` as a deprecated alias to
be removed before any native `wealthfolio` CLI ships.

## Proposed Architecture

### Workspace Layout

```text
crates/
  agent-tools          # package: wealthfolio-agent-tools
  wealthfolio-mcp      # package: wealthfolio-mcp
```

The MCP host integration lives in the existing apps: `apps/tauri/src/mcp/`
(desktop) and `apps/server/src/mcp/` + `apps/server/src/api/agent_access.rs`
(web).

Future, optional / deferred: `apps/cli` (the `wealthfolio` stdio bridge),
`crates/runtime` (shared service composition), `packages/wealthfolio-mcp-npm`
(distribution wrapper).

### Runtime Hosts

```text
Desktop:
MCP client (HTTP-capable) -> 127.0.0.1:<port>/mcp -> Tauri ServiceContext

Docker/self-hosted:
MCP client -> HTTPS /mcp (direct) -> Axum AppState
```

Both runtimes expose Streamable HTTP directly. A stdio bridge (deferred) would
not be a third runtime — it would be a compatibility shim for MCP clients that
require stdio.

### `crates/agent-tools`

Owns the runtime-neutral tool catalog.

Responsibilities:

- Define tool names, descriptions, input schemas, output types, scope
  requirements, and access levels (read / draft / write / suggest).
- Execute tools against an abstract `AgentEnvironment`.
- Sanitize tool arguments for audit logging.
- Provide adapters used by `wealthfolio-ai` (rig) and `wealthfolio-mcp`.

It must not depend on Tauri or Axum, own MCP transport, own LLM provider
orchestration, or own app authentication.

**`AgentEnvironment` is the existing `AiEnvironment`, split.** Move the data
service accessors into `agent-tools`; keep assistant-only accessors
(`secret_store`, `chat_repository`) on an extension trait in `crates/ai`:

```rust
// crates/agent-tools — data services only, exact set per current tool usage:
// account, activity, holdings, valuation, allocation, performance, income,
// goal, health, taxonomy, asset, quote, settings, cash-activity,
// activity-taxonomy-assignment, categorization-rules services.
pub trait AgentEnvironment: Send + Sync {
    fn base_currency(&self) -> String;
    fn account_service(&self) -> Arc<dyn AccountServiceTrait>;
    /* ... remaining service accessors ... */
}

// crates/ai — assistant-only additions:
pub trait AssistantEnvironment: AgentEnvironment {
    fn secret_store(&self) -> Arc<dyn SecretStore>;
    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait>;
}
```

Service trait names follow the canonical names in `crates/core`. The three
concrete services listed above get traits extracted as part of Phase 1.

```rust
#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn input_schema(&self) -> serde_json::Value;
    fn required_scopes(&self) -> &'static [AgentScope];
    fn access_level(&self) -> AgentToolAccess;
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError>;
}
```

A rig adapter in `crates/ai` wraps `AgentTool` into rig's `Tool` so the in-app
assistant keeps identical behavior. This prevents the assistant and MCP from
drifting.

**Tool names are stable identifiers.** `ChatThreadConfig` snapshots tool
allowlists by name and `normalize_tools_allowlist` already handles legacy name
expansion. Tools keep their existing names during extraction; any future rename
is a migration (allowlist expansion entry), not a simple edit.

### `crates/wealthfolio-mcp`

Owns MCP protocol integration.

Responsibilities:

- Convert `agent-tools` into MCP tools/resources/prompts.
- Enforce scopes at the MCP boundary.
- Call audit logging hooks.
- Expose a server builder runnable over local HTTP inside Tauri and HTTP inside
  Axum (and, if the deferred stdio bridge ships, over stdio).

It must not build repositories/services, open SQLite, or know Tauri/Axum
internals beyond adapter hooks.

**SDK:** uses `rmcp` (the official Rust MCP SDK) for transport, session
handling, and protocol negotiation. The embedded-HTTP-in-Tauri shape is served
by mounting rmcp's `StreamableHttpService` in the same axum stack used by both
hosts (see Resolved Decisions).

**Protocol version:** do not pin. Implement spec-standard version negotiation
and declare a _minimum_ supported version (Streamable HTTP transport; the
deprecated HTTP+SSE transport is not supported).

### `apps/cli` (deferred — not built)

There is no `apps/cli` today and no `wealthfolio` binary. The stdio bridge below
is the intended future shape, kept here as a design sketch. Nothing ships it
yet.

```text
wealthfolio mcp serve                                            (future)
  Bridge stdio to the running desktop app MCP server discovered locally.

wealthfolio mcp serve --server https://wealthfolio.example.com   (future)
  Bridge stdio to a remote server MCP endpoint.
```

If/when built, local bridge mode would fail with a remediation message when the
desktop app is not running ("Open Wealthfolio, enable the MCP server in
Settings, then try again").

## Desktop Embedded MCP

The Tauri app hosts a local MCP HTTP server when enabled in settings.

Defaults:

- disabled by default
- bind to `127.0.0.1`
- **stable default port 8639, with fallback**: try 8639 first (overridable via
  the `mcp_server_port` setting) so Streamable-HTTP-capable clients can connect
  directly; fall back to a random high port on conflict. The lock file is always
  the source of truth for discovery.
- all tools registered (read, draft, write/suggest, commit, CSV import); each
  call is scope-gated against the presenting token, so a token only reaches what
  its scopes allow
- a valid Personal Access Token required (PAT-only — see Authentication below)

The embedded server uses the existing `ServiceContext`. This ensures no second
process opens SQLite, writes go through existing services, domain events flow
through the app's event sink, and UI updates stay consistent.

### Authentication (PAT-only)

The embedded desktop server authenticates **solely against the SQLite-stored
Personal Access Tokens** — the same `personal_access_tokens` table and the
shared `wealthfolio_mcp::pat` module used by the Axum server. There is no
separate local keyring token: the earlier single `wfl_`-prefixed local token
(keyring secret `mcp.local`) was dropped. Tokens are created per client from
settings and presented as bearer tokens, exactly as on the web host. There is no
token rotation; to "rotate", remove the token and create a new one.

### Local HTTP Security

The local MCP HTTP server must:

- bind to loopback only
- reject requests without a valid bearer PAT
- validate the `Origin` header before handling MCP requests: allows only no
  `Origin` or `Origin: null` (a configurable allowlist of known local clients
  can be added later if a browser-based local client needs it)
- never log tokens
- be unstartable on mobile: the `mcp_*` Tauri commands and the server
  orchestration are `#[cfg(desktop)]`-gated and return an error on iOS/Android —
  the UI hiding is not the enforcement boundary

Origin validation is required even on `127.0.0.1` to reduce DNS rebinding and
malicious-browser request risk.

### Discovery File

When the embedded server starts, Tauri writes a discovery file in the app data
directory:

```text
<app_data>/mcp.lock
```

Tauri resolves the app data path for the desktop identifier
`com.teymz.wealthfolio` (and any deferred CLI must resolve the same path) — via
a shared helper or an explicitly tested `directories::ProjectDirs` mapping. If
the app identifier changes, the lock-file convention migrates with it.

The file holds discovery data only — port, pid, and start time. It does **not**
contain a token or a token fingerprint:

```json
{
  "lockFileVersion": 1,
  "port": 8639,
  "pid": 12345,
  "startedAt": "2026-05-17T00:00:00Z"
}
```

Rules:

- The lock file never contains a token; it is only a discovery hint.
- A client (or the deferred CLI) validates pid/port/health before connecting.
- Tauri deletes the file on clean shutdown and clears a stale file on start.
- Stale lock files surface as a failed health check.

### Settings UI

Settings section: **AI Agent Access**.

Controls (as built):

- **Enable** the feature (master flag, `mcp_server_enabled`) and **Start
  automatically** with Wealthfolio (`mcp_server_auto_start`).
- **Start / Stop** the server at runtime.
- **Log agent activity** toggle (`mcp_audit_enabled`) controlling audit writes.
- Show bind address and port.
- Per-client tokens: **create** a token (name + selectable scopes/preset, shown
  once) and **remove** a token. There is no rotation — remove and recreate.
- Copy the direct Streamable HTTP MCP client config.
- Show recent agent activity (the audit log view) and purge it.

Live session enumeration is not exposed; token removal plus audit logging cover
revocation and visibility.

## Docker/Web MCP

The Axum server exposes `/mcp` in the same runtime that serves the web app,
using the existing `AppState`. It is enabled with `WF_MCP_ENABLED=true` (default
false) and mounted top-level — outside the JWT-protected `/api/v1` subtree and
outside its 300s request timeout, which would kill SSE streams.

Authentication: Personal Access Tokens, sent as bearer tokens, with explicit
scopes. Server MCP always requires PATs — there is no trusted reverse proxy
bypass. Note this is net-new infrastructure: the server has no token table or
scope concept today.

Host validation: `WF_MCP_ALLOWED_HOSTS` (comma-separated) enables a strict
`Host`-header allowlist on `/mcp`. When unset, Host validation is disabled —
rmcp's loopback-only default would break real deployments behind a domain, and
the PAT bearer requirement is the security boundary (browsers cannot attach
`Authorization` headers cross-site, so DNS rebinding gains nothing). Set it when
deploying behind a known hostname for defense in depth.

### Personal Access Tokens

```text
personal_access_tokens
- id
- name
- token_prefix
- token_hash
- scopes_json          -- JSON array of scope strings
- expires_at           -- optional; UI recommends but does not force expiry
- last_used_at
- revoked_at
- created_at
```

Rules:

- Store only token hashes. High-entropy random tokens hashed with SHA-256
  (Argon2 is unnecessary for high-entropy secrets).
- Show the full token only once at creation; use the prefix for lookup and
  display.
- Log token fingerprint, never the token, in audit records.

PAT management lives in the settings UI on both hosts — the web Agent Access
settings and the desktop AI Agent Access settings both create/list/remove rows
in this same table.

## Tool Catalog

Tools keep their existing `crates/ai` names — no renames during extraction (see
"Tool names are stable identifiers" above).

There are **two catalogs** (`crates/agent-tools/src/catalog.rs`):

- `assistant_catalog()` — read + draft/suggest tools, for the in-app assistant.
  It excludes the commit and CSV-import tools (the assistant persists through
  its own confirmation widget / `import_csv` flow).
- `mcp_catalog()` — everything (read + draft/suggest + commit + import),
  scope-filtered at the MCP boundary so a token sees only what its scopes reach.

### Read Tools

```text
get_holdings
get_accounts
get_cash_balances
search_activities
get_goals
get_valuation_history
get_income
get_asset_allocation
get_performance
get_health_status
list_categorization_context
list_asset_taxonomies
get_asset_taxonomy_assignments
get_portfolios
get_net_worth
get_contribution_limits
```

### Draft / Suggest Tools (assistant + MCP)

```text
record_activity                    -- prepare an activity draft
record_activities                  -- prepare a batch of drafts
propose_transaction_categories     -- (tool: propose_transaction_categories)
create_categorization_rule
prepare_asset_classification
```

### MCP-only Commit Tools

```text
commit_activity_draft              -- persist one reviewed draft
commit_activity_drafts             -- persist a batch
commit_asset_classification_draft  -- persist one reviewed classification draft
```

### MCP-only CSV Import Tools

```text
get_import_mapping                 -- fetch an account's import mapping
prepare_activity_import            -- validate + duplicate-detect rows
commit_activity_import             -- import through the real pipeline
```

`import_csv` remains **assistant/UI-only** — it is not exposed over MCP; the
agent-facing CSV path is the three import tools above.

Rules:

- Draft and import-preview tools never mutate data; activity commits require
  `activities:write` (which itself requires `activities:draft`), and
  classification commits require `classification:write` (which itself requires
  `classification:suggest`).
- CSV / activity-row content must not be persisted in raw audit logs: the
  write/import tools redact their `activities`/row arguments to a count
  (`"[N rows]"`) via per-tool audit sanitization.
- Activity writes go through existing activity services and validation.
- Suggestions return proposed assignments and rationale; agents never directly
  alter allocation semantics.

### Deferred Indefinitely

Classification writes, taxonomy create/edit/delete, activity/account deletion,
backups, secrets, addon install, device pairing.

## Scope Model

Scopes reuse the addon permission category _names_ (`accounts`, `holdings`,
`activities`, `performance`, `financial-planning`, ...) with an action suffix.
This is naming alignment only: the addon permission system is declaration-only
with no runtime enforcement, so nothing is shared beyond vocabulary. The agent
scope enum (`crates/agent-tools/src/scope.rs`) is a small hand-written Rust enum
and is the first enforced permission model in the codebase.

**Define only scopes that gate shipped tools.** Speculative scopes are liability
— they appear in token UIs and imply capabilities that don't exist.

The old design used a `portfolio:read` scope; as built it is
**`holdings:read`**. It gates holdings, allocation, valuation, income, and net
worth. `get_portfolios` is under `accounts:read`, not a portfolio scope.

Read scopes:

```text
accounts:read            get_accounts, get_cash_balances, get_portfolios
holdings:read            get_holdings, get_asset_allocation,
                         get_valuation_history, get_income, get_net_worth
performance:read         get_performance
activities:read          search_activities, get_import_mapping
financial-planning:read  get_goals, get_contribution_limits
health:read              get_health_status
classification:read      list_asset_taxonomies, get_asset_taxonomy_assignments,
                         list_categorization_context
```

Write / draft / suggest scopes:

```text
activities:draft         record_activity, record_activities,
                         prepare_activity_import
activities:write         commit_activity_draft / commit_activity_drafts,
                         commit_activity_import  (each also requires
                         activities:draft)
classification:suggest   propose_transaction_categories,
                         create_categorization_rule,
                         prepare_asset_classification
classification:write     commit_asset_classification_draft
                         (also requires classification:suggest)
```

Dependency rules: `activities:write` requires `activities:draft`, and
`classification:write` requires `classification:suggest` (you cannot commit
without the matching draft/suggest capability). Token creation validates this.

Presets (`AgentScopeSet` constructors):

- `read-only` — all read scopes.
- `read-activity-draft` — read + `activities:draft`.
- `read-activity-write` — read + `activities:draft` + `activities:write`.
- `read-activity-write-classification-suggest` — the above plus
  `classification:suggest` and `classification:write`.

Scope strings are parsed with `AgentScope::parse`, which rejects unknown scopes
(including the removed `portfolio:read`). Token creation rejects unknown scopes;
the auth path (`AgentScopeSet::from_strs`) silently skips unknown scopes for
forward compatibility with tokens minted by a newer version. There is no
backward-compat alias for `portfolio:read` — this is greenfield, so nothing was
minted under the old name.

Scope enforcement happens at the `agent-tools` catalog boundary, before tool
execution. Runtime hosts also enforce transport-level auth (bearer PAT), but
tool execution never relies on transport auth alone.

## Audit Logging

MCP and agent-tool execution write audit rows to SQLite in both desktop and
server mode.

```text
mcp_audit_log
- id
- session_id          -- groups calls from one agent session
- actor_kind          -- "pat" (the ActorKind enum reserves other kinds, but
                      --  only "pat" is produced — both hosts auth via PATs)
- actor_fingerprint
- tool
- scopes_json
- args_summary        -- sanitized per-tool
- outcome             -- success | denied | error
- error_message
- created_at
```

Rules:

- Never log secrets, full CSV content, or raw tokens.
- Keep rows forever; manual purge button in settings.
- Index on `(created_at, tool)` for the settings activity view.

The activity view is filtered and paginated **server-side** (`list_paged` /
`AuditFilter`): a case-insensitive substring match on the tool name plus
`IN`-list filters on tool, outcome, and actor-kind (fields AND-ed, values within
a field OR-ed). The UI resolves a token's `actor_fingerprint`
(`sha256:<hex-prefix>`) back to the token's display name.

## Threat Model Notes

- With auto-start enabled, the local MCP server may run whenever the app runs. A
  bearer PAT is the boundary between local processes and agent access: stored
  only as a SHA-256 hash, shown once, never logged.
- The PAT requirement protects against accidental local access, not a fully
  compromised OS user account.
- Local HTTP requests validate `Origin` even on loopback.
- Server MCP requires PATs even behind an authenticating reverse proxy.
- Agent tools never expose raw database access, secrets, backups, addon
  installation, or device pairing.

## Data Flow

### Desktop

```text
MCP client (HTTP) -> 127.0.0.1:<port>/mcp directly
  -> Tauri MCP middleware authenticates the bearer PAT against the SQLite
     personal_access_tokens table (shared wealthfolio_mcp::pat), checks Origin
  -> agent-tools catalog checks the PAT's scopes, then executes via
     ServiceContext services
  -> domain events update UI and derived data as usual

(A stdio bridge — deferred — would discover the server via <app_data>/mcp.lock,
 validate the health endpoint, and forward stdio to this same local HTTP MCP.)
```

### Docker/Web

```text
MCP client -> HTTPS /mcp (direct)
  -> bearer PAT authenticates; scopes checked at agent-tools boundary
  -> AppState services execute; server events flow normally
```

## Failure Modes

Desktop: server disabled/stopped → connection refused (enable + start in
settings); stale lock file → health check fails with remediation;
missing/invalid PAT → unauthorized; removed token → re-copy config with a new
token; port conflict → fall back to random port, rewrite lock file.

Server: missing/revoked/expired PAT → unauthorized; insufficient scope → denied
and audited; MCP disabled → clear setup error.

Tool execution: validation failures return structured tool errors; denied calls
are audited; partial write failures return enough information for the agent to
explain what was and was not saved.

## Implementation Plan

### Phase 1: Invert the rig dependency (the real extraction)

- Create `crates/agent-tools` with the `AgentTool` trait and `AgentScope` enum.
- Split `AiEnvironment`: data accessors move to `AgentEnvironment` in
  agent-tools; `secret_store`/`chat_repository` stay on an
  `AssistantEnvironment` extension trait in `crates/ai`.
- Extract traits for the three concrete services (`CashActivityService`,
  `ActivityTaxonomyAssignmentService`, `CategorizationRulesService`).
- Write the rig adapter in `crates/ai` (wraps `AgentTool` as rig `Tool`).
- Migrate the first two tools (`get_accounts`, `get_holdings`) with parity tests
  proving schemas and outputs match the current assistant tools.

### Phase 2: Migrate the catalog

- Migrate remaining read tools, then draft/suggest tools, keeping existing
  names.
- Add scope metadata, access levels, and per-tool audit sanitization
  (generalizing the existing `import_csv` redaction).
- Verify the in-app assistant behavior is unchanged (allowlist tests,
  `ChatThreadConfig` compatibility).

### Phase 3: Desktop embedded MCP

- Validate `rmcp` fits the embedded-HTTP-in-Tauri shape.
- Create `crates/wealthfolio-mcp`; embed the local HTTP MCP server in Tauri.
- PAT authentication (shared `wealthfolio_mcp::pat`), `mcp.lock` discovery file
  (no token), default-port-with-fallback binding, Origin validation.
- `mcp_audit_log` migration and settings UI (enable, start/stop, auto-start, log
  toggle, per-client token create/remove, copy config, activity view).

### Phase 4 (deferred): CLI stdio bridge

- Resolve the npm `wealthfolio` bin collision first.
- Create `apps/cli`; implement `wealthfolio mcp serve` bridging stdio to the
  desktop server. **Not built.**
- Ship installable client config examples (stdio and direct HTTP).

**As built, both runtimes ship the full scope-gated catalog (read + draft +
write/suggest + import) behind selectable-scope PATs — there is no
read-only-only release.**

### Phase 5: Docker/web MCP

- Server `/mcp` endpoint on `AppState`.
- PAT table, creation/deletion, scope enforcement; web settings UI for PAT
  management and audit log.

### Phase 6: Runtime extraction

Extract shared service composition into `crates/runtime` once agent-tools and
MCP prove the interfaces. The duplication is already real (~1,400 lines, ~90%
overlapping wiring of ~63 services across `ServiceContext` and `AppState`), and
MCP makes it a three-consumer problem. Trigger: do this when the next service
addition requires touching both compositions plus the `AgentEnvironment` trait.
Keep shell-specific code (events, secrets, auth) in Tauri and Axum.

## Testing Strategy

Agent tools: unit-test with mock services; snapshot JSON schemas; parity tests
against current assistant tools; scope denials happen before execution.

Desktop MCP: starts only when enabled; loopback-only; lock file has no token;
rejects missing/invalid PAT and disallowed Origins; activity commit updates
derived data through existing domain events.

Server MCP: requires PAT; enforces scopes; rejects expired/revoked tokens; works
behind a reverse proxy; audits success/denied/error.

Audit: sanitizes secrets and CSV/activity-row content; records session, actor
fingerprint, tool, scopes, outcome, timestamp; server-side filtering/pagination;
manual purge removes rows.

Regression: existing Tauri commands, web REST routes, and in-app assistant tool
calls unchanged; no direct SQLite access introduced by MCP.

## Resolved Decisions (as implemented)

- Settings entry is named **AI Agent Access**.
- Desktop default port: **8639**, random fallback on conflict; `mcp_server_port`
  setting overrides. Settings keys: `mcp_server_enabled`,
  `mcp_server_auto_start`, `mcp_audit_enabled` (and `mcp_server_port`).
- SDK: **rmcp 1.7** (manual `ServerHandler`, runtime tool registration,
  `StreamableHttpService` mounted in axum on both hosts; host auth context flows
  via forwarded `http::request::Parts` extensions — covered by a regression
  test).
- npm bin collision: dev-tools CLI renamed to `wealthfolio-addon` with a
  deprecated `wealthfolio` alias.
- Auth is **PAT-only on both hosts**: a shared `personal_access_tokens` table
  and `wealthfolio_mcp::pat`. No separate desktop local/keyring token; no token
  rotation (remove + recreate).
- PAT creation UX: name + fixed expiry options (30/90 days, 1 year, none) +
  **selectable scopes** (presets: read-only, read-activity-draft,
  read-activity-write, read-activity-write-classification-suggest); token shown
  once. Dependency rules enforced (`activities:write` ⇒ `activities:draft`,
  `classification:write` ⇒ `classification:suggest`).
- Server MCP fail-closed: `WF_MCP_ENABLED=true` on a non-loopback address
  requires auth configured, with no `WF_AUTH_REQUIRED=false` escape hatch
  (otherwise anyone could mint PATs).

## Open / Deferred Decisions

- CLI stdio bridge (`wealthfolio mcp serve`) — not built; distribution (native
  binary vs npm wrapper) and whether it absorbs the addon dev tools are open.

## Default Decisions

- No standalone CLI today; if one ships it is a stdio bridge only
  (`wealthfolio`).
- No local direct DB mode, ever, for agents.
- Desktop MCP embedded in Tauri; Docker MCP embedded in Axum.
- `AgentEnvironment` is the split of the existing `AiEnvironment`, not a new
  parallel trait.
- Tool names are stable; existing `crates/ai` names are kept.
- Scopes are defined only for shipped tools; addon category reuse is
  naming-only.
- Auth is PAT-only on both hosts; lock file never contains secrets.
- Audit log stored in SQLite with `session_id`.
- Selectable scopes from the start: read, activity draft/commit, and
  classification suggest/write all ship behind explicit scopes.
