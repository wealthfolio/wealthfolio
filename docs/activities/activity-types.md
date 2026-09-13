# Activity Types Reference

This document provides a comprehensive reference for Activity types used in
Wealthfolio. Understanding these types is essential for tracking portfolio
movements and for creating activities programmatically through addons or CSV
imports.

## Overview

Wealthfolio uses a closed set of **14 canonical activity types**. Activities can
affect:

- **Cash Balance**: The cash position in the account (by currency)
- **Asset Quantity**: The number of shares/units held
- **Cost Basis**: The original cost of holdings for gain/loss calculations
- **Net Contribution**: Total money contributed to/withdrawn from the portfolio
  (affects TWR performance)

---

## Final amounts (3.8 and later)

`amount` is the saved final cash magnitude, including fees and taxes. Runtime
calculations use it as-is. They do not derive a missing total or deduct charges
again. Type normally determines direction; a SELL can be an outflow when its
trade details prove charges exceed proceeds. Explicit zero remains zero.

Writers can derive missing trade totals from quantity × unit price × asset
multiplier, plus charges for BUY or minus charges for SELL. Import can convert a
matching gross total to final; a conflicting total is preserved for review.
Plain cash and income require an explicit amount. Standalone charges and
recognized asset-income composites have their own missing-amount derivation.

All monetary inputs use activity currency. `fx_rate` converts activity currency
to account currency. A positive supplied rate settles BUY/SELL cash in account
currency; otherwise trade cash stays in activity currency. Non-trade cash stays
in activity currency, even with a rate. The rate can still affect contribution
reporting, while displayed cash valuation uses FX service data. Asset quote
currency does not participate in calculating the trade total. The asset owns the
multiplier.

Cash and gross flows differ: a deposit's final amount plus included charges is
its pre-charge contribution; a withdrawal's final amount minus included charges
is its pre-charge withdrawal. Income uses final amount plus included charges to
recover its gross value. This does not create another cash movement.

Exceptions: SPLIT uses amount as a ratio; security transfers move holdings and
only their fee affects cash; DRIP, staking rewards, and in-kind dividends
compile into matching income/acquisition legs. These cancel in the same currency
without FX. With a supplied positive FX rate and different activity/account
currencies, the income stays in activity currency while the synthetic BUY uses
account currency, so both cash balances change. Do not supply a rate for a
reinvestment that had no currency conversion.

