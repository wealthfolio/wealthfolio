## Context

PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) introduces
user-defined portfolio grouping across Income, Activity,  
Holdings, Performance, and Dashboard views.

The feature direction is valuable, but the current implementation should be  
treated as a prototype. It introduces a `portfolios` table with JSON account  
IDs and passes composite `MULTI:id,id` strings through frontend, services, and  
repositories. That approach creates correctness and maintainability issues:

- mixed-currency portfolio performance can be wrong;
- web mode portfolio CRUD is not fully wired;
- new portfolio rows do not participate in device sync;
- portfolio membership is stored as JSON, so accounts cannot cascade through a  
  foreign key and membership cannot be queried/indexed safely;
- single-account saved portfolios collapse into plain account IDs in the
  current  
  selector design;
- Dashboard portfolio rows currently blur account grouping with analytical  
  reporting scopes;
- `accounts.group` should remain account organization metadata instead of
  being  
  absorbed into portfolios.

The target model should separate real accounts, account grouping, and saved  
portfolio reporting scopes.

## Industry Meaning of Portfolio

In investment software, a portfolio is a collection of financial assets
managed  
or evaluated together toward an objective.

A portfolio is not necessarily one account. For example:

- a Retirement portfolio can span IRA, Roth IRA, 401(k), and taxable accounts;
- a Kids Education portfolio can span multiple custodial accounts;
- an Income portfolio can span accounts but focus on income-producing assets.

In Wealthfolio:

- `Account` is the ledger or custody boundary;
- `Portfolio` should be a saved reporting scope over accounts;
- asset-level grouping should stay with taxonomies/custom groups unless a  
  separate asset collection feature is introduced.

## Target Design Principles

The target design should follow these principles:

- model saved views as first-class records with stable IDs;
- store many-to-many membership in relational rows, not serialized JSON;
- keep `accounts.group` as account organization metadata;
- do not put dashboard placement or other presentation flags in the portfolio  
  table;
- model saved portfolios separately from account groups;
- pass typed filters through services instead of encoded strings;
- resolve filters once at the service boundary and keep repositories focused
  on  
  database access;
- aggregate money in base currency for cross-account reports;
- preserve decimal precision for financial values and avoid `REAL`/floating  
  aggregation for stored decimal text;
- make sync idempotent with deterministic row IDs and parent-before-child
  apply  
  ordering;
- allow future views, such as ad hoc account filters or optional asset
  filters,  
  without changing repository contracts again.

## Terminology

### Account

A real custody or ledger container.

Examples:

- Fidelity IRA
- Wealthsimple TFSA
- Coinbase
- Bank checking account

### Account Group

The existing `accounts.group` field.

Purpose:

- account organization;
- settings/account organization.

Rule:

- an account belongs to zero or one account group;
- keep the existing DB column for now to avoid an unnecessary migration;
- if richer group metadata is needed later, add a dedicated  
  `account_groups` table, not a portfolio concept.

### Portfolio

User-facing saved reporting scope.

Purpose:

- filter Income;
- filter Activity;
- filter Holdings/Allocations;
- calculate Performance;

Rule:

- an account can belong to many portfolios.

### Asset Collection

Not part of this PR.

Wealthfolio already has asset taxonomies/custom groups for asset classification:

- asset class;
- sector;
- region;
- risk;
- custom groups.

Do not mix asset grouping into this account portfolio feature. A future richer  
portfolio model could combine an account filter with an optional asset filter,
but  
this PR should stay account-scoped.

## Target Schema

Keep account grouping on `accounts.group` for now, and do not migrate it into  
portfolio tables.

Normalize saved portfolios into a portfolio table plus membership rows.

```sql
CREATE TABLE portfolios (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX idx_portfolios_name_unique
ON portfolios(lower(trim(name)));

CREATE TABLE portfolio_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    portfolio_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (portfolio_id)
        REFERENCES portfolios(id)
        ON DELETE CASCADE,
    FOREIGN KEY (account_id)
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    UNIQUE(portfolio_id, account_id)
);

CREATE INDEX idx_portfolio_accounts_portfolio
ON portfolio_accounts(portfolio_id, sort_order);

CREATE INDEX idx_portfolio_accounts_account
ON portfolio_accounts(account_id);
```

`portfolio_accounts.id` should be deterministic, for example:

```
pfm_{portfolio_id}_{account_id}
```

This gives device sync a stable row identity for membership changes.

