# Wealthfolio Tax Engine — Composable Rule Architecture

Status: design proposal — not yet implemented. Companion to
`data_model.md` §5 (JS rules engine) — that doc establishes *that* a JS
engine exists; this doc fleshes out *how* rules are structured and
composed. Posted for upstream and community feedback before any code
work begins.

## 1. Core idea

A user's tax outcome is the composition of many small, independent rules —
not the execution of one giant program. Different filers need different
subsets:

- A US-CA Roth holder evaluating a dividend needs ~3 rules (wrapper
  short-circuit → exempt, done).
- A US-NY filer with a CA muni and a German ADR needs ~8 (character,
  fed muni rule, state muni mismatch, treaty WHT, FTC accrual, …).
- A CH filer needs none of the US logic.

A monolithic `us-tax-rules.js` would force every user to load (and trust)
the entire US tax code even when they only care about dividend
qualification. Instead, ship many small **rule packs** and let the filer
profile select which ones run.

This is **not** an attempt to mimic the IRC, the LIR, or any complete tax
code. It's a framework for stitching together a few common rules with
clear composition semantics, with the user able to inspect, edit, and
extend the active rule chain.

## 2. Goals and non-goals

The product framing is **decision-support estimation**, not tax
preparation. Concrete use case: a user holding a position with a $5k
short-term gain wants to rotate into a faster-appreciating asset. They
need a rough answer to "if I sell today, what's the tax bite?" — close
enough to decide between selling now or waiting 40 days for LT
treatment. Order-of-magnitude correctness is what matters; line-by-line
filing accuracy is not. The user is expected to consult an accountant
or filing software for actual returns.

This framing has design consequences:
- Effective-rate config can be approximate (single LT rate, not the
  0/15/20 bracket lookup); the user can override with their own bracket.
- Edge cases (AMT, NIIT, K-1) can be opt-in modifiers, not silent
  defaults — when they don't apply, omitting them is the right answer.
- Reasons (`treatment.reasons`) matter as much as numbers. The user
  should be able to read "$1,500 LT cap gain at 15% (US fed) + $232 NY
  ordinary stacked = ~$1,732" and judge whether it's reasonable.
- Speed beats precision. A planner that can re-evaluate the whole
  portfolio in a few seconds when the user toys with "what if I sell X"
  is more useful than one that takes 30 seconds to be filing-accurate.

**Goals**
- Composable: each pack ~20–100 lines of JS, single concern.
- Profile-driven: user declares jurisdictions and wrappers; engine
  derives the active rule chain.
- Inspectable: user can view the chain and the effective combined JS.
- Forkable: user can copy any pack, edit, save as custom; custom
  overrides built-in.
- Conservative initial scope: ship ~10 seed packs covering common US +
  CA filers with taxable, Roth, and traditional accounts.
- Estimation-grade output: "rotate this position now or wait 40 days?"
  is the canonical use case.
- Speed for interactive use: re-evaluate "what if I sell X" in
  milliseconds.

**Non-goals (explicit, since the cost of trying is exponential):**

*Output and certification:*
- Replicating any country's full tax code.
- Replacing TurboTax / WealthSimple Tax / an accountant.
- Computing filing-ready numbers. Output is always "estimated" with a
  banner pointing to a real tax professional for filing.
- Certification under any tax authority's filing standards.
- Generating tax forms (1099, T5, P60, Modelo 100, etc.).

*Bracket and threshold precision:*
- Exact bracket lookups for progressive rates (0/15/20% LTCG, ordinary
  income brackets, etc.). v1 uses single configurable rates with
  user override.
- AMT computation with phase-outs and AMTI.
- NIIT applied with MAGI-threshold logic. v1 applies the surcharge
  flat or skips it; doesn't compute the threshold-crossing math.
- Additional Medicare tax thresholds.
- SALT-cap interactions on US itemized returns.
- Multi-state apportionment for users with income sourced to several
  states.
- State-by-state phase-outs of preferential rates (HI, ND, etc.).
- Quebec abatement edge cases beyond the flat 16.5%.

*Cross-event accounting:*
- US wash-sale enforcement across accounts or across years (v1 may flag
  same-account/same-year violations only).
- Canadian superficial-loss rule equivalent.
- Loss carryforward / carryback across multiple tax years (year-level
  packs may track within-year offsets but not multi-year state).
- Italian 4-year same-category-only loss-offset accounting.
- UK bed-and-breakfasting matching (the 30-day repurchase rule).

*Pass-through and complex instruments:*
- K-1 pass-through income decomposition (partnership / S-corp / trust
  K-1 lines).
- PFIC mark-to-market or QEF election mechanics.
- Section 1256 60/40 contracts (futures, broad-based index options).
- Foreign earned income exclusion (FEIE) mechanics for US citizens
  abroad.
- Roth conversion ladder modeling.
- 529 qualified vs non-qualified withdrawal accounting.

*Corporate-action depth:*
- Continuous corporate-action ingestion (mergers, spin-offs, exchange
  offers) with issuer-supplied basis allocations (US Form 8937,
  equivalents elsewhere). Manual entry only.
- Crypto-specific reporting standards (US 1099-DA, similar new
  jurisdictional rules) — covered to the extent they fit standard
  activity types; specialized forms not generated.

*Estate, gift, and ownership transitions:*
- Estate, gift, and inheritance tax modeling.
- Inheritance step-up basis events beyond simple basis adjustment.
- Trust-level taxation (DNI computation, simple vs complex trust).
- Exit tax / deemed-disposal-on-emigration (US §877A, CA, NL, etc.) —
  flagged as a community pack, not v1.

*Owner-occupied / personal-use:*
- Home-sale exclusion (US §121).
- Personal-use property gain/loss disallowance.
- Owner-occupied principal residence rules across jurisdictions.

