# Private Assets

Private assets are a first-class manual-entry ledger for investments that need
more accounting context than a market-priced security or a lightweight
alternative asset can provide.

## Why A Dedicated Ledger

Wealthfolio already has alternative asset vocabulary and taxonomy support for
assets such as real estate, collectibles, and liabilities. Private funds and
direct private investments need additional facts that do not fit cleanly as
generic asset metadata:

- manager and vehicle context
- commitment amount
- statement dates and reported marks
- contributed and distributed capital
- freshness state for stale statements
- optional look-through sub-assets

Keeping these records in a private-assets ledger makes the accounting explicit
without overloading the public holdings or alternative-assets models.

## V1 Scope

This implementation is manual-entry only and is behind a default-off app setting
so maintainers can ship the schema and services without showing the capability
until they choose to enable it. When enabled, users can maintain fund managers,
private assets, optional sub-assets, and statement-backed snapshots. The latest
snapshots feed holdings, dashboard, and net-worth views as a separate private
assets category.

The first version intentionally does not include PDF parsing, IRR calculations,
or an event ledger. Those features need real statement samples and separate
modeling work.

## Data Model

The ledger adds four persisted concepts:

- `fund_managers`: optional manager records for fund vehicles
- `private_assets`: fund or direct private investment records
- `private_sub_assets`: optional look-through rows under a private asset
- `private_snapshots`: statement marks with value, cash-flow basis, and date

Direct private assets cannot be linked to a fund manager. Fund vehicles require
one. Snapshot cash flows support both total-to-date and period-only reporting,
but the UI defaults new statements toward total-to-date entry because that is
the most common statement shape.

## Runtime Surfaces

The desktop app exposes Tauri commands and the web server exposes matching REST
routes for the private-assets read and write flows. Those endpoints reject
requests while the feature setting is disabled. The frontend adapters keep those
environments aligned so settings, holdings, dashboard, net-worth, and AI
assistant tools use the same core services.

Private assets appear in portfolio summaries as their own category. They are not
mixed into public security holdings, and they remain distinct from generic
alternative assets.
