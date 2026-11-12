//! Manual assets and liabilities, their valuations and loan payments, and
//! the net worth and portfolio histories.

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlternativeAssetRow {
    id: String,
    kind: Value,
    name: String,
    currency: String,
    value: Decimal,
    valuation_date: NaiveDate,
    purchase_price: Option<Decimal>,
    purchase_date: Option<NaiveDate>,
    unrealized_gain: Option<Decimal>,
    unrealized_gain_pct: Option<Decimal>,
    linked_asset_id: Option<String>,
    linked_asset_name: Option<String>,
    notes: Option<String>,
    loan_original_amount: Option<f64>,
    loan_annual_rate: Option<f64>,
    loan_payment_amount: Option<f64>,
    loan_frequency: Option<Value>,
    loan_renewal_maturity: Option<NaiveDate>,
    loan_interest_to_date: Option<f64>,
    details: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetValuationRow {
    date: NaiveDate,
    asset_id: String,
    name: String,
    kind: Value,
    value: Decimal,
    currency: String,
    source: String,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoanPaymentRow {
    date: NaiveDate,
    loan_id: String,
    loan_name: String,
    amount: f64,
    escrow: f64,
    applies_to: Option<Value>,
    activity_id: String,
    account_id: String,
    account_name: Option<String>,
}

/// Asset categories of the net worth breakdown, in the order the net worth
/// screen lists them. Liabilities are separate columns, one per liability.
const NET_WORTH_CATEGORIES: [AssetCategory; 7] = [
    AssetCategory::Cash,
    AssetCategory::Investment,
    AssetCategory::Property,
    AssetCategory::Vehicle,
    AssetCategory::Collectible,
    AssetCategory::PreciousMetal,
    AssetCategory::Other,
];

/// Net worth history as flat spreadsheet rows: totals first, then one
/// column per breakdown entry, the same columns on every row.
fn net_worth_csv_records(
    history: &[NetWorthHistoryPoint],
    labels: &[(String, String)],
) -> Vec<ExportRecord> {
    history
        .iter()
        .map(|point| {
            let mut record = ExportRecord::new()
                .with("date", point.date.format("%Y-%m-%d").to_string())
                .with("currency", point.currency.clone())
                .with("netWorth", decimal_value(point.net_worth))
                .with("totalAssets", decimal_value(point.total_assets))
                .with("totalLiabilities", decimal_value(point.total_liabilities))
                .with("portfolioValue", decimal_value(point.portfolio_value))
                .with(
                    "alternativeAssetsValue",
                    decimal_value(point.alternative_assets_value),
                )
                .with("netContribution", decimal_value(point.net_contribution));
            for (key, label) in labels {
                let value = point.breakdown.get(key).copied().unwrap_or(Decimal::ZERO);
                record.set(label, decimal_value(value));
            }
            record
        })
        .collect()
}

/// The earlier of two optional dates; a missing one doesn't count.
fn earlier(a: Option<NaiveDate>, b: Option<NaiveDate>) -> Option<NaiveDate> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

impl DataExportService {
    pub(super) fn alternative_asset_records(&self, today: NaiveDate) -> Result<Vec<ExportRecord>> {
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let names = holdings
            .iter()
            .map(|holding| (holding.id.clone(), holding.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut rows = Vec::with_capacity(holdings.len());
        for holding in &holdings {
            // Interest paid so far is a fact about the past; the payoff date
            // and future instalments are forecasts and stay on the loan screen.
            let interest_to_date = match (&holding.loan, &holding.metadata) {
                (Some(_), Some(metadata)) => {
                    let quotes = self.sources.quotes.get_historical_quotes(&holding.id)?;
                    let payments = self
                        .sources
                        .alternative_assets
                        .get_loan_payments(&holding.id)?;
                    loan_calculation(metadata, &quotes, &payments, today)
                        .map(|calculation| calculation.interest_to_date)
                }
                _ => None,
            };
            rows.push(AlternativeAssetRow {
                id: holding.id.clone(),
                kind: kind_value(&holding.kind),
                name: holding.name.clone(),
                currency: holding.currency.clone(),
                value: holding.market_value,
                valuation_date: holding.valuation_date.date_naive(),
                purchase_price: holding.purchase_price,
                purchase_date: holding.purchase_date,
                unrealized_gain: holding.unrealized_gain,
                unrealized_gain_pct: holding.unrealized_gain_pct,
                linked_asset_id: holding.linked_asset_id.clone(),
                linked_asset_name: holding
                    .linked_asset_id
                    .as_ref()
                    .and_then(|id| names.get(id).cloned()),
                notes: holding.notes.clone(),
                loan_original_amount: holding.loan.as_ref().and_then(|loan| loan.original_amount),
                loan_annual_rate: holding.loan.as_ref().and_then(|loan| loan.annual_rate),
                loan_payment_amount: holding.loan.as_ref().and_then(|loan| loan.payment_amount),
                loan_frequency: holding
                    .loan
                    .as_ref()
                    .and_then(|loan| loan.frequency.as_ref())
                    .map(kind_value),
                loan_renewal_maturity: holding.loan.as_ref().and_then(|loan| loan.renewal_maturity),
                loan_interest_to_date: interest_to_date,
                details: holding.metadata.clone(),
            });
        }
        ExportRecord::from_records(&rows)
    }

    pub(super) fn asset_valuation_records(
        &self,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let mut rows = Vec::new();
        for holding in &holdings {
            let mut quotes: Vec<Quote> = self.sources.quotes.get_historical_quotes(&holding.id)?;
            quotes.sort_by_key(|quote| quote.timestamp);
            for quote in quotes {
                let date = quote.timestamp.date_naive();
                if !options.in_range(date) {
                    continue;
                }
                rows.push(AssetValuationRow {
                    date,
                    asset_id: holding.id.clone(),
                    name: holding.name.clone(),
                    kind: kind_value(&holding.kind),
                    value: quote.close,
                    currency: quote.currency,
                    source: quote.data_source,
                    notes: quote.notes,
                });
            }
        }
        ExportRecord::from_records(&rows)
    }

    pub(super) fn loan_payment_records(
        &self,
        lookups: &Lookups,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let account_ids = lookups.exported_account_ids(options);
        let accounts = &lookups.account_names;
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let mut rows = Vec::new();
        for holding in holdings.iter().filter(|holding| holding.loan.is_some()) {
            for payment in self
                .sources
                .alternative_assets
                .get_loan_payments(&holding.id)?
            {
                if !account_ids.contains(&payment.account_id) || !options.in_range(payment.date) {
                    continue;
                }
                rows.push(LoanPaymentRow {
                    date: payment.date,
                    loan_id: holding.id.clone(),
                    loan_name: holding.name.clone(),
                    amount: payment.amount,
                    escrow: payment.escrow,
                    applies_to: payment.applies_to.as_ref().map(kind_value),
                    activity_id: payment.activity_id.clone(),
                    account_name: accounts.get(&payment.account_id).cloned(),
                    account_id: payment.account_id,
                });
            }
        }
        rows.sort_by(|a, b| (a.date, &a.loan_id).cmp(&(b.date, &b.loan_id)));
        ExportRecord::from_records(&rows)
    }

    /// The first day anything was recorded: an activity or a valuation of an
    /// asset or liability.
    pub(super) fn earliest_date(&self, lookups: &Lookups) -> Result<Option<NaiveDate>> {
        let tz = self.timezone();
        let first_activity = self
            .sources
            .activities
            .get_first_activity_date(None)?
            .map(|instant| user_date_from_utc(instant, tz));
        // Accounts tracked by holdings start at their first snapshot, which
        // can come before any activity or with none at all.
        let mut first_snapshot: Option<NaiveDate> = None;
        for account in &lookups.accounts {
            let first = self
                .sources
                .snapshots
                .get_earliest_snapshot_date(&account.id)?;
            first_snapshot = earlier(first_snapshot, first);
        }
        let mut first_valuation: Option<NaiveDate> = None;
        for holding in self.sources.alternative_assets.get_alternative_holdings()? {
            let first = self
                .sources
                .quotes
                .get_historical_quotes(&holding.id)?
                .into_iter()
                .map(|quote| quote.timestamp.date_naive())
                .min();
            first_valuation = earlier(first_valuation, first);
        }
        Ok(earlier(
            earlier(first_activity, first_snapshot),
            first_valuation,
        ))
    }

    pub(super) async fn net_worth_records(
        &self,
        lookups: &Lookups,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        let start = match options.start_date {
            Some(start) => start,
            None => match self.earliest_date(lookups)? {
                Some(start) => start,
                None => return Ok(Vec::new()),
            },
        };
        let end = options.end_date.unwrap_or(today).min(today);
        if start > end {
            return Ok(Vec::new());
        }
        let history = self
            .sources
            .net_worth
            .get_net_worth_history(start, end)
            .await?;
        match format {
            ExportFileFormat::Json => ExportRecord::from_records(&history),
            ExportFileFormat::Csv => {
                let labels = self.breakdown_labels(lookups, &history)?;
                Ok(net_worth_csv_records(&history, &labels))
            }
        }
    }

    /// Spreadsheet column names for the history breakdown's keys: category
    /// keys stay as they are, liabilities and credit cards get their names.
    pub(super) fn breakdown_labels(
        &self,
        lookups: &Lookups,
        history: &[NetWorthHistoryPoint],
    ) -> Result<Vec<(String, String)>> {
        let keys = history
            .iter()
            .flat_map(|point| point.breakdown.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let categories = NET_WORTH_CATEGORIES
            .iter()
            .map(|category| NetWorthService::category_key(*category))
            .collect::<Vec<_>>();
        let accounts = &lookups.account_names;
        let liabilities = self
            .sources
            .alternative_assets
            .get_alternative_holdings()?
            .into_iter()
            .map(|holding| (holding.id, holding.name))
            .collect::<HashMap<_, _>>();

        let mut labels = categories
            .iter()
            .filter(|key| keys.contains(**key))
            .map(|key| (key.to_string(), key.to_string()))
            .collect::<Vec<_>>();
        let mut others = keys
            .iter()
            .filter(|key| !categories.contains(&key.as_str()))
            .map(|key| {
                let label = match key.strip_prefix(CREDIT_CARD_KEY_PREFIX) {
                    Some(account_id) => format!(
                        "Credit card: {}",
                        accounts.get(account_id).map_or(account_id, String::as_str)
                    ),
                    None => format!(
                        "Liability: {}",
                        liabilities.get(key).map_or(key.as_str(), String::as_str)
                    ),
                };
                (key.clone(), label)
            })
            .collect::<Vec<_>>();
        others.sort_by(|a, b| a.1.cmp(&b.1));
        // Two liabilities can share a name; keep both columns apart.
        let mut seen = HashSet::new();
        for (key, label) in &mut others {
            if !seen.insert(label.clone()) {
                *label = format!("{label} ({key})");
            }
        }
        labels.extend(others);
        Ok(labels)
    }

    pub(super) async fn portfolio_history_records(
        &self,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let base_currency = self.base_currency();
        let resolved = self
            .sources
            .portfolios
            .resolve_account_scope(&AccountScope::All, &base_currency)?;
        let totals = self
            .sources
            .valuations
            .get_historical_valuations_for_accounts(
                &resolved.scope_id,
                &resolved.account_ids,
                &resolved.base_currency,
                options.start_date,
                options.end_date,
            )
            .await?;
        // All accounts together first, as before, then each account's own rows.
        let mut records = totals
            .iter()
            .map(|row| Ok(ExportRecord::from_record(row)?.with("accountName", "All accounts")))
            .collect::<Result<Vec<_>>>()?;
        let mut accounts = self
            .sources
            .accounts
            .get_accounts_by_ids(&resolved.account_ids)?;
        accounts.sort_by(|a, b| a.name.cmp(&b.name));
        for account in accounts {
            // The async read loads the history off the async workers.
            let scope = self.sources.portfolios.resolve_account_scope(
                &AccountScope::Account {
                    account_id: account.id.clone(),
                },
                &base_currency,
            )?;
            for row in self
                .sources
                .valuations
                .get_historical_valuations_for_accounts(
                    &scope.scope_id,
                    &scope.account_ids,
                    &scope.base_currency,
                    options.start_date,
                    options.end_date,
                )
                .await?
            {
                records.push(
                    ExportRecord::from_record(&row)?.with("accountName", account.name.clone()),
                );
            }
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn net_worth_csv_gives_every_row_the_same_named_columns() {
        use std::collections::BTreeMap;
        use std::str::FromStr;
        let point = |day: u32, breakdown: &[(&str, &str)]| NetWorthHistoryPoint {
            date: date(2026, 1, day),
            portfolio_value: Decimal::from(100),
            alternative_assets_value: Decimal::from(500),
            total_liabilities: Decimal::from(50),
            total_assets: Decimal::from(600),
            net_worth: Decimal::from(550),
            net_contribution: Decimal::ZERO,
            breakdown: breakdown
                .iter()
                .map(|(key, value)| (key.to_string(), Decimal::from_str(value).unwrap()))
                .collect::<BTreeMap<_, _>>(),
            currency: "EUR".into(),
        };
        let history = vec![
            point(1, &[("cash", "100"), ("loan-1", "50")]),
            point(2, &[("properties", "500.5")]),
        ];
        let labels = vec![
            ("cash".to_string(), "cash".to_string()),
            ("properties".to_string(), "properties".to_string()),
            ("loan-1".to_string(), "Liability: Car loan".to_string()),
        ];

        let rows = net_worth_csv_records(&history, &labels);
        let csv = String::from_utf8(
            crate::exports::format_records(&rows, ExportFileFormat::Csv)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let lines = csv.lines().collect::<Vec<_>>();

        assert_eq!(
            lines[0],
            r#""date","currency","netWorth","totalAssets","totalLiabilities","portfolioValue","alternativeAssetsValue","netContribution","cash","properties","Liability: Car loan""#
        );
        assert_eq!(
            lines[1],
            r#""2026-01-01","EUR","550.0","600.0","50.0","100.0","500.0","0.0","100.0","0.0","50.0""#
        );
        assert!(lines[2].ends_with(r#""0.0","500.5","0.0""#), "{}", lines[2]);
        assert!(!csv.contains('{'), "no JSON left in the CSV");
    }

    #[test]
    fn earliest_date_ignores_missing_sources() {
        assert_eq!(earlier(None, None), None);
        assert_eq!(
            earlier(Some(date(2025, 3, 1)), None),
            Some(date(2025, 3, 1))
        );
        assert_eq!(
            earlier(None, Some(date(2024, 1, 1))),
            Some(date(2024, 1, 1))
        );
        assert_eq!(
            earlier(Some(date(2025, 3, 1)), Some(date(2024, 1, 1))),
            Some(date(2024, 1, 1)),
            "a snapshot before the first activity starts the history"
        );
    }
}
