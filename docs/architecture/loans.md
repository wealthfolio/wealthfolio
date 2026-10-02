# Loans: architecture and design

This document is the permanent specification for liability valuation, loan
schedules, mortgage presentation, and their verification. Update it when the
calculation contract, persisted inputs, or user-facing behavior changes.

## Scope and ownership

The shared Rust engine in `crates/core/src/assets/loan.rs` owns dated loan
valuation. Alternative holdings, net worth, net-worth history, and both Tauri
and Axum use it. The frontend consumes its results for balances, charts,
interest metrics, payment schedules, and linked-property equity.

The supported model is principal-and-interest instalment loans with monthly or
14-day payments, dated term changes, extra repayments, and confirmed balances.
Manual liabilities require no loan terms. Escrow, insurance, fees, penalties,
lender business-day adjustments, revolving-credit servicing, and actual/365
interest agreements are outside the automatic model. Currency conversion remains
the portfolio's responsibility.

`calculate_loan` accepts metadata, closing balance observations, and an explicit
ISO calendar `asOf` date. It reads neither the clock nor storage. There is no
second valuation engine in TypeScript and no persisted calculated schedule.
Frontend level-payment formulas provide previews; saved creation payments and
recalculation use the shared dated engine.

### Data flow

```text
                  Loan forms and edit sheets
             (terms, renewals, extras, confirmations)
                                |
                                v
                    Shared frontend adapters
                                |
                   +------------+------------+
                   |                         |
                   v                         v
            Tauri commands              Axum handlers
                   |                         |
                   +------------+------------+
                                |
                                v
                   Shared services / storage
                                |
                                v
                   SQLite: recorded inputs
             +-------------------------------------+
             | Original terms + loan_projection    |
             | Dated loan_events                   |
             | Confirmed closing balance quotes    |
             +-------------------------------------+
                                |
                 Callers assemble input snapshots
                   (metadata, balances, asOf)
                                |
                                v
             +-------------------------------------+
             | Shared Rust loan engine             |
             |                                     |
             | calculate_loan                      |
             |   -> dated ledger and current terms |
             |                                     |
             | recalculate_loan                    |
             |   -> solves payments by calling     |
             |      the same dated calculator      |
             |                                     |
             | No storage or clock access          |
             +-------------------------------------+
                                |
                      Calculated results
                                |
             +------------------+------------------+
             |                  |                  |
             v                  v                  v
      Loan Overview       Alternative        Net worth and
      and Schedule        holdings           net-worth history
      (via adapters)      and equity         (requested dates)
```

Calculated rows remain estimates and are not written back as confirmations.
Saving a solved payment updates the original projection during creation or adds
dated term events during recalculation. After a saved edit, affected queries
refresh and consumers recompute from the recorded inputs.

### Implementation map

Paths below are relative to the repository root.

| Responsibility                                   | Location                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Dated valuation and calendar rules               | `crates/core/src/assets/loan.rs`                               |
| Interest conversion and posting precision        | `crates/core/src/assets/loan/interest.rs`                      |
| Payment solving                                  | `crates/core/src/assets/loan/recalculation.rs`                 |
| Holdings integration                             | `crates/core/src/assets/alternative_assets_service.rs`         |
| Net worth and history                            | `crates/core/src/portfolio/net_worth/net_worth_service.rs`     |
| Shared frontend calls                            | `apps/frontend/src/adapters/shared/alternative-assets.ts`      |
| Desktop commands                                 | `apps/tauri/src/commands/alternative_assets.rs`                |
| Web handlers                                     | `apps/server/src/api/alternative_assets.rs`                    |
| Overview, timeline, schedule, and sheets         | `apps/frontend/src/pages/asset/alternative-assets/components/` |
| Actions and calculation queries                  | `apps/frontend/src/pages/asset/alternative-assets/hooks/`      |
| Presentation, event editing, and ledger assembly | `apps/frontend/src/pages/asset/alternative-assets/lib/`        |

Runtime commands stay thin. Any API change must preserve frontend adapter, Tauri
registration, web command mapping, and Axum route parity.

## Persisted data

Reuse asset metadata and manual closing quotes. Calculated instalments are never
stored as confirmed balances, even after their dates pass. Extra repayments are
metadata events rather than inferred balance confirmations.

