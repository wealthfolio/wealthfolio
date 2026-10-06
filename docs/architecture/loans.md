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
Previews, creation, and saved terms use the same Rust setup rules; the frontend
only reads stored terms back into the form, on calendar days.

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

Loan actions are written by the backend alone. `apply_loan_action` takes a
confirmation, extra repayment, renewal, recalculation, closure, or event or
balance edit; it reads the loan's metadata and manual quotes, checks the action
against them, and writes both in one transaction through the sync outbox. A
refused action writes nothing. Actions that change recorded balances start the
same portfolio recalculation as a manual quote. Dates are checked against today
in the settings timezone, allowing one day for a device ahead of it. The
decision, including the engine calculation that checks a repayment or solves a
payment, runs inside the write transaction on the database writer. Creation and
Edit loan details send a loan setup instead of loan fields; see
[Loan setup](#loan-setup).

### Implementation map

Paths below are relative to the repository root.

| Responsibility                                   | Location                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Dated valuation and calendar rules               | `crates/core/src/assets/loan.rs`                               |
| Interest conversion and posting precision        | `crates/core/src/assets/loan/interest.rs`                      |
| Payment solving                                  | `crates/core/src/assets/loan/recalculation.rs`                 |
| Stored format and balance provenance             | `crates/core/src/assets/loan/model.rs`                         |
| Loan setup checks, stored terms, and previews    | `crates/core/src/assets/loan/setup.rs`                         |
| Loan actions and their rules                     | `crates/core/src/assets/loan/actions.rs`                       |
| Payment allocation, statuses, and suggestions    | `crates/core/src/assets/loan/payments.rs`                      |
| Linking a withdrawal to a loan                   | `crates/core/src/assets/loan/linking.rs`                       |
| Atomic loan writes                               | `crates/storage-sqlite/src/assets/alternative_repository.rs`   |
| Holdings integration                             | `crates/core/src/assets/alternative_assets_service.rs`         |
| Holdings card summary                            | `crates/core/src/assets/loan/summary.rs`                       |
| Net worth and history                            | `crates/core/src/portfolio/net_worth/net_worth_service.rs`     |
| Shared frontend calls                            | `apps/frontend/src/adapters/shared/alternative-assets.ts`      |
| Desktop commands                                 | `apps/tauri/src/commands/alternative_assets.rs`                |
| Web handlers                                     | `apps/server/src/api/alternative_assets.rs`                    |
| Overview, timeline, schedule, and sheets         | `apps/frontend/src/pages/asset/alternative-assets/components/` |
| Actions, calculation queries, and formatting     | `apps/frontend/src/pages/asset/alternative-assets/hooks/`      |
| Presentation, event editing, and ledger assembly | `apps/frontend/src/pages/asset/alternative-assets/lib/`        |
| Linking from Spending rows                       | `apps/frontend/src/features/spending/components/`              |

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

Loan fields, events included, live in the asset's metadata, so device sync
treats them as part of the asset row: when two devices change the same loan
before syncing, the later change wins and the other is lost.

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

### Loan setup

A loan setup is what the user enters: original amount, origination date, and
interest rate, and for a calculated loan its schedule: frequency, interest
method, first payment date, amortization in months or a last payment date, the
payment, renewal maturity, the "Paid from" account, and escrow per payment.
`apply_loan_setup` in `loan/setup.rs` checks the whole setup and derives the
stored fields; `preview_loan_terms` runs the same derivation without saving, so
a preview always matches what is saved.

1. **Manual loans** need no schedule. An entered original amount must be above
   zero and an entered rate between 0 and 100.
2. **Calculated loans** require an original amount above zero, an origination
   date, a frequency, and an amortization above zero. The rate must be between 0
   and 100; an omitted rate is 0.
3. **Dates.** The first payment defaults to one period after origination and
   must fall after it. The last payment cannot fall before the first. Renewal
   maturity must fall after origination.
4. **Derived schedule.** The end is given as months of amortization or as a last
   payment date, not both. Months give the payment count by frequency and the
   last payment by the payment calendar. A stored last payment that still
   matches the entered months is kept, so saving other details never moves an
   off-cadence contractual end.
5. **Payment.** An entered payment must be above zero. An omitted payment is
   solved as at creation, below.
6. **Paid from and escrow** follow the payment rules: an active, unarchived cash
   account in the loan's currency, and escrow of zero or more. Paid from is set
   when editing a loan; creation refuses it.
7. **One way in.** Creation takes a setup with the asset. Edit loan details
   sends its setup with the other details in one request, saved with the
   `set_terms` rules in one transaction through the sync outbox, so a refusal or
   a failure saves none of it. The alternative-asset metadata API refuses loan
   fields (`loan_projection`, `loan_events`, `renewal_maturity_date`,
   `tracking_mode`, `payment_account_id`, `escrow_amount`, `original_amount`,
   `origination_date`, `interest_rate`) on liabilities with
   `LOAN_FIELDS_READ_ONLY`.

A refused setup names the rule it broke with a stable code, and nothing is
written. Every save checks the whole setup.

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
months, as loan agreements state it; the backend stores it as
`amortizationEndDate`: the last payment counted from the first payment at the
selected frequency. A stored date that still matches the entered duration is
kept, so saving other details never moves an end date that is off the payment
cadence.

Each action below is one backend call. Refusals are stable codes, such as
`LOAN_EVENT_CHANGED` or `LOAN_PAYMENT_REQUIRED`, that the UI translates.

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
and the loan page. Holdings returns each liability's card summary (terms in
effect, payoff date, renewal maturity, original amount) from the calculation
that values it, so a card runs no calculation of its own. Alternative assets and
loans count even when there are no accounts. Confirmation adjustments are not
cash payments. Passing time does not turn a projected payment into a
confirmation.

