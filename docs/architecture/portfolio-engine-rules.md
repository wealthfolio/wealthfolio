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
(R3.3).

**R7.2 The methods the engine computes.** FIFO: lots are relieved oldest first,
and delivered units cover a short in the order the sender gave them. An
account's settings name its method, and the engine alone says which methods it
computes: an account set to another is refused (`UNSUPPORTED_COST_BASIS`) and
its results are not written; where another account needs it folded (a transfer
partner), it is folded FIFO. Each account's settings are read on their own. An
account with none (no meta, or no `accounting` entry in it) takes the defaults,
FIFO. Settings this version cannot read are refused the same way and never read
as the defaults: meta that is not JSON, an `accounting` entry that is not an
object, or a code it does not know, such as one a newer version wrote. Only a
failed database read fails the whole job. Changing an account's method refolds
it (§5). Fixtures: every fixture is FIFO.

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
  the engine computes (R7.3). Where a law compares the engine with itself
  (determinism, windows, renaming), it proves consistency, not these rules; the
  fixtures above prove the rules.
- §5 is checked mechanically: a storage test changes every column the engine
  reads, one at a time, and fails unless the change leaves the marker scope and
  earliest day the table states.
