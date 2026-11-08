# Wealthfolio CLI and MCP Agent Access Design

## Spending access

See [Spending MCP access](spending-mcp-implementation.md) for the implemented
permission matrix, tools, reviewed writes, compatibility and accounting limits.
Spending read/organization/budget grants are independent of asset
classification; old stored tokens require explicit reauthorization. Default and
monthly budgets share `budget:write` and retain native inheritance semantics.

## Editing API key permissions

Existing API key permissions can be edited from AI Agent Access through the
application-authenticated management API or profile-scoped Tauri command. Both
validate the complete scope replacement before updating only `scopes_json`
through the existing SQLite writer. MCP authentication resolves the token for
each request, so the next request uses the new permissions, including within an
existing session. No authorization cache, tool catalog, or session rebuild is
needed. The credential and expiration stay unchanged; editing an expired key
does not reactivate it. Calls already authorized continue. Clients caching tool
lists may need to refresh or reconnect. This operation is not exposed as an MCP
tool.

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
- `mcp_catalog()` — everything (read + draft/suggest + commit + categorization
  rules + import + transfer linking + quote import), scope-filtered at the MCP
  boundary so a token sees only what its scopes reach.

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

`get_health_status` reads the Health Center's cached status. With
`refresh: true` it first runs the full checks through
`AgentEnvironment::run_health_checks`, which each host implements with the same
`HealthServiceTrait::run_full_checks` call as its Health Center (local reads
only, the configured timezone, no client timezone) and which refreshes the cache
the Health Center shows. A refresh within a minute of the last run returns that
run; refreshes take a lock while they check this and run, so concurrent calls
run the checks once.

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
commit_categorization_rule         -- persist one reviewed categorization rule draft
commit_transaction_categories     -- persist reviewed transaction category assignments
```

### MCP-only Categorization Rule Tools

```text
list_categorization_rules          -- list saved rules with their origin
rerun_categorization_rules         -- re-apply the rules to the spending accounts
```

`list_categorization_rules` returns every saved rule, highest priority (the one
that wins a match) first: pattern, match type, target taxonomy and category
(with the category's key and name), activity type, amount condition, priority
and account scope. `origin` is `user`, `preset` (with `presetId`,
`presetVersion` and `presetModified`) or `addon` (with `addonId`, read from the
`addon:<addonId>:` prefix of the ids add-ons give their rules). It filters by
`taxonomyId` and `origin`. `rerun_categorization_rules` runs the same rerun as
the rules page over the accounts opted in to spending tracking, and does nothing
when tracking is off. With `onlyUncategorized` (default `true`) it only fills
activities without a category in the rule's taxonomy; with `false` it also
replaces rule, import and AI categories. Manual categories and split allocations
are never changed. It returns the number of spending accounts and of activities
a rule matched.

### MCP-only Transaction Category Management

```text
list_transaction_categories        -- list categories in the three activity taxonomies
prepare_transaction_category      -- validate and draft one new category without saving
commit_transaction_category       -- persist the reviewed category after confirmation
```

These tools only support `spending_categories`, `income_sources`, and
`savings_categories`; they never create or modify asset taxonomies. Listing
requires `spending:read` and works before any accounts or transactions exist.
Preparation also uses `spending:read`; committing additionally requires
`spending:write`.

Call `list_transaction_categories` with an optional `taxonomyId` to discover
existing category IDs, keys, and parent relationships. Prepare a category with
`taxonomyId`, `name`, `key`, and optional `parentId`, `color` (`#RRGGBB`,
default `#808080`), and `description`. Show the returned `category` object to
the user, then pass that object to `commit_transaction_category` after
confirmation. Committing revalidates the draft against current data, rejects
duplicate keys and IDs, and requires the parent to belong to the selected
taxonomy. Keys are case-sensitive, unique within a taxonomy, and cannot contain
whitespace or control characters. Reusing a committed draft fails rather than
creating a second category. Creation uses the native taxonomy service and SQLite
writer. All native `create_category` callers, including REST and Tauri, now
reject duplicate keys in these three activity taxonomies, including concurrent
creates. Native updates and moves share the same parent/cycle checks and reject
changed keys that introduce collisions. Unchanged legacy duplicate keys permit
cosmetic edits. Bulk import remains unchanged; this is not a global SQL
uniqueness constraint or a cleanup of existing data. Names, keys, descriptions,
and parent IDs are redacted from MCP audit arguments.