`loan_projection` accepts a JSON object or serialized JSON with `version: 1`.
Any other version yields no automatic calculation.

| Field                 | Meaning                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `annualRate`          | Nominal annual percentage                                         |
| `interestMethod`      | `nominal_periodic`, `monthly`, or `semiannual`                    |
| `paymentAmount`       | Regular principal-and-interest payment, excluding escrow and fees |
| `frequency`           | `monthly`, `biweekly`, or `accelerated_biweekly`                  |
| `firstPaymentDate`    | Contractual first instalment, distinct from origination           |
| `paymentCount`        | Original contractual instalment count                             |
| `amortizationEndDate` | Projection horizon, distinct from renewal maturity                |

Original principal and origination remain in `original_amount` and
`origination_date`. The engine uses them to reconstruct estimates before the
first confirmation. Creation without an entered current balance records the
original principal at origination; today's balance is calculated. A synthetic
anchor used after deleting observations is not a confirmed statement.

A renewal event's `termEndDate` is renewal maturity and does not replace the
amortization horizon. `renewal_maturity_date` holds the renewal date used by the
presentation.

`loan_events` supports renewals, rate changes, payment changes, frequency
changes, and extra repayments. Confirmed balances are closing quotes, never
events; a `loan_event|type=...` or `loan_closed` note records their origin, and
user notes follow as an escaped `|note=` suffix. Invalid event entries are
ignored on read. Invalid loan terms yield no automatic calculation and retain
manual valuation. Validate dates and numbers at input and calculation
boundaries.

`tracking_mode: "manual"` disables calculation and keeps the quote-based
valuation used for other alternative assets. Saving details with automatic
calculation enabled clears it.

### Liabilities from earlier releases

Earlier releases stored only `sub_type`, `original_amount` or `purchase_price`,
`origination_date` or `purchase_date`, `interest_rate`, and `linked_asset_id`,
with balances as manual quotes. These liabilities have no `loan_projection`, so
they keep manual valuation and need no migration. Editing details shows
automatic calculation off; enabling it and entering payment terms writes a
`loan_projection`, after which existing quotes act as confirmed balances.

## Calculation contract

### Dates, accrual, and posting

Contractual dates are `YYYY-MM-DD` calendar dates, not UTC instants. Monthly
payments keep the first payment's day, clamped to the end of shorter months: a
first payment on the 31st falls on each month's last day, while the 30th stays
the 30th even when the first payment is in a 30-day month. Biweekly payments
advance by 14 days.

For annual decimal rate `r` and payments per year `p`:

| Interest method    | Period rate                 |
| ------------------ | --------------------------- |
| `nominal_periodic` | `r / p`                     |
| `monthly`          | `(1 + r / 12)^(12 / p) - 1` |
| `semiannual`       | `(1 + r / 2)^(2 / p) - 1`   |

Missing conventions retain `nominal_periodic`; never infer one from currency or
loan type. Ordinary and accelerated biweekly use the same selected rate
conversion. Acceleration changes payment size to half the equivalent monthly
payment, not the interest convention.

Between dated events, interest is principal × period rate × elapsed calendar
days / days in the scheduled payment period. A full unchanged period accrues one
period's interest. A partial first period starts at the earliest known balance;
no interest is invented before it. This proportional stub calculation is an
estimate, not lender-specific daily accrual.

The reported balance is posted principal, not a settlement quote. Interest
accumulates separately until an instalment posts. On each date:

1. Accrue the preceding interval using its existing terms.
2. Apply new rate, payment, frequency, and renewal terms.
3. Post the scheduled instalment, if due.
4. Apply extra repayments in recorded order.
5. Apply the confirmed closing balance, if present.

A payment-date rate change cannot alter interest already accrued. A frequency
change starts a new schedule anchor and carries accrued interest forward.

Posted interest, contractual payments, and balances are rounded to cents, with
decimal midpoints rounded away from zero. Effective-rate conversion and
fractional accrual retain floating precision between postings; a no-op event
must not change rounding. The final instalment is capped at principal plus
accrued interest. Extra principal repayment cannot erase accrued interest. A
confirmed zero balance closes the loan.