See [upgrade notes](final-cash-upgrade.md) and the consumer
[Activity Fields reference](https://wealthfolio.app/docs/concepts/activity-fields/).
`needs_review` is independent of status: a Posted row still counts while
flagged. Incomplete imported final amounts are kept as Draft for review.

## Summary Table

| Type             | Category | Cash Impact          | Holdings Impact   | Cost Basis         | Net Contribution                     | Required Asset |
| ---------------- | -------- | -------------------- | ----------------- | ------------------ | ------------------------------------ | -------------- |
| **BUY**          | Trading  | -amount              | +quantity         | +cost              | No change                            | Yes            |
| **SELL**         | Trading  | +amount              | -quantity         | -cost (FIFO)       | No change                            | Yes            |
| **SPLIT**        | Trading  | No change            | Adjusted          | Per-share adjusted | No change                            | Yes            |
| **DEPOSIT**      | Cash     | +amount              | N/A               | N/A                | +gross flow                          | No             |
| **WITHDRAWAL**   | Cash     | -amount              | N/A               | N/A                | -gross flow                          | No             |
| **TRANSFER_IN**  | Transfer | +amount or +quantity | +quantity (asset) | Preserved/set      | +gross flow (ordinary account scope) | Optional       |
| **TRANSFER_OUT** | Transfer | -amount or -quantity | -quantity (asset) | Removed (FIFO)     | -gross flow (ordinary account scope) | Optional       |
| **DIVIDEND**     | Income   | +amount              | No change         | No change          | No change                            | Yes            |
| **INTEREST**     | Income   | +amount              | No change         | No change          | No change                            | Optional       |
| **CREDIT**       | Income   | +amount              | No change         | No change          | Depends on subtype                   | No             |
| **FEE**          | Charge   | -amount              | No change         | No change          | No change                            | Optional       |
| **TAX**          | Charge   | -amount              | No change         | No change          | No change                            | Optional       |
| **ADJUSTMENT**   | Other    | Varies               | Varies            | Varies             | No change                            | Yes (required) |
| **UNKNOWN**      | Other    | No auto impact       | No auto impact    | No auto impact     | No change                            | Optional       |

---

## Activity Categories

### Trading Activities

#### BUY

**Purpose**: Purchase of a security or other asset.

| Impact               | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| **Cash**             | Decreases by `amount` (final total including fee and tax) in activity currency |
| **Holdings**         | Increases quantity; new lot created with cost basis                            |
| **Cost Basis**       | Increases by `amount` (final total including fee and tax)                      |
| **Net Contribution** | No change (internal reallocation of cash to asset)                             |

**Entry Fields**: `asset`, `quantity`, `unit_price`, `currency`, final `amount`.
The writer can calculate an omitted amount. **Optional Fields**: `fee`, `tax`.

**Example**: Buy 10 shares of AAPL at $150 with $5 fee

- Cash: -$1,505 USD
- Holdings: +10 AAPL shares
- Cost Basis: +$1,505

---

#### SELL

**Purpose**: Disposal of a security or other asset.

| Impact               | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| **Cash**             | Increases by `amount` (final proceeds after fee and tax) in activity currency |
| **Holdings**         | Decreases quantity; lots reduced using FIFO                                   |
| **Cost Basis**       | Decreases by cost basis of sold lots (FIFO matching)                          |
| **Net Contribution** | No change (internal reallocation of asset to cash)                            |

**Entry Fields**: `asset`, `quantity`, `unit_price`, `currency`, final `amount`.
The writer can calculate an omitted amount. **Optional Fields**: `fee`, `tax`.

**Note**: Realized gain/loss = proceeds - cost basis of sold lots.

---

#### SPLIT

**Purpose**: Stock split or reverse split adjustment.

| Impact               | Description                                    |
| -------------------- | ---------------------------------------------- |
| **Cash**             | No change                                      |
| **Holdings**         | Quantity adjusted by split ratio               |
| **Cost Basis**       | Per-share cost adjusted (total cost unchanged) |
| **Net Contribution** | No change                                      |

**Required Fields**: `asset`, `amount` (split ratio, e.g., 2 for 2:1) **Optional
Fields**: `metadata.split_ratio` (e.g., "2:1"), `quantity` (unused, use `amount`
for ratio)

**Example**: 2-for-1 split of 100 shares at $200/share

- Before: 100 shares @ $200 = $20,000 cost basis
- After: 200 shares @ $100 = $20,000 cost basis

---

### Cash Activities

#### DEPOSIT

**Purpose**: Incoming funds from outside Wealthfolio (external source).

| Impact               | Description                                           |
| -------------------- | ----------------------------------------------------- |
| **Cash**             | Increases by `amount` in activity currency            |
| **Holdings**         | N/A                                                   |
| **Cost Basis**       | N/A                                                   |
| **Net Contribution** | Increases by the pre-charge flow (amount + fee + tax) |

**Required Fields**: `amount`, `currency` **Optional Fields**: `fee`

**TWR Impact**: External flow - creates a sub-period boundary for TWR
calculation.

---

#### WITHDRAWAL

**Purpose**: Outgoing funds to an external destination.

| Impact               | Description                                           |
| -------------------- | ----------------------------------------------------- |
| **Cash**             | Decreases by `amount` in activity currency            |
| **Holdings**         | N/A                                                   |
| **Cost Basis**       | N/A                                                   |
| **Net Contribution** | Decreases by the pre-charge flow (amount - fee - tax) |

**Required Fields**: `amount`, `currency` **Optional Fields**: `fee`

**TWR Impact**: External flow - creates a sub-period boundary for TWR
calculation.

---

### Transfer Activities

Ordinary cash transfers update account-level net contribution: `TRANSFER_IN`
increases it and `TRANSFER_OUT` decreases it. A complete, recognized internal
cash FX conversion within the same account is a narrow exception:

- Source-currency cash decreases by the transferred amount.
- Destination-currency cash increases by the transferred amount.
- Account-level `net_contribution` and `net_contribution_base` do not change.
- No external portfolio flow or TWR cash-flow event is created.

This exception uses Wealthfolio's qualified FX-pair recognition. Same-account
transfers or transfers that merely share a group identifier are not
automatically contribution-neutral.

#### TRANSFER_IN

**Purpose**: Move cash or assets into this account.

| Scenario                            | Cash Impact         | Holdings Impact     | Net Contribution            |
| ----------------------------------- | ------------------- | ------------------- | --------------------------- |
| **Ordinary cash transfer**          | +amount             | N/A                 | +gross flow (account scope) |
| **Recognized same-account FX pair** | +destination amount | N/A                 | No change                   |
| **Asset transfer**                  | -fee only           | +quantity (new lot) | +cost_basis (account scope) |

**Required Fields**:

- Cash: `amount`, `currency`
- Asset: `asset`, `quantity`, `unit_price`, `currency`

**Optional Fields**: `fee`, `tax` (cash transfers), `metadata.flow.is_external`

**Flow Behavior**:

| Scope         | Ordinary internal transfer (`is_external = false`) | `is_external = true` |
| ------------- | -------------------------------------------------- | -------------------- |
| **Account**   | +net_contribution                                  | +net_contribution    |
| **Portfolio** | No external flow when paired                       | +net_contribution    |

**Use Cases**:

- Default: Transfer between Wealthfolio accounts (cost basis preserved)
- External: Adding holdings from outside the portfolio (gifts, inheritance,
  external brokerage)

---

#### TRANSFER_OUT

**Purpose**: Move cash or assets out of this account.

| Scenario                            | Cash Impact    | Holdings Impact  | Net Contribution            |
| ----------------------------------- | -------------- | ---------------- | --------------------------- |
| **Ordinary cash transfer**          | -amount        | N/A              | -gross flow (account scope) |
| **Recognized same-account FX pair** | -source amount | N/A              | No change                   |
| **Asset transfer**                  | -fee only      | -quantity (FIFO) | -cost_basis (account scope) |

**Required Fields**:

- Cash: `amount`, `currency`
- Asset: `asset`, `quantity`, `currency`

**Optional Fields**: `fee`, `tax` (cash transfers), `metadata.flow.is_external`

**Flow Behavior**: Ordinary transfers use the opposite sign from TRANSFER_IN.
Recognized same-account cash FX pairs use the contribution-neutral behavior
described above.

**Use Cases**:

- Default: Transfer between Wealthfolio accounts
- External: Removing holdings from portfolio (gifts, donations, external
  transfer)

---

### Income Activities

#### DIVIDEND

**Purpose**: Cash dividend paid into the account.

| Impact               | Description                                         |
| -------------------- | --------------------------------------------------- |
| **Cash**             | Increases by `amount` in activity currency          |
| **Holdings**         | No change (unless DRIP or DIVIDEND_IN_KIND subtype) |
| **Cost Basis**       | No change                                           |
| **Net Contribution** | No change (income, not new capital)                 |

**Required Fields**: `asset`, `amount`, `currency` **Optional Fields**: `fee`,
`quantity` (for per-share tracking)

**Subtypes**: See [Dividend Subtypes](#dividend-subtypes) section.

---

#### INTEREST

**Purpose**: Interest earned on cash or fixed-income positions.

| Impact               | Description                                |
| -------------------- | ------------------------------------------ |
| **Cash**             | Increases by `amount` in activity currency |
| **Holdings**         | No change (unless STAKING_REWARD subtype)  |
| **Cost Basis**       | No change                                  |
| **Net Contribution** | No change (income, not new capital)        |

**Required Fields**: `amount`, `currency` **Optional Fields**: `asset`, `fee`

**Subtypes**: See [Interest Subtypes](#interest-subtypes) section.

---

#### CREDIT

**Purpose**: Cash-only credit such as refunds, rebates, or bonuses.

| Impact               | Description                                |
| -------------------- | ------------------------------------------ |
| **Cash**             | Increases by `amount` in activity currency |
| **Holdings**         | N/A                                        |
| **Cost Basis**       | N/A                                        |
| **Net Contribution** | Depends on subtype (see below)             |

**Required Fields**: `amount`, `currency` **Optional Fields**: `subtype`

**Net Contribution by Subtype**:

| Subtype   | Net Contribution | Rationale                                   |
| --------- | ---------------- | ------------------------------------------- |
| `BONUS`   | +gross flow      | New capital (sign-up bonus, referral bonus) |
| `REBATE`  | No change        | Reduced trading cost, not new capital       |
| `REFUND`  | No change        | Reversal of existing fee, not new capital   |
| (default) | No change        | Internal adjustment                         |

---

### Fee & Tax Activities

#### FEE

**Purpose**: Stand-alone brokerage or platform fee not tied to a trade.

| Impact               | Description                                          |
| -------------------- | ---------------------------------------------------- |
| **Cash**             | Decreases by the saved `amount` in activity currency |
| **Holdings**         | No change                                            |
| **Cost Basis**       | No change                                            |
| **Net Contribution** | No change                                            |

**Required saved Fields**: `amount`, `currency`. A writer can fill a missing
amount from `fee`. **Optional Fields**: `asset` (for asset-specific fees)

**Common Subtypes**:

- `MANAGEMENT_FEE`: Advisory/management fee
- `ADR_FEE`: ADR custody fee
- `INTEREST_CHARGE`: Margin interest

---

#### TAX

**Purpose**: Tax paid from the account (withholding, CGT, etc.).

| Impact               | Description                                |
| -------------------- | ------------------------------------------ |
| **Cash**             | Decreases by `amount` in activity currency |
| **Holdings**         | No change                                  |
| **Cost Basis**       | No change                                  |
| **Net Contribution** | No change                                  |

**Required Fields**: `amount`, `currency` **Optional Fields**: `asset` (for
asset-specific taxes)

**Common Subtypes**:

- `WITHHOLDING`: Dividend withholding tax
- `NRA_WITHHOLDING`: Non-resident alien withholding

---

### Other Activities

#### ADJUSTMENT

**Purpose**: Non-trade correction or transformation (usually no cash movement).

| Impact               | Description         |
| -------------------- | ------------------- |
| **Cash**             | Typically no change |
| **Holdings**         | May change          |
| **Cost Basis**       | May change          |
| **Net Contribution** | No change           |

**Required Fields**: `asset`, varies by use case **Optional Fields**: `metadata`
with adjustment details

**Use Cases**:

- Option expiring worthless
- Return of capital basis adjustment
- Merger/spinoff compiler input
- Corporate action adjustments

**Note**: This is a flexible type for non-standard corrections. Specific
handling depends on the `subtype` and metadata.

---

#### UNKNOWN

**Purpose**: Unmapped or unrecognized activity type requiring user review.

| Impact  | Description                          |
| ------- | ------------------------------------ |
| **All** | No automatic impact until classified |

**Behavior**: Activities imported with unrecognized types are marked as UNKNOWN
and flagged for review (`needs_review = true`). Users should manually reclassify
using `activity_type_override` or delete these activities.

---

## Subtypes

Subtypes provide semantic variations of activity types without schema changes.
The compiler expands these into canonical activity postings.

### Dividend Subtypes

| Subtype             | Description                                                    | Expansion                   |
| ------------------- | -------------------------------------------------------------- | --------------------------- |
| `DRIP`              | Dividend Reinvestment Plan - dividend automatically reinvested | DIVIDEND + BUY              |
| `QUALIFIED`         | Qualified dividend (tax classification)                        | DIVIDEND (pass-through)     |
| `ORDINARY`          | Ordinary dividend (tax classification)                         | DIVIDEND (pass-through)     |
| `RETURN_OF_CAPITAL` | Return of capital (reduces cost basis)                         | DIVIDEND (special handling) |
| `DIVIDEND_IN_KIND`  | Dividend paid as additional units of the same asset            | DIVIDEND + BUY              |

#### DRIP Expansion

**Stored Activity**:

```json
{
  "activity_type": "DIVIDEND",
  "subtype": "DRIP",
  "asset": { "id": "AAPL" },
  "amount": 100, // dividend cash amount
  "quantity": 0.5, // shares received
  "unit_price": 200 // reinvestment price
}
```

**Compiled Postings**:

1. **DIVIDEND**: `amount = $100` (income recognition)
2. **BUY**: `quantity = 0.5, unit_price = $200, amount = $100` (share
   acquisition)

**Net Cash Effect**: $0 without a supplied FX rate (both legs use the same
currency).

---

#### DIVIDEND_IN_KIND Expansion

**Stored Activity**:

```json
{
  "activity_type": "DIVIDEND",
  "subtype": "DIVIDEND_IN_KIND",
  "asset": { "id": "AAPL" },
  "amount": 250,
  "quantity": 10, // shares received
  "unit_price": 25 // FMV at receipt
}
```

**Compiled Postings**:

1. **DIVIDEND**: `amount = $250` (income recognition)
2. **BUY**: `asset = AAPL, quantity = 10, unit_price = $25, amount = $250`
   (share acquisition)

---

### Interest Subtypes

| Subtype            | Description                              | Expansion               |
| ------------------ | ---------------------------------------- | ----------------------- |
| `STAKING_REWARD`   | Crypto staking reward received as tokens | INTEREST + BUY          |
| `LENDING_INTEREST` | Interest from securities lending         | INTEREST (pass-through) |
| `COUPON`           | Bond coupon payment                      | INTEREST (pass-through) |

#### STAKING_REWARD Expansion

**Stored Activity**:

```json
{
  "activity_type": "INTEREST",
  "subtype": "STAKING_REWARD",
  "asset": { "id": "ETH" },
  "quantity": 0.01, // ETH received
  "unit_price": 2000, // FMV at receipt
  "amount": 20 // value = 0.01 * 2000
}
```

**Compiled Postings**:

1. **INTEREST**: `amount = $20` (income recognition)
2. **BUY**: `quantity = 0.01, unit_price = $2000, amount = $20` (token
   acquisition)

**Net Cash Effect**: $0 without a supplied FX rate (both legs use the same
currency).

---

### Credit Subtypes

| Subtype  | Description                                  | Net Contribution          |
| -------- | -------------------------------------------- | ------------------------- |
| `BONUS`  | Sign-up/referral/promotional bonus           | External flow (+)         |
| `REBATE` | Trading rebate (maker rebate, volume rebate) | Internal flow (no change) |
| `REFUND` | Fee correction/reversal                      | Internal flow (no change) |

---

## Metadata Structure

Activities support a `metadata` JSON field for additional context:

```json
{
  "flow": {
    "is_external": true
  },
  "split_ratio": "2:1",
  "source": {
    "broker": "Schwab",
    "original_type": "REI"
  }
}
```

### Key Metadata Fields

| Field                  | Type    | Used By         | Description                                   |
| ---------------------- | ------- | --------------- | --------------------------------------------- |
| `flow.is_external`     | boolean | TRANSFER_IN/OUT | Marks transfer as crossing portfolio boundary |
| `split_ratio`          | string  | SPLIT           | Human-readable split ratio (e.g., "2:1")      |
| `source.broker`        | string  | All             | Original broker name                          |
| `source.original_type` | string  | All             | Raw activity type from provider               |

---

## Activity Status

Each activity has a status that controls whether it affects calculations:

| Status    | Description                           | Affects Calculations |
| --------- | ------------------------------------- | -------------------- |
| `POSTED`  | Finalized activity                    | Yes                  |
| `PENDING` | Awaiting settlement or confirmation   | No                   |
| `DRAFT`   | User-created draft, not yet finalized | No                   |
| `VOID`    | Cancelled or reversed (soft delete)   | No                   |

**Note**: Only `POSTED` activities are compiled and processed by the holdings
calculator.

---

## Activity Type Override

Users can override the activity type using `activity_type_override` without
modifying the original `activity_type`. This is useful for:

- Correcting misclassified imports
- Mapping `UNKNOWN` types to canonical types
- Preserving original provider classification while using correct semantics

The `effective_type()` method returns the override if set, otherwise the
original type.

---

## Activity Type Groups

### Trading Types

```
BUY, SELL, SPLIT
```

### Income Types

```
DIVIDEND, INTEREST
```

### Cash-Only Types (never have an asset)

```
DEPOSIT, WITHDRAWAL, FEE, TAX, CREDIT
```

**Note**: TRANSFER_IN/TRANSFER_OUT can be cash OR asset depending on whether an
asset is linked. INTEREST can have an optional asset (e.g., bond interest).

---

## Form Field Requirements

Trade entry can calculate an omitted final amount before saving. Cash and income
amounts are final, including any charges. Asset-income subtypes also use
quantity and price. These entry requirements do not imply runtime fallback
calculations.

| Type             | Required Fields                                              |
| ---------------- | ------------------------------------------------------------ |
| **BUY**          | Asset, Quantity, Unit Price, Currency                        |
| **SELL**         | Asset, Quantity, Unit Price, Currency                        |
| **DIVIDEND**     | Asset, Amount, Currency                                      |
| **INTEREST**     | Amount, Currency                                             |
| **DEPOSIT**      | Amount, Currency                                             |
| **WITHDRAWAL**   | Amount, Currency                                             |
| **TRANSFER_IN**  | Amount (cash) or Asset+Quantity+Unit Price (asset), Currency |
| **TRANSFER_OUT** | Amount (cash) or Asset+Quantity (asset), Currency            |
| **FEE**          | Amount or Fee, Currency                                      |
| **TAX**          | Amount, Currency                                             |
| **SPLIT**        | Asset, Amount (split ratio)                                  |
| **CREDIT**       | Amount, Currency                                             |
| **ADJUSTMENT**   | Varies                                                       |

---

## Workflow Recommendations

### Simple (Holdings-Only)

For quick onboarding when only tracking portfolio value:

1. Use `TRANSFER_IN` with `is_external = true` to add existing positions
2. Use `DEPOSIT` to set initial cash balance
3. Adjust as needed with `TRANSFER_IN/OUT`

### Full (Transaction-Level)

For precise IRR, cash-flow, and tax analytics:

1. Seed account with `DEPOSIT`
2. Record every `BUY`, `SELL`, `DIVIDEND`, `INTEREST`
3. Use `TRANSFER_IN/OUT` for inter-account moves (default internal)
4. Use `TRANSFER_IN/OUT` with `is_external = true` for external moves
5. Log expenses via `FEE` and `TAX`

---

## Best Practices

1. **Use DEPOSIT/WITHDRAWAL for external cash flows** - These properly track net
   contributions for performance calculations.

2. **Use TRANSFER_IN/OUT for inter-account moves** - Default behavior preserves
   cost basis and nets to zero at portfolio level.

3. **Mark external transfers explicitly** - Set
   `metadata.flow.is_external = true` when crossing portfolio boundary.

4. **Use subtypes for semantic variations** - Instead of custom types, use
   subtypes (e.g., DIVIDEND with subtype DRIP).

5. **Include charges in the final amount** - Record fee and tax details too, but
   never deduct them again or duplicate them as standalone activities.

6. **Set currency explicitly** - Always specify the activity currency for proper
   multi-currency handling.

7. **Use activity_type_override for corrections** - Preserves original
   classification for audit purposes.