### MCP-only CSV Import Tools

```text
get_import_mapping                 -- fetch an account's import mapping
prepare_activity_import            -- validate + duplicate-detect rows
commit_activity_import             -- import through the real pipeline
```

`import_csv` remains **assistant/UI-only** — it is not exposed over MCP; the
agent-facing CSV path is the three import tools above.

### MCP-only Transfer Linking Tools

```text
find_transfer_matches              -- unlinked transfers + their candidates
link_transfer_activities           -- link confirmed pairs (batch)
unlink_transfer_activities         -- unlink pairs linked by mistake (batch)
```

An unlinked TRANSFER_OUT / TRANSFER_IN pair between owned accounts counts as
spending and income. `find_transfer_matches` scans posted transfers in active
accounts with no linked other side
(`ActivityServiceTrait::find_unlinked_transfers`). The scan reads the activities
once, off the async workers, and includes archived accounts when resolving
pairs, so a transfer whose other side sits in an archived account counts as
linked. Each listed transfer comes with its `TransferLinkState`, the state the
Health Center also reads (`TransferPairResolution::link_state`), and the
candidates the Link Transfer dialog suggests, drawn from open accounts. The
Health Center reports `needs_counterpart` and `broken_link`; the scan also lists
`external` transfers, because imports mark transfers external unless the source
says internal, so an internal move can carry the marker. `linkStates` narrows
the scan, `offset`/`limit` page it, and a lookup by `activityId` of a transfer
that is already linked returns its other side (`linkedTo`) and state
(`linkedState`) instead of an entry.

The Health Center resolves pairs over archived accounts the same way and reports
only transfers in active accounts.

Link and unlink call the same core methods as the dialog, so they apply its
validation, trigger recalculation and set the user-edit flag that keeps broker
syncs from undoing them. Linking a pair that is already linked to each other
repairs it: the pair keeps its group and loses an external marker left on either
leg, which the Health Center reports as a conflicting marker. Each pair in a
batch (up to 100) succeeds or fails on its own, and the audit log keeps only the
pair ids. The in-app assistant has no confirmation card for linking and does not
get these tools.

### MCP-only Quote Import Tools

```text
prepare_quote_import               -- preview reviewed closing prices
commit_quote_import                -- save them as manual quotes (batch)
```

These save the closing prices a statement reports for existing assets, so the
portfolio's value on the statement date can match it without changing
activities, quantities or cost basis. Each row names an asset by `assetId`
(tickers are never resolved; `get_asset`, under `holdings:read`, finds an id), a
`date` (`YYYY-MM-DD`, not in the future), a `price` in the asset's quote
currency, that `currency`, and an optional `overwrite` flag. Investment assets
are accepted, and so are manually priced alternative assets and liabilities,
whose values are stored as manual quotes (a gold coin's price, a house's value,
a mortgage balance). FX rates and market-priced alternative assets keep their
own paths.

`prepare_quote_import` (`QuoteServiceTrait::preview_quote_import`) reports per
row the asset, the quote valuations use for that day (a manual quote before a
provider one) with its source, and the outcome: `create` (no quote that day, or
a provider or broker quote with the same price and currency, which is saved as a
manual quote so a later refetch cannot change the day), `skip` (a manual quote
with the same price and currency is stored), `update` (a different price is
stored and the row sets `overwrite`), `conflict` (a different price without
`overwrite`) or `invalid` (unknown asset, an FX or market-priced alternative
asset, bad or future date, non-positive price, a currency other than the asset's
quote currency, or a second row for the same asset and date).

