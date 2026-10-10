# Currency exchange activities

`FX_EXCHANGE` records a currency conversion inside one transaction-tracked,
non-liability account. It is independent of cross-account transfers.

| API field                                  | Meaning                              |
| ------------------------------------------ | ------------------------------------ |
| `accountId`                                | Account that owns both cash balances |
| `amount`, `currency`                       | Actual cash debited, positive        |
| `destinationAmount`, `destinationCurrency` | Actual cash credited, positive       |
| `activityDate`, `comment`                  | Existing date and notes fields       |

Use the actual debit and credit, including charges. There are no additional
fee/tax inputs and no `fxRate` override. The displayed execution rate is
`destinationAmount / amount`; it is never fetched or saved as a valuation rate.
The currencies must differ, including after minor-unit normalization. Backend
amounts remain decimal strings; the form follows existing numeric inputs with up
to eight decimal places.

Desktop and mobile use the existing activity CRUD routes. Exchanges can be
viewed, edited, duplicated and deleted as one record. They cannot be
reclassified or edited piecemeal in the spreadsheet grid; use the full form.
Spending displays them as neutral internal movement, never income, spending or
saving. Its filtered, selected and daily cash totals nevertheless include both
native legs. The existing mixed-currency daily header remains blank unless just
one currency contributes after netting.

Content-based deduplication includes both cash sides for exchanges. Fingerprints
for existing activity types and explicit idempotency keys are unchanged.

The account-history activity drawer also shows both sides. On days with a posted
exchange, it explains why its single-currency cash-audit approximation is
unavailable instead of treating the exchange as zero cash movement. Actual
balances and performance still come from the backend valuation engine.

## Architecture impact

- **Persistence changes:** two nullable SQLite columns and a widened
  activity-type CHECK. The new migration rebuilds the table because SQLite
  cannot alter that CHECK in place; it preserves IDs, dependent rows, indexes
  and projection triggers. The existing migration runner owns backup, FK
  handling and the migration transaction. Downgrade refuses while exchanges
  exist.
- **Engine changes:** two cash events with one source activity, using the
  existing projection savepoint. No lot, contribution or external flow. Event
  attribution prices both sides at valuation FX and records their net as FX
  gain/loss; a missing rate must not attribute only the other side. See R2.2a in
  `portfolio-engine-rules.md` and `NOM-FX-EXCHANGE`.
- **Unchanged boundaries:** existing frontend adapters → Tauri commands/Axum
  handlers → core service → SQLite writer transaction/outbox, domain events and
  background recomputation. No new endpoint, worker, retry, lock or provider
  setting. Saves register valuation currency pairs using the existing local FX
  registry, without requesting execution quotes or resolving securities.
- **Sync compatibility:** snapshot schema version 5. Upgrade all participating
  devices before exchanging these records. Existing version checks reject newer
  snapshots on old clients; incremental replay rejects unknown destination
  columns instead of silently dropping them. Device sync remains opt-in.
- **Read/export:** search, raw activity APIs and existing CSV/JSON exports
  retain both amounts/currencies. Spending read DTOs add optional
  `cashMovements` for exchanges: two signed native amounts with optional per-leg
  base valuations, replacing the scalar `netAmount`/`netAmountBase` for
  aggregation. Unposted or invalid exchanges have an empty list. Existing local,
  activity-date FX lookup and missing-rate/cancelled-currency rules are
  unchanged; execution ratios are not valuation rates. Ordinary rows retain
  their scalar fields.
- **Grid/import:** grid duplication retains both final cash amounts and the
  existing explicit duplicate idempotency key. CSV profiles and draft validation
  share a type set excluding `FX_EXCHANGE`, because `ActivityImport` cannot
  carry the destination fields. Existing signed FX CSV aliases still represent
  legacy transfer legs. Creation via CSV, broker normalization or AI tools is
  not added; historical external-transfer workarounds are not converted.

## Regression checks

- Engine:
  `cargo test --locked -p wealthfolio-portfolio-engine --test fx_exchange` and
  the `NOM-FX-EXCHANGE` golden (balances, P&L, TWR, precision, lifecycle,
  invalid/unposted exchanges).
- Service/storage: `cargo test --locked -p wealthfolio-core fx_exchange` and
  `CONNECT_API_URL=http://test.local cargo test --locked -p wealthfolio-storage-sqlite fx_exchange`
  (CRUD, patch preservation, event currencies, local-only preparation,
  migration/dependencies/downgrade, export/outbox/replay/snapshot).
- UI: activity Vitest tests, adapter parity, type checks, locale check, both
  frontend builds; `pnpm test:e2e e2e/fx-exchange.spec.ts` exercises desktop and
  mobile against the runner's fresh synthetic database.
- Spending: `cargo test --locked -p wealthfolio-spending` and the transaction
  helper Vitest suite cover both native legs, conversions, unposted rows,
  classification neutrality, pagination and selected/daily netting.
