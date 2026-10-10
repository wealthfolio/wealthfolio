# Portfolio engine rules for boundary cases

The architecture (`portfolio-engine.md`) describes how the engine works. This
page states what it must produce where the answer is a decision, not a
mechanism: money in and out, transfers, dates and currencies, dated reads, and
which writes invalidate which results. Code and tests follow this page; a change
of rule changes this page first, and is approved before it is implemented.

Each rule names the fixtures whose expected values are worked out by hand from
it, never taken from the engine.

## 1. Money in and out (flows)

**R1.1 Transactions accounts.** A deposit, withdrawal, or transfer to or from
outside the scope is money in or out on its business day, at its amount (or its
units at that day's price, for securities). Income, fees and taxes are returns,
not flows. Its holdings are the projection's: snapshots it kept from holdings
mode, imported or entered, stay stored (switching back reads them again) but are
not read.

**R1.2 Holdings accounts: snapshots for numbers, activities for reports.** A
holdings account is known only through its snapshots, so its value, positions,
flows and returns come only from them. At each snapshot after its first, money
in or out = the snapshot's value − the previous snapshot's holdings valued at
that day's prices; if either side is not fully priced, the flow is undetermined.
Users may record any activity on a holdings account, transfers included, but the
engine never uses a holdings account's activities for those numbers: deposits
and withdrawals are inside the next snapshot, and dividends, interest, fees and
taxes feed only the income, fees and taxes reports. The one exception is a
split, which is a fact about the asset, not an account activity (R1.5).
Fixtures: EDGE-MIX-04, NOM-MIX-01.

**R1.3 A scope's first day** carries no flow: it is where returns start.

**R1.4 An account opening inside a scope** (its first day is not the scope's
first day) brings money in. A transactions account brings what its activities
brought in that day, or its net contribution when it recorded none; a holdings
account brings its first snapshot's value (undetermined when not fully priced).
Fixtures: EDGE-MIX-02, LIFE-EMPTY-01.

**R1.5 Splits are facts about the asset.** Rows recording a split of the same
asset within one day of each other are one split: its most authoritative row
(user-edited, manual or imported before a provider's, then the latest updated)
gives its day and ratio, so a provider's wrong row next to the user's correction
is not applied twice (EDGE-QT-05). A split recorded on any account, a holdings
account included, applies to every holdings account that holds the asset, and
decides whether the data provider adjusted its prices. A holdings snapshot
states quantities as of its own date: read on any later day, by valuations,
holdings, account values and net worth alike, they are multiplied by every split
after that date up to the day, whether the provider adjusted its prices or not,
and the next snapshot is compared with them that way. Prices from before a split
that the provider adjusted are read back at their unadjusted level. A
transactions account's lots split on the split day of a split it records itself
(as before): brokers record a split on each account, not always on the same day,
so another account's row would split its lots twice (§8). Fixtures:
EDGE-SPLIT-01, EDGE-SPLIT-02, EDGE-SPLIT-03, EDGE-SPLIT-04, EDGE-QT-05.

## 2. Transfers

**R2.1 Between two transactions accounts in the scope.**

- Each leg is priced on its own day. The sender gives what it held: its leg is
  priced on the units it actually removed, and is no flow when it held none. The
  receiver books the quantity its own activity records; units the sender lacked
  arrive at the transfer's price.
- At the scope, the outgoing leg nets whole, and so does the incoming leg when
  the sender gave every unit. When the sender lacked some, what remains of the
  incoming leg is money from outside the history, from both legs whatever a
  dated read cuts: priced at a quote, the leg nets in the share of units the
  sender gave (out units ÷ in units); valued at cost (R2.4), it nets the cost
  the sender removed, so the cost booked for the units it lacked remains. A cash
  pair nets whole: a rate difference between its legs is a gain (#1655).
- Each leg is priced on its own day, so the legs' amounts differ when the price
  moves; their units differ only by what the sender lacked.
- The sender's units are the sum of the slices it relieved, which a split's
  rounding can leave short of the units sent (three thirds of a unit are
  0.9999999999999999999999999999). A shortfall below the fold's dust (1e-8
  units) is none, as the receiver books it: the sender gave every unit and the
  pair nets whole.
- Fixtures: EDGE-TXF-02, EDGE-TXF-09, EDGE-TXF-12, EDGE-TXF-14, EDGE-TXF-19,
  EDGE-TXF-24.

**R2.2 A currency conversion inside one account.** When the import linker
recorded it, it moves no money in or out and a better rate than the market's is
a gain; otherwise each leg moves net contribution at the market rate (legacy)
and the difference reads as an estimated flow. Fixtures: EDGE-TXF-05,
EDGE-TXF-13.

**R2.2a A manually recorded `FX_EXCHANGE`.** One stored row debits `amount` in
`currency` and credits `destination_amount` in `destination_currency` on one
transaction-tracked account. Both amounts are positive actual cash, inclusive of
charges; the currencies must differ after minor-unit normalization. It has no
asset, lots, fees, tax, activity-to-account `fx_rate`, contribution or boundary
flow. Both compiled postings share one source and the projection's savepoint:
neither is applied when the exchange is invalid. Their signed values at the
valuation FX rates on that day sum to FX gain/loss, not income or contributions;
both rates are required for that attribution. The execution rate is derived for
display only. Old transfer pairs retain R2.2; no historical data is rewritten.
Fixture: NOM-FX-EXCHANGE (1000 USD deposit, 100 USD → 92 EUR at EURUSD 1.10: 900
USD + 92 EUR, value 1001.2 USD, contribution 1000 USD, gain 1.2 USD, TWR 0.12%).

**R2.3 A transfer between a transactions account and a holdings account** is not
netted as a pair. The transactions side is money (or shares) leaving or entering
the scope on its day, as a transfer to or from outside: the fold does not wait
for the holdings side. The holdings side counts when its next snapshot shows it
(R1.2), at that snapshot's prices, so a price move in between reads as money in
or out (§8). Fixtures: EDGE-MIX-03, EDGE-MIX-05, EDGE-MIX-06.

**R2.4 A transfer without a quote** is valued at cost.

- The outgoing leg flows the cost it removed. Each lot it removes gives its own
  cost, so it realizes nothing, in base as in its currency.
- The incoming leg books the sender's lots at their cost, and units with no
  sender lot (the sender lacked them, is a holdings account, or the transfer is
  unpaired) at its own price. Units arriving into a short cover it first. Its
  whole fee is capitalised into the lots it opens, at their rates to the base
  currency; a leg that opens none capitalises nothing, and its fee is a charge.
- The incoming leg flows the cost of every unit it delivered, the lots it opened
  and the units that covered a short, less its fee as capitalised into those
  lots.
- A receiving lot's original-cost columns record its book cost on delivery,
  including its capitalized fee. Checkpoints preserve that opening amount
  separately from current cost, so later adjustments or disposals cannot change
  the historical incoming flow. Its acquisition price, date, rates and purchase
  charges retain the source lot's history.
- Costs keep the sender's historical rates to the base currency, as opened lots
  do, whether or not a rate exists on the transfer day. A cover's proceeds in
  base are that delivered cost even when the covered short's own cost has no
  rate; its realized P&L in base is then unknown (R3.4).
- Fixtures: EDGE-TXF-15, EDGE-TXF-16, EDGE-TXF-17, EDGE-TXF-18, EDGE-TXF-20,
  EDGE-TXF-21, EDGE-TXF-22, EDGE-MIX-06, EDGE-MIX-07.

**R2.5 Moving a short** is a liability changing hands: sending it is money in,
receiving it money out. The receiver books the short units its activity records,
those the sender lacked at the transfer's price (R2.1). Fixtures: EDGE-TXF-07,
EDGE-TXF-08, EDGE-TXF-23.

## 3. Dates and currencies

**R3.1** An activity's day is its business date in the portfolio's time zone.

**R3.2** A quote's timestamp is an instant in UTC (one without a time zone means
UTC), and its day is that instant's UTC date. Normal writes store both
consistently; synced rows are normalized where applied (R6.1).

**R3.3** A sale's or cover's proceeds convert to the base currency at the
disposal day's rate; costs at their acquisition rate, so realized P&L in base
includes the currency move. Exception: transfer legs (R2.4).

**R3.4** A rate is the direct pair's (or its inverse's) observation on the day,
else its nearest observation before or after (on a tie, the one before), however
far. Without any direct observation, it goes through other currencies by the
path with the fewest hops (equal paths in currency-code order), each hop at its
own nearest observation. Only when no path exists at all is an amount in the
base currency unknown: it is recorded as zero, with a currency warning.

