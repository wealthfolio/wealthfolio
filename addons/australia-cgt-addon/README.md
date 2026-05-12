# Australia CGT Planner Addon

Australia CGT Planner is a Wealthfolio addon for Australian capital gains tax
planning and reconciliation. It is not tax advice and it is not a complete tax
return engine.

The addon is designed for simple AUD activity review first: it helps users see
matched parcels, income-year summaries, local AMMA/AMIT adjustments, and records
that need manual review before an accountant or tax lodgement workflow.

## Current Scope

- AUD BUY/SELL activity matching.
- FIFO parcel matching by symbol and account ID, with account name as fallback.
- Australian income-year summaries.
- Capital losses applied before discount, including losses carried forward from
  earlier report years.
- Current-law 50 percent CGT discount eligibility using the ATO 12-month timing
  rule that excludes both acquisition day and CGT event day.
- Simple AMMA/AMIT cost-base increases and decreases per parcel and income year.
- Dividend franking percentage from the `australiaCgt.frankingPercentage`
  activity metadata field, shown for review only.
- 30 June 2027 market-value snapshots for transition planning.
- ABS quarterly CPI fetch and local cache for planning inputs.
- Warnings for unmatched sells, non-AUD BUY/SELL activity, and unmodelled
  activity types.

## Limitations

- Not tax advice.
- Uses FIFO only. It does not yet support taxpayer-selected parcel
  identification or optimisation.
- Does not convert foreign-currency CGT amounts. Non-AUD BUY/SELL activity is
  excluded and surfaced for review.
- Does not model corporate actions such as splits, consolidations, DRPs, bonus
  shares, buy-backs, demergers, takeovers, returns of capital, rights issues, or
  liquidations.
- AMMA/AMIT support is limited to simple net cost-base movements. It does not
  implement every AMMA/SDS field or every edge case.
- Franking data is display-only. The addon does not calculate dividend tax,
  franking credit gross-up, or tax offsets.
- Budget 2026-27 transition support is provisional. The addon stores CPI and
  30 June 2027 snapshot inputs and reports pre-transition parcels, but it does
  not yet calculate post-2027 indexed disposals end to end.
- ESS, crypto, foreign-resident CGT rules, and non-CGT income-tax outcomes are
  outside the current scope.
- Opening capital losses from years before the imported Wealthfolio history are
  not yet a separate input.

## Privacy and Storage

Addon tax data is stored locally by the addon in browser local storage. This
includes AMMA records, CPI observations, transition snapshots, and manual
acquisition-date overrides.

Refreshing CPI fetches public ABS quarterly CPI data from the ABS API. No
portfolio data is sent to ABS by this addon.

## Example Workflow

1. Import AUD activity history into Wealthfolio.
2. Open Australia CGT Planner from the sidebar.
3. Review unmatched sells, unsupported non-AUD activity, and ignored activity
   warnings.
4. Add AMMA/AMIT parcel adjustments from annual statements where relevant.
5. Add 30 June 2027 parcel market values for transition planning.
6. Export the matched-lot CSV for accountant review or reconciliation.

## Development

```bash
pnpm --filter australia-cgt-addon test
pnpm --filter australia-cgt-addon type-check
pnpm --filter australia-cgt-addon build
```

Full app acceptance should use the dedicated Wealthfolio E2E harness:

```bash
pnpm test:e2e:australia-cgt-addon
```