*Out-of-scope tax mechanisms:*
- Malta non-dom and Cyprus non-dom remittance-basis taxation (see §4.8).
- Argentina-style multi-rate FX environments (see §4.8).
- Phase-out tables for any progressive surtax.
- VAT, GST, sales tax, transfer tax on real estate (we model
  securities, not consumption taxes).

*Historical scope:*
- Tax-rate or rule changes more than ~3 years before the current year.
  Effective-date scoping (§11.1) supports this if community packs
  provide it; v1 ships current-year rules only.

If a user's situation requires *any* of the above, the answer is
"see your accountant" — and the UI should make that handoff
graceful (export of treatments + reasons in a form an accountant can
review). That export-for-handoff is itself a v1 goal; the
computation-of-the-final-number is not.

## 3. Composition model

A rule pack is a JS module:

```javascript
export const meta = {
  id: "us-fed/qualified-dividends",
  applies: { jurisdiction: ["US"] },
  consumes: ["activity", "asset", "lots"],
  emits: ["income_character", "reasons"],
  priority: 100,
};

export function evaluate(ctx, treatment) {
  if (ctx.activity.type !== "DIVIDEND") return treatment;
  if (ctx.activity.income_type !== "QUALIFIED_DIV") return treatment;
  // (holding-period checks etc.)
  return {
    ...treatment,
    income_character: "qualified_dividend",
    reasons: [...(treatment.reasons ?? []), "US: QDI holding-period met"],
  };
}
```

A `Treatment` is the accreting result. The core structure is a
**list of liability lines**, each tagged with the jurisdiction that
levies it — no fixed `federal` / `state` slots, since real-world tax
hierarchies vary in depth (some countries have only national tax,
some go national → regional → city, some add cross-border layers
with credits).

```javascript
{
  income_character: "qualified_dividend" | "ordinary_dividend"
                  | "ltcg" | "stcg" | "tax_exempt_int" | ...,

  // One line per jurisdiction that has anything to say about this event.
  // Order is informational only; the engine does not depend on it.
  liabilities: [
    {
      id: "us-fed",                      // unique per treatment, used for credit refs
      jurisdiction: "US",                // ISO 3166 country (or country-subdivision-locality)
      level: "national",                 // national | subnational | local | supranational
      currency: "USD",                   // currency this liability is denominated in
      treatment: "taxable" | "exempt" | "deferred",
      taxable_basis: 1000.00,            // amount subject to tax in this jurisdiction
      effective_rate: 0.15,              // optional; absent for "exempt"
      gross_amount:   150.00,            // taxable_basis * effective_rate
      surcharges: [                      // optional add-ons (NIIT, AMT, additional medicare)
        { name: "NIIT", rate: 0.038, amount: 38.00 }
      ],
      credits: [                         // claims against this line from other lines
        { source_id: "fr-fed", amount: 120.00, mechanism: "FTC" }
      ],
      net_amount: 68.00,                 // gross + surcharges - credits
      reasons: ["US: LTCG at 15%", "FTC: $120 from FR withholding"]
    },
    // ...further lines for state, city, foreign jurisdictions
  ],

  withheld: [
    { jurisdiction: "FR", amount: 120.00, creditable_against: ["US"] }
  ],
  basis_adjustments: [{ lot_id, delta_per_share }],   // ROC, scrip dividends
  treatment_changes_on: Date | [{ date, becomes }],
  reasons: string[],                     // top-level reasons (cross-cutting commentary)
  final: boolean,                        // short-circuit flag
}
```

The engine runs packs in priority order. A pack can short-circuit by
setting `treatment.final = true` (Roth IRA → exempt across all
jurisdictions, no further analysis).

### 3.1 Multi-level jurisdictions and credit mechanics

The `liabilities[]` model accommodates three patterns the fixed
`federal/state` model cannot:

**Multi-level domestic stacking.** A New York City resident's dividend
incurs liability at three levels: US federal, NY state, NYC local. Each
is its own line in `liabilities`, with its own taxable basis and rate.
Sometimes a higher-level jurisdiction's tax is deductible from a
lower-level base (or vice versa); when that applies, a `credits` entry
on the affected line records the dependency.

**Cross-border treaty crediting.** An American living in France pays
French tax on US-sourced dividends; the US then taxes the same income
but allows a Foreign Tax Credit for the French tax paid. The `fr-fed`
line records the gross French liability; the `us-fed` line records the
gross US liability with a `credits` entry referencing `fr-fed` and a
`mechanism: "FTC"`. Net US tax is gross-minus-credit.

**Surcharges as nested liabilities.** US NIIT (3.8% on investment
income above a threshold), additional medicare tax, AMT — these aren't
separate jurisdictions but are surcharges on the federal line. They
live in `surcharges[]` on the affected liability rather than as
top-level lines, keeping the jurisdiction list clean.

### 3.2 Engine helpers for cross-line operations

Packs that need to reference other lines (a US FTC pack reading
foreign-withholding lines, a NYC-resident pack stacking on NY state)
use engine-provided helpers rather than searching `liabilities` by
hand:

```javascript
__wf.findLiability(treatment, { jurisdiction: "FR", level: "national" })
__wf.addLiability(treatment, { id, jurisdiction, level, ... })
__wf.addCredit(treatment, { target_id: "us-fed",
                            source_id: "fr-fed",
                            amount: 120.00,
                            mechanism: "FTC" })
__wf.addSurcharge(treatment, { target_id: "us-fed",
                               name: "NIIT", rate: 0.038, amount: 38.00 })
```

This keeps pack code clean and gives the engine a single place to
enforce invariants — credits can't exceed source amount, surcharge
totals can't go negative, jurisdiction codes are validated, etc.

### 3.3 Worked examples

**Example A — NYC resident sells a US equity at a long-term gain
($10,000 LT gain).**

