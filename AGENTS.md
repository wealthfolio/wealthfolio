# AGENTS.md

AI agent guide for this repository. Covers behavioral rules, architecture, and
common task playbooks.

---

## Behavioral Guidelines

**These come first because they prevent the most mistakes.**

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them—don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

### 2. Simplicity First

- No features beyond what was asked.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

### 3. Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated issues, mention them—don't fix them.
- Remove only what YOUR changes made unused.

### 4. Goal-Driven Execution

- Transform tasks into verifiable goals.
- For multi-step tasks, state a brief plan with verification steps.
- Unverified work is incomplete work.

### 5. Output Precision

- Lead with findings, not process descriptions.
- Use structured formats (lists, tables, code blocks).
- Include absolute file paths—never relative.

---

## Overview

- **Frontend**: React + Vite + Tailwind v4 + shadcn (`apps/frontend/`)
- **Desktop**: Tauri/Rust with SQLite (`apps/tauri/`, `crates/`)
- **Web mode**: Axum HTTP server (`apps/server/`)
- **Packages**: `@wealthfolio/ui`, addon-sdk, addon-dev-tools (`packages/`)

## Code Layout

```
apps/frontend/
├── src/
│   ├── pages/          # Route pages
│   ├── components/     # Shared components
│   ├── features/       # Self-contained feature modules
│   ├── commands/       # Backend call wrappers (Tauri/Web)
│   ├── adapters/       # Runtime detection (desktop vs web)
│   └── addons/         # Addon runtime

apps/tauri/src/
└── commands/           # Tauri IPC commands

apps/server/src/
└── api/                # Axum HTTP handlers

crates/
├── core/               # Business logic, models, services
├── storage-sqlite/     # Diesel ORM, repositories, migrations
├── market-data/        # Market data providers
├── connect/            # External integrations
├── device-sync/        # Device sync, E2EE
└── ai/                 # AI providers and LLM integration
```

## Run Targets

| Task         | Command                          |
| ------------ | -------------------------------- |
| Desktop dev  | `pnpm tauri dev`                 |
| Android init | `pnpm tauri android init`        |
| Android dev  | `pnpm tauri android dev`         |
| Android APK  | `pnpm tauri android build --apk` |
| Web dev      | `pnpm run dev:web`               |
| Tests (TS)   | `pnpm test`                      |
| Tests (Rust) | `cargo test`                     |
| Type check   | `pnpm type-check`                |
| Lint         | `pnpm lint`                      |
| All checks   | `pnpm check`                     |

---

## Agent Playbook

### Bug-fix PR reviews

- Trace the reported symptom through the actual execution path before judging
  the fix.
- Establish why the original code fails and how the changed code prevents that
  failure.
- Seek a reproduction or regression test that fails before and passes after.
- Distinguish confirmed findings, hypotheses, and unverified behavior.
- “No regressions found” does not mean “the reported bug is fixed.”
- If root-cause evidence is missing, explicitly conclude **“fix not verified”**;
  do not imply approval.
- Inspect the exact PR revision and report validation limitations.

### Adding a feature with backend data

1. **Frontend route/UI** → `apps/frontend/src/pages/`,
   `apps/frontend/src/routes.tsx`
2. **Command wrapper** → `apps/frontend/src/commands/<domain>.ts` (follow
   `RUN_ENV` pattern)
3. **Tauri command** → `apps/tauri/src/commands/*.rs`, wire in `mod.rs` +
   `lib.rs`
4. **Web endpoint** → `apps/server/src/api/`, call `crates/core` service
5. **Core logic** → `crates/core/` services/repos
6. **Tests** → Vitest for TS, `#[test]` for Rust

### UI patterns

- Components: `@wealthfolio/ui` and `packages/ui/src/components/`
- Forms: `react-hook-form` + `zod` schemas from
  `apps/frontend/src/lib/schemas.ts`
- Theme: tokens in `apps/frontend/src/globals.css`

### Architecture pattern

```
Frontend → Adapter (tauri/web) → Command wrapper
                ↓
        Tauri IPC  |  Axum HTTP
                ↓
           crates/core (business logic)
                ↓
           crates/storage-sqlite
```

---

## Conventions

### Avoid magic strings

- Use named constants for secret-store keys and other identifiers shared across
  code paths.
- Reuse existing constants; do not duplicate their declarations or inline their
  values at call sites.
- Put shared constants in the owning module or crate and import them across
  runtimes where possible.
- Keep persisted key values unchanged when replacing literals with constants.

### TypeScript

- Strict mode, no unused locals/params
- Prefer interfaces over types, avoid enums
- Functional components, named exports
- Directory names: lowercase-with-dashes

### Rust

- Idiomatic Rust, small focused functions
- `Result`/`Option`, propagate with `?`, `thiserror` for domain errors
- Keep Tauri/Axum commands thin—delegate to `crates/core`
- Migrations in `crates/storage-sqlite/migrations`

### Security

- All data local (SQLite), no cloud
- Secrets via OS keyring—never disk/localStorage
- Never log secrets or financial data

---

## Validation Checklist

Before completing any task:

- [ ] Builds: `pnpm build` or `pnpm tauri dev` or `cargo check`
- [ ] Tests pass: `pnpm test` and/or `cargo test`
- [ ] Both desktop and web compile if touching shared code
- [ ] Changes are minimal and surgical

---

## Plan Mode

- Make plans extremely concise. Sacrifice grammar for brevity.
- End with unresolved questions, if any.

---

When in doubt, follow the nearest existing pattern.