**R3.5** Realized P&L is every disposal that realizes, whatever closed it: a
sale or cover, an option's expiry, or units a transfer delivers into an opposite
position (a short covered by arriving shares, or a long closed by an arriving
short). A transfer out moves its lots at their cost and realizes nothing (R2.4).
The previous calculator kept BUY and SELL disposals only. A purchase's charges
count once, as fees where they were paid: attribution adds them back to the P&L
of the lots that carry them, including a lot a transfer moved within the scope
(it keeps its purchase date and charges) and a cover such a lot makes (the
charges the transfer out took less those its lots arrived with). Fixtures:
NOM-OPT-01, NOM-TXF-02, NOM-TXF-04, EDGE-TXF-10, EDGE-POS-06.

## 4. Dated reads

**R4.1** A dated read equals the full read on every day after its first; its
first day carries no flow.

**R4.2** Units in transit between the legs of a transfer spread over several
days belong to neither account. A window starting between the legs reads their
return as gain; a window spanning both legs is unaffected (§8).

## 5. What invalidates what

Every fact the engine reads leaves a marker in `projection_state` when it
changes, in the same transaction, from the earliest day it can affect. `GENESIS`
is `0001-01-01`; `@all` refolds every account from `GENESIS`.

| Fact              | Change                                                                                            | Marker and earliest day                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account           | insert                                                                                            | the account, from `GENESIS` (sync can deliver its snapshots first)                                                                                                                             |
| Account           | currency, type, tracking mode, archived, accounting settings in meta as the job reads them (R7.2) | the account, from `GENESIS`                                                                                                                                                                    |
| Activity          | insert, update, delete (any field)                                                                | old and new accounts, from the day before their old and new dates; transfer partners likewise; a split's old and new assets from `GENESIS`                                                     |
| Asset             | insert                                                                                            | its holders, from `GENESIS` (sync can deliver snapshots naming it first); an FX asset whose rates arrived before it (a sync batch defers foreign keys): its conversions from its earliest rate |
| Asset             | kind, quote currency, instrument type, option, contract multiplier                                | its holders, from `GENESIS`                                                                                                                                                                    |
| Asset             | an FX asset's pair (`instrument_symbol`, `quote_ccy`), or an asset becoming or ceasing to be FX   | `@all`                                                                                                                                                                                         |
| Asset             | delete                                                                                            | as its kind was: its holders from `GENESIS`, or `@all` for an FX asset                                                                                                                         |
| Quote             | insert, update, delete                                                                            | its asset's prices (an FX asset's: conversions) from the earliest of its old and new `day` and timestamp dates; old and new assets when reassigned                                             |
| Observed snapshot | insert, update, delete                                                                            | its account from its date; old and new accounts, each from its own date, when reassigned                                                                                                       |
| Snapshot position | insert, update, delete                                                                            | its old and new snapshots' accounts, each from its snapshot's date                                                                                                                             |
| Settings          | base currency or time zone inserted, changed, renamed to or from, or deleted                      | `@all`                                                                                                                                                                                         |