## Payments from an account

A calculated loan can name the cash account its payments leave from. Each
payment is then an ordinary withdrawal in that account, tagged with the loan, so
cash and debt move together and net worth changes only by interest and escrow.
This follows how budgeting and accounting tools treat a loan payment: principal
is a transfer to the loan, interest and escrow are costs, and the lender's
statement remains the truth.

### Stored data

- Loan metadata `payment_account_id` names the "Paid from" account, and
  `escrow_amount` is the escrow usually included in a payment. Both are optional
  and written by loan actions only.
- A payment is tagged in its activity metadata under `loan_payment`: `loan_id`,
  optional `escrow` (included in this payment) and optional `applies_to` (an
  instalment due date, or `extra`). Only the payment actions write this key;
  ordinary activity edits and imports keep it unchanged.
- Storage reads tagged withdrawals as stored, with their instants
  (`StoredPayment`, `StoredLoan`); core dates them in the settings timezone
  (rule 5), so storage takes no timezone.

### Rules

1. **One record per payment.** The withdrawal is the payment; the loan stores no
   copy. Regular and extra payments are both tagged withdrawals.
2. **Eligible payments.** A tag counts only on a posted withdrawal (after any
   type override) in a cash account in the loan's currency. Linking checks this;
   anything that later stops qualifying is ignored, not converted.
3. **Calculated loans only.** Payments are linked to calculated loans. A loan
   switched to manual keeps its tags but ignores them; its balance comes from
   confirmations. Loans without tagged payments behave exactly as before.
4. **The tag decides, not the account.** Changing the "Paid from" account only
   changes where new payments are recorded and where untagged withdrawals are
   suggested; payments already tagged keep counting. "Paid from" must be an
   active, unarchived cash account in the loan's currency; one archived or
   deactivated later is treated as not set.
5. **Payment date.** A payment is dated by its activity date, the calendar day
   Wealthfolio shows for that withdrawal in the settings timezone. Near midnight
   that can differ from its date in UTC; the local day is the one that counts. A
   date stored at UTC midnight (broker sync, and bare dates saved before they
   were stored on their local day) counts on the day shown, which west of UTC is
   the day before.
6. **Escrow first.** The tag's escrow, at most the payment amount, is never
   principal or interest. Linking fills it from the loan's `escrow_amount`, so a
   later change to that amount does not rewrite earlier payments. A payment
   linked as extra principal has no escrow unless the user names it.
7. **Matching an instalment.** Unless the tag names a target, a payment settles
   the unpaid instalment whose due date is nearest, within 10 days for monthly
   loans and 6 days for biweekly ones. A tag naming an instalment due date, or
   `extra`, overrides matching.
8. **Allocation.** Applied to an instalment, the payment covers what remains of
   that instalment's scheduled payment, its interest and principal, and any
   extra repayment recorded on the due date, so a withdrawal paying both counts
   the extra once. Whatever is left is extra principal on the payment date,
   applied like a recorded extra repayment. A payment that settles no instalment
   is entirely extra principal.
9. **Shortfalls and missed payments are flagged, not guessed.** From the first
   counted payment onward, an instalment more than its matching window overdue
   with less than its scheduled payment applied is marked short or missing. An
   extra repayment recorded on the due date counts through its own event, so it
   is not required from the payments, though a later payment within the window
   still counts toward it (rule 8). The balance still assumes the scheduled
   payment until a confirmed balance corrects it, because an import that is late
   or incomplete must not lower debt.
10. **A repeated difference suggests a payment change.** When the last three
    instalments settled by payments, matched or directed, each differ from the
    scheduled payment by the same amount of at least 1.00, the loan suggests a
    dated payment change instead of counting the difference every time. An extra
    repayment recorded on the due date is no difference, whether paid with the
    instalment or apart. Until the user acts, rule 8 applies.
11. **Confirmed balances still win.** A confirmation on or after a payment's
    date overrides the estimate from that date, as before; a payment on the same
    day is already included in it.
12. **Recording from the loan.** With a "Paid from" account, Extra repayment
    records a withdrawal there tagged `extra` instead of a loan event; the
    withdrawal is created first, so a failed link leaves an untagged withdrawal
    that is offered for linking. Without one, it records an event as before.
