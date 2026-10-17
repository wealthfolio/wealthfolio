use crate::activities::IncomeData;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeByAsset {
    pub asset_id: String,
    pub kind: String,
    pub symbol: String,
    pub name: String,
    pub income: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeByAccount {
    pub account_id: String,
    pub account_name: String,
    pub by_month: HashMap<String, Decimal>,
    pub total: Decimal,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeSummary {
    pub period: String,
    pub by_month: HashMap<String, Decimal>,
    pub by_type: HashMap<String, Decimal>,
    pub by_asset: HashMap<String, IncomeByAsset>,
    /// Income per currency, in that currency.
    pub by_currency: HashMap<String, Decimal>,
    /// Income per currency, converted to `currency`. Like the other converted
    /// totals, it leaves out income without an exchange rate.
    pub by_currency_base: HashMap<String, Decimal>,
    pub by_account: HashMap<String, IncomeByAccount>,
    pub total_income: Decimal,
    pub currency: String,
    pub monthly_average: Decimal,
    pub yoy_growth: Option<Decimal>,
    /// Currencies with income but no exchange rate to `currency`, in this
    /// period or in the previous one `yoy_growth` compares against. That
    /// income is left out of every converted total; `by_currency` still
    /// counts this period's.
    pub unconverted_currencies: BTreeSet<String>,
}

impl IncomeSummary {
    pub fn new(period: &str, currency: String) -> Self {
        IncomeSummary {
            period: period.to_string(),
            by_month: HashMap::new(),
            by_type: HashMap::new(),
            by_asset: HashMap::new(),
            by_currency: HashMap::new(),
            by_currency_base: HashMap::new(),
            by_account: HashMap::new(),
            total_income: Decimal::ZERO,
            currency,
            monthly_average: Decimal::ZERO,
            yoy_growth: None,
            unconverted_currencies: BTreeSet::new(),
        }
    }

    pub fn add_income(&mut self, data: &IncomeData, converted_amount: Decimal) {
        *self
            .by_month
            .entry(data.date.to_string())
            .or_insert_with(|| Decimal::ZERO) += &converted_amount;
        *self
            .by_type
            .entry(data.income_type.clone())
            .or_insert_with(|| Decimal::ZERO) += &converted_amount;
        self.by_asset
            .entry(data.asset_id.clone())
            .and_modify(|entry| entry.income += converted_amount)
            .or_insert_with(|| IncomeByAsset {
                asset_id: data.asset_id.clone(),
                kind: data.asset_kind.clone(),
                symbol: data.symbol.clone(),
                name: data.symbol_name.clone(),
                income: converted_amount,
            });
        *self
            .by_currency
            .entry(data.currency.clone())
            .or_insert_with(|| Decimal::ZERO) += &data.amount;
        *self
            .by_currency_base
            .entry(data.currency.clone())
            .or_insert_with(|| Decimal::ZERO) += &converted_amount;
        self.by_account
            .entry(data.account_id.clone())
            .and_modify(|entry| {
                *entry
                    .by_month
                    .entry(data.date.clone())
                    .or_insert(Decimal::ZERO) += converted_amount;
                entry.total += converted_amount;
            })
            .or_insert_with(|| {
                let mut by_month = HashMap::new();
                by_month.insert(data.date.clone(), converted_amount);
                IncomeByAccount {
                    account_id: data.account_id.clone(),
                    account_name: data.account_name.clone(),
                    by_month,
                    total: converted_amount,
                }
            });
        self.total_income += &converted_amount;
    }

    /// Counts income that has no exchange rate to `currency`: only in its own
    /// currency, so the converted totals leave it out.
    pub fn add_unconverted_income(&mut self, data: &IncomeData) {
        *self
            .by_currency
            .entry(data.currency.clone())
            .or_insert_with(|| Decimal::ZERO) += &data.amount;
        self.unconverted_currencies.insert(data.currency.clone());
    }

    pub fn calculate_monthly_average(&mut self, num_months: Option<u32>) {
        let months = num_months.unwrap_or(self.by_month.len() as u32);
        if months > 0 {
            self.monthly_average = self.total_income / Decimal::new(months as i64, 0);
        }
    }
}