## Entity Diagram

![[screenshot 2026-05-11 à 15.30.52.png]]

erDiagram ACCOUNTS { text id PK text name text group "account organization
metadata" text currency boolean is_active boolean is_archived }

    PORTFOLIOS {
        text id PK
        text name UK
        text description
        integer sort_order
        text created_at
        text updated_at
    }

    PORTFOLIO_ACCOUNTS {
        text id PK "pfm_{portfolio_id}_{account_id}"
        text portfolio_id FK
        text account_id FK
        integer sort_order
        text created_at
    }

    ACCOUNTS ||--o{ PORTFOLIO_ACCOUNTS : "can belong to many"
    PORTFOLIOS ||--o{ PORTFOLIO_ACCOUNTS : "has members"

`Total Portfolio` / `All Accounts` is intentionally not shown as a row. It is
a  
virtual system scope represented by `AccountFilter::All`, while snapshots or  
valuations may still use internal cache IDs for calculated data.

## API Shape

Use a typed account filter everywhere instead of composite string IDs.

Avoid the name `AccountScope` because the performance module already has  
`PerformanceScope`, which means "flow boundary" rather than "which accounts
are  
included".

```ts
type AccountFilter =
  | { type: "all" }
  | { type: "account"; accountId: string }
  | { type: "portfolio"; portfolioId: string }
  | { type: "adHoc"; accountIds: string[] };
```

Backend services should resolve an `AccountFilter` once, validate the result,
and  
then pass `&[String]` account IDs into repositories.

Keep portfolio identity distinct from the resolved account list. A saved  
portfolio containing one account is still `{ type: "portfolio" }`, not a plain  
account ID. This prevents UI/query behavior from changing just because a  
portfolio currently has one member.

Repositories should not parse:

- `MULTI:id,id`
- `PORTFOLIO`
- frontend-specific selection strings

This keeps storage code simple, testable, and safe.

## Service Responsibilities

### Portfolio Service

Owns portfolio CRUD, membership, and validation:

- create/update/delete/list portfolios;
- allow one or more accounts for `portfolio` unless product explicitly decides  
  otherwise;
- trim names and enforce case-insensitive uniqueness;
- reject duplicate account IDs in the same request;
- validate account IDs exist and define archived/inactive eligibility;
- own `created_at` and `updated_at`; do not trust client-provided timestamps;
- write portfolio and membership changes in one transaction;
- return portfolio details with member IDs.

### Account Filter Resolver

Shared service helper:

```rust
enum AccountFilter {
    All,
    Account(String),
    Portfolio(String),
    AdHoc(Vec<String>),
}
```

Responsibilities:

- resolve `All` to active/non-archived accounts as appropriate for the caller;
- resolve `Account` to one account;
- resolve `Portfolio` through `portfolio_accounts`;
- resolve `AdHoc` by validating account IDs;
- preserve a deterministic account order.

### Feature Services

Income, Activity, Holdings, Allocations, and Performance should accept an
account  
filter or resolved account IDs.

Avoid adding feature-specific portfolio/filter parsing in repositories.

For temporary compatibility during a staged refactor, frontend wrappers may  
translate old route params into an `AccountFilter`, but core services should
not  
grow new string encodings.

## Performance Semantics

For portfolio performance, transfers must be classified relative to the
selected  
scope:

```
member -> member: internal
member -> non-member: external withdrawal
non-member -> member: external contribution
```

This rule is different from total-portfolio performance when the selected
scope  
is a subset of accounts.

This is a real change to TWR calculation. The current flow classifier uses a  
metadata flag that describes the whole-portfolio boundary. For saved
portfolios,  
the calculation must look up the paired transfer leg by  
`source_group_id`, compare both leg account IDs against the resolved
membership  
set, and classify the flow at runtime.

Implementation requirements:

- resolve portfolio membership once per performance query;
- load linked transfer legs for activities in the period;
- treat missing or broken transfer pairs explicitly. Conservative default:  
  classify the visible leg as external and emit a warning/health issue so the\
  user can repair the pair.

## Currency Semantics

Do not sum `DailyAccountValuation.total_value`, `cash_balance`, `cost_basis`,
or  
`net_contribution` directly across accounts.

Those fields are account-currency values. For mixed-currency portfolios,
direct  
summation gives incorrect values and incorrect returns.

Target approach:

- extend `daily_account_valuation` with explicit base-currency columns:
  - `cash_balance_base`
  - `investment_market_value_base`
  - `total_value_base`
  - `cost_basis_base`
  - `net_contribution_base`
- populate those columns during valuation calculation;
- aggregate portfolio views from those base columns;
- expose synthetic portfolio valuation in base currency with  
  `fx_rate_to_base = 1`.

Do not re-derive portfolio valuations from large holdings snapshots at query  
time unless the base-value columns are not available yet. Snapshot-derived  
calculation is acceptable as a migration/rebuild path, not as the hot query
path.

Holdings and allocation views must also aggregate in base currency. Existing  
per-account holdings already carry base-currency value; multi-account
portfolio  
views should sum by asset/category using base values, not account-currency  
values.

## Calculation Strategy

### Current Calculation Pipeline

Today Wealthfolio calculation is account-first:

1. holdings snapshots are persisted for individual accounts;
2. a virtual `TOTAL` scope is rebuilt from individual account snapshots;
3. daily valuations are persisted for each account and for `TOTAL`;
4. performance reads those persisted daily valuations.

`TOTAL` is not a user portfolio record. It is a system calculation cache for  
all-account views, quote-sync planning, net worth, and portfolio-level  
performance.

PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) currently treats
a saved portfolio as a `MULTI:` account string:

- latest holdings are synthesized by loading member account snapshots and  
  reusing the `TOTAL` aggregation helper;
- historical performance is synthesized by summing rows from  
  `daily_account_valuation`;
- the summed historical valuation fields are account-currency fields, not base  
  fields;
- portfolio-relative linked transfers are not reclassified against the
  selected  
  member set.

That shape is useful as a prototype, but it should not become the target  
calculation model.

Keep persisted calculation artifacts for:

- individual accounts;
- the virtual `Total Portfolio` / `All Accounts` system scope.

Do not precompute and persist snapshots or daily valuations for every saved
user  
portfolio by default.

Rationale:

- saved portfolios can overlap, so each account edit could fan out to many  
  portfolio recalculations;
- precomputing every portfolio multiplies storage by the number of saved  
  portfolios;
- portfolio membership edits would require rebuilding historical portfolio  
  caches even when account data did not change;
- user portfolios are saved reporting filters, not ledger/custody boundaries;
- sync should move user portfolio definitions, not derived calculation caches.

`Total Portfolio` is different. It is a virtual system scope represented by  
`AccountFilter::All`, but existing `TOTAL` snapshots and valuations can remain  
as internal calculation caches because many core workflows use all-account
totals  
and quote-sync state.

Target behavior by view:

- latest holdings and allocations: resolve portfolio members, load latest  
  account snapshots, and aggregate on read in base currency;
- income and activity: resolve portfolio members and query by account IDs;
- performance: resolve portfolio members and build a synthetic base-currency  
  valuation series on read from account-level valuation rows;
- Dashboard: keep the account list based on `accounts.group`; do not
  materialize  
  user portfolio rows in the account-group hierarchy.

### Portfolio History Chart Contract

The history chart still needs a daily portfolio series. The target difference
is  
where that series comes from:

- account and `TOTAL` valuation history are persisted calculation artifacts;
- saved portfolio valuation history is a read model derived from member
  account  
  histories;
- saved portfolio performance history is calculated from that derived
  valuation  
  series.

For `AccountFilter::All`, keep using the existing `TOTAL` historical
valuations.  
That path is already a system-level cache and should remain fast.

For `AccountFilter::Portfolio` and `AccountFilter::AdHoc`, build the chart  
series on read:

1. resolve the member account IDs;
2. load account-level daily valuations for the requested date range;
3. use base-currency valuation fields for aggregation;
4. group by date and sum member account values;
5. return synthetic daily portfolio valuation points in base currency;
6. feed the same synthetic series into the performance calculator to produce
   the  
   `returns[]` series used by the Performance chart.

Do not write `daily_account_valuation` rows with `account_id = portfolio_id`.  
That would make portfolio definitions behave like calculated accounts and
would  
create invalidation, sync, and membership-history problems.

Membership semantics for the MVP:

- portfolio history uses the portfolio's current member account set across the  
  selected historical range;
- changing membership changes the derived history immediately on the next query;
- no historical membership timeline is implied.

If Wealthfolio later needs "portfolio as managed mandate" semantics, add  
membership effective dates, for example `valid_from` and `valid_to`, and
compute  
history against the membership set effective on each day. Do not add that  
complexity to
PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) unless the
product explicitly needs time-versioned  
portfolios.

For valuation charts, sum base market values. For performance charts, also  
classify linked transfers relative to the selected member set so the TWR and
net  
contribution series reflect the portfolio boundary.

### Read-Time Feasibility

Read-time portfolio history is feasible if it is built from  
`daily_account_valuation`, not from holdings snapshots.

The existing table is compact and indexed by `(account_id, valuation_date)`.  
For a portfolio with `M` accounts and `D` daily points, the read path scans
about  
`M * D` valuation rows. That is acceptable for normal local SQLite use because  
it avoids:

- JSON snapshot deserialization for every historical day;
- quote lookup;
- FX-rate lookup;
- position-level valuation;
- rewriting derived rows whenever membership changes.

The target repository method should load member account valuation rows in one  
range query and aggregate in Rust with `Decimal`, for example:

```rust
fn get_portfolio_valuation_series(
    account_ids: &[String],
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
) -> Result<Vec<DailyPortfolioValuation>>;
```

Do not aggregate decimal text in SQLite with `SUM(CAST(... AS REAL))`; that is  
both mixed-currency unsafe and precision unsafe.

Current-code feasibility:

- `total_value_base`, `cash_balance_base`, and `investment_market_value_base`  
  can be derived from current rows
  as `account_currency_value * fx_rate_to_base`;
- `cost_basis_base` can be derived the same way under the current valuation  
  semantics, because account snapshot cost basis is converted to account\
  currency at the snapshot date;
- `net_contribution_base` cannot be derived safely from  
  `net_contribution * fx_rate_to_base`, because contribution base values are\
  cumulative cash-flow amounts converted at the flow dates, not at the
  valuation  
  date.

Therefore the correct target is to persist explicit base-currency valuation  
columns during normal account and `TOTAL` valuation calculation, especially  
`net_contribution_base`.

Factor FX conversion at valuation-write time, not portfolio-read time:

- keep `calculate_valuation` responsible for producing both account-currency  
  and base-currency valuation fields;
- reuse the FX rates already fetched for the account/date valuation pass;
- populate base columns once when account valuations are recalculated;
- make portfolio history reads a pure indexed load plus decimal aggregation.

If profiling later shows large portfolios are slow, add a local derived cache  
keyed by portfolio ID, member-set hash, date range, base currency, and
valuation  
version. Keep that cache rebuildable and unsynced; the source of truth remains  
account valuations plus portfolio membership.

The synthetic portfolio valuation series should:

1. load account-level daily valuations for member accounts;
2. aggregate explicit base-currency valuation columns by date;
3. classify linked transfers relative to the portfolio member set;
4. adjust net contribution for member-to-member internal transfers;
5. return a synthetic base-currency series for the performance calculator.

If this becomes too slow later, add a local derived cache such as  
`portfolio_valuation_cache`. That cache should be invalidated/rebuilt from  
account data and portfolio membership, and should not become the source of
truth  
or a synced user model.

## Dashboard Semantics

Dashboard account groups and saved portfolios should not be treated as the
same  
UI layer.

`accounts.group` is account organization metadata. A saved portfolio is an  
analytical shortcut that can overlap with many account groups.

Target behavior:

- keep account groups intact when grouping is enabled;
- do not show portfolios inside the account list for
  PR [feat(portfolios): portfolio grouping support across income, activity, holdings, performance and dashboard #938](https://github.com/wealthfolio/wealthfolio/pull/938);
- do not remove portfolio member accounts from their normal account groups;
- avoid double-counting only in aggregate totals, not by hiding accounts from  
  their account group.

If product later wants portfolio summaries on Dashboard, model that as a UI or  
dashboard-preference layer, not as columns on `portfolios`.

## Account Group Direction

Do not convert `accounts.group` directly into portfolios.

`accounts.group` is account organization metadata. A portfolio is an
analytical  
reporting boundary.

Target direction:

- keep the physical `accounts.group` column for now;
- keep its rule simple: one account has zero or one account group;
- do not create portfolio records from account groups;
- do not create account groups from portfolio records.

If richer account-group metadata becomes necessary later, add a dedicated  
`account_groups` table and an `accounts.group_id` column. Keep that model  
separate from portfolios.

## Device Sync Requirements

Both portfolio tables must participate in device sync before release.

Required work:

- add `portfolios` and `portfolio_accounts` to sync table lists, with  
  `portfolios` ordered before `portfolio_accounts`, and `portfolio_accounts`\
  ordered after both `accounts` and `portfolios`;
- add sync entities for portfolios and portfolio memberships;
- implement `SyncOutboxModel` for both DB models;
- use `writer.exec_tx` and `tx.insert` / `tx.update` / `tx.delete`;
- add storage mapping for incremental apply;
- include both tables in snapshot export/import;
- add sync tests for create/update/delete portfolio and membership changes.

If this is omitted, portfolio configuration will be local-only and will not  
match Wealthfolio's existing sync behavior for account metadata.

Foreign keys are important here: replay must apply account and portfolio
inserts  
before membership inserts. Tests should cover this ordering.

## Web Mode Requirements

The web adapter must map CRUD commands to actual Axum routes and serialize  
payloads.

Expected route shape:

```
GET    /portfolios
GET    /portfolios/{id}
POST   /portfolios
PUT    /portfolios/{id}
DELETE /portfolios/{id}
POST   /account-filters/resolve
```

Avoid Tauri-only assumptions in shared frontend hooks.

## PR Refactor Plan

PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) should move to
the target model before merge. Do not merge the interim  
JSON membership / `MULTI:` string model and plan a later corrective refactor.

Keep the PR focused by reducing the product surface, not by keeping the wrong  
model. A good mergeable target is:

1. replace JSON `portfolios.account_ids` with `portfolio_accounts`;
2. add Rust domain types:
   - `Portfolio`
   - `NewPortfolio`
   - `PortfolioAccount`
   - `AccountFilter`
3. keep portfolio CRUD service/repository names aligned with the user-facing  
   concept;
4. implement an account filter resolver in the core/service layer;
5. remove all `MULTI:` parsing from frontend, core, and repositories;
6. wire desktop, web, and device sync for `portfolios` and `portfolio_accounts`;
7. validate portfolio create/update inputs: trimmed name, distinct account
   IDs,  
   account existence, and archived/inactive behavior;
8. reset settings dialog state when opening/editing a different portfolio;
9. keep Dashboard account groups separate from saved portfolio rows;
10. update Income, Activity, Holdings, and Allocations to use typed filters or  
    resolved account IDs;
11. include Performance only if base-currency aggregation and
    portfolio-relative  
    transfer classification are implemented correctly.

If the performance work is too large, defer portfolio support on the
Performance  
page rather than shipping known-wrong mixed-currency or transfer behavior.

### Follow-Up: Valuation Model

Add explicit base-currency columns to `daily_account_valuation`:

1. `cash_balance_base`;
2. `investment_market_value_base`;
3. `total_value_base`;
4. `cost_basis_base`;
5. `net_contribution_base`.

Populate them during normal account and `TOTAL` valuation calculation. Then
use  
those fields to build portfolio valuation series on read.

### Follow-Up: Account Group Cleanup

Keep this separate from portfolio work:

1. keep the DB column `accounts.group`;
2. keep Dashboard account grouping based on this account field;
3. only add an `account_groups` table later if richer metadata is needed.

## Compatibility

The new portfolio CRUD commands in
PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) are not part of
the public addon SDK  
surface today. The existing addon `PortfolioAPI` exposes holdings, income,  
valuation, update, and recalculation APIs. If saved-portfolio CRUD APIs are  
added to the addon SDK later, keep old names as aliases for one release or
call  
out a hard rename in the changelog.