```javascript
{
  income_character: "ltcg",
  liabilities: [
    { id: "us-fed",  jurisdiction: "US",     level: "national",
      treatment: "taxable", taxable_basis: 10000, effective_rate: 0.15,
      gross_amount: 1500, surcharges: [{name: "NIIT", rate: 0.038, amount: 380}],
      credits: [], net_amount: 1880,
      reasons: ["US: LTCG at 15%", "NIIT applies (estimated)"] },

    { id: "us-ny",   jurisdiction: "US-NY",  level: "subnational",
      treatment: "taxable", taxable_basis: 10000, effective_rate: 0.0685,
      gross_amount: 685, net_amount: 685,
      reasons: ["NY: cap gains taxed as ordinary at 6.85%"] },

    { id: "us-nyc",  jurisdiction: "US-NYC", level: "local",
      treatment: "taxable", taxable_basis: 10000, effective_rate: 0.03876,
      gross_amount: 387.60, net_amount: 387.60,
      reasons: ["NYC: 3.876% on investment income"] }
  ],
  reasons: ["Estimated total tax: $2,952.60 — see your accountant"]
}
```

**Example B — American living in France receives a $1,000 dividend
from a French company; France withholds 30%, US treaty rate is 15%.**

```javascript
{
  income_character: "ordinary_dividend",
  liabilities: [
    { id: "fr-fed",  jurisdiction: "FR", level: "national",
      treatment: "taxable", taxable_basis: 1000, effective_rate: 0.30,
      gross_amount: 300, net_amount: 300,
      reasons: ["FR: 30% withholding at source on dividends"] },

    { id: "us-fed",  jurisdiction: "US", level: "national",
      treatment: "taxable", taxable_basis: 1000, effective_rate: 0.32,
      gross_amount: 320,
      credits: [{ source_id: "fr-fed", amount: 300, mechanism: "FTC" }],
      net_amount: 20,
      reasons: ["US: ordinary div at 32%", "FTC: $300 credited from FR withholding"] }
  ],
  withheld: [{ jurisdiction: "FR", amount: 300, creditable_against: ["US"] }],
  reasons: ["Estimated combined tax: $320 ($300 to FR + $20 to US after FTC)"]
}
```

The first example shows three-level domestic stacking (federal + state +
city); the second shows cross-border crediting where one country's
liability reduces another's. Neither pattern fits a fixed
`federal`/`state` Treatment shape.

### 3.4 Composition semantics — open question

Two viable styles, decision deferred:

1. **Merge style (current sketch).** Each pack returns a new treatment;
   later packs read prior state and overwrite or augment. Simple, but
   conflicts are silent (a state pack accidentally clobbering a
   federal-line entry).
2. **Operation style.** Each pack returns operations
   (`{op: "addLiability", line: {...}}`,
   `{op: "addCredit", target_id, source_id, amount, mechanism}`,
   `{op: "addSurcharge", target_id, name, rate, amount}`,
   `{op: "addReason", target_id?, text}`). Engine applies in order.
   More verbose but produces a clean per-activity audit trail and makes
   inter-pack dependencies explicit.

Operation style is probably better for a tax engine. Will prototype
both. See §11.

## 3.5 QuickJS as the runtime — fit and trade-offs

The engine runs rule packs inside an embedded **QuickJS** interpreter
(via the `rquickjs` Rust crate). Key properties:

- **Small footprint.** ~210 KB compiled into the binary. No external
  toolchain (Node, V8, browser).
- **Sandboxed by construction.** No `fs`, `net`, `process`, `import`
  from URLs. The only API a pack sees is what we explicitly expose.
  Since rule packs are pure functions, this is exactly what we want.
- **Pure-function model fits packs naturally.** A pack's `evaluate(ctx,
  treatment)` is a JS function over plain objects. No event loop, no
  promises, no async — just call and return.
- **Deterministic.** Same input → same output, every time. Critical
  for reproducible historical reports and for unit-testing packs.
- **Familiar syntax.** Most contributors can read JS; rule packs can be
  prototyped in a browser console with the same code.

### What QuickJS gives us, concretely

```rust
// One-time setup at startup
let runtime = quickjs::Runtime::new()?;
let ctx = quickjs::Context::full(&runtime)?;

