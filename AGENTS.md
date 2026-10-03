# AGENTS.md

Shared instructions for agents working on Wealthfolio, a local-first finance app
with a React frontend, Tauri desktop/mobile runtime, and Axum web server.

## Working agreements

- Resolve routine implementation choices from nearby code. State material
  assumptions; ask when ambiguity changes scope, public behavior, data
  compatibility, or an irreversible action.
- Prefer the smallest readable change that satisfies the task. Avoid speculative
  features and abstractions; preserve validation at external input and
  persistence boundaries.
- Reuse before adding infrastructure: trace the existing service, event, queue,
  and error handling before proposing a new mechanism. Extend those first.
- Before adding a migration, persisted state, worker, retry mechanism, or
  synchronization primitive, explain the concrete failure it prevents and why
  existing mechanisms cannot handle it. Separate required behavior from optional
  resilience; do not add optional resilience without agreement.
- Match existing style. Do not refactor unrelated code or reformat adjacent
  files. Remove only imports, variables, and functions made unused by your
  changes.
- Preserve existing user changes. Report unrelated issues rather than fixing
  them.
- For multi-step work, give a brief plan with verification steps. Keep plans
  clear and concise; identify what is reused, added, and deferred, and list
  unresolved questions only when they need an answer.

## Architecture boundaries for fixes and refactors

Before implementation, trace the affected execution path and identify whether
proposed changes alter network calls or provider settings, synchronous versus
background execution, persistence or events, ownership of business logic,
failure propagation, retries, or user-edit precedence.

For small fixes and behavior-preserving refactors, preserve these boundaries. If
a boundary change is necessary, explain the previous and proposed behavior, why
the existing mechanism is insufficient, and the required validation before
proceeding. Include an explicit **Architecture impact** note in the plan and PR
description: either name the boundaries that remain unchanged, or describe the
changes and their validation. Revisit this note if the implementation expands.
Do not call a change a refactor if it changes observable behavior, side effects,
or execution timing.

Test architectural invariants as well as successful outcomes: disabled providers
receive no requests, local resolution does not acquire new network dependencies,
provider failures stay isolated, and enrichment preserves user edits. In final
reports and PR descriptions, state changed boundaries and distinguish tested
guarantees from unverified assumptions.

## Architecture and implementation

- Frontend code lives in `apps/frontend/src/`; shared TypeScript packages live
  in `packages/`. Reuse `@wealthfolio/ui` components and existing feature
  patterns.
- Frontend calls go through `@/adapters`. `apps/frontend/vite.config.ts` selects
  Tauri or web adapters at build time using `BUILD_TARGET`; `adapters/index.ts`
  defaults to Tauri for TypeScript checking, as does the `#platform` alias in
  `apps/frontend/tsconfig.json`. TypeScript includes the frontend source tree,
  but these aliases do not validate both runtime configurations equivalently.
- Shared domain calls live in `apps/frontend/src/adapters/shared/` and use
  `shared/platform.ts`, which resolves through `#platform`. Runtime-specific
  operations live in `adapters/tauri/` and `adapters/web/`; some features own
  local adapters. Follow the relevant existing domain instead of creating a new
  layer.
- Keep Tauri commands (`apps/tauri/src/commands/`) and Axum handlers
  (`apps/server/src/api/`) thin. Put shared business logic in the owning Rust
  crate; core services live in `crates/core/`, persistence and migrations in
  `crates/storage-sqlite/`. Add schema changes as new migrations in
  `crates/storage-sqlite/migrations/`; never edit a migration already shipped.

When adding or changing a backend call, trace both runtime paths: the frontend
adapter/export, Tauri command registration in `apps/tauri/src/lib.rs`, web
command mapping in `apps/frontend/src/adapters/web/core.ts`, and Axum
route/handler. Use `apps/frontend/src/adapters/shared/accounts.ts` as a
shared-call example and
`apps/frontend/src/adapters/adapter-command-parity.test.ts` to check wiring.

For UI work, use React Router in `apps/frontend/src/routes.tsx`, existing
react-hook-form/Zod form patterns, and theme tokens in
`apps/frontend/src/globals.css`. Prefer interfaces for object shapes, named
component exports, and lowercase-with-dashes directories; avoid TypeScript
enums. For Rust domain errors, follow the existing `Result`/`Option` and
`thiserror` patterns.

## Persisted identifiers and security

- Reuse named constants for secret-store keys and identifiers shared across code
  paths. Put shared constants in the owning module/crate; preserve persisted key
  values when replacing literals.
