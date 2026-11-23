//! Holdings, lots, realised gains, manual prices and income.

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceRow {
    date: NaiveDate,
    asset_id: String,
    symbol: Option<String>,
    name: Option<String>,
    price: Decimal,
    open: Decimal,
    high: Decimal,
    low: Decimal,
    currency: String,
    source: String,
    notes: Option<String>,
}

impl DataExportService {
    pub(super) async fn holding_records(
        &self,
        format: ExportFileFormat,
    ) -> Result<Vec<ExportRecord>> {
        let base_currency = self.base_currency();
        let resolved = self
            .sources
            .portfolios
            .resolve_account_scope(&AccountScope::All, &base_currency)?;
        let accounts = self
            .sources
            .accounts
            .get_accounts_by_ids(&resolved.account_ids)?;
        let account_ids = self.holdings_account_ids(&accounts, true);
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let holdings = if account_ids.len() == 1 {
            self.sources
                .holdings
                .get_holdings(&account_ids[0], &base_currency)
                .await?
        } else {
            self.sources
                .holdings
                .get_holdings_for_accounts(&account_ids, &base_currency, &resolved.scope_id)
                .await?
        };
        let records = holdings
            .into_iter()
            .map(HoldingListItem::from)
            .collect::<Vec<_>>();
        match format {
            ExportFileFormat::Csv => ExportRecord::from_records(
                &records
                    .into_iter()
                    .map(HoldingExportRow::from)
                    .collect::<Vec<_>>(),
            ),
            ExportFileFormat::Json => ExportRecord::from_records(&records),
        }
    }

