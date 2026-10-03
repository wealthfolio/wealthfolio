# Cost Basis Methods

Each account has an accounting policy that decides how a disposal (SELL,
TRANSFER_OUT, option expiry) relieves cost basis. It drives book value, average
cost, realized gains and the `lots` / `lot_disposals` tables.

## Supported settings

| Setting (account form)      | `costBasisMethod` | `costBasisProfile` | Relief                                         |
| --------------------------- | ----------------- | ------------------ | ---------------------------------------------- |
| First in, first out (FIFO)  | `FIFO` (default)  | `GENERIC`          | Oldest lot first                               |
| Average cost                | `WAC`             | `GENERIC`          | Weighted average cost of the position          |
| Canadian ACB (average cost) | `WAC`             | `CANADA_ACB`       | Weighted average cost (identical-property ACB) |

The policy is stored in the account's `meta` JSON under `accounting`:

```json
{ "accounting": { "costBasisMethod": "WAC", "costBasisProfile": "CANADA_ACB" } }
```

Saving an account emits `AccountsChanged`, which rebuilds the account's
snapshots, lots and disposals from its full history, so switching methods
restates past sales too.

Not supported yet: `LIFO`, `PORTFOLIO` pooling scope, and lot selection
strategies. `CANADA_ACB` with anything but `WAC` is rejected. An unsupported
setting fails the snapshot calculation with a validation error rather than
silently falling back to FIFO.

## How average cost is applied

Lots are kept as they are under FIFO: one lot per acquisition, with its own
date, source activity and acquisition FX. Under `WAC` a disposal takes the
**same fraction of every open lot** instead of consuming the oldest one first.

- The cost removed is `position cost × quantity sold / position quantity`, i.e.
  the average cost × units, and every remaining lot keeps its per-unit cost, so
  the next disposal relieves the average again.
- Because each lot carries its own acquisition-date FX, the base-currency cost
  removed is also the average of the base-currency cost. For a CAD base this is
  the CAD ACB of a USD security.
- The last lot takes the rounding remainder so the units removed equal the units
  sold exactly. Selling the whole position closes every lot.
- A disposal writes one `lot_disposals` row per lot slice; their cost basis sums
  to the average-cost relief.
- An internal transfer (paired TRANSFER_OUT / TRANSFER_IN) moves the relieved
  slices to the receiving account, so the units arrive at the sender's average
  cost.

## Cost basis adjustments

Two ADJUSTMENT subtypes change cost basis without moving units or cash. `amount`
is the adjustment, in activity currency.

- `RETURN_OF_CAPITAL` lowers cost basis (T3 box 42, or a broker's "ROC cost
  adjustment"). Book the cash with the distribution that paid it.
- `NOTIONAL_DISTRIBUTION` raises cost basis (a distribution reinvested without
  issuing units, also called a phantom or reinvested capital gains
  distribution).

Cost basis never goes below zero. The part of a return of capital that exceeds
the remaining basis is recorded as a realized gain: a zero-quantity
`lot_disposals` row against the adjustment, with zero cost basis.

How the change is spread across lots depends on the method:

- `WAC`: a reduction scales every lot's cost by the same factor, so only the
  pooled basis floors at zero. An increase is spread by units.
- `FIFO`: the change is spread per unit, and each lot floors at zero on its own
  (per-share basis).

## Canadian ACB rules

The `CANADA_ACB` profile applies the identical-property rules of the Income Tax
Act. Each rule below has a test in
`crates/core/src/portfolio/snapshot/holdings_calculator_tests.rs`
(`canada_acb_rules` module) built from the cited worked example.

| Rule                                                                                        | Source                                   | Test                                                                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Identical properties share one ACB: total cost ÷ units, recalculated at each purchase       | ITA s. 47; CRA T4037                     | `identical_properties_are_averaged_and_a_sale_relieves_the_average`     |
| Purchase commissions add to ACB; sale commissions reduce proceeds                           | CRA T4037; finiki (Ed)                   | `purchase_commissions_add_to_acb_and_sale_commissions_reduce_proceeds`  |
| A sale does not change ACB per unit                                                         | finiki (Genevieve)                       | `a_sale_does_not_change_acb_per_unit`                                   |
| Reinvested distributions are purchases that re-average ACB                                  | TD Wealth "Identical Properties" (Josée) | `reinvested_distributions_re_average_acb`                               |
| Return of capital reduces ACB                                                               | T3 box 42                                | `return_of_capital_reduces_acb`                                         |
| ACB cannot be negative: excess return of capital is a capital gain and ACB resets to zero   | ITA 40(3); adjustedcostbase.ca           | `return_of_capital_beyond_acb_is_a_capital_gain_and_acb_floors_at_zero` |
| Notional (phantom) distributions increase ACB                                               | T3 reporting; adjustedcostbase.ca        | `notional_distribution_increases_acb_without_adding_units`              |
| A stock split changes units, not total ACB                                                  | CRA T4037                                | `stock_split_keeps_total_acb_and_divides_acb_per_unit`                  |
| Moving units between your own accounts is not a disposition; the units keep their ACB       | ITA (no change in beneficial ownership)  | `transfer_between_own_accounts_carries_the_average_acb`                 |
| Foreign-currency cost converts at the acquisition-date rate, proceeds at the sale-date rate | CRA T4037                                | `foreign_currency_acb_averages_cad_cost_at_acquisition_fx`              |

### Not modelled

- **Pooling across accounts.** The CRA pools identical property across all of a
  taxpayer's non-registered accounts. Wealthfolio pools per account (`ACCOUNT`
  scope), which matches broker statements. Reconcile tax ACB across accounts
  outside the app.
- **Superficial loss rule** (ITA 54). A loss on a sale with an identical
  purchase within 30 days before or after is not denied, and the denied loss is
  not added to the replacement units' ACB.
- **Deemed dispositions** on in-kind contributions to RRSPs, TFSAs and similar
  plans. Record these as an external TRANSFER_OUT and an external TRANSFER_IN at
  fair market value.
- **Foreign-currency return of capital** lowers each lot's cost in the position
  currency, so its base-currency effect uses each lot's acquisition FX rather
  than the rate on the date of the return of capital.
- A position whose ACB has been reduced to zero reports its lots' basis as
  unknown, because a zero-cost lot cannot be told apart from a missing price.
- Registered accounts do not need ACB, but computing it there is harmless.