### Creation, renewal, and recalculation

Automatically generated creation payments must settle the dated schedule by its
amortization horizon, including a delayed first instalment and cent postings. An
accelerated payment remains at least the rounded half-monthly preview amount. If
payment solving is unavailable, creation cannot save an undated fallback.

Renewal records dated terms and optional maturity. Omitted settings inherit the
terms at the renewal's effective date: an empty payment keeps the current
payment, and frequency or interest method are stored only when changed. A
payment is an amount per period, so a renewal that changes the frequency must
state its payment. Adding an older renewal must not overwrite a later renewal's
maturity. Future rates remain unknown: projections assume the recorded rates and
payments continue beyond renewal maturity.

The renewal form defaults to the current term's maturity once it has passed. It
previews the payment that keeps the original amortization through
`recalculate_loan` with the draft renewal applied, and offers it without saving
it. An optional balance from the renewal letter is saved first as a confirmed
balance on the renewal date; manual quotes are keyed by day, so a retry replaces
it instead of duplicating it.

`recalculate_loan` searches for the smallest cent payment that clears principal
and accrued interest by the existing horizon. An accelerated biweekly loan pays
half the monthly payment that clears it, rounded up, as at creation, so it still
finishes early. A payment recorded after the effective date would replace the
solved one, so the result is unavailable then. It preserves frequency resets and
recorded payment, rate, and extra-repayment events through that horizon. Trial
projections use confirmations only through the recalculation's effective date;
later confirmations or corrections cannot prove a candidate payment sufficient.
Actual valuation continues to use every recorded observation.

Recalculation saves dated rate/payment events, never overwrites original terms,
and never regenerates quotes. Preview and save use the same backend calculation;
an unavailable result cannot be saved.

### Editing, deletion, and reconciliation

Edit loan details updates original projection parameters and corresponding
scalar metadata together. It preserves dated events and confirmed quotes. A
confirmation remains authoritative even if original principal or origination is
corrected; changing an incorrect observation is a separate balance edit. Opening
confirmations must remain independently editable and deletable.

Forms take amortization (mortgages) or loan term (other loans) as years and
months, as loan agreements state it, and store it as `amortizationEndDate`: the
last payment counted from the first payment at the selected frequency. A stored
date that still matches the entered duration is kept, so saving other details
never moves an end date that is off the payment cadence.

Confirm balance writes a closing quote. Close loan writes a confirmed zero.
Extra repayment for an automatic loan writes an event only. A recorded balance
on or after the repayment date still takes priority, so the repayment form warns
that the repayment will not lower the balance from that confirmation on. Editing
a confirmation preserves its user notes and rejects collisions with another
confirmed date. Deleting an event preserves same-day siblings. Linking or
unlinking a property changes only `linked_asset_id`, preserving terms, events,
and confirmations. Deleting the property unlinks its mortgages; it does not
delete those liabilities. Deleting the final observation must not hide an
automatic loan whose original terms still support calculation; no replacement
confirmation is invented.

### Response semantics

| Result                                 | Meaning                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `currentBalance`                       | Posted principal on `asOf`                                                                 |
| Current terms                          | Rate, payment, cadence, and interest method effective on `asOf`                            |
| `calculationStartDate`                 | Beginning of reconstructed history; interest totals may not cover the loan's lifetime      |
| Row `payment` / `principal`            | Include applied extras; subtract `extraPayment` for the regular-instalment portion         |
| `balanceAdjustment`                    | Confirmed closing balance minus calculated closing balance; neither repayment nor interest |
| `remainingPayments`                    | Future scheduled instalments only                                                          |
| `residualBalance` / `residualInterest` | Unpaid principal / accrued interest at the projection horizon                              |
| `payoffDate`                           | Terminal settlement of both principal and accrued interest                                 |

Zero principal alone does not establish payoff; an interest-only final
instalment may remain. Residual interest is not added to posted-principal net
worth. Reopening resets payoff; trailing term changes or repeated zero
confirmations do not move an already settled payoff date.

Net-worth snapshots and history must use the same dated principal as holdings
and the loan page. Confirmation adjustments are not cash payments. Passing time
does not turn a projected payment into a confirmation.

## Page and interaction design