Frontend persisted state also needs compatibility handling. The Performance
page  
stores `TrackedItem` values in local storage; if portfolio route shapes or
filter  
payloads change, add a small migration or defensive cleanup so stale
selections  
do not break page load.

## Tests To Add

### Migration

- JSON `portfolios.account_ids` values migrate into `portfolio_accounts`;
- duplicate account IDs in a legacy JSON row produce one membership;
- stale account IDs are skipped or surfaced according to the chosen migration  
  policy;
- migration is idempotent and does not create duplicate memberships when re-run;
- `accounts.group` remains on accounts and is not converted into portfolios.

### Validation

- account group remains a single field on each account;
- portfolio allows many-to-many membership;
- invalid account IDs are rejected;
- duplicate account IDs in create/update are rejected or deduplicated before  
  persistence;
- names are trimmed and case-insensitive duplicates are rejected;
- single-account portfolio behavior is explicitly tested according to the
  final  
  product decision;
- deleting a portfolio deletes memberships;
- hard-deleting an account cascades through `portfolio_accounts`.

### Account Filter Resolution

- `All` resolves expected accounts;
- `Account` resolves one account;
- `Portfolio` resolves portfolio members;
- `AdHoc` resolves validated IDs;
- archived/inactive account behavior is explicit per caller.