13. **Edits flow through.** Editing, voiding or deleting a tagged withdrawal
    changes the loan; unlinking keeps the withdrawal and removes the tag.
    Deleting the loan removes its tags and keeps the withdrawals. Linking or
    unlinking rewrites the withdrawal, so its account is recalculated as after
    any activity edit.
14. **One valuation.** The loan page, holdings, net worth and net-worth history
    count the same payments, so they show the same dated principal.
15. **No double count.** A withdrawal and a recorded extra repayment on the same
    day for the same amount are taken to be the same money, unless the
    withdrawal is a regular payment: one the user directed to an instalment, or
    one matched to the instalment due on its own date, which covers that day's
    extra repayments (rule 8) so the money counts once. A double-up payment
    beside an extra of the same amount stays two payments. Linking such a
    withdrawal is refused with `LOAN_PAYMENT_DUPLICATES_EVENT` unless the user
    chooses to replace the event, which removes it and links the whole
    withdrawal, without escrow unless the user names it, as that extra principal
    in one transaction. Recording or moving an extra repayment onto one a linked
    withdrawal already made is refused with `LOAN_EXTRA_ALREADY_LINKED`. With
    "Paid from" set, an extra repayment already recorded is refused before any
    withdrawal is created.

Matching and allocation run in the shared engine. The engine first builds the
schedule without derived payments, allocates payments in date order against its
instalments, then calculates again with the derived extra principal. It returns
each instalment's status and each payment's allocation for display. Spending's
split of a payment into principal and interest, and creating payments for loans
whose account is not imported, are later changes.

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
  With no renewal before or ahead it is labelled Loan term, since the term is
  the whole loan.
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
- This term appears only with a renewal date; without one, its figures would
  repeat Payoff and the strip. Payoff lists the original payoff only when the
  estimate differs from it.
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
when overdue; a tracked mortgage without maturity offers Add renewal date in its
details card. A row, term entry, or recorded chart marker opens the same edit
sheet. Deletion requires confirmation. Inputs and mobile sheet behavior follow
the application's shared form patterns. Cadence/status text supports all ten
locales, including accelerated biweekly. Use localized month names rather than
ambiguous numeric dates.

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
- Setup tests (`loan/setup_tests.rs`) cover each setup rule, the solved payment,
  a kept off-cadence end, and a payment calendar that matches the frontend forms
  it replaced.
- Rust action tests (`loan/actions_tests.rs`) cover each action's rules: date
  limits, repayments within the balance on their date, occupied balance dates,
  stale event edits, renewal settings and maturity, and manual balances on their
  own calendar day. Storage tests
  (`crates/storage-sqlite/tests/loan_actions.rs`) verify that a write failing
  after the metadata change leaves the loan untouched, that a refused action
  writes nothing, that a renewal's balance and terms are written together, that
  confirming a day replaces its creation quote, that creation takes a setup,
  that the general details update refuses loan fields and writes nothing, and
  that editing details with loan terms saves both or neither.
- Payment tests (`loan/payments_tests.rs`, `loan/linking_tests.rs`) cover
  eligibility, escrow, matching windows, directed targets, short and missing
  instalments, suggestions, and confirmations winning. Storage tests verify that
  tagged payments value the loan in holdings, that linking refuses ineligible
  withdrawals and accounts, that deleting a loan untags its payments, and that
  replacing a recorded extra repayment with its withdrawal counts it once. The
  net-worth service test checks that the same payments count in net worth and
  its history.
- Frontend tests cover the setup each form sends and never loan fields in
  metadata, showing the backend preview and its refusals, the action each dialog
  sends, period boundaries, privacy-related presentation, and opening
  confirmations, and that liabilities from earlier releases can opt into
  calculation.
- [`e2e/23-loan-lifecycle.spec.ts`](../../e2e/23-loan-lifecycle.spec.ts) covers
  the complete fixture, shared actions, net worth with unrelated holdings
  already present, creation, cross-asset UI, previews, and the backend refusing
  bad terms and loan fields in metadata.
- [`e2e/24-loan-editing.spec.ts`](../../e2e/24-loan-editing.spec.ts) covers
  event management, form validation, conventions, confirmation edits, and
  recalculation.
- [`e2e/25-loan-payments.spec.ts`](../../e2e/25-loan-payments.spec.ts) covers
  Paid from, linking from Spending and from the loan, the payment change
  suggestion, extra repayments recorded as withdrawals, replacing an extra
  repayment with its withdrawal, unlinking, and deleting a loan with tagged
  payments.

Verify accounting conservation, rounding, calendar boundaries, stub periods,
dated ordering, cadence resets, closure/reopening, residuals, invalid inputs,
and bounded projections. Preserve parity across both runtime adapters. Display
unavailable projections honestly rather than converting them into zero.

Run focused Rust and frontend tests for the change; run the loan E2E files for
changes to these flows. Follow [`e2e/README.md`](../../e2e/README.md) for a
fresh installation and real web backend. App E2E tests are currently a local
gate, not part of PR CI. Passing the covered cases is not proof of every
lender's rules.
