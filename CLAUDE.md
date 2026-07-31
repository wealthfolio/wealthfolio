# CLAUDE.md — wealthfolio

Bryan's maintained fork of Wealthfolio. **Dormant** unless a custom build or an upstream PR
is wanted.

| remote | branch | notes |
|---|---|---|
| `origin` | **`bryan-main`** (default) | https://github.com/btankc/wealthfolio — upstream main plus the `alternativeAssets` addon-API patch |
| `upstream` | `main` | https://github.com/wealthfolio/wealthfolio |

- `STATE.md` is local and **git-excluded** — read it, never commit it.
- Package manager is `corepack pnpm`. Not bare npm, not bare pnpm.
- A second router at `.claude/CLAUDE.md` covers the app layout (`apps/`, `crates/`,
  `packages/`).

## Project-local skills — these ship with the fork, not with the workspace

`.claude/skills/` and `.claude/commands/` here carry upstream Wealthfolio's own tooling. They
are scoped to this repo and are the right tools inside it; nothing else in the workspace is
React, so they are deliberately unrouted anywhere else.

| when | use |
|---|---|
| touching a `useEffect` — dependency arrays, cleanup, effects that should not be effects | `react-useeffect` |
| running or adding end-to-end tests | `run-e2e-tests` |
| the upstream contributor-interview flow | `/interview` |

For React component API design and performance, the workspace-level `composition-patterns`
and `react-best-practices` apply here too — they are React-only and this is the only React
codebase.

## Before any upgrade — read this first

The v3 networking migration is the expensive lesson. The webview blocks `fetch` outright and
the broker SSRF-blocks private IPs, so reaching the finance bridge on the LAN needs
`ctx.api.network.request` plus HTTPS over Tailscale Serve (a `100.x` address counts as shared,
not private). Installed SDK typings also lied about the wire format — verify payload shapes
against the host app's source at its current version, not against the local `.d.ts`, and never
discard a bulk API's `result.errors`: v3 bulk save is all-or-nothing and total rejection looks
identical to success without them.

The consumer of this fork is the rental-tax addon in `~/finances`; its bridge contract is what
breaks first when upstream changes.