### Performance

- mixed-currency portfolio uses base-currency values;
- member-to-member transfers are internal;
- member-to-non-member transfers are external;
- non-member-to-member transfers are external;
- orphaned linked transfer legs are classified consistently and surfaced for  
  repair.
- user portfolio performance is derived from account-level valuations on read,  
  not precomputed for every saved portfolio by default.
- user portfolio performance returns the daily `returns[]` series needed by
  the  
  Performance chart.

### Portfolio History

- portfolio valuation history is derived on read from member account valuation  
  history;
- querying portfolio history does not write `daily_account_valuation` rows for  
  the portfolio ID;
- `AccountFilter::All` uses the existing virtual `TOTAL` history cache;
- changing portfolio membership changes derived historical chart output
  without  
  recalculating account snapshots or account valuations;
- the MVP applies the current member set across the selected historical range.

### Holdings And Allocations

- mixed-currency holdings aggregate by asset using base-currency values;
- mixed-currency allocation categories sum base-currency values;
- portfolio allocation totals do not exceed expected percentages because of  
  currency mixing or duplicate parent/child taxonomy assignments.
- latest portfolio holdings are synthesized from member account snapshots and
  do  
  not require persisted portfolio snapshots.

### Dashboard

- portfolios are not inserted into the grouped account list;
- saved portfolio rows do not remove accounts from their account groups;
- overlapping saved portfolios do not imply a portfolio total is part of  
  account-group net worth.