`commit_quote_import` runs the preview again and saves nothing if any row is
invalid or a conflict. Otherwise it passes the create and update rows to
`QuoteServiceTrait::import_quotes`, the pipeline behind the quote CSV import,
which saves them as `MANUAL` quotes. A manual quote takes precedence over the
provider quote of its day, and provider syncs skip days that have one. Creating
or editing a BUY or SELL of a manually priced asset still writes its trade price
as that day's manual quote, replacing a saved statement price. The batch may
overwrite only when a row lands on a day that has a quote (an approved update,
or an equal provider price saved as manual), so in a batch of rows on empty days
a quote stored after the check is never replaced. Skipped rows make a repeated
call a no-op. `import_quotes` emits one `PriceHistoryChanged` per batch that
saves a quote; the runtime planners debounce it and recalculate valuations from
saved quotes, from each quote's day, without a market sync. The commit reports
`recalculation: "queued"` so the agent can verify the result with
`get_valuation_history` or `get_net_worth` a few seconds later. Single-quote
writes (`add_quote`, `update_quote`, `delete_quote`, used by activities, manual
snapshots and alternative assets) emit no event.

A batch holds up to 100 rows, and the audit log keeps only the asset ids, dates
and counts of the arguments, never prices. As for every tool, an argument that
fails to parse is recorded in the error message, which may quote it. The in-app
assistant has no confirmation card for quotes and does not get these tools.

### MCP-only Asset and Market Data Reads

```text
get_asset                          -- one asset's market-data setup and price state
get_quote_history                  -- an asset's stored quotes over a date range
get_market_data_providers          -- built-in and custom providers
refresh_market_data                -- refresh prices or replace provider history
prepare_asset_update               -- preview a fix to an asset's listing, currency or provider
commit_asset_update                -- save it, then replace the provider history
```

These let an agent find why an asset's prices are missing or wrong. They read
stored data only and never call a provider. All three need `holdings:read`.