    pub(super) fn holdings_account_ids(
        &self,
        accounts: &[Account],
        include_archived: bool,
    ) -> Vec<String> {
        accounts
            .iter()
            .filter(|account| include_archived || !account.is_archived)
            .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Holdings))
            .map(|account| account.id.clone())
            .collect()
    }

    /// Leading label columns for rows that only carry ids.
    pub(super) fn labels(
        account_id: &str,
        asset_id: &str,
        accounts: &HashMap<String, String>,
        assets: &HashMap<String, Asset>,
    ) -> ExportRecord {
        let asset = assets.get(asset_id);
        ExportRecord::new()
            .with("accountName", accounts.get(account_id).cloned())
            .with("symbol", asset.and_then(asset_symbol))
            .with("assetName", asset.and_then(|asset| asset.name.clone()))
    }

    pub(super) async fn lot_records(
        &self,
        lookups: &Lookups,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let account_ids = lookups.exported_account_ids(options);
        let accounts = &lookups.account_names;
        let assets = &lookups.assets;
        let mut lots = self
            .sources
            .lots
            .get_all_lots()
            .await?
            .into_iter()
            .filter(|lot| account_ids.contains(&lot.account_id))
            .collect::<Vec<_>>();
        lots.sort_by(|a, b| (&a.open_date, &a.id).cmp(&(&b.open_date, &b.id)));
        lots.iter()
            .map(|lot| {
                let mut record = Self::labels(&lot.account_id, &lot.asset_id, accounts, assets);
                record.extend(ExportRecord::from_record(lot)?);
                Ok(record)
            })
            .collect()
    }

    pub(super) async fn realized_gain_records(
        &self,
        lookups: &Lookups,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        let account_ids = lookups
            .exported_account_ids(options)
            .into_iter()
            .collect::<Vec<_>>();
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let floor = NaiveDate::from_ymd_opt(1900, 1, 1).expect("1900-01-01 is a valid date");
        let start_exclusive = options
            .start_date
            .and_then(|date| date.pred_opt())
            .unwrap_or(floor);
        let end = options.end_date.unwrap_or(today);
        let accounts = &lookups.account_names;
        let assets = &lookups.assets;
        let mut disposals = self
            .sources
            .lots
            .get_lot_disposals_for_accounts_in_date_range(&account_ids, start_exclusive, end)
            .await?;
        disposals.sort_by(|a, b| (&a.disposal_date, &a.id).cmp(&(&b.disposal_date, &b.id)));
        disposals
            .iter()
            .map(|disposal| {
                let mut record =
                    Self::labels(&disposal.account_id, &disposal.asset_id, accounts, assets);
                record.extend(ExportRecord::from_record(disposal)?);
                Ok(record)
            })
            .collect()
    }

    pub(super) fn manual_price_records(
        &self,
        lookups: &Lookups,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let mut assets = lookups
            .assets
            .values()
            .filter(|asset| !asset.is_alternative())
            .collect::<Vec<_>>();
        assets.sort_by_key(|asset| asset_symbol(asset));
        let mut rows = Vec::new();
        for asset in &assets {
            // Prices the user entered or imported, on any asset: an override on
            // a market-priced asset counts, provider history on a manual one doesn't.
            let mut quotes = self.sources.quotes.get_manual_quotes(&asset.id)?;
            quotes.sort_by_key(|quote| quote.timestamp);
            for quote in quotes {
                let date = quote.timestamp.date_naive();
                if !options.in_range(date) {
                    continue;
                }
                rows.push(PriceRow {
                    date,
                    asset_id: asset.id.clone(),
                    symbol: asset_symbol(asset),
                    name: asset.name.clone(),
                    price: quote.close,
                    open: quote.open,
                    high: quote.high,
                    low: quote.low,
                    currency: quote.currency,
                    source: quote.data_source,
                    notes: quote.notes,
                });
            }
        }
        ExportRecord::from_records(&rows)
    }

    /// Income per month and account, from the income screen's all-time view.
    pub(super) fn income_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let summaries = self.sources.income.get_income_summary(None)?;
        let Some(all) = summaries.iter().find(|summary| summary.period == "ALL") else {
            return Ok(Vec::new());
        };
        // Income in a currency with no rate is left out of the totals.
        let unconverted = all
            .unconverted_currencies
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        let mut rows = all
            .by_account
            .values()
            .flat_map(|account| {
                account.by_month.iter().map(move |(month, amount)| {
                    (
                        month.clone(),
                        account.account_name.clone(),
                        account.account_id.clone(),
                        *amount,
                    )
                })
            })
            .filter(|(month, _, _, amount)| !amount.is_zero() && month_in_range(month, options))
            .collect::<Vec<_>>();
        rows.sort();
        Ok(rows
            .into_iter()
            .map(|(month, account_name, account_id, amount)| {
                ExportRecord::new()
                    .with("month", month)
                    .with("accountName", account_name)
                    .with("accountId", account_id)
                    .with("income", decimal_value(amount))
                    .with("currency", all.currency.clone())
                    .with("unconvertedCurrencies", unconverted.clone())
            })
            .collect())
    }

    /// Income from each holding: all time, this year and the two years before.
    pub(super) fn income_by_source_records(&self) -> Result<Vec<ExportRecord>> {
        let summaries = self.sources.income.get_income_summary(None)?;
        let period = |name: &str| summaries.iter().find(|summary| summary.period == name);
        let Some(all) = period("ALL") else {
            return Ok(Vec::new());
        };
        let in_period = |name: &str, asset_id: &str| {
            period(name)
                .and_then(|summary| summary.by_asset.get(asset_id))
                .map_or(Decimal::ZERO, |asset| asset.income)
        };
        let mut assets = all.by_asset.values().collect::<Vec<_>>();
        assets.sort_by(|a, b| {
            b.income
                .cmp(&a.income)
                .then_with(|| a.symbol.cmp(&b.symbol))
        });
        Ok(assets
            .into_iter()
            .map(|asset| {
                ExportRecord::new()
                    .with("symbol", asset.symbol.clone())
                    .with("name", asset.name.clone())
                    .with("kind", asset.kind.clone())
                    .with("assetId", asset.asset_id.clone())
                    .with("incomeAllTime", decimal_value(asset.income))
                    .with("dividendsAllTime", decimal_value(asset.dividend_income))
                    .with(
                        "incomeThisYear",
                        decimal_value(in_period("YTD", &asset.asset_id)),
                    )
                    .with(
                        "incomeLastYear",
                        decimal_value(in_period("LAST_YEAR", &asset.asset_id)),
                    )
                    .with(
                        "incomeTwoYearsAgo",
                        decimal_value(in_period("TWO_YEARS_AGO", &asset.asset_id)),
                    )
                    .with("currency", all.currency.clone())
                    .with(
                        "unconvertedCurrencies",
                        all.unconverted_currencies
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
            })
            .collect())
    }
}