### Web Mode

- list/get/create/update/delete portfolio commands call the right URLs;
- command payloads are serialized correctly;
- route names match frontend adapter paths.

### Device Sync

- portfolio create/update/delete writes outbox events;
- membership create/delete writes outbox events;
- snapshot export/import includes portfolio tables;
- remote incremental events apply correctly;
- replay applies memberships after referenced accounts and portfolios.

## Review Findings From PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938)

### P1: Mixed-Currency Portfolios Calculate Wrong Performance

File:

```
crates/storage-sqlite/src/portfolio/valuation/repository.rs
```

The new SQL aggregation sums account-currency valuation fields directly and
then  
marks the synthetic result as base currency with `fx_rate_to_base = 1`.

`DailyAccountValuation` stores account-currency values, so a USD+CAD portfolio  
will produce numerically wrong returns.

The query also casts decimal strings to `REAL` before summing, which
introduces  
floating-point precision risk for financial values.

Fix by adding explicit base-currency valuation columns and aggregating those
for  
portfolio performance using decimal-safe handling. Do not sum account-currency  
fields across accounts.

### P1: Portfolio Transfers Are Not Classified Relative To Membership

Files:

```
crates/core/src/portfolio/snapshot/snapshot_service.rs
crates/core/src/portfolio/valuation/valuation_service.rs
apps/frontend/src/adapters/shared/portfolio.ts
```

