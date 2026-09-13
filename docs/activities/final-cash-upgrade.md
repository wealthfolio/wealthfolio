# Upgrade notes: authoritative final cash (v3.8)

From this version, an activity's **amount** is the final cash that moved,
including fees and taxes. Readers book it as-is; nothing re-derives it at read
time. On first launch after upgrading, a one-shot migration rewrites legacy rows
to this contract. Make a normal database backup before updating. The application
does not create a potentially large automatic startup backup. What you may
notice:

## Some historical amounts were corrected or flagged

- A trade whose stored amount was the pre-fee **gross** now stores the final
  total (for example, a buy of `10 × $100` with a `$9.99` fee changes from
  `$1,000` to `$1,009.99`). The replaced value is recorded on the row's metadata
  (`final_cash_migration.legacy_amount`) so you can inspect the previous value.
- A trade whose stored amount **contradicts** its own quantity × price ± charges
  keeps your number untouched and is flagged for review instead.
- Flagged rows appear in the review banner on the Activities page; open each one
  and confirm its asset, type, and final amount.

## Activity and asset currencies

The activity currency denominates every monetary transaction field, including
unit price, amount, fee, and tax. The asset quote currency is independent market
valuation metadata, so a CAD activity for a USD-quoted asset still derives its
final cash from its CAD quantity, price, and charges. FX is only used later when
the activity cash must be converted into the account currency.

An activity still requires review when its final cash cannot be established from
complete inputs and a trustworthy asset multiplier. The migration never guesses
a missing option or bond scale.

## Fees on plain cash entries no longer subtract

For deposits, withdrawals, and cash transfers, the amount **is** the ledger. A
separate fee column on such a row is informational and no longer reduces the
balance. If a $1,000 transfer actually moved $985, the truth is `amount = 985`.
Rows where this changes the historical balance were flagged for review rather
than rewritten.

## Contract multipliers

- The **asset** owns its contract multiplier. The multiplier field on the option
  form seeds a brand-new asset when it is first created; on an asset that
  already exists it has no effect, and cash, cost basis, and market value all
  follow the asset's value.
- A pre-existing row whose stored total was entered at a different scale than
  its asset says cannot be verified, so the upgrade keeps your number and flags
  the row for review. Correct the asset's multiplier and re-enter the total, or
  record the differently-scaled contract as its own asset.
- Bonds default to a multiplier of 1 (provider quotes are stored as a fraction
  of par). Percent-of-par pricing is opt-in per asset via `contractMultiplier`
  metadata.

## CSV import

Imported rows now pass the same writer policy as every other entry surface: a
missing trade total is derived, a gross total is converted to final, and a
contradicting total is kept but flagged. A row whose final cash cannot be
established is imported as a **draft** for review instead of silently booking
zero.

## Review and zero amounts

The upgrade preserves lifecycle status. `needs_review` is a separate flag, so
Posted activities still count while flagged. A Posted row with no final amount
has no runtime cash movement until corrected. Legacy Draft rows are added to the
review queue without becoming Posted.

Legacy zero trade totals are treated as missing when trustworthy inputs can
calculate a final total. This is an upgrade-only rule; a user-confirmed zero
remains zero during normal use.

Affected accounts rebuild their holdings and valuation histories. Failed
rebuilds remain pending and retry on a later launch. Update all synced devices
before recording more activities: each device runs its own migration and the
rewrites do not emit sync events.

For field meanings and examples, see the
[Activity Fields reference](https://wealthfolio.app/docs/concepts/activity-fields/).