- Preserve local-first SQLite storage and existing opt-in broker/device-sync
  boundaries. Do not introduce new storage or transmission of financial data
  outside the requested scope.
- Access secrets through `SecretStore` in `crates/core/src/secrets/mod.rs`.
  Tauri uses native credential storage (`apps/tauri/src/secret_store.rs`); the
  web server uses a file-backed store with configured encryption
  (`apps/server/src/secrets/mod.rs`, `apps/server/src/config.rs`). Preserve
  these protections; do not add plaintext persistence or browser localStorage
  for secrets.
- Never log secrets or financial data.

## Setup and commands

Run commands from the repository root unless noted. Use the Node version in
`.node-version`, pnpm version in `package.json`, and Rust toolchain in
`rust-toolchain.toml`. Install JS dependencies with
`pnpm install --frozen-lockfile`. Build package declarations with
`pnpm build:types` before standalone frontend checks/builds in a fresh checkout;
`pnpm type-check` includes that step.

| Task                       | Command / scope                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| Desktop development        | `pnpm tauri dev` (persistent dev process)                                      |
| Web development            | `pnpm dev:web` (persistent dev process)                                        |
| TS tests, one run          | `pnpm --filter frontend exec vitest run` (append a test path for focused runs) |
| TS formatting, lint, types | `pnpm check` (does not run tests, builds, or Rust checks)                      |
| TS type checks             | `pnpm type-check`                                                              |
| Web frontend build         | `pnpm build`                                                                   |
| Tauri frontend build       | `pnpm build:tauri` (does not compile Rust)                                     |
| Focused Rust tests         | `cargo test --locked -p <crate> <test_filter>`                                 |
| Rust runtime compilation   | `cargo check --locked -p wealthfolio-app -p wealthfolio-server`                |

## Validation by change

Start with focused regression checks, then cover the affected consumers. After
checks pass, repeat or broaden them only for new changes, failures, or
unresolved risk. Do not substitute a running dev server for a completed build
check.

- **Documentation/instructions:** verify referenced paths, commands, imports,
  and consistency; check formatting and diff. Application builds/tests are
  unnecessary.
- **Frontend or shared TS packages:** run relevant one-shot tests, lint, and
  `pnpm type-check`. Routine component changes do not require both builds. For
  adapter/runtime wiring, Vite/build configuration, dependencies, or shared
  package changes affecting both bundles, run `pnpm build` and
  `pnpm build:tauri`. For target-specific build changes, build that target.
- **Adapter/API wiring:** also run
  `pnpm --filter frontend exec vitest run src/adapters/adapter-command-parity.test.ts`;
  check affected Rust runtimes and relevant handler/service tests.
- **Rust logic or persistence:** run focused crate tests,
  `cargo fmt --all -- --check`, and Clippy for affected crates with
  `cargo clippy --locked -p <crate> --all-targets --all-features -- -D warnings`.
  Compile affected consumers; shared backend changes require both runtime
  packages in the command above. CI runs Clippy across `--workspace`.
- **UI text/translations:** update affected keys and plural forms in every
  supported locale; run `pnpm --filter frontend i18n:check`.
- **UI behavior/layout:** exercise the changed flow. Run
  `pnpm test:e2e:net-worth` for relevant net-worth layout changes and
  `pnpm test:e2e:addon-sandbox` for addon sandbox changes. For application
  flows, use `pnpm test:e2e` or focused specs. Before running E2E tests, consult
  `.claude/skills/run-e2e-tests/SKILL.md` and `e2e/README.md` for setup; use the
  selected suite's script/config for its server and browser requirements.

For full PR checks and environment prerequisites, consult
`.github/workflows/pr-check.yml` and relevant specialized workflows when working
in that area. Rust storage outbox tests need
`CONNECT_API_URL=http://test.local`; Tauri compilation needs frontend assets at
the configured `frontendDist` (build with `pnpm build:tauri`; CI documents its
placeholder setup). Native/mobile checks also require the target's system
dependencies and SDKs.

Report checks that were blocked or not run and why; never imply they passed.
Review the final diff for unrelated changes before finishing.

## Code review rules

Challenge whether each new mechanism needs to exist, not only whether it works.

For bug-fix reviews:

- Trace the reported symptom through the actual execution path before judging
  the fix. Establish why the original code fails and how the change prevents it.
- Seek a reproduction or regression test that fails before and passes after.
- Distinguish confirmed findings, hypotheses, and unverified behavior.
- “No regressions found” does not mean “the reported bug is fixed.” If
  root-cause evidence is missing, explicitly conclude **“fix not verified”**; do
  not imply approval.
- Inspect the exact PR revision and report validation limitations.