The existing asset route remains the entry point. `MortgageOverview` and shared
`LoanOverview` use mortgage-specific or generic loan wording. Other asset types
retain their existing layouts. Reuse shared cards, theme tokens, inputs, and
responsive sheets; action state belongs to `useLoanActions` so Overview and
Schedule open the same forms.

### Overview

- A summary strip shows principal-repaid progress, current term progress with a
  today marker, and the next payment with its estimated principal/interest
  split. The term indicator represents elapsed time, not principal repayment.
- One full-width balance chart combines reconstructed history, confirmations,
  and future projections. Use the success color and gradient fill, a dashed
  future line, and labelled today, renewal, and estimated-payoff references.
  Recorded renewal and extra-repayment markers have tooltips and open edit
  sheets.
- Range pills offer YTD, 1Y, 5Y, and ALL. ALL includes the full projection and
  reduction since origination. Past ranges show history; reduction compares the
  ending balance with the observation before the first day so first-day payments
  count. An unknown opening balance is unavailable, not zero. Reduction is not a
  cash-payment total.
- This term, Payoff, and Loan details cards separate renewal outlook, estimated
  versus contractual amortization end, and original facts/last confirmation.
  They stay quiet label/value lists below the strip and chart, and do not repeat
  the strip's figures. Both estimated cards carry one Estimated label whose hint
  states the calculation start date. Current terms reflect dated renewals rather
  than the original rate.
- A linked asset sits at the end of the details card. For a property it shows
  equity after every loan on the property, and loan-to-value, when they share a
  currency.
- Renewal balance is the last closing balance on or before maturity. Payments
  until renewal count scheduled instalments after today through maturity,
  excluding extras. Remaining amortization runs from renewal to projected
  payoff; it is unavailable if the projection leaves a residual. Missing or
  expired maturity prompts an update rather than showing a stale outlook.
- Interest is always estimated. Display the calculation start date where needed,
  and state that forecasts assume recorded rates and payments continue. Keep
  last-confirmed dates separate from the calculation date. Balance privacy hides
  monetary metrics and charts. Manual liabilities do not promise a payoff.

### Schedule and actions

The Schedule tab retains the `tab=history` route parameter. It contains a terms
strip and one Payments & events ledger. Original terms, renewals, and the
unknown period after renewal are sized by duration; a today marker distinguishes
the elapsed portion from the rest of the current term. Use compact status labels
with explanatory tooltips and localized dates.

The ledger merges the loan start, scheduled payments, recorded events, confirmed
balances, and next renewal. Group rows by year with payment, principal,
interest, and extra totals. Past is newest first; Upcoming is chronological.
Events only is a checkbox filter, separate from the Past/Upcoming selector. Runs
of ordinary payments collapse; recorded events and confirmations retain direct
edit access. Other alternative assets keep the value-history grid.

Header actions group balance operations, term changes, and management. Schedule
also offers Add event. Renew is highlighted near maturity (within 90 days) or
when overdue; a mortgage without maturity offers Add renewal date. A row, term
entry, or recorded chart marker opens the same edit sheet. Deletion requires
confirmation. Inputs and mobile sheet behavior follow the application's shared
form patterns. Cadence/status text supports all ten locales, including
accelerated biweekly. Use localized month names rather than ambiguous numeric
dates.

## Verification and fixtures

All loan examples live in
[`crates/core/src/assets/loan/fixtures.json`](../../crates/core/src/assets/loan/fixtures.json),
with `lifecycle`, `fcac`, `cfpb`, and `nationwide` sections. Expected values are
independent of engine output; do not regenerate them from the implementation.

### Complete lifecycle schedule

`lifecycle` is a synthetic CAD loan: $1,200 originated January 1, 2025, at 12%
nominal annual interest, with monthly payments from February 1. The annuity
preview is $106.618546414; the saved cent payment is $106.62. A separate Decimal
worksheet calculated the expected values using explicit monthly rows and
ROUND_HALF_UP.

Checkpoints cover scheduled payments, a $100 extra repayment, an $800 confirmed
balance, a May renewal to 6% and $110 payments, a backdated March renewal to
18%, editing the extra repayment to $150, deleting the confirmation,
editing/deleting the opening confirmation, and payoff. Earlier checkpoints
contain expected balance, interest, payoff, and net worth. The final state
includes every payment row through payoff, not just sampled dates.

