//! Performance outputs: the legacy `PerformanceResult` contract, typed.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::scalar::Currency;
use super::valuation::BasisStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ReturnMethod {
    #[default]
    TimeWeighted,
    ValueReturn,
    /// Price-only return of a quoted symbol (no cash flows).
    SymbolPriceBased,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityStatus {
    Ok,
    Partial,
    NoData,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SummaryBasis {
    MarketValue,
    BookBasis,
    Mixed,
    #[default]
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SummaryStatus {
    Complete,
    #[default]
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Returns {
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub twr: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub annualized_twr: Option<Decimal>,
    /// Period money-weighted return derived from the annualized XIRR.
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub irr: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub annualized_irr: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub value_return: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub annualized_value_return: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Attribution {
    #[serde(with = "crate::model::decimal_serde")]
    pub contributions: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub distributions: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub income: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub realized_pnl: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub unrealized_pnl_change: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fx_effect: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub fees: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub taxes: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub residual: Decimal,
}

impl Attribution {
    /// Profit and loss across the attributed components.
    pub fn pnl(&self) -> Decimal {
        self.income + self.realized_pnl + self.unrealized_pnl_change + self.fx_effect
            - self.fees
            - self.taxes
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Risk {
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub volatility: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub max_drawdown: Option<Decimal>,
    pub peak_date: Option<NaiveDate>,
    pub trough_date: Option<NaiveDate>,
    pub recovery_date: Option<NaiveDate>,
    pub drawdown_duration_days: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataQuality {
    pub status: QualityStatus,
    pub warnings: Vec<String>,
    pub not_applicable_reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub amount: Option<Decimal>,
    #[serde(default, with = "crate::model::decimal_serde::option")]
    pub percent: Option<Decimal>,
    pub method: ReturnMethod,
    pub basis: SummaryBasis,
    pub quality: QualityStatus,
    pub amount_status: SummaryStatus,
    pub percent_status: SummaryStatus,
    pub basis_status: BasisStatus,
    pub reasons: Vec<String>,
}

impl Default for Summary {
    fn default() -> Self {
        Self {
            amount: None,
            percent: None,
            method: ReturnMethod::NotApplicable,
            basis: SummaryBasis::NotApplicable,
            quality: QualityStatus::NotApplicable,
            amount_status: SummaryStatus::Unavailable,
            percent_status: SummaryStatus::Unavailable,
            basis_status: BasisStatus::NotApplicable,
            reasons: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeriesPoint {
    pub date: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
    pub value: Decimal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerformanceResult {
    pub scope: String,
    pub currency: Currency,
    pub period_start: Option<NaiveDate>,
    pub period_end: Option<NaiveDate>,
    pub method: ReturnMethod,
    pub returns: Returns,
    pub attribution: Attribution,
    pub risk: Risk,
    pub data_quality: DataQuality,
    pub basis_status: BasisStatus,
    pub summary: Summary,
    pub series: Vec<SeriesPoint>,
    pub is_holdings_mode: bool,
    pub is_mixed_tracking_mode: bool,
    /// Dated holdings scope with an unpriceable transition: summary amount
    /// and percent stay unavailable through every summary refresh.
    #[serde(skip)]
    pub holdings_flows_unavailable: bool,
    /// A period endpoint is UNAVAILABLE: IRR, value return and the headline
    /// amount stay unavailable through every summary refresh.
    #[serde(skip)]
    pub coverage_unavailable: bool,
}
