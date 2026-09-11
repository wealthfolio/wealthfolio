# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Wealthfolio — local-first desktop investment tracker. React + Vite frontend,
Tauri/Rust backend, SQLite storage. Runs in two modes: **desktop** (Tauri
native app) and **web** (Axum HTTP server + browser).

## Key Directories

- `apps/frontend/` — React app (pages, components, adapters, hooks)
- `apps/tauri/` — Tauri desktop app (IPC command handlers, app lifecycle)
- `apps/server/` — Axum HTTP server (web mode route handlers)
- `crates/wealthfolio-core` — Database-agnostic domain logic, service traits, domain models
- `crates/wealthfolio-storage-sqlite` — Diesel/SQLite implementations of core traits
- `crates/wealthfolio-market-data` — Provider-agnostic quote fetching (Yahoo, Alpha Vantage, etc.)
- `crates/wealthfolio-connect` — Cloud broker sync (feature-gated: `connect-sync`)
- `crates/wealthfolio-device-sync` — E2EE device pairing/sync (feature-gated: `device-sync`)
- `packages/` — Shared TS packages (addon-sdk, ui, addon-dev-tools)
- `addons/` — Distributable addon plugins

## Quick Commands

- Dev desktop: `pnpm tauri dev`
- Dev web: `pnpm run dev:web`
- Tests: `pnpm test` | `cargo test`
- Single Rust test: `cargo test -p wealthfolio-core test_name`
- Type check: `pnpm type-check`
- Lint: `pnpm lint`

## Docker (web mode only)

Docker targets the **web mode** only — the desktop Tauri app requires native OS
access. The Dockerfile is a multi-stage production build (not a dev environment).

```bash
docker build -t wealthfolio-web .
docker run -e WF_LISTEN_ADDR=0.0.0.0:8080 -p 8080:8080 -v wf-data:/data wealthfolio-web
```

For development, use `pnpm run dev:web` (Vite + Axum with hot reload).
Copy `.env.web.example` → `.env.web`. Required vars: `WF_SECRET_KEY`
(`openssl rand -base64 32`) and `WF_AUTH_PASSWORD_HASH` (Argon2id hash).

## Logs

**Dev:** Rust logs print to the terminal; frontend logs go to browser DevTools.  
**Tauri production:** macOS `~/Library/Logs/com.wealthfolio.app/`, Linux
`~/.local/share/com.wealthfolio.app/logs/`, Windows `%APPDATA%\com.wealthfolio.app\logs\`  
**Docker:** `docker logs <container>`

## Architecture

### Desktop vs Web modes

Both modes share the same Rust service layer (`ServiceContext` / `AppState`),
crates, and domain logic. Only the transport layer differs:

| | Desktop | Web |
|---|---|---|
| Transport | Tauri IPC (`invoke()`) | HTTP REST (`/api/v1/*`) |
| Events | Tauri events → `listen()` | SSE stream |
| Auth | Keyring (local) | JWT cookies |
| DB path | OS app-data dir | `WF_DB_PATH` env var |

### Frontend adapter pattern

`apps/frontend/src/adapters/` abstracts the transport. Vite's `resolve.alias`
swaps the adapter at build time:
- `adapters/tauri/` — wraps `invoke()` with 120s timeout
- `adapters/web/` — wraps `fetch()` using a `COMMANDS → HTTP route` map

Never call `invoke()` or `fetch()` directly from components — always go through
adapters.

### IPC: adding a new command

1. Define the Rust handler in `apps/tauri/src/commands/<domain>.rs`:
   ```rust
   #[tauri::command]
   pub async fn my_command(state: State<'_, Arc<ServiceContext>>) -> Result<T, String>
   ```
2. Register it in `apps/tauri/src/lib.rs` (`invoke_handler`)
3. Add the Axum route in `apps/server/src/api/<domain>.rs`
4. Add the adapter call in both `adapters/tauri/<domain>.ts` and
   `adapters/web/<domain>.ts`

### Rust crate boundaries

- **core** — no database, no Diesel. Only traits, models, and business logic.
- **storage-sqlite** — only crate with Diesel. Implements core traits.
- **market-data** — stateless provider chain; no persistence.
- **connect / device-sync** — optional via feature flags; depend on core only.

Services are injected into `ServiceContext` at startup. Database writes go
through a `WriteHandle` actor to prevent SQLite deadlocks.

### Domain events

Service mutations emit `DomainEvent` → async event sink → debounced queue
worker → portfolio recalc + frontend notification (Tauri events or SSE).
Frontend doesn't receive direct mutation results for state; it re-queries
after events.

### Key data model notes

- All monetary values use `Decimal` (not `f64`)
- `ActivityType`, `TrackingMode`, etc. are enums — not strings
- `Activity.status = PENDING_REVIEW` blocks portfolio calculations
- Holdings are derived from activities, not stored independently

## Frontend Conventions

- Component files: PascalCase. Directories: lowercase-with-dashes.
- File order: component export → subcomponents → helpers → static content → types
- State: TanStack Query for server state; no duplication into client stores
- Router: TanStack Router

## Rust Conventions

- Error handling: `thiserror` for custom errors, `?` operator throughout
- Async: `#[tokio::test]` for async tests
- No `unwrap()` in production paths

---

## Plan Mode

Make plans extremely concise. Sacrifice grammar for concision. End each plan
with a list of unresolved questions, if any.

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

### 1. Think Before Coding

Before implementing: state assumptions explicitly. If multiple interpretations
exist, present them. If simpler approach exists, say so. If unclear, stop and ask.

### 2. Simplicity First

Minimum code that solves the problem. No speculative features, abstractions for
single-use code, or error handling for impossible scenarios. If you write 200
lines and it could be 50, rewrite it.

### 3. Surgical Changes

Touch only what you must. Don't improve adjacent code. Match existing style.
Remove imports/variables YOUR changes made unused, but not pre-existing dead code.

### 4. Goal-Driven Execution

Transform tasks into verifiable goals. For multi-step tasks:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```
