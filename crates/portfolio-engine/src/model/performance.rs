//! Performance outputs: the legacy `PerformanceResult` contract, typed.

use std::fmt;

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
    pub warnings: Vec<QualityNote>,
    pub not_applicable_reasons: Vec<QualityNote>,
}

/// Which figure a note is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Metric {
    Irr,
    ValueReturn,
    Pnl,
}

impl fmt::Display for Metric {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Irr => "IRR",
            Self::ValueReturn => "Value return",
            Self::Pnl => "P&L",
        })
    }
}

/// What a note's figure was computed for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "account", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Subject {
    HoldingsScope,
    HoldingsAccount(String),
}

impl fmt::Display for Subject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HoldingsScope => f.write_str("holdings-only scope"),
            Self::HoldingsAccount(account) => write!(f, "holdings account {account}"),
        }
    }
}

/// Attribution component a skipped conversion belonged to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Component {
    Income,
    Fee,
    Tax,
}

impl fmt::Display for Component {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Income => "Income",
            Self::Fee => "Fee",
            Self::Tax => "Tax",
        })
    }
}

/// A warning or not-applicable reason on a performance result: a stable
/// code with its data, so a host can localise it. `Display` renders the
/// English text hosts show today.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QualityNote {
    TwoValuationPointsRequired,
    NoAccountsSelected,
    ScopeHistoryIncomplete {
        detail: String,
    },
    ScopeMetricsUnavailable,
    TwoQuotePointsRequired,
    NonPositiveStartingQuote,
    PriceSeriesOutOfRange,
    SymbolPriceOnly,
    SymbolTwrNotApplicable,
    SymbolIrrNotApplicable,
    HoldingsTwrNotApplicable,
    HoldingsIrrNotApplicable,
    HoldingsReturnOutOfRange,
    FlowsNotInferred {
        metric: Metric,
        subject: Subject,
    },
    HoldingsValueReturnUnavailable,
    HoldingsNonPositiveStart,
    NonPositiveBookBasis {
        metric: Metric,
        subject: Subject,
    },
    IncompleteBookBasis {
        metric: Metric,
        subject: Subject,
    },
    PnlUnavailable {
        subject: Subject,
    },
    HoldingsFlowsEstimated,
    CoverageUnavailable {
        metric: Metric,
    },
    TransactionNonPositiveStart,
    NetContributionFlows,
    DegradedFlowProvenance,
    PartialUnpricedRows,
    TwrUnknownFlow {
        date: NaiveDate,
    },
    TwrCoverageUnavailable {
        date: NaiveDate,
    },
    TwrNegativeValue {
        date: NaiveDate,
    },
    TwrNegativeDenominator {
        date: NaiveDate,
    },
    TwrOutOfRange {
        date: NaiveDate,
    },
    TwrNoChain,
    IrrTwoPointsRequired,
    IrrUnknownFlow,
    IrrInsufficientFlows,
    IrrNoSignChange,
    IrrCannotEvaluate,
    IrrNoConvergence,
    AttributionIncomplete {
        #[serde(with = "crate::model::decimal_serde")]
        difference: Decimal,
        #[serde(with = "crate::model::decimal_serde")]
        tolerance: Decimal,
    },
    AttributionSkipped {
        component: Component,
        activity: String,
    },
    RealizedSkipped {
        disposal: String,
    },
    RealizedSkippedAcquisitionFx {
        disposal: String,
    },
    ScopedFxSkippedRate {
        account: String,
    },
    ScopedFxSkippedRange {
        account: String,
    },
    ExternalMarkerIgnored {
        group: String,
    },
    MixedScope,
    MixedTwrNotApplicable,
    MixedIrrNotApplicable,
    MixedSkippedTwoPoints {
        account: String,
    },
    MixedSkippedNegative {
        account: String,
    },
    MixedHoldingsFlowsEstimated {
        account: String,
    },
    MixedExcludedFlows {
        account: String,
    },
    MixedExcludedBasis {
        account: String,
    },
    MixedPercentExcluded {
        account: String,
    },
    MixedPercentNoDenominator {
        account: String,
    },
    MixedPercentCoverage {
        account: String,
    },
    MixedCoverageDiffers,
    MixedReturnOutOfRange,
    MixedNonPositiveDenominators,
    MixedSeriesUnavailable,
    MixedAttributionUnreconciled {
        #[serde(with = "crate::model::decimal_serde")]
        delta: Decimal,
    },
}

