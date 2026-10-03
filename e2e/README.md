# E2E Tests

Wealthfolio E2E tests use [Playwright](https://playwright.dev/) and run against
the **web app** (not the Tauri desktop app). The frontend and Rust backend run
against a fresh SQLite database. The automated runner uses synthetic market-data
fixtures; application APIs and persistence are not mocked.

---

## Prerequisites

- `pnpm` installed
- Rust toolchain installed (for the backend server)
- Chrome installed (Playwright uses the system Chrome)

---

## Running E2E Tests

### Automated — full suite

The easiest way to run the entire suite. Handles everything automatically:
prepares a fresh database, starts the web app, waits for both servers, runs
Playwright, and shuts everything down.

```bash
pnpm test:e2e
```

The runner replaces supported market-data providers with fixtures and disables
other providers. Treasury fixtures supply security terms and yield curves to the
real Treasury parser and calculator. See
[the fixture contract](fixtures/quotes/README.md).

Run the regular bond regression with the same setup:

```bash
pnpm test:e2e e2e/22-bond-fixtures.spec.ts
```

To open the Playwright UI instead:

```bash
pnpm test:e2e:ui
```

---

### Manual — specific tests or debugging

Use this when you want to run a subset of tests or iterate quickly without
restarting the server on every run.

#### Step 1 — Prepare a fresh database

```bash
node scripts/prep-e2e.mjs
```

This creates a unique timestamped data directory (e.g.
`db/app-testing-20260411T120000Z-XXXXXX/`) and writes its database, vault, and
addon paths to `.env.web`. The profile registry and profile databases stay in
that directory too. **Run this every time** before starting the server —
changing only the database filename would reuse the previous installation's
profiles.

#### Step 2 — Start the web app

**Option A — watch the terminal output directly:**

```bash
WEALTHFOLIO_E2E=1 WEALTHFOLIO_FIXTURE_DIR="$PWD/e2e/fixtures/quotes" pnpm run dev:web
```

Leave those fixture variables unset only when running the opt-in live-provider
spec.

Wait until you see Vite's "ready in Xms" and the Rust server binding messages,
then move on to Step 3 in a separate terminal.

**Option B — redirect output to a log file and use the wait script:**

```bash
WEALTHFOLIO_E2E=1 WEALTHFOLIO_FIXTURE_DIR="$PWD/e2e/fixtures/quotes" pnpm run dev:web > /tmp/wealthfolio-dev2.log 2>&1 &
./scripts/wait-for-both-servers-to-be-ready.sh
```

`wait-for-both-servers-to-be-ready.sh` polls the log file until it detects both
"ready in" (Vite) and the Axum server binding on port 8088, then prints the last
few lines and exits. The output redirect is required — the script reads from a
file, not from a live terminal.

> **If the web app is already running:** Stop it first (Ctrl+C), then re-run
> `prep-e2e.mjs` and restart. The running instance is using a stale database —
> tests assume an empty DB and will silently skip asset creation if data already
> exists, causing failures for unrelated reasons.

#### Step 3 — Run specific tests

```bash
# Run a specific spec file
npx playwright test e2e/10-symbol-mapping-validation.spec.ts

# Run with browser visible (useful for debugging)
npx playwright test e2e/10-symbol-mapping-validation.spec.ts --headed

# Run all tests
npx playwright test

# Run and open the HTML report afterwards
npx playwright test && npx playwright show-report
```

---

## Important rules

- **Always run `prep-e2e.mjs` before starting the server.** Tests assume an
  empty database. If you run against an existing database, setup steps may
  silently skip asset creation and tests may fail for unrelated reasons.
- **Do not run E2E tests against the Tauri desktop app.** The tests default to
  `http://localhost:1420`; use `WF_E2E_BASE_URL` when that port is occupied.
- **Do not run E2E tests while the Tauri dev server (`pnpm tauri dev`) is
  running** on the same ports — they conflict.
- Tests run **serially** (1 worker, serial mode). Do not try to parallelize
  them.

---

## Test files

| File                                   | What it tests                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `01-happy-path.spec.ts`                | Onboarding, accounts, deposits, trades                                                                                      |
| `02-activities.spec.ts`                | All activity types                                                                                                          |
| `03-fx-cash-balance.spec.ts`           | FX cash balances                                                                                                            |
| `04-csv-import.spec.ts`                | CSV activity import                                                                                                         |
| `05-form-validation.spec.ts`           | Form field validation errors                                                                                                |
| `06-activity-data-grid.spec.ts`        | Activity data grid interactions                                                                                             |
| `07-asset-creation.spec.ts`            | Manual asset creation and editing                                                                                           |
| `08-holdings-and-performance.spec.ts`  | Holdings and performance views                                                                                              |
| `09-bulk-holdings.spec.ts`             | Bulk holdings CSV import                                                                                                    |
| `10-symbol-mapping-validation.spec.ts` | Symbol mapping real-time validation (Yahoo Finance, Börse Frankfurt)                                                        |
| `13-multi-exchange-import.spec.ts`     | Multi-exchange CSV import: XETRA/LSE/TSX/NASDAQ resolution, region & instrument-type classification (issue #855)            |
| `16-final-cash-policy.spec.ts`         | Final-cash writer policy through CSV import: persisted amounts + review flags per policy row, fixture-computed ledger total |
| `20-asset-exchange-edit.spec.ts`       | Asset exchange edits: unchanged keys, duplicate-identity errors, and ISO-only venues                                        |
| `21-bond-live.spec.ts`                 | Opt-in real-provider bond checks; requires `WF_BOND_LIVE_E2E=1` and a server started without fixture mode                   |
| `22-bond-fixtures.spec.ts`             | UI bond creation/buy, CUSIP/ISIN reuse, provider terms, numerical Treasury prices, holdings valuation, and type filters     |
| `23-loan-lifecycle.spec.ts`            | Shared loan fixture lifecycle, net-worth consistency, loan creation, and asset-type presentation                            |
| `24-loan-editing.spec.ts`              | Loan event management, form validation, interest conventions, balance edits, and recalculation                              |

---

## Not in CI (tracked follow-up)

None of the specs in this directory run in CI. `pr-check.yml` installs
Playwright only for `pnpm test:e2e:addon-sandbox`, a standalone frontend-only
harness; the app suite needs a built Rust backend on :8088, a seeded database,
and serial execution against shared state.

Standing that up is its own change — it should add the whole suite as one job,
not smuggle individual specs in. Until then these specs are a local gate only:
run `pnpm test:e2e` before merging anything that touches activities, import, or
holdings.

---

## Debugging a failing test

```bash
# Run with Playwright inspector (step through actions)
npx playwright test e2e/<spec>.spec.ts --debug

# Show the last HTML report
npx playwright show-report

# Record a trace for a failing test (trace is saved on retry)
# Already configured in playwright.config.ts: trace: "on-first-retry"
```

## Profile startup and switching

The isolated profile suite uses a disposable installation directory, a generated
server secret, and the production web build. It starts its own server and does
not run `prep-e2e.mjs` or rewrite `.env.web`.

Run from the repository root:

```bash
cargo build -p wealthfolio-server
pnpm build
pnpm exec playwright test --config playwright.profiles.config.ts
```

Rebuild for web if the last frontend build targeted Tauri. Chrome must be
installed and port 18388 available. The suite exercises profile switching,
appearance, shared-browser tab routing, and mobile navigation. Native privacy
covers, OS lifecycle events, and native OAuth require device testing.

See the
[profile architecture](../docs/architecture/multi-profile-and-app-lock.md) for
access boundaries and additional release verification requirements.
