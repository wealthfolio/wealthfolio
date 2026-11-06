# Tax-Aware Rebalancing via Addon-Provided Policy

> **Status:** Draft for discussion. Addendum to the
> [SOTA Target Model Spec](./sota-target-model-spec.md), Phase 4 (Tax-Aware
> Planning) + Phase 5 (Addons). **Audience:** maintainers (architecture
> decision) and third-party addon authors (integration contract).

## 1. Purpose

Let country-specific and jurisdiction-specific tax rules influence the core
rebalance engine, **without** those rules living in core and **without** addons
writing into core.

The trigger was [PR #1263](https://github.com/wealthfolio/wealthfolio/pull/1263)
("wealthfolio-rebalancer"): a contributor built a Spain-specific transfer mode
(fund-to-fund _traspaso_, tax-exempt) directly in core, because the addon had no
way to read the user's configured allocation targets and no way to feed
jurisdiction rules back into the core rebalancer. That direction was rejected
per the product line in
[#1070](https://github.com/wealthfolio/wealthfolio/pull/1070): **keep core
rebalancing smart, explainable, and simple; push niche/jurisdiction-specific
behavior to addons.**

This document proposes how to do that cleanly.

## 2. Non-goals

- **Not a second rebalancer.** Addons do not compute plans. Core stays the only
  rebalance engine.
- **No addon writes to core.** Nothing the addon produces is persisted in core.
  Everything is transient input to a single calculation.
- **No core→addon callback.** Core (Rust) cannot synchronously call a sandboxed
  JS addon mid-computation, and we do not add such a mechanism. All calls remain
  addon→core via `invoke`. See §6 for how "core reads the addon" is actually
  realized.

## 3. What SOTA already provides

The north-star model already anticipated tax-aware rebalancing. The pieces
exist:

- **`ExecutionPolicy`** (§5.7) already carries:
  `tax_mode: ignore | aware | strict`,
  `lot_selection: fifo | lifo | hifo | loss_first | long_term_first`,
  `wash_sale_check`, `max_realized_gain`, `asset_location`, `blocked_asset_ids`.
- **Trade Candidate Selection** (§6.6) already has the hooks: sort sell
  candidates "loss-first / long-term-first / highest cost basis first"; respect
  "max realized gain, wash-sale, do-not-trade".
- **`TradeDraft`** (§5.9) carries `tax_lot_ids`, `estimated_gain`,
  `wash_sale_warning`. Its `action` is `buy | sell` only — no `swap`/`transfer`.
- **Phase 4** was gated on data: "ship when tax lots, cost basis by lot, ST/LT
  gain estimate exist." That data now exists (§9).
- **Phase 5** explicitly plans "Addon SDK APIs for allocation targets and
  advisor state" and "addon-provided funding policies."

**This proposal is Phase 4 + Phase 5 combined:** the addon becomes the
_jurisdiction tax provider_ that fills the one gap SOTA left open — the
country-specific meaning of "taxable", "exempt", "deferred", "wash sale" — and
feeds the tax-aware candidate selection core already designed. It is not
parallel machinery.

## 4. Core idea

```
The core owns the rebalance math and the tax-aware selection logic.
The addon owns the jurisdiction rules that parameterize that logic.
```

Concretely, the addon answers questions core cannot answer generically:

- Which accounts are taxable vs tax-deferred vs tax-exempt?
- What capital-gains rate / holding-period threshold applies?
- Which holdings can be swapped tax-free (traspaso, in-kind transfer, wrapper
  reallocation)?
- What counts as a wash sale in this jurisdiction?

Core takes those answers and does everything else: enumerate candidates, compute
realized gains per lot, rank, respect caps, produce explainable trade drafts.

## 5. Architecture: two bricks

### Brick A — read-only context (addon reads core)

An addon-SDK read-only surface so the addon can present the user's real
accounts, assets, and (optionally) allocation targets in its own configuration
UI.

The **size** of this surface depends on the α/β decision in §7:

- Under **β (recommended)**: minimal — list accounts and list assets/holdings by
  identity only, so the user can tag them ("this account is a PEA", "these two
  funds are traspaso-eligible"). **No cost basis, no lots, no drift leaves
  core.**
- Under **α**: full — holdings with lots, cost basis, unrealized gain, and the
  drift report, because the addon computes tax numbers itself.

Either way, this is the read-only allocation-targets API originally scoped (list
targets, weights, constraints, drift) plus accounts/holdings identity, wired
into the SDK exactly like the existing `snapshots` namespace (commit
`e7381ad7a`).

> The maintainer has endorsed exposing target allocations read-only via the
> addon API ([#1263](https://github.com/wealthfolio/wealthfolio/pull/1263)) and
> is building an improved addon system from a security standpoint. Brick A
> should land **through** that new addon-security layer, not front-run it — this
> doc assumes Brick A rides that work rather than defining a parallel surface.

### Brick B — transient tax-policy injection (core reads addon)

At rebalance time, the active tax addon(s) hand core a **TaxPolicy** object.
Core feeds it into `calculate_rebalance_plan` as transient input (not persisted)
and returns a tax-aware plan.

> **Fork to resolve (see §14):** eligibility (which account is a wrapper, which
> instruments are transfer-eligible) can reach core two ways: (1) a **persisted
> tag** on Account/Instrument that core reads at plan time — the approach
> proposed in [#1263](https://github.com/wealthfolio/wealthfolio/pull/1263),
> extending the #1177 constraint model with a `tax_wrapper_type` /
> `transfer_eligible` tag; or (2) this **transient TaxPolicy** supplied by the
> addon, nothing persisted. They are complementary: (1) works with no addon
> installed and is a plain write-path the core UI can own; (2) is the
> addon-driven, non-persisted version. This doc specifies (2); a hybrid is
> viable (addon writes the tag via a normal write API, core reads it later — but
> that is a **write path**, out of scope for the read-only brick).

This is the heart of the feature. Its exact shape depends on α vs β.

## 6. How "core reads the addon" is realized

There is no Rust→JS callback. The flow is a single frontend-orchestrated
round-trip, and every _call_ is still addon→core:

```
1. User opens the rebalance screen (CORE UI).
2. Core UI collects the active tax addon(s) for the current scope.
3. Each addon returns its TaxPolicy (β) or TaxOverlay (α).       [addon → core: read context if needed]
4. Core UI merges them and calls:
        calculate_rebalance_plan(target, cash, mode, taxPolicy)  [addon → core: invoke]
5. Core rebalance engine consumes the policy (transient) and     [core computes]
   returns a tax-aware plan with explanations.                   [core → addon: return value]
```

Core "reads" the addon in the sense that it **receives the addon's policy as a
parameter**. Nothing is persisted, nothing calls back into JS. This satisfies
"back-and-forth, but the addon never writes to core."

The **core rebalance screen is the orchestrator**; addons are passive providers
that implement one function (§8). This keeps a single rebalance entry point and
matches "core stays the brain."

## 7. Key decision: α (addon computes values) vs β (addon supplies rules)

This is the central architectural fork and should be decided first, because α
and β produce entirely different contracts.

### α — Addon computes the tax values

The addon enumerates candidate actions from live holdings, attaches computed
taxable-gain amounts per holding/lot, and returns a numbers-only overlay. Core
consumes the numbers as opaque costs.

- **+** Maximum flexibility for exotic jurisdictions core could never model.
- **−** Core becomes a passive consumer of opaque numbers → weaker
  explainability, harder to audit, requires trusting addon math.
- **−** Requires exposing sensitive data (cost basis, lots, gains, drift) to the
  addon (larger Brick A).

### β — Addon supplies declarative rules, core computes (recommended)

The addon returns a declarative **TaxPolicy** (account tax characters, gains
rate + holding-period threshold, transfer-equivalence classes, wash-sale
window). Core applies these rules to its own lots during candidate selection
(§6.6) and computes the actual realized gains.

- **+** Core stays deterministic, explainable, and auditable (SOTA principle #6,
  direction #1070). The tax math lives in one place.
- **+** **Privacy/security win:** cost basis, gains, and lot detail never leave
  core. The addon only sees account/asset **identities** so the user can tag
  them. Brick A shrinks dramatically.
- **+** Decoupled: the rules are largely static user config set once in the
  addon UI; the policy can be queried at rebalance time with little or no live
  context.
- **−** Needs a well-defined rule vocabulary (§8); less flexible for
  jurisdictions that do not fit the vocabulary.

**Recommendation: β**, with a narrow α-style escape hatch (an addon may override
a specific computed value with an attached `reason`, surfaced in the
explanation). This keeps core in control by default while leaving room for
genuinely exotic rules.

> The rest of this document specifies the β contract. If the maintainer prefers
> α, the contract changes to a numbers overlay and Brick A must expose lots and
> cost basis.

## 8. The β contract

### 8.1 Addon interface

```ts
// Implemented by every jurisdiction tax addon.
// Called by the core rebalance orchestrator at plan time.
export interface TaxPolicyProvider {
  /**
   * Return the declarative tax rules this addon governs.
   * `ctx` is minimal under β: the accounts and assets in scope, by identity,
   * so the addon can map its stored user config onto real ids.
   */
  computeTaxPolicy(ctx: TaxPolicyContext): TaxPolicy | Promise<TaxPolicy>;
}

export interface TaxPolicyContext {
  baseCurrency: string;
  accountIds: string[];
  assetIds: string[];
  // No holdings values, no lots, no cost basis under β.
}
```

### 8.2 TaxPolicy shape (β)

```ts
export interface TaxPolicy {
  /** Which addon produced this, for merge/attribution and explanations. */
  providerId: string;

  /** Accounts this policy governs (ownership scope for multi-addon merge). */
  governedAccountIds: string[];

  /** Per-account tax character. Sells in exempt/deferred accounts realize no
   *  taxable gain. */
  accountTaxCharacter: Record<
    string,
    "taxable" | "tax_deferred" | "tax_exempt"
  >;

  /** Capital-gains parameters core uses to compute estimated_gain per lot. */
  capitalGains?: {
    /** Rate applied to a realized long-term gain, in bps. */
    longTermRateBps: number;
    /** Rate applied to a realized short-term gain, in bps. */
    shortTermRateBps: number;
    /** Holding period (months) at/after which a gain is long-term. */
    longTermThresholdMonths: number;
  };

  /** Sets of assets/holdings that can be exchanged with no realized gain
   *  (traspaso, in-kind transfer, wrapper reallocation). A sell inside a class
   *  matched by a buy inside the same class is emitted as a linked, tax-deferred
   *  pair. */
  transferClasses?: Array<{
    id: string;
    /** Assets that are mutually fungible for tax purposes. */
    assetIds: string[];
    /** Optional: restrict the class to a single account/wrapper. */
    accountId?: string;
    reason: string; // e.g. "ES traspaso between accumulating funds"
  }>;

  /** Optional wash-sale rule core enforces using its own lot/activity history. */
  washSale?: { windowDays: number };

  /** Optional escape hatch (α inside β): override a specific computed value. */
  overrides?: Array<{
    subject: { holdingId?: string; lotId?: string; assetId?: string };
    estimatedGainOverride?: string; // decimal
    reason: string;
  }>;
}
```

Everything here is a **rule or parameter**, not a computed cost. Core owns the
computation.

### 8.3 What core does with it

Extends §6.6 candidate selection:

1. When sizing/ranking sell candidates, compute `estimated_gain` per lot from
   the lot's cost basis + acquisition date + current price + `capitalGains`
   rules, scaled by the account's `accountTaxCharacter` (exempt/deferred → 0).
2. Before proposing a plain sell to fund an underweight sleeve, check
   `transferClasses`: if the overweight holding and an underweight sleeve buy
   candidate share a class, emit a **linked sell+buy pair** (see §9) marked
   tax-deferred instead of a taxable sell.
3. Apply `washSale` and existing `max_realized_gain` / do-not-trade constraints.
4. Attach the applied rule and its `reason` to each `TradeDraft.reason` / run
   explanation.

### 8.4 The "Transfer" presentation is gated on eligibility

A linked pair may be **presented** as a single tax-free "Transfer" **only** when
core has positive eligibility evidence for that exact account/instrument combo:
either shared `transferClasses` membership (instrument-level, e.g. Spanish
funds) or a wrapper-level `accountTaxCharacter` that permits internal
reallocation (account-level, e.g. a PEA swap). **Absent that evidence, the two
trades must stay a plain "Sell + Buy".**

This is deliberate. A "Transfer" label is a tax-adjacent claim ("tax-neutral
movement, not two taxable events"). It is false for many pairs — e.g. a French
CTO (_compte-titres ordinaire_) supports no direct holding-to-holding transfer
at all: every sell is a taxable event forced through cash. Showing such a pair
as "Transfer" would misrepresent it. Eligibility is therefore evaluated per pair
at plan time, never assumed from the presence of a sell+buy pair. (This
addresses the concern raised in
[#1263](https://github.com/wealthfolio/wealthfolio/pull/1263).) Per SOTA §7.5,
"Transfer" is a trade-grouping label, **not** a new `ScenarioMode`.

## 9. Worked examples

Three unrelated tax regimes, expressed with the **same five `TaxPolicy` fields**
— no per-country code in core. Each example exercises a different part of the
vocabulary, which is the point: it demonstrates the model generalizes.

> Note on `accountTaxCharacter`: it describes the tax treatment of an **internal
> rebalancing sell right now**, not withdrawal taxation (out of scope for
> rebalancing). Both `tax_deferred` and `tax_exempt` mean "an internal sell
> realizes no taxable gain today"; they differ only for later withdrawal/asset-
> location logic.

### 9.1 Spain — traspaso (transfer-equivalence class)

**What it is.** In Spain, moving money from one accumulating investment fund to
another via a _traspaso_ defers the capital-gains tax entirely — the gain is not
realized on transfer, even in an ordinary taxable account. A plain sell of the
same fund, by contrast, realizes a ~19–26% capital-gains tax.

**Exercises:** `transferClasses` (tax-free swap between specific funds).

Addon config (set once in the addon UI):

```
accountTaxCharacter: { "acc-es-cto": "taxable" }
capitalGains: { longTermRateBps: 1900, shortTermRateBps: 1900, longTermThresholdMonths: 0 }
transferClasses: [{ id: "es-traspaso", assetIds: ["fund-A", "fund-B"], accountId: "acc-es-cto",
                    reason: "ES traspaso between accumulating funds" }]
```

Drift says: reduce sleeve of A by €5,000, increase sleeve of B by €5,000.

1. Without the policy: sell €5,000 of A → realize gain → 19% tax; then buy B.
2. With the policy: A and B share `es-traspaso` → core emits a **linked pair**:
   - `TradeDraft{ action: sell, asset: fund-A, estimated_gain reflects 0 tax, transfer_group_id: "g1" }`
   - `TradeDraft{ action: buy, asset: fund-B, transfer_group_id: "g1" }`
   - reason: "Traspaso: tax-free transfer A→B (ES)".
3. The plan prefers this over any taxable sell because its tax cost is 0.

No `swap` action: the `buy | sell` primitive is preserved; tax-free semantics
come from the deferred `estimated_gain` plus a `transfer_group_id` grouping the
two drafts for explainability.

### 9.2 United States — taxable brokerage + IRA/Roth (per-lot gains, wash-sale)

**What it is.** In the US there is no tax-free fund transfer. Instead:

- A **taxable brokerage** sell realizes a capital gain taxed by **holding
  period**: held **> 12 months** = long-term (0/15/20%); held **≤ 12 months** =
  short-term (ordinary income rate, higher). So core should prefer selling
  **long-term lots** and prefer selling **loss lots** (tax-loss harvesting).
- The **wash-sale rule** disallows the loss if a substantially identical asset
  is bought within **30 days** before/after the sale.
- A **Traditional 401(k)/IRA** is **tax-deferred**; a **Roth IRA** is
  **tax-exempt**. Trades inside either realize **no** taxable gain today, so
  core can rebalance freely there.

**Exercises:** `capitalGains` (ST/LT split), `washSale`, and
`accountTaxCharacter` (deferred/exempt vs taxable). Plus the user's
`lot_selection` in `ExecutionPolicy` (`long_term_first`, `loss_first`).

Addon config:

```
accountTaxCharacter: {
  "acc-brokerage": "taxable",
  "acc-401k":      "tax_deferred",
  "acc-roth":      "tax_exempt"
}
capitalGains: { longTermRateBps: 1500, shortTermRateBps: 3200, longTermThresholdMonths: 12 }
washSale: { windowDays: 30 }
```

Drift says: reduce US equities by \$10,000.

1. Core enumerates sell candidates across accounts. For each **lot** it computes
   `estimated_gain` from `Lot.cost_basis` + `Lot.acquisition_date` + price, then
   the tax from `capitalGains` scaled by the account character:
   - a lot in **acc-roth / acc-401k** → tax 0 (character exempt/deferred);
   - a **long-term** lot in the brokerage → 15%;
   - a **short-term** lot in the brokerage → 32%;
   - a **loss** lot in the brokerage → negative tax (harvest → preferred).
2. With `lot_selection: loss_first, long_term_first`, core drains the Roth/401k
   and loss/long-term brokerage lots before touching short-term gains.
3. `washSale` blocks (or warns on) any harvested-loss sell that would be undone
   by a buy of the same asset within 30 days; core sets `wash_sale_warning`.
4. Result: same \$10,000 drift correction, minimum realized tax, each draft
   labeled with the applied rule ("long-term lot, 15%", "tax-deferred account,
   no tax", "harvested loss").

Here **no transfer class** applies — the whole benefit comes from per-lot gain
math + account character + lot ordering, all core-side from addon-supplied
rules.

### 9.3 France — PEA vs CTO (account-level wrapper)

**What it is.** The **PEA** (_Plan d'Épargne en Actions_) is a tax wrapper:
gains on trades **inside** the envelope are **not taxed as long as nothing is
withdrawn** — you can buy/sell/rebalance freely with no taxable event. (After 5
years, withdrawals are exempt from income tax; social contributions ~17.2% still
apply — but that is withdrawal, out of rebalance scope.) A **CTO**
(_compte-titres ordinaire_, ordinary brokerage) instead realizes gains on every
sell, taxed at the **flat PFU of 30%** (12.8% income + 17.2% social).

**Exercises:** `accountTaxCharacter` at the **wrapper level** — the dominant
lever here is which account you trade in, not which lot.

Addon config:

```
accountTaxCharacter: { "acc-pea": "tax_exempt", "acc-cto": "taxable" }
capitalGains: { longTermRateBps: 3000, shortTermRateBps: 3000, longTermThresholdMonths: 0 }
```

(France's PFU is flat, so ST and LT rates are equal and the holding-period
threshold is irrelevant.)

Drift says: reduce French equities by €8,000; the user holds the same sleeve in
both the PEA and the CTO.

1. Core computes the sell tax per account: inside the **PEA** → 0 (character
   exempt); inside the **CTO** → 30% of the realized gain.
2. `tax_mode: aware` makes core prefer sourcing the €8,000 from the **PEA**,
   leaving CTO gains unrealized.
3. If the PEA cannot supply the full amount, core sells the remainder from the
   CTO and labels those drafts "CTO sell, 30% PFU on €X gain" so the user sees
   the tax cost explicitly.

The benefit is driven entirely by `accountTaxCharacter`; no transfer class, no
lot subtlety needed.

### 9.4 United Kingdom — ISA + annual CGT allowance (the limit case)

This example is included deliberately because it **does not fully fit the five
fields** — it shows where the vocabulary needs to grow, and how the escape hatch
absorbs the gap until it does.

**What it is.** Two parts:

- An **ISA** (_Individual Savings Account_) is a tax-exempt wrapper — trades and
  gains inside are never taxed. This part fits:
  `accountTaxCharacter: "tax_exempt"`, same as a Roth or PEA.
- Outside an ISA, the UK grants an **annual capital-gains allowance** (£3,000/
  year as of 2024): the first £3,000 of _net_ realized gains across the tax year
  is tax-free; only the excess is taxed. This part **does not fit**: it is not a
  per-lot rate or a per-account character — it is a **running annual budget**
  that depends on gains already realized **elsewhere and earlier in the year**,
  which core does not track.

**Why it breaks the model.** The tax cost of a candidate sell is no longer a
pure function of that lot (rate × gain). It depends on how much allowance
remains, which depends on prior realizations in the same tax year — state that
lives outside a single rebalance run. `capitalGains` as specified has no notion
of a consumable yearly exemption.

**How we handle it, honestly:**

1. **Short term (no vocabulary change):** the ISA part works today via
   `accountTaxCharacter`. For the allowance, the addon uses the **`overrides`
   escape hatch** (§8.2): having its own record of gains realized so far this
   year, it can zero out the `estimated_gain` on candidate sells up to the
   remaining allowance, each with a `reason` ("within £3,000 annual CGT
   allowance"). Core stays deterministic on everything else; the one
   allowance-dependent value is supplied by the addon that actually knows the
   year-to-date state.
2. **Long term (vocabulary growth):** if allowances prove common (UK, Germany's
   Sparer-Pauschbetrag, etc.), add a first-class
   `annualExemption { remaining, currency, resetsOn }` field so core can reason
   about it directly instead of via overrides.

The takeaway for the contract: the five fields cover the **stateless** majority
of tax rules; **stateful/period-based** rules (annual allowances, YTD caps) are
the known frontier, handled by the escape hatch now and a targeted field later.
This is exactly the kind of boundary worth agreeing on with the maintainer
before freezing the contract.

### 9.5 Same vocabulary, four regimes

| Jurisdiction     | Mechanic                           | `TaxPolicy` fields used                                       | Core path                          |
| ---------------- | ---------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Spain traspaso   | tax-free fund-to-fund transfer     | `transferClasses`                                             | linked tax-deferred pair (§9.1)    |
| US brokerage     | ST/LT gains, harvest, wash-sale    | `capitalGains`, `washSale`, `accountTaxCharacter`             | per-lot gain + lot ordering (§9.2) |
| France PEA / CTO | wrapper-level exempt vs flat 30%   | `accountTaxCharacter` (+ flat `capitalGains`)                 | per-account gain, source routing   |
| UK ISA + CGT     | exempt wrapper + **annual budget** | `accountTaxCharacter`, `overrides` → future `annualExemption` | per-account + escape hatch (§9.4)  |

No branch in core says "Spain", "US", "France", or "UK". The first three regimes
fit the five stateless fields; the UK allowance is the honest edge — covered by
the escape hatch now, a candidate for one new field later.

## 10. What changes, where

| Layer                         | Change                                                                 | Size      |
| ----------------------------- | ---------------------------------------------------------------------- | --------- |
| Core `ExecutionPolicy`        | already has `tax_mode`, `lot_selection`, etc. — wire them              | small     |
| Core candidate selection §6.6 | consume `TaxPolicy`: per-lot gain, transfer classes, wash-sale         | medium    |
| Core `TradeDraft`             | add `transfer_group_id` (grouping only, no new action)                 | small     |
| Core rebalance input          | accept transient `TaxPolicy` param (not persisted)                     | small     |
| SDK Brick A                   | read-only accounts/assets identity (β) or full holdings+lots+drift (α) | small (β) |
| SDK Brick B                   | `TaxPolicyProvider` interface + `TaxPolicy` types                      | small     |
| Frontend orchestration        | core rebalance screen collects/merges active addons                    | medium    |
| Addon template                | scaffold implementing `computeTaxPolicy`                               | small     |

No new persisted entity. No `swap` action. No core→addon callback.

## 11. Multiple addons

One addon per jurisdiction is expected. Because a `TaxPolicy` declares its
`governedAccountIds`, overlays are **partitioned by account ownership** and
normally disjoint (a user's Spanish accounts vs their French PEA). Core routes
each account to its governing addon; no global priority needed when scopes are
disjoint.

Conflict (two addons claim the same account) is rare. Fallback: most-restrictive
wins for constraints; manifest order or a user setting otherwise. Not to be
over-engineered now; v1 may assume disjoint scopes or a single active addon.

## 12. Data availability (Phase 4 prerequisite — met)

Verified present in core today:

- `Holding.cost_basis`, `Holding.unrealized_gain` (already computed),
  `Holding.lots`.
- `Lot.acquisition_date`, `Lot.cost_basis`, `Lot.acquisition_price`,
  `Lot.acquisition_fees`, `Lot.quantity`.

This is exactly the "tax lots + cost basis by lot + ST/LT gain" data Phase 4 was
gated on. Under β this stays internal to core (used for computation); under α it
would have to be exposed through Brick A.

## 13. Constraints preserved

- Read-only for the addon's view of core; the only thing the addon "sends" is a
  transient policy consumed by one calculation.
- Nothing persisted in core by the addon.
- All calls addon→core via `invoke`; no callback.
- Core remains the single, explainable rebalance engine.

## 14. Open decisions for maintainer

1. **α vs β.** Recommendation: β (rules; core computes) with a narrow override
   escape hatch. Confirm, or prefer α (numbers overlay)?
2. **`transfer_group_id` on `TradeDraft`** to represent tax-free transfers as
   linked buy/sell pairs — acceptable, or is a first-class `transfer` action
   preferred despite the larger surface?
3. **Rule vocabulary scope for v1.** Minimum viable = `accountTaxCharacter` +
   `capitalGains` + `transferClasses`. Defer `washSale`, asset-location, loss
   harvesting to later?
4. **`tax_mode` UX.** Expose `ignore | aware | strict` per-target (consistent
   with ExecutionPolicy) — confirm placement.
5. **Multi-addon merge.** v1 = assume disjoint scopes / single active addon, or
   design the merge now?
6. **Addon template/versioning.** Where does the scaffold live, and how is the
   `TaxPolicy` contract versioned as jurisdictions expand?
7. **Eligibility source: persisted tag vs transient policy.** #1263 proposed a
   persisted `tax_wrapper_type` / `transfer_eligible` tag on Account/Instrument
   (write path, core reads at plan time); this doc proposes a transient
   addon-supplied `TaxPolicy` (no persistence). Pick one, or a hybrid (addon
   writes the tag via a normal write API). Note the persisted-tag route needs a
   write path and is therefore a separate axis from the read-only Brick A.
8. **Stateful/period-based rules.** Annual allowances (UK CGT £3,000, DE
   Sparer-Pauschbetrag) depend on year-to-date realizations core does not track
   (§9.4). Accept the `overrides` escape hatch for v1, or add a first-class
   `annualExemption` field now?

## 15. Suggested phasing

- **P0 (this doc):** agree α/β and the contract shape with the maintainer.
- **P1:** Brick A read-only SDK surface (already scoped) + `TaxPolicyProvider`
  interface + types. No core math yet.
- **P2:** Core consumes `accountTaxCharacter` + `capitalGains` in §6.6 (per-lot
  gain, `tax_mode: aware`). Explanations. **Validated by the France PEA/CTO
  (§9.3) and US brokerage (§9.2) cases** — both need only P2.
- **P3:** `transferClasses` → linked tax-deferred pairs. **Validated by the
  Spain traspaso case (§9.1)**; reference Spain addon as the first template.
- **P4:** wash-sale (US, §9.2), loss harvesting, multi-addon merge.

## 16. References

- [SOTA Target Model Spec](./sota-target-model-spec.md) — §4.4, §5.7, §6.6,
  Phases 4–5.
- [Rebalance Algorithm](./rebalance-algorithm.md).
- PR #1263 (traspaso trigger), PR #1070 (product direction), PR #1177 (generic
  constraints), commit `e7381ad7a` (SDK namespace precedent).