impl fmt::Display for QualityNote {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use QualityNote::*;
        const REVIEW: &str = "Review the underlying transactions, prices, and cash balances.";
        match self {
            TwoValuationPointsRequired => f.write_str("Performance unavailable: at least two valuation points are required."),
            NoAccountsSelected => f.write_str("Performance unavailable: no accounts selected."),
            ScopeHistoryIncomplete { detail } => write!(f, "Performance is partially unavailable for this scope because valuation history is incomplete: {detail}"),
            ScopeMetricsUnavailable => f.write_str("Performance metrics unavailable because scoped valuation history is incomplete."),
            TwoQuotePointsRequired => f.write_str("Performance unavailable: at least two quote points are required."),
            NonPositiveStartingQuote => f.write_str("Performance unavailable: starting quote price is non-positive."),
            PriceSeriesOutOfRange => f.write_str("Performance unavailable: the price series is outside the supported range."),
            SymbolPriceOnly => f.write_str("Symbol-only performance uses price quotes only; dividends and distributions are excluded unless the quote series is total-return adjusted."),
            SymbolTwrNotApplicable => f.write_str("TWR unavailable for symbol-only price performance because there is no portfolio cash-flow scope."),
            SymbolIrrNotApplicable => f.write_str("IRR unavailable for symbol-only price performance because there are no user cash flows."),
            HoldingsTwrNotApplicable => f.write_str("TWR unavailable for holdings-only scopes because transaction cash flows are not tracked."),
            HoldingsIrrNotApplicable => f.write_str("IRR unavailable for holdings-only scopes because transaction cash flows are not tracked."),
            HoldingsReturnOutOfRange => f.write_str("Value return unavailable for holdings-only scope because the compounded return is outside the supported range."),
            FlowsNotInferred { metric, subject } => write!(f, "{metric} unavailable for {subject} because external cash flows could not be inferred from snapshots."),
            HoldingsValueReturnUnavailable => f.write_str("Value return unavailable for holdings-only scope."),
            HoldingsNonPositiveStart => f.write_str("Value return unavailable for holdings-only scope because starting total value is zero or negative."),
            NonPositiveBookBasis { metric, subject } => write!(f, "{metric} unavailable for {subject} because ending book basis is zero or negative."),
            IncompleteBookBasis { metric, subject } => write!(f, "{metric} unavailable for {subject} because book basis is incomplete."),
            PnlUnavailable { subject } => write!(f, "P&L unavailable for {subject}."),
            HoldingsFlowsEstimated => f.write_str("External cash flows for this holdings-tracked scope are estimated from position and cash changes between snapshots; cash income received between snapshots may not be captured in period gains."),
            CoverageUnavailable { metric } => write!(f, "{metric} unavailable because valuation coverage is unavailable at the period start or end; review missing prices or manual valuations."),
            TransactionNonPositiveStart => f.write_str("Value return unavailable for transaction-mode scope because starting value is zero or negative."),
            NetContributionFlows => f.write_str("External cash flows were inferred from net contribution deltas for part of this period because gross daily flow data was unavailable; same-day deposits and withdrawals may be netted."),
            DegradedFlowProvenance => f.write_str("External cash flow provenance is incomplete for part of this period; return and attribution results may include degraded flow data."),
            PartialUnpricedRows => f.write_str("Some valuation rows exclude unpriced held positions; returns are computed on the priced subset and may not represent the full scope."),
            TwrUnknownFlow { date } => write!(f, "TWR unavailable for {date} because an external flow amount or transfer boundary is unknown."),
            TwrCoverageUnavailable { date } => write!(f, "TWR unavailable for {date} because valuation coverage is unavailable; review missing prices or manual valuations."),
            TwrNegativeValue { date } => write!(f, "TWR unavailable for {date} because portfolio value is negative. {REVIEW}"),
            TwrNegativeDenominator { date } => write!(f, "TWR unavailable for {date} because the return denominator (opening value + inflow) is negative. {REVIEW}"),
            TwrOutOfRange { date } => write!(f, "TWR unavailable for {date} because the compounded return is outside the supported range."),
            TwrNoChain => f.write_str("TWR unavailable: no period starts with positive opening value and denominator of at least 1 base currency unit."),
            IrrTwoPointsRequired => f.write_str("IRR unavailable: at least two valuation points are required."),
            IrrUnknownFlow => f.write_str("IRR unavailable because an external flow amount or transfer boundary is unknown."),
            IrrInsufficientFlows => f.write_str("IRR unavailable: insufficient dated cash flows."),
            IrrNoSignChange => f.write_str("IRR unavailable: cash flows do not change sign."),
            IrrCannotEvaluate => f.write_str("IRR unavailable: solver could not evaluate cash flows."),
            IrrNoConvergence => f.write_str("IRR unavailable: solver did not converge."),
            AttributionIncomplete { difference, tolerance } => write!(f, "Performance attribution is incomplete for this period. Difference: {difference}; tolerance: {tolerance}. Review Health Center for possible data issues."),
            AttributionSkipped { component, activity } => write!(f, "{component} attribution skipped for activity {activity} because FX conversion failed."),
            RealizedSkipped { disposal } => write!(f, "Realized P&L attribution skipped for disposal {disposal} because FX conversion was unavailable."),
            RealizedSkippedAcquisitionFx { disposal } => write!(f, "Realized P&L attribution skipped for disposal {disposal} because acquisition FX conversion was unavailable."),
            ScopedFxSkippedRate { account } => write!(f, "Scoped FX attribution skipped for account {account} because its end-date FX rate is unavailable."),
            ScopedFxSkippedRange { account } => write!(f, "Scoped FX attribution skipped for account {account} because its converted movement is outside the supported range."),
            ExternalMarkerIgnored { group } => write!(f, "Transfer group {group} ignored external transfer metadata because the valid pair is internal to the selected scope."),
            MixedScope => f.write_str("This scope mixes transaction-mode and holdings-mode accounts, so TWR and IRR are unavailable. The return is a value return over account-level components."),
            MixedTwrNotApplicable => f.write_str("TWR unavailable for mixed transaction and holdings scopes."),
            MixedIrrNotApplicable => f.write_str("IRR unavailable for mixed transaction and holdings scopes."),
            MixedSkippedTwoPoints { account } => write!(f, "Mixed performance skipped account {account} because at least two valuation points are required."),
            MixedSkippedNegative { account } => write!(f, "Mixed performance skipped account {account} because it has negative portfolio value in its history. Please review the underlying transactions and holdings."),
            MixedHoldingsFlowsEstimated { account } => write!(f, "External cash flows for holdings account {account} are estimated from position and cash changes between snapshots."),
            MixedExcludedFlows { account } => write!(f, "Mixed performance excluded account {account} because its external cash flows could not be inferred from snapshots."),
            MixedExcludedBasis { account } => write!(f, "Mixed performance excluded account {account} from all-time gain/loss because its holdings basis is incomplete or unavailable."),
            MixedPercentExcluded { account } => write!(f, "Mixed performance percentage excluded account {account} because its summary amount is unavailable."),
            MixedPercentNoDenominator { account } => write!(f, "Mixed performance percentage unavailable because account {account} contributes to the summary amount but has no valid return denominator."),
            MixedPercentCoverage { account } => write!(f, "Mixed performance percentage unavailable because account {account} is in scope but has no complete summary amount or return denominator."),
            MixedCoverageDiffers => f.write_str("Value return unavailable for mixed scope because summary amount and denominator coverage differ."),
            MixedReturnOutOfRange => f.write_str("Value return unavailable for mixed scope because it is outside the supported range."),
            MixedNonPositiveDenominators => f.write_str("Value return unavailable for mixed scope because all account-level denominators are zero or negative."),
            MixedSeriesUnavailable => f.write_str("Return series unavailable for all-time mixed scopes because transaction and holdings components use different baselines."),
            MixedAttributionUnreconciled { delta } => write!(f, "Mixed performance attribution did not reconcile to the summary amount; unreconciled delta is {delta}."),
        }
    }
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
    pub reasons: Vec<QualityNote>,
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
    /// and percent stay unavailable through every summary refresh. Internal
    /// to `measure`; not part of the result a host reads.
    #[serde(skip)]
    pub(crate) holdings_flows_unavailable: bool,
    /// A period endpoint is UNAVAILABLE: IRR, value return and the headline
    /// amount stay unavailable through every summary refresh. Internal to
    /// `measure`; not part of the result a host reads.
    #[serde(skip)]
    pub(crate) coverage_unavailable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn notes_render_the_english_hosts_show_and_serialise_as_codes() {
        let note = QualityNote::IncompleteBookBasis {
            metric: Metric::Pnl,
            subject: Subject::HoldingsAccount("acc-1".into()),
        };
        assert_eq!(
            note.to_string(),
            "P&L unavailable for holdings account acc-1 because book basis is incomplete."
        );
        let residual = QualityNote::AttributionIncomplete {
            difference: dec!(-5),
            tolerance: dec!(2.09),
        };
        assert_eq!(
            residual.to_string(),
            "Performance attribution is incomplete for this period. Difference: -5; tolerance: 2.09. Review Health Center for possible data issues."
        );
        let json = serde_json::to_value(&residual).unwrap();
        assert_eq!(json["code"], "ATTRIBUTION_INCOMPLETE");
        assert_eq!(json["difference"], "-5");
        let back: QualityNote = serde_json::from_value(json).unwrap();
        assert_eq!(back, residual);
    }
}
