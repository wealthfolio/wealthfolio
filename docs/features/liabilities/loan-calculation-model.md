# Liability and loan calculation model

This document describes how Wealthfolio represents and values loans and other
liabilities. It is the reference for the frontend projection engine and for
future storage or API implementations.

## Concepts

A liability has two different kinds of data:

1. **Observed data**: balances and repayments that the user has actually
   recorded or confirmed.
2. **Projected data**: future amortisation calculated from the current terms.

Projected instalments are not market quotes and must not be persisted as quotes.
The application stores the terms and dated events, then calculates the future
schedule when it is displayed.

Historical quotes are never rewritten when a new event is entered. An event
changes the projection from its effective date onward.

## Loan inputs

The projection engine accepts:

| Input              | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `principal`        | Balance from which the projection starts                        |
| `annualRate`       | Annual nominal interest rate, expressed as a percentage         |
| `paymentAmount`    | Optional fixed payment; if omitted, it is calculated            |
| `paymentCount`     | Maximum number of future payments                               |
| `frequency`        | `monthly`, `biweekly`, or `accelerated_biweekly`                |
| `firstPaymentDate` | Date of the first projected payment                             |
| `events`           | Validated dated events applied before the payment on their date |

For a periodic rate `r` and balance `B`, interest for a period is:

```text
interest = B × r
principal = max(0, payment - interest)
closing balance = max(0, B - principal)
```

The periodic rate is `annualRate / 100 / periodsPerYear`. Monthly loans use 12
periods per year; biweekly loans use 26. Accelerated biweekly payments are
calculated as half the equivalent monthly payment.

For a constant-payment loan, the calculated payment is:

```text
payment = B × r / (1 - (1 + r)^(-n))
```

For a zero rate, the payment is `B / n`. Rounding is applied to displayed
closing balances, not during the internal amortisation calculation.

## Event types

Events are dated and ordered by `effectiveDate`.

| Event                      | Required fields                                   | Effect                                                  |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `balance_correction`       | `balance`                                         | Replaces the balance from the effective payment onward  |
| `extra_repayment`          | `amount`                                          | Reduces principal without adding interest               |
| `rate_change`              | `annualRate`                                      | Changes the rate for subsequent payments                |
| `payment_change`           | `paymentAmount`                                   | Changes the fixed payment for subsequent payments       |
| `payment_frequency_change` | `frequency`                                       | Changes the period spacing and periodic rate            |
| `renewal`                  | `annualRate`, optional payment/frequency/end date | Starts a new term while preserving the previous history |

Malformed events are ignored when read. Dates must be ISO calendar dates and
amounts/rates must be finite and non-negative. Payments and extra repayments
must be strictly positive.

## Renewals and corrections

A renewal is not a rewrite of the original loan. It is a dated event:

- payments before the effective date keep their original rate, payment and
  balances;
- the new rate and optional payment apply from the effective date;
- an optional end date limits the new term;
- previous quotes remain unchanged.

Balance corrections and extra repayments follow the same rule. The current
balance is the last relevant observed balance; the event is then applied only to
future projection periods. The UI must never delete or regenerate historical
quotes as a side effect of these actions.

## Confirmed versus projected values

The following values are confirmed inputs:

- manual balance quotes;
- balance-correction events;
- extra-repayment events;
- explicitly recorded closure values;
- historical quotes generated before the projection-only storage model.

Rows marked `loan_schedule` or `scheduled_payoff` are legacy projections. A
legacy row is usable for historical display when its date is in the past, but a
future legacy row must not override the current balance. The compatibility view
filters those future rows while keeping the original data available for
migration and audit purposes.

## Manual-only tracking

A liability can be created in manual mode. Manual mode is appropriate when the
user knows balances but does not want to maintain an amortisation schedule.

Manual mode:

- requires a current balance and valuation date;
- does not require a rate, original amount, origination date or term;
- does not create `loan_projection` metadata;
- does not create future schedule quotes;
- accepts later manual balance entries and dated balance events.

Automatic mode is selected explicitly in the creation form and requires the
terms needed to calculate a projection.

## Persistence and compatibility

Loan terms are stored in asset metadata. Projection parameters are serialized
under `loan_projection`; dated lifecycle events are stored under `loan_events`.
The metadata format is deliberately versioned so it can evolve without
reinterpreting historical quotes.

Existing installations may contain future `loan_schedule` quotes. They remain
read-compatible, but new code must not create additional future schedule quotes.
A later migration may archive or remove obsolete generated rows after the
projection engine has been validated against the user's confirmed data.

## Display and valuation rules

The same valuation snapshot must be used for:

- the liability page;
- the amortisation table;
- the liability chart;
- principal and interest indicators;
- net-worth calculations;
- linked-asset equity calculations.

The snapshot uses the latest relevant observed balance and never a future legacy
projection. Future rows shown in an amortisation table are calculated on demand
and are labelled as projected. Historical rows retain their original dates and
values.

## Testing expectations

Changes to this model should cover, as applicable:

- zero-rate and non-zero-rate amortisation;
- monthly and biweekly frequencies;
- first-payment/origination-date semantics;
- renewal, rate change and payment change boundaries;
- balance correction and extra repayment events;
- manual-only liabilities;
- legacy future schedule compatibility;
- closure and zero-balance projections;
- consistency between the liability valuation and net worth.
