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
