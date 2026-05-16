# E2E Tests

Wealthfolio E2E tests use [Playwright](https://playwright.dev/) and run against
the **web app** (not the Tauri desktop app). There are **no mocks** — both
frontend and backend must be running against a fresh database.

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

This creates a new timestamped SQLite database (e.g.
`db/app-testing-20260411T120000Z.db`) and writes its path to `.env.web`. **Run
this every time** before starting the server — it ensures test isolation.

#### Step 2 — Start the web app

**Option A — watch the terminal output directly:**

```bash
pnpm run dev:web
```

Wait until you see Vite's "ready in Xms" and the Rust server binding messages,
then move on to Step 3 in a separate terminal.

**Option B — redirect output to a log file and use the wait script:**

```bash
pnpm run dev:web > /tmp/wealthfolio-dev2.log 2>&1 &
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
- **Do not run E2E tests against the Tauri desktop app.** The tests are
  hardcoded to `http://localhost:1420`.
- **Do not run E2E tests while the Tauri dev server (`pnpm tauri dev`) is
  running** on the same ports — they conflict.
- Tests run **serially** (1 worker, serial mode). Do not try to parallelize
  them.

---

## Test files

| File                                   | What it tests                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `01-happy-path.spec.ts`                | Onboarding, accounts, deposits, trades                                                                           |
| `02-activities.spec.ts`                | All activity types                                                                                               |
| `03-fx-cash-balance.spec.ts`           | FX cash balances                                                                                                 |
| `04-csv-import.spec.ts`                | CSV activity import                                                                                              |
| `05-form-validation.spec.ts`           | Form field validation errors                                                                                     |
| `06-activity-data-grid.spec.ts`        | Activity data grid interactions                                                                                  |
| `07-asset-creation.spec.ts`            | Manual asset creation and editing                                                                                |
| `08-holdings-and-performance.spec.ts`  | Holdings and performance views                                                                                   |
| `09-bulk-holdings.spec.ts`             | Bulk holdings CSV import                                                                                         |
| `10-symbol-mapping-validation.spec.ts` | Symbol mapping real-time validation (Yahoo Finance, Börse Frankfurt)                                             |
| `13-multi-exchange-import.spec.ts`     | Multi-exchange CSV import: XETRA/LSE/TSX/NASDAQ resolution, region & instrument-type classification (issue #855) |

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