For example, the backdated March 15 renewal splits March into 14 days at 12% and
17 days at 18% across a 31-day payment period. After the $150 extra repayment,
March closes at $859.81. April interest is
`859.81 × (0.01 × 14/31 + 0.015 × 17/31) = 10.96` rounded. May's payment settles
the preceding period at 18%; the new 6% applies after May 1. The final December
1 payment is $17.61: $17.52 principal plus $0.09 interest. Total posted interest
is $57.47, and net worth with no other assets is the negative principal balance.

Rust checks every checkpoint and every final payment row. The browser drives the
same lifecycle through real forms and persistence, comparing displayed balance,
saved-input calculation, net worth, and net-worth history at each checkpoint.
Focused tests separately cover delayed first payments and future confirmations.

### Independent reference cases and limits

These public examples supplement the lifecycle; they do not establish universal
lender equivalence. Reference observations were captured September 24, 2026.

- `fcac`: the Canadian Financial Consumer Agency calculator's $100,000, 5%,
  25-year amortization, five-year term examples, including monthly, biweekly,
  accelerated biweekly, and a $1,000 initial extra repayment. Monthly payment is
  $581.60; accelerated biweekly is $290.80. Dates in tests are synthetic because
  the calculator takes periods rather than payment dates. Its monthly summary
  uses an unrounded payment of approximately $581.604985: 60 displayed payments
  differ from its total by $0.30. Summary and table term balances differ by one
  cent. Ordinary biweekly first interest ($190.33) uses a different conversion
  from accelerated biweekly ($190.12), so it is an observation, not a golden
  semiannual-conversion assertion. Reported partial-final interest in the extra
  repayment and accelerated cases is inconsistent with remaining principal;
  those final amounts and lifetime totals are not golden expectations.
- `cfpb`: a fictional regulator statement with $264,776.43 principal at 4.75%,
  monthly interest $1,048.07, and principal due $386.46. Its $1,669.71 payment
  includes $235.18 escrow; model principal and interest as $1,434.53 and exclude
  $160 fees. This checks a monthly breakdown, not lifetime amortization. The
  March 1 test period anchor is synthetic, not the statement's issue date.
- `nationwide`: a published annual example with $128,751.20 opening principal,
  twelve $752.11 payments, $3,132.91 interest, $20 fee, $160.16 insurance, and
  $123,038.95 closing principal. The figures reconcile but lack dated rate
  inputs for engine reconstruction. A deliberate zero-interest baseline verifies
  that the closing confirmation captures unmodelled charges as adjustment, not
  payment.

### Test organization and change gate

- Rust engine, recalculation, reference, lifecycle, and boundary tests live
  beside the calculator. Boundary tests cover pre-origination dates, UTC
  observation dates, deleted opening confirmations, maturity edits, closure, and
  oversized repayments. Net-worth service tests verify integration.
- Frontend tests cover preview conventions, input construction, editing, period
  boundaries, privacy-related presentation, and opening confirmations. They also
  verify that rejected repayments write nothing, manual balances use UTC
  calendar days, and liabilities from earlier releases can opt into calculation.
- [`e2e/23-loan-lifecycle.spec.ts`](../../e2e/23-loan-lifecycle.spec.ts) covers
  the complete fixture, shared actions, net worth with unrelated holdings
  already present, creation, and cross-asset UI.
- [`e2e/24-loan-editing.spec.ts`](../../e2e/24-loan-editing.spec.ts) covers
  event management, form validation, conventions, confirmation edits, and
  recalculation.

Verify accounting conservation, rounding, calendar boundaries, stub periods,
dated ordering, cadence resets, closure/reopening, residuals, invalid inputs,
and bounded projections. Preserve parity across both runtime adapters. Display
unavailable projections honestly rather than converting them into zero.

Run focused Rust and frontend tests for the change; run both loan E2E files for
changes to these flows. Follow [`e2e/README.md`](../../e2e/README.md) for a
fresh installation and real web backend. App E2E tests are currently a local
gate, not part of PR CI. Passing the covered cases is not proof of every
lender's rules.