`get_asset` takes an `assetId` or a `query` (the asset lookup that
`get_asset_taxonomy_assignments` uses, now shared in `tools/asset_lookup.rs`, so
finding an id no longer needs `classification:read`); several matches return
`candidates`. It returns the identity (kind, instrument type, symbol, MIC,
ISIN), quote mode and currency, preferred provider and per-provider symbols, the
latest quote with its stale flag or the reason it is missing, the sync state,
stored quotes grouped by source and currency with their date span, and the
accounts holding the asset with quantities (the asset page's holdings read).

`get_quote_history` returns date, close, currency and source per stored quote,
newest first, for a range (default the last 365 days) and optional source,
capped at 500 rows by default and 2000 at most, with `truncated`.

`get_market_data_providers` lists built-in providers from
`QuoteServiceTrait::get_providers_info` and custom providers from
`AgentEnvironment::custom_providers` (id `CUSTOM:<code>`, the form the app's
asset editor and symbol resolution use). Custom provider sources are left out:
their URLs and headers can hold API keys. Stored sync errors stay internal for
the same reason, as in the quote service's other public reads: `get_asset`
reports a failed last sync with the generic `PublicError::provider_unavailable`
message, and `get_market_data_providers` passes on the counts and generic
messages `get_providers_info` returns. Custom providers report no error details,
since their failures are recorded under the dispatch row. The in-app assistant
does not get these tools.

`refresh_market_data` (`market-data:write`, also `holdings:read`) has four
modes. `latest`, `recent` (N days, default 30) and `history` (the app's "Refetch
prices") map to `MarketSyncMode` `Incremental`, `RefetchRecent` and
`BackfillHistory` and go through `AgentEnvironment::request_portfolio_job`,
which each host implements with the path its price buttons use: Tauri calls
`handle_portfolio_request`, Axum spawns the same coordinator job as
`enqueue_portfolio_job`. The job's one-at-a-time lock, retries and recalculation
are unchanged; the tool returns `queued` and the agent checks the result with
`get_asset` or `get_health_status`. The default implementation reports that the
environment cannot start jobs. Tauri builds the environment before its profile
context exists, so the context sets a `OnceLock` binding (app handle and a weak
context reference) when it is installed.

`replace` (asset ids required, at most 10, MARKET quote mode only) calls
`QuoteServiceTrait::reset_provider_history` for each asset during the call, in a
spawned task so a dropped request still commits. The reset fetches the history
from the asset's current provider and, in one transaction, replaces the provider
rows; MANUAL and BROKER quotes stay, and a failed fetch deletes nothing. The
quote service emits one `PriceHistoryChanged` per successful reset (and one per
`reset_all_provider_history` that replaced anything); the hosts' reset commands
no longer emit their own. Only enabled providers are used: the market data
client is built from enabled providers, as before.

`prepare_asset_update` / `commit_asset_update` (`market-data:write`, also
`holdings:read`; #2467) change an investment asset's quote currency, quote mode,
symbol, exchange MIC, preferred provider (any enabled provider, including an
existing custom one as `CUSTOM:<code>`) or one built-in provider's symbol. The
tools never create or configure providers. Both build the same plan:

- The full `UpdateAssetProfile` for `AssetServiceTrait::update_asset_profile`.
  Storage writes `provider_config`, `quote_mode`, `name`, `display_code` and
  `notes` even when a payload leaves them out, so the tool reads the asset and
  sends all of them back; `metadata` is left out, which storage preserves.
  Provider config keys the request does not touch are kept.
- `AssetServiceTrait::preview_asset_profile_update`, which runs the
  normalization and identity-collision check `update_asset_profile` runs, now
  shared in one function, and returns the profile that would be stored and any
  asset that already has the listing. A collision blocks the commit.
- A named provider must exist and be enabled; otherwise the plan is blocked
  before any request. When the listing, currency or provider of a MARKET asset
  changes, or the asset switches to MARKET, the new
  `QuoteServiceTrait::resolve_asset_quote` asks for the latest quote with the
  asset as it would be stored (its whole provider configuration, overrides
  included, as a sync uses it). No quote, an answer from another provider than
  the preferred one, or a quote in another currency or unit than the requested
  one (GBp and GBX count as the same) blocks the commit. The probe is the asset
  exactly as a sync would send it. Known limit: Alpha Vantage and Finnhub label
  a quote with the exchange's currency, or with the asset's own quote currency
  when the listing gives none, instead of reporting one, so for them the check
  cannot contradict that currency; Yahoo reports it. The preview always makes
  this request; the commit makes it again.
- The commit re-reads the asset after the provider request and saves nothing
  when any field the update writes changed meanwhile (storage does not bump
  `updated_at` on profile edits), so an edit made in the app is not overwritten.
  This is a check before the write, not a database compare-and-swap.
- For such changes the commit replaces the provider history afterwards (the
  `refresh_market_data` `replace` path), so rows in the old currency or from the
  old provider go away; MANUAL and BROKER quotes stay. `keepHistory: true` skips
  it. History cannot be replaced for custom providers; the preview warns.

`update_asset_profile` still resets the asset's sync state and emits
`AssetsUpdated`, which queues the sync and recalculation as for an edit in the
app. Transactions, quantities and cost are never changed.

### MCP-only Activity Update Tools

```text
prepare_activity_updates           -- preview corrections to existing activities (batch)
commit_activity_updates            -- apply confirmed corrections in place (batch)
prepare_activity_deletions         -- preview deleting existing activities (batch)
commit_activity_deletions          -- delete confirmed activities (batch)
```

These correct an activity already stored, such as adding the acquisition cost
and fee to a transfer in recorded before they were known, without re-importing
it. A row names an `activityId` and only the fields to change, from those the
activity grid edits: date, account, type, subtype, asset, quantity, unit price,
amount, currency, fee, tax, FX rate, notes, `approve` (the grid's Approve:
clears the review flag and posts a draft), and `void`. `void: true` sets a
posted activity's status to VOID and clears its review flag: it stays stored but
no longer counts in holdings, cash or performance, and `void: false` posts it
again. Only a posted activity is voided, so a restore always posts it. Omitted
fields keep their stored value and `null` clears an optional one; unknown fields
are refused.

Both tools go through `ActivityServiceTrait`. The preview calls
`preview_activity_update`, which runs `update_activity`'s validation and returns
what it would write for the activity and a linked transfer's other leg, without
its writes (asset creation, quote-mode changes, manual quotes, FX pair
registration). Each row lists every field that would change with its current and
proposed value, including values core derives, and the changes mirrored onto the
other leg. The commit validates each row again and calls `update_activity`, so a
bare date lands on that day in the configured timezone, the other leg of a
linked transfer receives the mirrored date, notes, amount and approval, the
portfolio recalculates from the earlier date, and the row is marked
user-modified so broker syncs keep the edit. It reports each changed field as
stored before and after. Updates never create activities and never use the
import flow.

The tools refuse, per row:

- an asset named by symbol: the asset changes only by the id of a stored asset,
  since resolving a symbol can look up or create assets through market-data
  providers;
- a change to the account, currency, type or asset of a linked transfer leg (or
  the quantity of a security transfer leg, or the FX rate of a cross-currency
  cash transfer leg, since core mirrors the amount with the pair's stored rate),
  which would break the pair; the error says to unlink first with
  `unlink_transfer_activities`;
- a missing activity, an invalid value, or a row that changes nothing;
- voiding a draft or a pending activity (which count toward nothing yet; delete
  them instead), voiding an activity already void, restoring one that is not,
  `void` together with `approve`, or voiding or restoring one leg of a linked
  transfer whose legs differ in status (core mirrors the status onto the other
  leg, so a draft leg would otherwise be posted without approval).

The deletion tools take a list of activity ids. The preview reads each activity
and, through `get_transfer_pair_for_activity`, the other leg of a linked
transfer, and lists both as stored; the commit checks each id again and calls
`delete_activities_checked`, which returns all deleted rows and recalculates the
portfolio. The existing SQLite writer transaction refuses the whole row if its
source-group cascade would remove an id outside that reviewed deletion set. This
also covers a link created between tool validation and the write, without adding
a lock or changing the native grid's deletion policy. The preview checks the
same stored group and refuses groups other than a recognized linked pair, even
when all group ids are named; those activities can be voided instead. Both legs
of a linked transfer must be named: a leg whose other leg is missing from the
call is refused, so a transfer linked after the preview cannot delete an
activity the user never reviewed. The row naming the second leg reports the row
that deletes it (`deletedWith`); a repeated id is refused. A row warns when an
activity came from a broker sync, which may add a deleted activity back; voiding
keeps it out of calculations and, because the update marks it user-modified,
broker syncs keep it void. The commit reports each deleted activity as it was
stored. The audit log keeps only the ids.

Each row in a batch (up to 100) succeeds or fails on its own. The audit log
keeps only each row's activity id and the names of the fields it sets, never
their values. The in-app assistant does not get these tools; users edit in the
activity grid.

For transaction categories, show the proposals from
`propose_transaction_categories` to the user first. After confirmation, pass the
selected `activityId`, `taxonomyId`, and `categoryId` values to
`commit_transaction_categories`:

```json
{
  "assignments": [
    {
      "activityId": "activity-1",
      "taxonomyId": "spending_categories",
      "categoryId": "category-1"
    }
  ]
}
```

The tool accepts 1–100 assignments and rejects blank IDs or duplicate
activity/taxonomy pairs. It calls the same bulk spending service as the in-app
Apply action. Activities must belong to eligible, opted-in spending accounts
with spending enabled; each taxonomy must match the activity's cash-flow bucket,
and each category must belong to that taxonomy. The entire batch succeeds or
fails together. Split replacement requires explicit intent and the expected
current split state.

Each confirmed assignment replaces the current category for its
activity/taxonomy pair. Ordinary assignments protect split transactions: if any
submitted row has splits, the whole batch conflicts and nothing is written. An
explicit single-category replacement includes `expectedSplits`, the full current
split rows returned by `search_spending_transactions`. Inside the existing
SQLite writer transaction, IDs, categories, amounts, notes, sort order and
timestamps are compared before clearing splits and assigning the category.
Changed state returns `draftStatus: "conflict"`, `assignmentCount: 0` and
per-row `conflicts`. Native bulk Apply uses the same guard; the split editor has
a separate confirmed replacement action. Financial activity fields stay
unchanged. The result includes `draftStatus: "applied"`, `assignmentCount`, the
stored `assignments` (source `manual`, weight `10000`), and `appliedAt`.
Repeating the same payload keeps one assignment with its existing ID; timestamps
may change. There is no draft-version check: a delayed commit or retry can
overwrite an intervening single-category edit. New or changed splits are
protected. Refresh the proposals and reconfirm when the intended assignment
changes. Audit arguments retain only the assignment count.

For categorization rules, `create_categorization_rule` returns an in-memory
draft and does not save it. After showing that draft to the user and receiving
confirmation, an MCP client passes the returned `rule` object to
`commit_categorization_rule`. The commit calls the same rule service as the
in-app confirmation widget; there is no server-side pending-draft queue. The
commit saves the rule for future categorization; it does not rerun rules over
existing transactions. `rerun_categorization_rules` does that once the user
asks.

Rules:

- Draft and import-preview tools never mutate data; activity commits require
  `activities:write` (which itself requires `activities:draft`), classification
  commits require `classification:write` (which itself requires
  `classification:suggest`), quote imports require `market-data:write` (which
  itself requires `holdings:read`), account changes require `accounts:write`
  (which itself requires `accounts:read`), and holdings snapshots require
  `holdings:write` (which itself requires `holdings:read`).
- CSV / activity-row content must not be persisted in raw audit logs: the
  write/import tools redact their `activities`/row arguments to a count
  (`"[N rows]"`) via per-tool audit sanitization.
- Activity writes go through existing activity services and validation.
- Suggestions return proposed assignments and rationale; agents never directly
  alter allocation semantics.

### MCP-only Portfolio Setup Tools

```text
prepare_account_change             -- preview creating or updating one account
commit_account_change              -- save it
get_holdings_snapshots             -- list an account's snapshot dates, or read one
prepare_holdings_snapshot          -- preview one date's positions and cash
commit_holdings_snapshot           -- save it
get_exchange_rates                 -- read stored exchange rates
prepare_alternative_asset          -- preview creating an alternative asset or liability
commit_alternative_asset           -- create it
```

These let an agent create the accounts it imports into, and fix an account's
details, without the app. Without `accountId` the change creates an account
(`name`, `accountType`, `currency` and `trackingMode` are required); with it,
the change updates that account and fields left out keep their stored values.
Settable fields: `name` (2 to 50 characters, as in the app's form),
`accountType`, `currency` (create only: every path keeps an account's currency
fixed), `group` and `accountNumber` (null clears), `trackingMode`
(`TRANSACTIONS` or `HOLDINGS`), `hidden` and `archived`. There is no delete.

`prepare_account_change` reads every account and reports the stored account, the
proposed one, the changed fields, other accounts with the same name
(case-insensitive) and warnings: the currency is fixed after creation, a
tracking mode switch leaves the other mode's activities or snapshots stored but
unused, and values in a non-base currency convert through exchange rates. Errors
block the change: a name clash unless `allowDuplicateName` is set (so a repeated
create cannot add a second account), a credit card in `HOLDINGS` mode, a
currency change, or an unknown account. A broker-connected account keeps its
provider link and account number, and its tracking mode cannot change here: in
the app that change starts a broker sync, which an agent should not start
unseen. Account numbers are masked to their last four characters in previews and
redacted in the audit log.

`commit_account_change` runs the same checks and saves through
`AccountServiceTrait::create_account` or `update_account`, the calls behind the
app's account form, so FX pair registration and the `AccountsChanged` and
`TrackingModeChanged` events (and the recalculation they plan) are unchanged. An
update sends back the stored `is_default` and provider fields and leaves the
account's meta (cost basis settings) as stored; an update that changes nothing
writes nothing. Both tools need `accounts:read` and `accounts:write`; the in-app
assistant does not get them.

The snapshot tools set up a HOLDINGS-mode account, whose holdings come from
dated snapshots instead of activities. `get_holdings_snapshots`
(`holdings:read`) lists an account's snapshot dates with their source, or
returns one date's positions (asset id, symbol, quantity, average cost,
currency) and cash. `prepare_holdings_snapshot` and `commit_holdings_snapshot`
(`holdings:read` and `holdings:write`) take an account, a date and every
position held on it, and accept only HOLDINGS-mode accounts that are not
connected to a broker (a broker's sync writes those snapshots). A snapshot
replaces whatever is stored on its date, so positions left out are not held
then; the preview says so and lists each position as added, changed, unchanged
or removed against that date's snapshot or, when there is none, the latest
earlier one. Cash left out (or null) is carried forward from that compared
snapshot, never zeroed; an empty list means no cash. A position names an asset
by `assetId`, or a reviewed listing (symbol, quote currency, instrument type
and, for an equity not priced by hand, exchange MIC: the rule
`AssetResolutionInput::reviewed_metadata_is_sufficient` applies to holdings
imports), so neither the preview nor the save looks a symbol up with a market
data provider. A listing that names a stored asset, as saving would match it
(`AssetServiceTrait::find_asset_by_listing`, the instrument-key lookup
`get_or_create_minimal_asset` uses), is that asset: the preview compares and
deduplicates it by its id; new listings with one instrument key
(`listing_instrument_key`, such as `BTC` and `BTC-USD`) are one asset too. A
stored position keeps its own currency, which can differ from its asset's quote
(a GBP cost for a GBp quote). A quote mode is set only on a new asset; a row
that would change a stored asset's mode is refused, since that would reprice the
asset in every account. The compared snapshot is read as one row through
`SnapshotServiceTrait::get_latest_holdings_keyframe`: the latest saved snapshot
for a HOLDINGS-mode account, the latest calculated one otherwise, each one
repository query. Quote and cash currencies are read as core spells them:
uppercased, except minor units such as GBp, so `usd` is USD. Dates follow the
holdings import's rules (a real day, not in the future). The commit saves
through `ManualSnapshotService::save_manual_holdings`, the function behind the
app's holdings form, so new assets, FX pair registration and the
`HoldingsChanged` event (and the recalculation it plans) are the same. That
includes the form's one price write: a hand-priced asset with no price on or
before the date gets its average cost as its first price; the preview lists
these in `firstPrices`. Other prices go through `commit_quote_import`. Up to 200
positions per snapshot; the audit log keeps the account, date, asset ids,
symbols and counts, never quantities, costs or cash. The tools reach the
snapshot and FX services through `AgentEnvironment::snapshot_service` and
`fx_service`, whose default bodies return `None`, so test environments need no
change.

`get_exchange_rates` (`holdings:read`) reads the stored rates valuations use,
through `FxServiceTrait`; it never fetches from a provider. Without dates it
returns the latest rate of each registered pair, optionally only pairs involving
the given currencies. With dates (up to 31) it returns each given currency's
rate into `to` (the base currency by default) on each date, through
`get_exchange_rates_for_dates`, the lookup valuations use; a pair without a
stored rate returns an error for that row.

`prepare_alternative_asset` and `commit_alternative_asset` (`holdings:read` and
`holdings:write`) create one property, vehicle, collectible, precious metal,
private equity holding, other asset or liability through
`AlternativeAssetServiceTrait::create_alternative_asset`, as the app's quick-add
form does: the value on its date is saved as a manual price. A liability is a
manual balance with a type (mortgage, auto, student or personal loan, HELOC,
other) and optionally the asset it finances; it takes no loan setup, so loans
with an interest rate, term and payment schedule stay in the app. Purchase price
and date are for assets only, and a precious metal needs its metal, quantity and
unit. A name another asset of the same kind already has is refused unless
`allowDuplicateName` is set, so a repeated create adds nothing. Dated values and
balances go through `prepare_quote_import` / `commit_quote_import`
(`market-data:write`), which accept manual alternative assets: a batch of
monthly balances is one call and one recalculation. The quote import takes
prices above zero only, so a paid-off (zero) balance is entered as the
`currentValue` at creation or in the app. The commit is the one additive MCP
write besides `commit_categorization_rule`: it creates an asset, its first
manual price and, for a non-base currency, its FX pair, and changes nothing
stored. Creating an alternative asset in another currency than the base one
registers the pair to the base currency in core (`with_fx_registration`), as
account creation does; before, no pair was registered and net worth history
counted the value unconverted. The audit log keeps the kind, currency, dates and
link, never names or amounts. The tools reach the service through
`AgentEnvironment::alternative_asset_service`, `None` by default.

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
                         get_valuation_history, get_income, get_net_worth,
                         get_asset, get_quote_history,
                         get_market_data_providers, get_holdings_snapshots,
                         get_exchange_rates
performance:read         get_performance
activities:read          search_activities, get_import_mapping,
                         find_transfer_matches
financial-planning:read  get_goals, get_contribution_limits
health:read              get_health_status
classification:read      list_asset_taxonomies, get_asset_taxonomy_assignments
spending:read            get_spending_context, search_spending_transactions,
                         list_transaction_categories, list_categorization_context,
                         list_categorization_rules, propose_transaction_categories,
                         create_categorization_rule
```

Write / draft / suggest scopes:

```text
activities:draft         record_activity, record_activities,
                         prepare_activity_import,
                         prepare_activity_updates,
                         prepare_activity_deletions (each also requires
                         activities:read)
activities:write         commit_activity_draft / commit_activity_drafts,
                         commit_activity_import  (each also requires
                         activities:draft),
                         link_transfer_activities / unlink_transfer_activities,
                         commit_activity_updates,
                         commit_activity_deletions
                         (each also requires activities:read and
                         activities:draft)
classification:suggest   prepare_asset_classification
classification:write     commit_asset_classification_draft
                         (also requires classification:suggest)
spending:write           commit_categorization_rule, commit_transaction_categories,
                         rerun_categorization_rules (also requires spending:read)
budget:write             budget management (also requires spending:read;
                         independent of spending:write)
market-data:write        prepare_quote_import, commit_quote_import,
                         refresh_market_data,
                         prepare_asset_update, commit_asset_update
                         (each also requires holdings:read)
accounts:write           prepare_account_change, commit_account_change
                         (each also requires accounts:read)
holdings:write           prepare_holdings_snapshot, commit_holdings_snapshot,
                         prepare_alternative_asset, commit_alternative_asset
                         (each also requires holdings:read)
```

Spending tools no longer accept `classification:*` or `activities:read` as a
substitute for `spending:read`. Persisted tokens keep their exact grants; there
is no automatic scope migration or compatibility alias. Investment and general
activity tools retain their own scopes. Both Spending writes require
`spending:read` and neither implies the other.

`get_spending_context` reports disabled/no-account states, effective enrollment,
exclusions, currency and timezone. `search_spending_transactions` intersects all
filters with that enrollment and returns native-currency rows, full splits,
canonical `effectiveAllocations`, a `hasHiddenAssignment` diagnostic for legacy
dual-state rows, and explicit pagination. It requests no FX. Category discovery
is independent of transaction history and the enabled toggle.

Dependency rules: `activities:write` requires `activities:draft`, and
`classification:write` requires `classification:suggest` (you cannot commit
without the matching draft/suggest capability). `market-data:write` requires
`holdings:read`: both quote tools return stored quotes, so the scope reaches no
tool without it. `accounts:write` requires `accounts:read` for the same reason:
the account change preview shows the stored accounts, and `holdings:write`
requires `holdings:read`, as the snapshot preview shows the stored holdings.
Token creation validates these, and no preset grants `market-data:write`,
`accounts:write` or `holdings:write`.

Presets (`AgentScopeSet` constructors):

- `read-only` — all read scopes, including `spending:read` for newly minted
  tokens.
- `spending-view` — `spending:read`.
- `spending-organize` — `spending:read` + `spending:write`.
- `spending-budgets` — `spending:read` + `budget:write`.
- `read-activity-draft` — read + `activities:draft`.
- `read-activity-write` — read + `activities:draft` + `activities:write`.
- `read-activity-write-classification-suggest` — the above plus
  `classification:suggest` and `classification:write` for assets; no Spending
  writes.

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