// Per evaluation:
ctx.with(|ctx| {
    let pack: Function = ctx.eval(pack_source)?;        // bytecode-cached
    let result: Value = pack.call((js_ctx, prior))?;
    let treatment: Treatment = serde_json::from_value(result.into())?;
    Ok(treatment)
})
```

The bridge is thin: serialize the Rust `EvalContext` (`{filer, account,
asset, activity, lots}`) to a JS object via `serde_json`, call the
pack's `evaluate`, deserialize the returned treatment back to Rust.

### Things QuickJS does NOT give us (and what we do about it)

- **No native Decimal type.** JS numbers are f64. For tax-rate math
  (rates have ≤5 sig figs; we're estimating, not preparing returns)
  this is acceptable. Two mitigations: (a) pass cost basis and
  proceeds as strings into the pack and rehydrate to Decimal on the
  Rust side after the pack returns; (b) include a small `decimal.js`
  helper in the pack runtime for packs that genuinely need precise
  arithmetic (e.g. ROC basis adjustment).
- **No package ecosystem.** Packs cannot `npm install` anything. If a
  pack wants helpers (e.g. holding-period date math), they're either
  inlined or provided by the engine as globals (`__wf.daysBetween`,
  `__wf.lookupTreatyRate`, etc.). Lean toward a small built-in helper
  set rather than letting packs import each other in v1.
- **No debugger / step-through.** Pack authors get `console.log` (which
  we redirect into the engine's evaluation log, surfaced in the
  per-evaluation reasons array). For our use case that's plenty.
- **No type checking.** JS is dynamically typed. We mitigate with a
  Zod-style schema validator that runs on every pack output and flags
  malformed treatments at evaluation time, not silently.

### Performance budget

QuickJS evaluates a typical small pack in 50–200 µs once bytecode is
cached. A US-CA filer with the v1 seed packs runs ~8 packs per activity
→ ~1–2 ms per activity. A 30k-activity portfolio → ~30–60 seconds for
a full re-evaluation. For interactive use ("what if I sell X tomorrow?")
we evaluate just the affected lots → milliseconds.

If this becomes a bottleneck (it shouldn't), three knobs are available:
parallel evaluation across activities (rule chain is a pure function,
trivially parallelizable), partial re-evaluation when only a few
activities change, and pack consolidation (merge frequently-co-occurring
packs at compile time).

### Engineering scope to integrate

- `rquickjs` dependency: 1 line in `Cargo.toml`
- Pack loader (filesystem + bundled): ~200 LOC
- `EvalContext` ↔ JS bridge with serde: ~300 LOC
- Engine evaluator (resolve chain, run packs, collect reasons): ~400 LOC
- Treatment schema validator: ~150 LOC
- Bytecode cache: ~50 LOC
- Built-in helper exposure (`__wf.*`): ~100 LOC

Roughly **one engineer-week** for a working v0 evaluator with three
sample packs. The bulk of the actual work is pack content, not engine
plumbing.

### Why JS over alternatives

| Alternative | Pro | Con |
|---|---|---|
| Hard-coded Rust | Fast, type-safe | Every rule change needs a Wealthfolio release |
| Lua (mlua) | ~50 KB, also pure | Sparse tax-domain code to reference; smaller author pool |
| Rhai | Rust-native | Niche; few authors know it |
| Custom DSL | Tailored to tax | Months to design; new language for users to learn |
| Python (PyO3) | Huge author pool | Embedding cost much higher; GIL; sandbox much harder |

QuickJS hits the sweet spot for our scale and audience: tiny embedding
cost, clean sandbox, familiar language.

## 4. Pack categories

Five buckets, each with a clear job. Order in the chain follows this list.

### 4.1 Wrapper packs
Read `ctx.account.wrapper_kind`. Often short-circuit.
- `wrapper/roth-ira-exempt` — set `final=true`, exempt
- `wrapper/trad-deferred` — emit a single liability line with
  `treatment="deferred"` covering all jurisdictions; real evaluation
  happens on WITHDRAWAL activities
- `wrapper/withdrawal-rmd` — applied to WITHDRAWAL events from deferred
  wrappers (later)
- `wrapper/tfsa-exempt`, `wrapper/isa-exempt`, `wrapper/ch-3a-exempt` —
  parallel forms

### 4.2 Character packs
Set the *kind* of income or gain. Jurisdiction-agnostic where possible.
- `character/lt-st-365` — SELL: LT if lot age ≥ 365d at close, else ST
  (US default; jurisdictions with different boundaries override)
- `character/qdi-eligibility` — DIVIDEND with `income_type=QUALIFIED_DIV`
  + 60-day holding window → qualified

### 4.3 Jurisdiction (federal/national) packs
- `us-fed/cap-gains-rates` — apply ST/LT rates to character-classified
  gains
- `us-fed/dividend-rates` — qualified = LT rates; ordinary = ordinary
- `us-fed/treasury-state-exempt` — Treasury interest: fed taxable, set
  `state_exempt = true`
- `us-fed/muni-bond-fed-exempt` — `tax_class=BOND_SUBNATIONAL` +
  `issuer_jurisdiction=US` → fed exempt
- `ca-fed/cap-gains-inclusion` — Canadian 50% (or 66.67% post-2024)
  inclusion
- `ch-fed/private-wealth-cg-exempt` — Swiss private capital gains
  generally exempt; dividends taxable

### 4.4 Subdivision (state/canton/province) packs
- `us-ca/muni-same-state` — CA muni for CA resident → state exempt
- `us-ny/muni-mismatch` — non-NY muni for NY resident → state taxable
- `us-ny/cap-gains-as-ordinary` — NY taxes cap gains at ordinary rates,
  layered on top of federal
- `ch-zh/dividend-rate` — ZH cantonal rate

### 4.5 Cross-border packs
- `xb/treaty-wht-lookup` — `withholding_jurisdiction` × `filer_jurisdiction`
  → expected treaty rate, mark creditable
- `xb/ftc-accrual` — record FTC available against federal tax

### 4.6 Adjustment packs (run last)
- `bonus-share/redistribute-basis-es` — Spanish/EU model: redistribute
  existing basis across enlarged position; zero income recognition
- `bonus-share/income-at-fmv-us` — US model: recognize income at FMV;
  fresh basis for new shares
- `roc/reduce-basis` — RETURN_OF_CAPITAL: emit basis adjustment, no
  current-period income

### 4.7 Year-level aggregation packs

A second category of packs that runs once per tax year over the
**aggregated portfolio state and the full year's activity stream**,
not over individual activities. These can refine per-event treatments
(applying allowances, disallowing losses) and emit liabilities that
have no per-event trigger at all (wealth taxes, deemed-return regimes).

The execution order is:

1. **Per-event pass** (§4.1–4.6) — every activity gets a treatment.
2. **Year-level pass** — receives all per-event treatments + the
   year-end positions snapshot + filer profile; emits year-keyed
   liabilities and modifies per-event treatments.
3. **Final aggregation** — sum and net into the per-year tax estimate.

Year-level pack contract:

```javascript
export const meta = {
  id: "uk/annual-exempt-amount",
  category: "annual",
  applies: { jurisdiction: ["UK"] },
};