Everything that decides what the engine reads, or which results to mark stale,
reads an activity's type as the engine does: its override when the override is
not blank (blank: empty or only whitespace, as Rust's `str::trim` strips it),
else its stored type. That covers the engine's facts, core's
`effective_activity_type`, the triggers and the split query; the activity
repository's queries and the frontend read it the same way, and every write
stores an override as it reads (R6.3). A run consumes a marker only after
writing what it covers. An account or asset that arrives after facts naming it
marks itself on insert (rows above), so a run that could not project it yet
projects it once it exists.

## 6. Data normalized where written

**R6.1** When sync applies a quote, incrementally or by restoring a snapshot,
its timestamp is rewritten as a UTC instant and its day set from it (R3.2). A
synced quote whose timestamp cannot be read is skipped, with a log entry. When
two quotes would then share an asset, day and source (a quote's id names its
day, so only a row whose day disagreed with its timestamp can), the row already
at that day is kept and the other skipped with a log entry; among rows a restore
rewrites, the lowest id is kept. Synced quote updates carry complete rows. Rows
already stored are not repaired: local writes keep them consistent, and only
sync could have written inconsistent ones.

**R6.2** Sync may move a quote to another asset or a snapshot to another
account; both owners are invalidated (§5).

**R6.3** An activity's type override is stored as it reads (§5): trimmed, and as
none when blank. An edit, a synced activity or broker edit, and a snapshot
restore each store it so. Rows already stored are not repaired: the app's own
forms never stored a blank or untrimmed override (an API caller could have
stored an untrimmed one by editing a broker activity with a padded type), and
editing a row, or receiving it by device sync, stores its override as it reads.

## 7. Cost basis methods

**R7.1 What a method decides.** An account's cost basis method decides only
which of its lots a disposal relieves, and how much of each lot's units and cost
leave with them: a sale, a cover, a transfer out, an option expiry. It also
decides which delivered units cover a short when a transfer arrives into one. It
never changes the units held, cash or prices. What it moves is cost: the cost a
transfer carries (R2.4), and the flows and net contribution valued at that cost,
follow the lots it relieves. Each lot keeps its acquisition date, its historical
rates and its source, so realized P&L in base follows from the lots relieved
(R3.3); under WAC a pool keeps its members' book cost instead (R7.2).

**R7.2 The methods the engine computes.**

- FIFO: lots are relieved oldest first, and delivered units cover a short in the
  order the sender gave them.
- LIFO: lots are relieved newest first, by acquisition. A lot a paired transfer
  delivers keeps the date it was bought, not the day it arrived (a slice of a
  WAC pool, the pool's earliest); units that arrive without a lot (an external
  transfer in, or what a sender lacked, R2.1) open a lot dated on arrival.
  Delivered units cover a short newest first. Lots acquired at the same instant
  go in reverse of the order they opened. Fixtures: NOM-CB-02, EDGE-CB-08,
  EDGE-CB-09.
- HIFO: lots with the highest cost per unit are relieved first: cost in the
  position currency, charges included, per unit held after splits, for short
  lots as for long ones. Costs compare at 15 significant digits, so equal costs
  reached by different divisions tie. Ties go to the earliest acquisition, then
  in the order FIFO takes them. Delivered units cover a short in the same order.
  Fixtures: NOM-CB-03, EDGE-CB-06, EDGE-CB-07.
- WAC (moving weighted average), as a pool, the way the UK's section 104 holding
  and Italy's _costo medio_ are kept:
  - Before a disposal, or a return of capital (a disposal of no units, R7.4), a
    position's lots on the relieved side merge into one pool: the lots no
    disposal has relieved join the lot a disposal has (the pool), or the
    earliest of them forms it. The pool holds their units after splits, their
    cost and charges, and their book cost in the account and base currency (its
    rates are that book cost over its cost). It keeps the id of the lot it
    formed from, so the disposals naming it stay valid, the earliest acquisition
    date, and no source; what it holds when it forms is its original, and its
    price is its cost less charges per unit.
  - A disposal takes the same share of every lot it relieves, so the cost it
    relieves is the position's average cost, in its currency and in base, and
    the average after it is the average before it; a purchase re-averages at the
    next disposal. Each sale is one disposal row, however many purchases built
    the pool.
  - A lot stays apart, relieved in the same share as the pool, when merging
    would change what it is worth or what reads it: one whose book cost has no
    rate, one bought on the day of a split the account records (the split must
    not reach it), one a transfer delivered (the transfer is valued from the
    lots it opened, R2.4), or a second relieved lot (its disposals name it).
  - A lot left with less than the dust closes only when the side keeps less than
    the dust: the side's dust, not each lot's.
  - A transfer out carries a slice of the pool: the average cost as one lot
    dated at the pool's earliest acquisition, which the receiver disposes of by
    its own method. Delivered units cover a WAC account's short alike, the same
    share of every delivered lot.
  - Attribution: a pooled purchase has no lot of its own, so its charge (what of
    it opened units) counts in its window; what the window's sales relieve from
    a pool, at the pool's charge per unit and at most those charges, is
    realized, the rest unrealized.
  - Fixtures: NOM-CB-01, EDGE-CB-01 to EDGE-CB-05.

An account's settings name its method, and the engine alone says which methods
it computes: an account set to another is refused (`UNSUPPORTED_COST_BASIS`) and
its results are not written; where another account needs it folded (a transfer
partner), it is folded FIFO. Each account's settings are read on their own. An
account with none (no meta, or no `accounting` entry in it) takes the defaults,
FIFO. Settings this version cannot read are refused the same way and never read
as the defaults: meta that is not JSON, an `accounting` entry that is not an
object, or a code it does not know, such as one a newer version wrote. Only a
failed database read fails the whole job. Changing an account's method refolds
it (§5). Fixtures: every other fixture is FIFO.

**R7.3 What a new method must respect.**

- Within the account: its results depend only on its own facts and the transfers
  it takes part in (architecture §4.8). Pooling lots across accounts is not
  supported.
- Forward only: a disposal's relief depends only on the account's lots when it
  happens, never on later activities. Rules that look ahead (Canada's
  superficial loss rule) are not supported.
- Cost is conserved: the cost relieved plus the cost that remains equals the
  cost before, in the position's currency and in base.
- Chosen from the account's lots alone: choosing specific lots for each disposal
  needs disposals to name their lots, which the facts do not carry, so it needs
  its own design first, as pooling and look-ahead rules do.
- A method is added with its entry here, hand-worked fixtures, and every
  property law passing under it (§9).

**R7.4 Returns of capital and notional distributions.** These are per-account
book-cost and performance calculations under the selected cost basis method. The
user or broker supplies the distribution's classification; the engine does not
determine taxable income or apply country-specific tax rules. Tax reporting may
require different lot allocation, cross-account pooling or other adjustments
(see §8).

A return of capital pays back part of the investor's capital. It reduces book
cost, and any amount beyond the remaining basis is recorded as realized P&L. A
notional distribution records income reinvested without additional units: it
increases both income and book cost by the entered amount. It is not a general
basis correction, nor does it represent every non-cash tax event.

Canadian fund distributions provide examples: a positive T3 box 42 amount
reduces ACB, while a negative amount increases it. A reinvested distribution may
issue and immediately consolidate units, leaving the holding's units unchanged.
The CRA and IRS examples in the fixtures illustrate supported scenarios; they do
not establish general tax compliance. The activities are recorded as:

- DIVIDEND with subtype `RETURN_OF_CAPITAL`: a distribution paid in cash that is
  capital. It books its cash as a dividend does and is no income; its fee and
  tax are charges. It recovers its gross amount (cash plus fee and tax) of cost.
- ADJUSTMENT with subtype `RETURN_OF_CAPITAL`: the capital part of distributions
  already recorded as dividends, known later (box 42, a broker's cost-only ROC
  row). No cash. It recovers its amount of cost and takes that amount out of
  income.
- ADJUSTMENT with subtype `NOTIONAL_DISTRIBUTION`: no cash and no units. It adds
  its amount to cost and to income.

Both adjustment subtypes require an asset on save and import. A malformed stored
row without an asset is rejected by the fold and contributes no income. These
subtypes accept spaces and hyphens in place of underscores, consistently in the
engine and reporting readers; new saves use the canonical spelling. Unknown
provider labels are preserved.

How each moves cost:

- The amount converts to the position's currency as a trade's price does (its
  own rate when one side is the account's currency, else the day's). It acts on
  the cost basis the account's method keeps. A return of capital is a disposal
  of no units: under WAC the lots pool first where R7.2 permits it. Lots kept
  separate for transfer or split history still form one basis pool in each
  currency: the amount recovers their basis in proportion to book cost, with
  only the pool's excess spread by units and realized. Thus nothing is realized
  while the combined basis covers the amount. Under FIFO, LIFO and HIFO the
  engine's allocation convention spreads it over the long lots by their units
  after splits, so every unit's cost moves alike. A notional distribution is a
  purchase of no units: like a purchase, it does not pool, and it spreads over
  the long lots by units. Lots keep their order by cost per unit for HIFO (lots
  a return of capital takes to zero then tie).
- Each lot's cost moves by its share in the position's currency, and its book
  cost in the account and base currency by the share at the distribution day's
  rate. The CRA converts the ACB "using the exchange rate in effect at the time
  the property was acquired and returns of capital were received", and a
  reinvested distribution counts at its own date. The lot keeps that book cost
  apart from its acquisition rates, so its purchase price and charges, and what
  its purchase and charges cost in the account and base currency, stay as
  bought. A receiving lot records its opening book cost separately (R2.4). A
  disposal takes its units' share of the book cost. A transfer that covers an
  opposite position divides those book costs between the covered and remaining
  units. A capitalized transfer fee increases explicit book costs at the carried
  acquisition rates, following the existing transfer-fee policy (R2.4). A zero
  cost in one currency does not discard a nonzero cost in another; known zero
  base cost remains valid for realized P&L.
- Known distribution proceeds do not make an unknown acquisition base cost
  known. Like an ordinary sale (R3.4), its base realized P&L remains zero when
  either proceeds or relieved base cost is unknown; known proceeds are retained.
- A return of capital realizes nothing while the basis covers it. When a share
  exceeds the basis in either currency, the basis there goes to zero and the
  excess is realized P&L, recorded as a disposal row with no units: its proceeds
  are the share, its cost what the basis covered. With no units left (the
  distribution's record date preceded a sale), all of it is realized P&L on the
  lot the account's last disposal of the asset closed.
- A notional distribution raises the cost and book cost by the share and
  realizes nothing.
- Neither moves units, net contribution or flows. Income moves by the amount:
  down for a return of capital adjustment, not at all for a cash return of
  capital, up for a notional distribution. The unrealized P&L the cost change
  causes, plus any realized P&L, adds back to that, so the gain is the change in
  value.
- It is rejected, changing nothing in the fold or in performance (architecture
  §4, per-activity atomicity), when the account has never held the asset (a
  return of capital) or holds no units of it (a notional distribution), or when
  the amount has no rate into the position's currency or, for a notional
  distribution, into the account and base currency. A return of capital with no
  day's rate into a currency reduces the book cost there with the cost, and its
  base attribution is zero. Every reader follows the rejection: performance and
  holdings income leave the activity out.
- The asset page requests closed holdings too and uses their calculated income,
  so a fully sold position follows the same reclassification and rejection
  rules.
- Fixtures: EDGE-ROC-01 to EDGE-ROC-05; and the Canadian worked examples
  NOM-ACB-01 (the CRA's mutual fund ACB chart, with a T3 box 42 return of
  capital), NOM-ACB-02 (the CRA's negative ACB example), NOM-ACB-03 (a phantom
  distribution, and one paid as a return of capital) and NOM-ACB-04 (the ACB is
  the pool's average). These single-account CAD examples illustrate average
  basis; a taxpayer's ACB may require pooling across accounts.

## 8. Known limits

- Holdings mode assumes trades and transfers happen at snapshot prices: a price
  move between a trade (or a transfer, R2.3) and the next snapshot reads as
  money in or out.
- A dividend recorded in a holdings account between snapshots reads as money in
  at the next snapshot, as an unrecorded one does (R1.2: activities never change
  a holdings account's numbers).
- Units in transit between transfer legs are not valued (R4.2).
- Two splits of one asset recorded within a day of each other read as one, and
  rows recording one split more than a day apart count as two (R1.5).
- A split is entered on a holdings account with the activity form; importing a
  CSV from a holdings account imports snapshots.
- A transfer's fee comes off its flow at the opened lots' rates weighted by
  their units today: a later split that reaches only some of those lots (the
  others closed before it) shifts that weighting, by a part of the fee (R2.4).
- A split recorded on one transactions account does not split another's lots
  (R1.5): each account records its own.
- A WAC pool's lot row records what the pool held when it last formed as its
  original, and the purchases it absorbed have no row of their own (their
  activities remain). A window's purchase charges in a pool are split between
  realized and unrealized at the pool's charge per unit, not purchase by
  purchase (R7.2).
- HIFO ranks lots by cost alone, in the position currency: it does not weigh
  holding periods (long- or short-term), as some brokers' tax optimizers do, and
  after FX moves the dearest lot in the base currency can be another. On a short
  position it closes the short sold at the highest price first, which realizes
  the most gain (R7.2).
- Income reports list the dividends received. A DIVIDEND with subtype
  `RETURN_OF_CAPITAL` is no income there either, but an ADJUSTMENT that later
  reclassifies part of a dividend as capital does not change the dividend row it
  reclassifies (R7.4).
- A WAC pool formed after a return of capital that took its lots' cost below
  their charges shows a negative price: a pool's price is its cost less charges
  per unit (R7.2, R7.4).
- WAC is per account: the same security in two WAC accounts is two pools.
  Jurisdictions that pool across accounts (Canada's ACB, France's PMP) or match
  later purchases (the UK's 30-day rule) need a tax report over all accounts
  (R7.3).
- An override stored blank or untrimmed before R6.3 keeps that form until its
  row is next edited or received by device sync. Until then, a reader that does
  not trim it (the addon SDK's `getEffectiveType` and `hasUserOverride`, broker
  sync's split check) reads a blank one as a type, or keeps the whitespace
  around another.
- The §5 trigger accepts some JSON the job's reader rejects: a lone surrogate
  escape, a number beyond a double, nesting deeper than 128 levels. A change
  elsewhere in an account's meta that adds one leaves no marker, and the account
  keeps its last results until a later run, for another change or a new day,
  refuses it (R7.2).

## 9. How tests use these rules

- Each rule's fixtures carry expected values worked out by hand in their
  `expected_notes`, and the goldens pin them.
- Property laws state rules over every scenario, under every cost basis method
  the engine computes and with the methods mixed across its accounts in every
  rotation (`@MIXED`, `@MIXED+1`, …), so transfers pair accounts on different
  methods (R7.3). Where a law compares the engine with itself (determinism,
  windows, renaming), it proves consistency, not these rules; the fixtures above
  prove the rules.
- §5 is checked mechanically: a storage test changes every column the engine
  reads, one at a time, and fails unless the change leaves the marker scope and
  earliest day the table states.
