# Credit card billing cycles

Credit card accounts can opt into billing statements in their account settings.
The user chooses a closing day and a payment due day, both integers from 1
to 31. A missing day in a shorter month uses that month's last day. The due date
is the first occurrence of the due day strictly after closing; equal days mean
payment in the following month. A cycle starts the day after the preceding close
and includes the whole closing day in the configured application timezone. It
stays open through that day.

The account page shows the open cycle and up to twelve previous cycles. Each
period links to the existing Activities page filtered to that card and date
range. The current balance and last closing balance are prominent summaries,
with separate closing and payment due dates and explicit transaction links.
Earlier cycles and the detailed calculation explanation are collapsed; the
closing-balance caveat stays visible. A billing settings link reuses the account
settings page. Cards without a schedule show a setup link and do not request
statement history.

## Balances

Core derives statement balances from the same posted cash ledger used for
running balances. It includes all earlier activity, even before the first
visible cycle, so unpaid debt and credit carry forward. Positive means owed;
negative means credit. Each currency stays separate, without a market-data or FX
request. Pending, draft, voided, future-dated and other-account rows do not
contribute. A history containing securities returns an error instead of a
misleading cash-only balance. Archived and non-transaction-tracked cards also
reject the read: the standard ledger excludes archived accounts.

A closed statement shows the balance at its close. Subsequent payments appear in
the next cycle and reduce the current card balance; they do not rewrite the
previous statement. These are computed statements from recorded transactions,
not imported issuer statements or a calculation of the remaining payment due.
Correcting earlier transactions or changing the schedule recomputes historical
statements. Partial imports cannot reconstruct missing opening debt.

## Architecture impact

- Settings live under `Account.meta.creditCardBilling`, for example
  `{"closingDay":25,"dueDay":5}`. Existing account writes, metadata
  preservation, backup/export and account synchronization carry them. No
  migration, new table, statement snapshot, worker, retry policy or
  synchronization primitive is added.
- Credit card create/update validates recognized billing metadata in core before
  persistence. Invalid values produce errors that do not echo metadata. Other
  account types keep inactive metadata without validating hidden card settings;
  changing the type back to a card validates those settings again.
- `ActivityServiceTrait::get_credit_card_statements` loads the account's ledger
  and runs shared core calculations on the existing blocking pool. Tauri's
  `get_credit_card_statements` and Axum's `GET /api/v1/accounts/{id}/statements`
  use that service and the existing profile/session boundary. Both frontend
  adapters expose the same read.
- Existing account/activity events invalidate the statement query alongside
  other portfolio queries. The active page also refreshes every minute so the
  open/closed boundary changes without requiring a new transaction.
- Spending date filters send calendar dates to the shared Rust service. It
  compares them in the configured application timezone, including DST
  transitions, so a browser in a different timezone sees the same statement
  period. Existing RFC3339 timestamp filters keep their inclusive instant
  semantics.
- No payment is created by closing a cycle. Card payment accounting, spending
  categorization, provider settings and network integrations are unchanged.
- The account form and statement list use existing UI components, privacy-aware
  amounts, calendar date formatting, logical spacing and all supported locales.

Issuer-specific business-day adjustments, changing historical schedules,
installment plans, minimum payments, interest calculations and allocation of
payments to individual statements are outside this feature. These require
additional issuer data or explicit accounting rules rather than guessing from
the card's ledger.