export function evaluate(yearCtx, treatments) {
  // yearCtx: { tax_year, filer, positions_snapshot, fx_rates_yearend }
  // treatments: array of per-event Treatments produced in pass 1
  // Returns: { modified_treatments, year_level_liabilities }
}
```

Wealth-tax jurisdictions (CH, NO, NL Box 3, ES Patrimonio, FR IFI)
tilt the architecture: their per-event packs are minimal or empty and
the year-level pack does the actual work. The Treatment shape extends
with year-keyed liabilities:

```javascript
{
  liabilities: [...],            // per-event lines (may be empty for NL)
  year_liabilities: [
    { id: "ch-zh-wealth-2025", jurisdiction: "CH-ZH", level: "subnational",
      currency: "CHF", treatment: "taxable",
      taxable_basis: 850000.00,  // year-end net wealth
      effective_rate: 0.0035,
      gross_amount: 2975.00,
      reasons: ["CH-ZH wealth tax: 0.35% on CHF 850k net wealth"] }
  ],
  ...
}
```

### 4.8 Known limitations / out-of-scope patterns

A few real-world tax mechanisms don't fit cleanly into the
event-or-year-level model. Documented as known gaps, not attempted
in v1:

**Flow-dependent (remittance-basis) taxation.** Malta's non-dom regime
and (more lightly) Cyprus tax foreign-source income only when funds
are remitted to the country of residence. The treatment of an activity
depends on a *future flow event* we don't model — a cross-account
TRANSFER becomes the taxable trigger, not the original SELL or
DIVIDEND. Possible future support:
- User tags accounts as "remittance boundary" (in-Malta vs external).
- Cross-boundary TRANSFERs become synthetic taxable activities.
- Or: Treatment carries `taxable_on_remittance: true` and estimation
  becomes "what if I remitted X today?"

For v1 we recommend declining to model Malta non-dom and Cyprus
non-dom; users in those regimes compute remittance tax manually.

**Full reporting-currency conversion under unstable FX.** Argentina's
multi-rate environment (official, blue, MEP, CCL) means there's no
canonical USD equivalent for an ARS amount. The architecture handles
this only as cleanly as the underlying data — user-configurable rate
sources per asset class would be needed.

**Continuous corporate-action ingestion (mergers, spin-offs, exchange
offers).** These produce basis allocations dictated by the issuer
(Form 8937 in the US). The Treatment shape can carry resulting basis
adjustments via `basis_adjustments[]`, but the *source* of the
allocation ratios is an external data feed we don't have. Manual entry
only for v1.

**State/cantonal cap-gains stacking with phase-outs.** A handful of US
states phase out preferential rates as income rises (HI, ND). Some
Swiss cantons have similar progressivity. Year-level packs can model
this but rate-table structure gets noisy. v1 ships flat-rate
templates; phase-outs become community-contributed packs.

## 5. Filer profile

The profile is a small structured object stored in settings:

```javascript
{
  primary_jurisdiction: "US-CA",         // residency-based liability
  secondary_jurisdictions: ["US-NY"],    // e.g. rental property in NY
  citizenship_jurisdictions: ["US"],     // citizenship-based liability (US is unique here)
  wrapper_kinds_in_use: ["TAXABLE_BROKERAGE", "ROTH_IRA", "TRAD_IRA"],
  fiscal_year_start: "01-01",            // MM-DD; UK="04-06", IN="04-01", default "01-01"
  reporting_currency: "USD",             // for cross-currency aggregation in summaries
  modifiers: ["amt_filer"],              // opt-in flags
  custom_packs: [],                      // user-authored .js paths
  pack_overrides: {                      // pack-level config, no code change
    "us-fed/cap-gains-rates": { lt_rate: 0.15, st_rate: 0.32 }
  }
}
```

`citizenship_jurisdictions` is separate from `secondary_jurisdictions`
because the loading semantics differ:
- Residency / nexus jurisdictions load packs that *replace or layer on*
  the primary (e.g. NY state rules for a rental property).
- Citizenship jurisdictions load packs that *layer above the residency
  set with FTC mechanics* — the canonical case is a US citizen abroad
  who pays foreign tax first, then computes US tax with foreign tax
  credits. Without an explicit citizenship slot this case is hard for
  users to express discoverably.

From the profile, the engine resolves the **active pack set**:

1. Start with all built-in packs.
2. Filter by `meta.applies`: keep packs whose declared jurisdictions
   intersect `primary_jurisdiction ∪ secondary_jurisdictions ∪
   citizenship_jurisdictions`, or whose wrapper match is in
   `wrapper_kinds_in_use`.
3. Append `custom_packs`.
4. Apply `pack_overrides` (injected into pack at load time as a config
   parameter).
5. Sort by `priority`, then by category order (§4).

This is a pure function of the profile. Any profile change recomputes
the chain.

## 6. Inspectability and customization

Three views in the UI, all reachable from Settings → Tax Profile:

### 6.1 Pack manager
List of all built-in packs. Each row shows id, summary, "applies to your
profile" badge, and a toggle. Click to expand the JS source. User can
disable any built-in pack.

### 6.2 Active rule chain
The ordered list the engine will run for this profile, with each pack's
source in collapsible sections. Read-only view of *what will run*. This
is what most users will look at when debugging "why did this dividend
get classified that way."

### 6.3 Effective rule book
A single concatenated `.js` of all active packs in execution order,
banner comments separating them. Copy-pasteable to an editor. Saving
this back as `custom-packs/full-override.js` replaces *all* built-ins —
the escape hatch for power users who want one giant file they fully
control.

Custom packs live in `~/.local/share/wealthfolio/tax-packs/*.js` (or the
OS-appropriate equivalent) and follow the same `meta` + `evaluate`
contract. They are loaded automatically; the engine validates the schema
on load and reports errors in the pack manager.

## 7. v1 seed packs (concrete)

Ten packs sufficient for a US filer in any state with taxable, Roth, and
traditional accounts holding equities, treasuries, munis, and foreign
ADRs:

1. `wrapper/roth-ira-exempt`
2. `wrapper/trad-deferred`
3. `character/lt-st-365`
4. `character/qdi-basic`
5. `us-fed/cap-gains-rates`
6. `us-fed/dividend-rates`
7. `us-fed/treasury-state-exempt`
8. `us-fed/muni-fed-exempt`
9. `us-state/muni-same-state` (template; subdivision-aware)
10. `xb/treaty-wht-credit`

Plus one bonus-share pack per regime (`bonus-share/redistribute-basis-es`,
`bonus-share/income-at-fmv-us`) and `roc/reduce-basis`.

What is deliberately NOT in v1:
- AMT computation
- Wash-sale window enforcement
- Section 1256 contracts
- PFIC mark-to-market or QEF election
- K-1 pass-through income decomposition
- Per-state cap-gains stacking beyond a basic template

These all become community contributions, each a focused 50–200 line
pack.

## 8. Jurisdiction coverage map

This section is descriptive, not prescriptive — it enumerates the
jurisdictions and tax patterns we have *thought about* during the
architecture design, so future contributors can see the diversity the
model is intended to serve. Inclusion here does **not** imply v1
commitment.

**Status legend**
- 🎯 **v1 seed** — shipped in the initial release
- 📦 **v1 stretch** — likely in the v1 timeframe if scope allows
- 🌍 **community** — solid fit for the architecture; awaiting a
  contributor with domain knowledge
- ⚠ **known gap** — does not fit cleanly; v1 declines; see §4.8
- ➖ **trivial** — single "no-op exempt" pack covers it

### 8.1 North America

| Jurisdiction | Levels / wrappers | Per-event packs | Year-level packs | Status |
|---|---|---|---|---|
| **US-fed** | National + Roth/Trad/401k/HSA/529 | `wrapper/roth-ira-exempt`, `wrapper/trad-deferred`, `character/lt-st-365`, `character/qdi-basic`, `us-fed/cap-gains-rates`, `us-fed/dividend-rates`, `us-fed/treasury-state-exempt`, `us-fed/muni-fed-exempt` | `us-fed/niit-threshold`, `us-fed/wash-sale-disallow`, `us-fed/amt` (later) | 🎯 |
| **US-CA** (LA) | Subnational | `us-state/muni-same-state` (CA template), `us-ca/cap-gains-as-ordinary` | — | 🎯 |
| **US-NY + NYC** | Subnational + local | `us-ny/muni-mismatch`, `us-ny/cap-gains-as-ordinary`, `us-nyc/local-rate` | — | 📦 |
| **US-MA** | Subnational | `us-ma/cap-gains-flat-rate` | — | 📦 |
| **US-TX** | National only (no state tax) | none | — | ➖ |
| **US-HI / US-ND** (phase-outs) | Subnational | rate-table packs with phase-outs | — | 🌍 |
| **CA-fed** | National + RRSP/TFSA/RESP/FHSA | `wrapper/tfsa-exempt`, `wrapper/rrsp-deferred`, `ca-fed/cap-gains-inclusion` (50% / 66.67% post-2024), `ca-fed/dividend-tax-credit` (eligible vs non-eligible) | `ca-fed/superficial-loss` (30-day) | 📦 |
| **CA-BC** (Vancouver) | Provincial | `ca-bc/cap-gains-rates`, `ca-bc/dividend-tax-credit` | — | 🌍 |
| **CA-ON** (Toronto) | Provincial | `ca-on/cap-gains-rates`, `ca-on/dividend-tax-credit` | `ca-on/health-premium` | 🌍 |
| **CA-QC** (Montreal) | Provincial + federal abatement | `ca-qc/cap-gains-rates`, `ca-fed/quebec-abatement` (16.5% reduction on QC-resident federal tax) | `ca-qc/health-contribution` | 🌍 |
| **MX** | National + AFORE | `mx/cap-gains-flat`, `wrapper/afore-deferred` | — | 🌍 |

### 8.2 Europe

| Jurisdiction | Levels / wrappers | Per-event packs | Year-level packs | Status |
|---|---|---|---|---|
| **UK** (London) | National + ISA/SIPP/JISA/LISA | `wrapper/isa-exempt`, `wrapper/sipp-deferred`, `uk/dividend-rates`, `uk/cap-gains-rates`, `uk/bed-and-breakfast-30d` | `uk/annual-exempt-amount` (£3k), `uk/dividend-allowance` (£500), `uk/personal-savings-allowance` | 📦 |
| **DE** (Munich) | National + Kirchensteuer surcharge | `de/abgeltungsteuer-25` (capital + dividends + interest flat 25%), `de/freistellungsauftrag` (€1k allowance) | — | surcharges: `de/soli` (5.5%), `de/kirchensteuer-by-land` (8% BY/BW, 9% else) | 🌍 |
| **GR** (Athens) | National | `gr/listed-equity-cg-suspended` (currently 0% on listed shares), `gr/dividend-wht-5` | `gr/solidarity-contribution` (if reinstated) | 🌍 |
| **ES** (Madrid) | National + autonomous community | `es/cap-gains-savings-rate`, `es/dividend-savings-rate`, `es-madrid/ac-rate-overlay`, `bonus-share/redistribute-basis-es` | `es-fed/patrimonio` (wealth tax) | 🌍 |
| **PT** | National + NHR wrapper | `pt/cap-gains-flat-28`, `pt/dividend-flat-28`, `wrapper/pt-nhr-foreign-passive-exempt` (10-year regime) | — | 🌍 |
| **IT** | National + regime amministrato/dichiarativo | `it/cap-gains-26`, `it/dividend-26` | `it/loss-category-offset` (4-year carryforward, same-category-only) | 🌍 |
| **FR** | National + PEA/PEE | `wrapper/pea-deferred-then-exempt` (5-year), `fr/pfu-30` (flat 30%) | `fr/ifi` (real-estate wealth tax) | 🌍 |
| **CH** (any canton) | National + canton + commune | `ch-fed/private-wealth-cg-exempt`, `ch-fed/dividend-taxable`, `wrapper/ch-3a-exempt-on-retirement` | **`ch-{canton}/wealth-tax`** (annual, primary mechanism), `ch-{canton}/income-tax-on-dividends` | 🌍 |
| **NL** | National (Box 3) | none — per-event tax is zero on investment portfolio | **`nl/box-3-deemed-return`** (the *only* mechanism) | ⚠ year-level dominates |
| **NO** | National + commune | `no/cap-gains-22`, `no/shielding-deduction` | **`no/formueskatt`** (wealth tax, primary) | 🌍 |
| **SE** | National + ISK wrapper | `se/cap-gains-30` (taxable accounts) | **`se/isk-flat-rate`** (annual flat tax on average value, ignore per-event) | 🌍 |
| **DK** | National + aktiesparekonto | `dk/cap-gains-progressive` | **`dk/aktiesparekonto-deemed`** (similar to ISK) | 🌍 |
| **FI** | National + OST | `fi/cap-gains-30-34` | `fi/ost-deemed-return` | 🌍 |
| **IE** | National + DIRT + 8-year deemed | `ie/cap-gains-33`, `ie/dirt-33` (deposit interest withheld) | `ie/8-year-deemed-disposal` | 🌍 |
| **BE** | National | `be/cap-gains-no-general` (with speculative exception), `be/tob` (transaction tax 0.12-1.32% per trade) | — | 🌍 |
| **MT** | National + non-dom remittance | (none until remittance modeled) | (none until remittance modeled) | ⚠ |
| **CY** | National + non-dom | `wrapper/cy-non-dom-foreign-passive-exempt` (17-year regime, with caveats) | — | ⚠ partial |
| **MC** | National (zero income tax) | none | — | ➖ |
| **EE** | Distributed-profit corporate; individual flat | `ee/cap-gains-20` | — | 🌍 |

### 8.3 Asia-Pacific

| Jurisdiction | Levels / wrappers | Per-event packs | Year-level packs | Status |
|---|---|---|---|---|
| **AU** | National + franking + super | `wrapper/super-deferred`, `au/franking-credit-gross-up`, `au/cap-gains-50pct-discount` (>12mo holding) | — | 🌍 |
| **NZ** | National | `nz/no-general-cgt`, `nz/fif-rules` (foreign investments) | — | 🌍 |
| **SG** | National only (no CGT) | none | — | ➖ |
| **HK** | National only (no CGT) | none | — | ➖ |
| **JP** | National + reconstruction surcharge + tokutei kouza wrapper | `jp/cap-gains-15`, `jp/dividend-15`, `jp/inhabitant-tax-5`, `wrapper/tokutei-kouza-broker-withheld` | — | surcharge: `jp/reconstruction-0.315` | 🌍 |
| **KR** | National + STT | `kr/cap-gains-by-asset-type`, `kr/securities-transaction-tax` | — | 🌍 |
| **CN** (Shanghai) | National | `cn/non-citizen-foreign-asset-exempt-5y`, `cn/citizen-worldwide-income`, `cn/dividend-20` | — | 🌍 |
| **IN** | National + cess + surcharge | `in/ltcg-listed-12.5-with-1L-exempt`, `in/stcg-listed-15`, `in/stt-on-trade` (SE tax) | `in/health-education-cess`, `in/income-surcharge-bracket` | 🌍 |
| **BR** | National with monthly cadence | `br/cap-gains-15-progressive`, `br/darf-monthly` | — | 🌍 |
| **AR** | National | `ar/cap-gains-15` | `ar/inflation-indexation` | ⚠ rate-input quality |

### 8.4 Middle East / Other

| Jurisdiction | Levels / wrappers | Per-event packs | Year-level packs | Status |
|---|---|---|---|---|
| **AE** (UAE) | National only (zero income tax for individuals) | none | — | ➖ |
| **SA** (Saudi) | National only (zakat doesn't apply to non-Muslims; income tax structure for residents) | none typically | — | ➖ |
| **QA, BH, OM, KW** | Mostly zero personal income tax | none | — | ➖ |
| **IL** | National + multiple election tracks | `il/cap-gains-25`, `il/inflation-adjusted-basis` | — | 🌍 |

### 8.5 Cross-border / universal

| Pack | Purpose | Status |
|---|---|---|
| `xb/treaty-wht-lookup` | Apply DTT withholding rate based on `withholding_jurisdiction × filer_jurisdiction` | 🎯 |
| `xb/ftc-accrual` | Record FTC available against domestic tax | 🎯 |
| `xb/citizenship-vs-residency-merge` | Handle US-citizen-abroad layering: residency packs run first, then US packs with FTC against the residency layer | 📦 |
| `xb/exit-tax-deemed-disposal` | Some jurisdictions (US §877A, CA, NL) deem disposal on emigration | 🌍 |

### 8.6 Coverage in numbers

- **Jurisdictions discussed:** ~38 (covering >85% of likely user base by population of major financial markets)
- **Packs sized:** ~120 distinct packs across all jurisdictions
- **v1 seed (🎯):** ~12 packs covering US-CA filer with common wrappers
- **v1 stretch (📦):** ~10 additional packs (UK, US-NY+NYC, US-MA, CA-fed core, citizenship-merge)
- **Community (🌍):** ~90 packs awaiting domain-knowledgeable contributors
- **Known gaps (⚠):** Malta non-dom, Cyprus non-dom remittance, NL Box 3 (handled via year-level only — works architecturally but conceptually different from per-event regimes), Argentina FX-rate ambiguity

This map is the answer to "is the architecture global enough?" — the
patterns generalize across the listed jurisdictions, and the gaps are
documented honestly rather than glossed over.

## 9. UI sketch

**Settings → Tax Profile**
- Primary jurisdiction (country + subdivision dropdown)
- Secondary jurisdictions (multi-select chips)
- Wrappers in use (auto-derived from accounts, editable)
- Modifier flags (`amt_filer`, `foreign_earned_income_excl`, …)
- Pack overrides (table of pack-id → config blob)
- Buttons: "View active rule chain", "View effective rule book"

**Tax Profile → Active Rule Chain (drawer or modal)**
- Ordered list, ~8–12 packs for a typical US filer
- Per-pack: name, applies-from-profile reason, source toggle, "edit a
  copy", "disable"
- Header button: "Export effective rule book (.js)"

**Per-account tax preview** (post-v1)
- For each account, run the chain on its activities, show implied
  treatments
- The validation surface — does my rule chain produce sensible numbers?
- Diff view if a profile or pack changes: "this dividend used to be
  classified ordinary; now it's qualified because pack X was enabled."

## 10. Engineering phasing

**v0 — proof of concept (~1 week)**
- Embed QuickJS via `rquickjs`
- Pack loader (filesystem + bundled), schema validator
- Engine: load profile, resolve active set, evaluate one activity
- Three packs: `wrapper/roth-ira-exempt`, `character/lt-st-365`,
  `us-fed/cap-gains-rates`
- CLI dump: "for activity X, treatment is Y, applied packs were Z"

**v1 — usable product (~3 weeks beyond v0)**
- All 10 seed packs
- Tax Profile settings UI
- Active Rule Chain viewer
- Effective Rule Book export
- Custom pack loading from user dir
- Pack-override config injection

**v2 — deferred**
- Per-account tax preview report
- Hot-reload during pack authoring
- AMT, wash-sale, K-1 packs (community-driven)
- Pack-pack dependency / replacement metadata
- Effective-date scoping (pack version per tax year)

## 11. Decisions and open questions

### 11.1 Decisions (Nick, 2026-04-16)

1. **Composition style — prototype operation style first.** Operation
   composition (§3.4) feels like the right shape for a tax engine, with
   per-activity audit trails and explicit inter-pack dependencies. Will
   prototype merge style as a fallback if operation proves too verbose.

2. **Custom-pack trust model — caveat emptor.** Treat the user pack
   directory like a user-authored spreadsheet. QuickJS already lacks
   network and filesystem access by default; we'll make sure those
   defaults stay locked down. No signing infrastructure in v1. UI
   badge to distinguish built-in vs user-installed packs.

3. **Effective-date scoping — yes.** Each pack declares
   `effective: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` in its meta;
   the engine selects the version applicable to each activity's date.
   Required for honest historical-year computations.

4. **Pack ID namespacing — reverse-DNS internally, friendly UI label.**
   Internal IDs like `org.wealthfolio.us-fed.qualified-dividends` keep
   the namespace open for community packs (`com.example.de-tax-2024`,
   etc.). UI shows a friendly label from `meta.name` and trims the
   org prefix in default display.

5. **Engine-data API contract — hydrated only, no DB access from
   packs.** The engine receives pre-hydrated `EvalContext` objects
   (filer, account, asset, activity, lots) from a Rust-side service.
   Packs cannot query the database. A small backend service prepares
   the context bundle so packs see consistent, FX-resolved data.

### 11.2 Still open

1. **Effective-rate location.** Rates can live in pack code, in
   `pack_overrides` config, or in a separate "rates registry." Leaning
   toward pack-config-with-a-rates-subsection-per-pack, but the right
   shape will become clearer once we have 5+ packs that share rates
   (e.g. all US-state packs referencing the same federal LT rate).

2. **Performance under realistic load.** QuickJS at ~50–200 µs per
   call with bytecode caching should handle a 30k-activity portfolio
   in ~1 minute, but worth measuring once a real chain exists. Plan B
   if it's a problem: parallel evaluation across activities (rule
   chain is a pure function, trivially parallelizable).

3. **Cost-basis method per jurisdiction.** US uses FIFO; Canada uses
   ACB; UK uses Section 104 pool with bed-and-breakfast; France uses
   weighted average. The current `lots` table is FIFO-shaped. Two
   options: pre-aggregate `lots` into a `BasisView` per filer's
   jurisdictional method (cleaner — rules don't see basis method), or
   emit `taxable_basis` per liability line via jurisdiction-specific
   basis packs. Will be flagged as an open question in `data_model.md`
   too, since it touches the schema layer.

4. **Treatment merging when multiple packs touch the same line.** If
   two state packs both want to set `effective_rate` on `us-ny`, who
   wins? Operation style largely solves this (explicit `addCredit` vs
   `addSurcharge`), but there's still a "later writer overrides
   earlier" question for shared fields. Need an explicit conflict
   policy or pack-priority discipline.

5. **Year-level pack ordering with per-event passes.** Year-level
   packs that modify per-event treatments (UK AEA application,
   wash-sale disallowance) need to run after all per-event packs but
   before final aggregation. Need to define whether year-level packs
   can themselves emit further per-event-style treatments, and how
   that interacts with the audit trail.


## 12. Relationship to `data_model.md`

`data_model.md` §4 specifies the *tagging surface*: what columns exist
on activities, accounts, and assets to make rule evaluation possible.
This doc specifies the *evaluation surface*: how the rules over those
tags are structured, composed, and presented to the user.

The two move together but can be designed mostly independently — the
tagging surface is "what facts are knowable about a transaction," and
the engine is "what to do with those facts." Adding a new tag is a
schema migration; adding a new rule is a pack drop-in.

## 13. Status and references

| Item | State |
|---|---|
| `data_model.md` (in repo) | Awaiting upstream review (alongside Phase A/B/C PRs) |
| Tax engine spike | Not started |
| Seed pack drafts | Not started |
| Pack manager UI | Not started |

References:
- `data_model.md` §5 — top-level rules engine framing
- `data_model.md` §4.3 — tagging surface (`income_type`, `tax_class`, etc.)
- `data_model.md` §4.4 — design choice: cost-basis redistribution lives
  in rules, not the schema
- `data_model.md` §5.5 — external read-only consumers of the rule
  output
- `WF-refactor-plan.md` — Phase D notes and inputs from advenacodex
  review