PR [#938](https://github.com/wealthfolio/wealthfolio/pull/938) routes portfolio
performance by resolving a saved portfolio into a  
`MULTI:` account string and then treating it as an account. The current  
performance flow classifier understands the whole-portfolio boundary, not an  
arbitrary subset of accounts.

For saved portfolios, linked transfer legs must be classified against the
member  
set. Member-to-member transfers are internal; member-to-non-member and  
non-member-to-member transfers are external flows. Without this, TWR and net  
contribution are wrong for any portfolio that contains only one side of a  
transfer pair.

Target fix: build portfolio valuation/performance series from resolved member  
IDs and linked transfer metadata, not from a `MULTI:` string masquerading as
an  
account ID.

### P1: Do Not Precompute Every Saved Portfolio By Default

Files:

```
crates/core/src/portfolio/snapshot/snapshot_service.rs
crates/core/src/portfolio/valuation/valuation_service.rs
apps/tauri/src/listeners.rs
apps/server/src/api/shared.rs
```

The existing recalculation pipeline persists snapshots and valuations for each  
account and for the virtual `TOTAL` scope. `TOTAL` is a useful system cache  
because all-account views are used widely.

Saved user portfolios should not follow the same default persistence model.  
Portfolios can overlap, membership can change, and every account edit would  
otherwise fan out into many recalculations.

Target fix: keep account and `TOTAL` persisted calculation caches, but derive  
user portfolio holdings and performance from account-level data on read. Add a  
local derived cache later only if profiling proves it is needed.

### P1: Web Mode Portfolio CRUD Is Not Wired

File:

```
apps/frontend/src/adapters/web/core.ts
```

The web adapter registers portfolio commands but does not append IDs or  
serialize request bodies for get/create/update/delete/find.

It also maps `find_portfolio_by_accounts` to `/portfolios/find-by-accounts`  
while the Axum route is `/portfolios/match`.

Web mode will 404/405 or send empty bodies for the new settings page.

### P1: Portfolio Groups Will Not Device Sync

File:

```
crates/storage-sqlite/src/portfolio/portfolios/repository.rs
```

Portfolio writes use `writer.exec`, and the new `PortfolioDB` is not
registered  
as a sync outbox model, app sync table, or sync entity mapping.

Existing `accounts.group` syncs because it is part of `accounts`; new
portfolio  
rows will remain local to one device.

### P2: Portfolio Membership Is Stored As JSON Without Referential Integrity

Files:

```
crates/storage-sqlite/migrations/2026-04-29-000001_portfolios/up.sql
crates/storage-sqlite/src/portfolio/portfolios/model.rs
crates/core/src/portfolio/portfolios/portfolio_service.rs
```

The `portfolios.account_ids` column stores a JSON array. Account deletes
cannot  
cascade, duplicate account IDs are not prevented by the database, and invalid
or  
stale account IDs can remain in saved portfolios.

The service only checks `account_ids.len() >= 2`; it does not validate
distinct  
IDs or account existence. The DB conversion also uses `unwrap_or_default()`,
so  
corrupt JSON silently becomes an empty portfolio.

Target fix: normalize membership into `portfolio_accounts` with foreign keys
and  
service-level validation. Interim fix: validate distinct existing account IDs
on  
create/update and surface JSON corruption as an error.

### P2: Single-Account Portfolios Lose Their Identity

File:

```
apps/frontend/src/adapters/shared/portfolios.ts
```

`buildAccountSelection` returns the raw account ID when a portfolio contains
one  
account. That makes a saved single-account portfolio indistinguishable from
the  
account itself and prevents future product support for "named views" over one  
account.

Target fix: preserve `{ type: "portfolio", portfolioId }` through the UI and  
backend. Do not encode saved portfolios as account-selection strings.

### P2: Dashboard Conflates Saved Portfolios With Account Groups

File:

```
apps/frontend/src/pages/dashboard/accounts-summary.tsx
```

The grouped Dashboard builds saved portfolio rows first, then removes every  
portfolio member from normal account groups. Because portfolios can overlap
and  
are analytical views, this can hide accounts from their groups and make  
portfolio rows look like part of the account grouping hierarchy.

Target fix: do not render saved portfolio views inside account groups. If  
Dashboard portfolio summaries are added later, put that placement in UI  
preferences, not the portfolio model. Do not remove accounts from their normal  
account groups just because they appear in a portfolio.

### P2: Portfolio Dialog Keeps Stale Form State

File:

```
apps/frontend/src/pages/settings/portfolios/portfolios-page.tsx
```

`name` and `selectedIds` are initialized from props only once. The key is
placed  
on `Dialog`, not on `PortfolioFormDialog`, so closing and reopening for
another  
portfolio can show or submit stale values.

Reset state in an effect when `open` or `portfolio` changes, or key the  
component at the parent call site.

## Recommended PR Comment

This PR is a good feature direction, but I do not think we should merge the  
current model as-is.

The target should keep account grouping separate from portfolio reporting  
scopes:

- keep the existing `accounts.group` column for account organization;
- `portfolios` represents a saved account reporting scope;
- portfolio membership lives in `portfolio_accounts`;
- do not add Dashboard/presentation flags to the `portfolios` table;
- service APIs use typed `AccountFilter`, not `MULTI:` strings;
- repositories receive resolved account ID slices and do not parse frontend  
  selection syntax.

This keeps account groups and portfolio reporting scopes distinct without  
forcing exclusive account groups into the same model as overlapping portfolios.

The current PR should be refactored before merge because it has blocking
issues  
around mixed-currency performance, web-mode CRUD wiring, and device sync.
