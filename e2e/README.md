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
| `25-loan-payments.spec.ts`             | Loan payments from a cash account: Paid from, linking from Spending and the loan, suggestions, extra repayments, unlinking  |
| `26-cost-basis-transfer.spec.ts`       | A transfer between accounts on different cost basis methods; switching the sender's method recalculates the receiver        |
| `27-cost-basis-methods.spec.ts`        | Switching an account between FIFO, LIFO, HIFO and WAC in the account form, and the book cost each leaves                    |
| `29-asset-mobile-scroll.spec.ts`       | Mobile asset section switching preserves page scroll while neighboring virtualized activity lists mount                     |
| `30-activity-scroll.spec.ts`           | Desktop asset/account activity tabs preserve page scroll; Spending selection and mobile tab switching preserve scroll       |
| `31-manual-liability.spec.ts`          | Manual loan origination, balance correction/deletion, principal fallback, and net-worth consistency                         |
| `31-formatting-regions.spec.ts`        | Austria, Romania, and Bulgaria formatting selections persist after saving and reloading settings                            |

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

# Open the trace kept for a failed test (playwright.config.ts: trace: "retain-on-failure")
npx playwright show-trace test-results/<test-folder>/trace.zip
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

## UI primitive guardrails (on demand)

`e2e/design-system/` checks the `@wealthfolio/ui` primitives on a synthetic
gallery (`apps/frontend/e2e/design-system/`): screenshots of every component and
open overlay (light and dark, 390 and 1440 px), overlay and keyboard behaviour,
and an axe WCAG 2.1 A/AA scan. It runs in Chromium and WebKit, only when asked;
it is not part of CI.

Screenshots and accessibility results compare against a baseline recorded on the
same machine from the code before a change, kept in `.local/design-system/`
(never committed, so baselines never cross platforms):

```bash
git switch main
pnpm test:e2e:design-system:baseline   # record the "before" state
git switch <your-branch>
pnpm test:e2e:design-system            # compare; differences fail with a diff
```

The accessibility scan records which rules fail on how many elements, because
the primitives do not pass cleanly yet: in WebKit it counts the focus guards
Base UI keeps around open popups, which Safari exposes as buttons without a
name. RTL is not covered because no shipped locale is right-to-left.

`colors.spec.ts` is the colour contract: every role a theme defines, text pairs
at 4.5:1 and the focus ring at 3:1, in light and dark. Callouts, banners and
pills on a status use its subtle surface (`bg-warning-subtle`,
`text-warning-subtle-foreground`, `border-warning-subtle-border`): status text
on a tint of its own colour (`text-warning` on `bg-warning/10`) can't reach
4.5:1. `Alert`'s status variants show that surface as glass (60% fill, a
hairline and `--surface-highlight` along the top), also checked at 4.5:1.

Each test is retried once in a fresh browser: late in a long run WebKit
sometimes stalls a page load without sending a request. Playwright reports a
test that only passes on retry as flaky; a real difference fails both attempts.

`pnpm ui:design-ratchet` counts, per file, font sizes off the type scale
(`text-[11px]`; the scale is `text-2xs` to `text-3xl` in `globals.css`), other
hard-coded px sizes in class names (`w-[300px]`; borders, rings, shadows and
offsets up to 4 px stay in px), and raw colours that bypass the theme's roles
(`text-amber-600`, hex literals, `rgb()`/`hsl()` values) or tint a status colour
(`bg-warning/10`), and fails when a file gains one. Sizes in rem follow the root
font size, which the Text size setting will change. Run it with `--update` after
removing some.
