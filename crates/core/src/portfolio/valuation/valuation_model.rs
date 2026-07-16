//! Portfolio valuation domain models.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::portfolio::economic_events::BasisStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExternalFlowSource {
    /// No external flow occurred. Neutral identity for provenance merging and the
    /// default for freshly-constructed rows and aggregation fillers. Available for
    /// returns and not degraded — it represents the *absence* of a flow, not an
    /// unvaluable one.
    #[default]
    NoFlow,
    /// A real external flow event whose amount or transfer boundary could not be
    /// determined. Absorbing under merging: must keep returns unavailable.
    Unknown,
    CashAmount,
    QuoteDerivedMarketValue,
    CostBasisFallback,
    RemovedLotBasisFallback,
    LegacyActivityAmountFallback,
    UnknownBoundaryTransfer,
    /// Legacy compatibility value for rows written before compiler-owned flow sources.
    ActivityDerived,
    /// Compatibility-only value for persisted rows that already have gross flow columns.
    StoredGross,
    NetContributionFallback,
    /// Aggregate valuation rows can contain multiple compiler flow sources on the same day.
    Mixed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_external_flow_source_code_is_safe_degraded_unknown() {
        let source = ExternalFlowSource::from_code("FUTURE_SOURCE");

        assert_eq!(source, ExternalFlowSource::Unknown);
        assert!(source.is_degraded());
        assert!(!source.is_explicit_gross());
    }

    #[test]
    fn legacy_activity_amount_code_maps_to_compiler_legacy_fallback() {
        assert_eq!(
            ExternalFlowSource::from_code("ACTIVITY_AMOUNT"),
            ExternalFlowSource::LegacyActivityAmountFallback
        );
    }

    #[test]
    fn known_external_flow_source_codes_roundtrip() {
        let sources = [
            ExternalFlowSource::NoFlow,
            ExternalFlowSource::Unknown,
            ExternalFlowSource::CashAmount,
            ExternalFlowSource::QuoteDerivedMarketValue,
            ExternalFlowSource::CostBasisFallback,
            ExternalFlowSource::RemovedLotBasisFallback,
            ExternalFlowSource::LegacyActivityAmountFallback,
            ExternalFlowSource::UnknownBoundaryTransfer,
            ExternalFlowSource::ActivityDerived,
            ExternalFlowSource::StoredGross,
            ExternalFlowSource::NetContributionFallback,
            ExternalFlowSource::Mixed,
        ];

        for source in sources {
            assert_eq!(ExternalFlowSource::from_code(source.as_str()), source);
        }
    }

    #[test]
    fn flow_source_quality_contract_is_explicit() {
        // NoFlow is the neutral "no external flow" identity: available for
        // returns, not degraded, and carries no gross flow value.
        assert!(!ExternalFlowSource::NoFlow.is_unavailable_for_returns());
        assert!(!ExternalFlowSource::NoFlow.is_degraded());
        assert!(!ExternalFlowSource::NoFlow.is_explicit_gross());

        assert!(ExternalFlowSource::ActivityDerived.is_explicit_gross());
        assert!(ExternalFlowSource::ActivityDerived.is_degraded());
        assert!(!ExternalFlowSource::ActivityDerived.is_unavailable_for_returns());

        assert!(ExternalFlowSource::StoredGross.is_explicit_gross());
        assert!(ExternalFlowSource::StoredGross.is_degraded());
        assert!(!ExternalFlowSource::StoredGross.is_unavailable_for_returns());

        assert!(ExternalFlowSource::CashAmount.is_explicit_gross());
        assert!(!ExternalFlowSource::CashAmount.is_degraded());
        assert!(!ExternalFlowSource::CashAmount.is_unavailable_for_returns());

        assert!(ExternalFlowSource::QuoteDerivedMarketValue.is_explicit_gross());
        assert!(!ExternalFlowSource::QuoteDerivedMarketValue.is_degraded());
        assert!(!ExternalFlowSource::QuoteDerivedMarketValue.is_unavailable_for_returns());

        assert!(ExternalFlowSource::CostBasisFallback.is_degraded());
        assert!(ExternalFlowSource::RemovedLotBasisFallback.is_degraded());
        assert!(ExternalFlowSource::LegacyActivityAmountFallback.is_degraded());
        assert!(ExternalFlowSource::Mixed.is_degraded());

        assert!(ExternalFlowSource::Unknown.is_unavailable_for_returns());
        assert!(ExternalFlowSource::UnknownBoundaryTransfer.is_unavailable_for_returns());
    }

    #[test]
    fn flow_source_merge_contract_is_explicit() {
        for source in ExternalFlowSource::ALL {
            assert_eq!(ExternalFlowSource::NoFlow.combine(source), source);
            assert_eq!(source.combine(ExternalFlowSource::NoFlow), source);
            assert_eq!(source.combine(source), source);
        }

        assert_eq!(
            ExternalFlowSource::Unknown.combine(ExternalFlowSource::CashAmount),
            ExternalFlowSource::Unknown
        );
        assert_eq!(
            ExternalFlowSource::UnknownBoundaryTransfer.combine(ExternalFlowSource::CashAmount),
            ExternalFlowSource::UnknownBoundaryTransfer
        );
        assert_eq!(
            ExternalFlowSource::Unknown.combine(ExternalFlowSource::UnknownBoundaryTransfer),
            ExternalFlowSource::UnknownBoundaryTransfer
        );
        assert_eq!(
            ExternalFlowSource::RemovedLotBasisFallback.combine(ExternalFlowSource::CashAmount),
            ExternalFlowSource::RemovedLotBasisFallback
        );
        assert_eq!(
            ExternalFlowSource::CashAmount.combine(ExternalFlowSource::QuoteDerivedMarketValue),
            ExternalFlowSource::Mixed
        );
    }

    #[test]
    fn valuation_status_quality_contract_is_explicit() {
        assert_eq!(
            ValuationStatus::from_code("PARTIAL_MISSING_QUOTE"),
            ValuationStatus::PartialUnpriced
        );
        assert_eq!(
            ValuationStatus::from_code("future-value-status"),
            ValuationStatus::Unavailable
        );
        assert!(ValuationStatus::Complete.is_complete());
        assert!(ValuationStatus::PartialUnpriced.is_degraded());
        assert!(!ValuationStatus::PartialUnpriced.is_unavailable_for_returns());
        assert!(ValuationStatus::Unavailable.is_unavailable_for_returns());
        assert_eq!(
            ValuationStatus::Complete.combine(ValuationStatus::PartialUnpriced),
            ValuationStatus::PartialUnpriced
        );
        assert_eq!(
            ValuationStatus::PartialUnpriced.combine(ValuationStatus::Unavailable),
            ValuationStatus::Unavailable
        );
    }
}

impl ExternalFlowSource {
    pub const ALL: [ExternalFlowSource; 12] = [
        ExternalFlowSource::NoFlow,
        ExternalFlowSource::Unknown,
        ExternalFlowSource::CashAmount,
        ExternalFlowSource::QuoteDerivedMarketValue,
        ExternalFlowSource::CostBasisFallback,
        ExternalFlowSource::RemovedLotBasisFallback,
        ExternalFlowSource::LegacyActivityAmountFallback,
        ExternalFlowSource::UnknownBoundaryTransfer,
        ExternalFlowSource::ActivityDerived,
        ExternalFlowSource::StoredGross,
        ExternalFlowSource::NetContributionFallback,
        ExternalFlowSource::Mixed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoFlow => "NO_FLOW",
            Self::Unknown => "UNKNOWN",
            Self::CashAmount => "CASH_AMOUNT",
            Self::QuoteDerivedMarketValue => "QUOTE_DERIVED_MARKET_VALUE",
            Self::CostBasisFallback => "COST_BASIS_FALLBACK",
            Self::RemovedLotBasisFallback => "REMOVED_LOT_BASIS_FALLBACK",
            Self::LegacyActivityAmountFallback => "LEGACY_ACTIVITY_AMOUNT_FALLBACK",
            Self::UnknownBoundaryTransfer => "UNKNOWN_BOUNDARY_TRANSFER",
            Self::ActivityDerived => "ACTIVITY_DERIVED",
            Self::StoredGross => "STORED_GROSS",
            Self::NetContributionFallback => "NET_CONTRIBUTION_FALLBACK",
            Self::Mixed => "MIXED",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "NO_FLOW" => Self::NoFlow,
            "CASH_AMOUNT" => Self::CashAmount,
            "QUOTE_DERIVED_MARKET_VALUE" => Self::QuoteDerivedMarketValue,
            "COST_BASIS_FALLBACK" => Self::CostBasisFallback,
            "REMOVED_LOT_BASIS_FALLBACK" => Self::RemovedLotBasisFallback,
            "LEGACY_ACTIVITY_AMOUNT_FALLBACK" | "ACTIVITY_AMOUNT" => {
                Self::LegacyActivityAmountFallback
            }
            "UNKNOWN_BOUNDARY_TRANSFER" => Self::UnknownBoundaryTransfer,
            "ACTIVITY_DERIVED" => Self::ActivityDerived,
            "STORED_GROSS" => Self::StoredGross,
            "NET_CONTRIBUTION_FALLBACK" => Self::NetContributionFallback,
            "MIXED" => Self::Mixed,
            _ => Self::Unknown,
        }
    }

    pub fn is_explicit_gross(self) -> bool {
        matches!(
            self,
            Self::CashAmount
                | Self::QuoteDerivedMarketValue
                | Self::CostBasisFallback
                | Self::RemovedLotBasisFallback
                | Self::LegacyActivityAmountFallback
                | Self::ActivityDerived
                | Self::StoredGross
                | Self::Mixed
        )
    }

    pub fn is_degraded(self) -> bool {
        matches!(
            self,
            Self::Unknown
                | Self::CostBasisFallback
                | Self::RemovedLotBasisFallback
                | Self::LegacyActivityAmountFallback
                | Self::UnknownBoundaryTransfer
                | Self::ActivityDerived
                | Self::StoredGross
                | Self::NetContributionFallback
                | Self::Mixed
        )
    }

    pub fn is_unavailable_for_returns(self) -> bool {
        matches!(self, Self::Unknown | Self::UnknownBoundaryTransfer)
    }

    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::NoFlow, source) | (source, Self::NoFlow) => source,
            (left, right) if left == right => left,
            (Self::UnknownBoundaryTransfer, _) | (_, Self::UnknownBoundaryTransfer) => {
                Self::UnknownBoundaryTransfer
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::RemovedLotBasisFallback, _) | (_, Self::RemovedLotBasisFallback) => {
                Self::RemovedLotBasisFallback
            }
            _ => Self::Mixed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ValuationStatus {
    #[default]
    Complete,
    PartialUnpriced,
    Unavailable,
}

impl ValuationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "COMPLETE",
            Self::PartialUnpriced => "PARTIAL_UNPRICED",
            Self::Unavailable => "UNAVAILABLE",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "COMPLETE" => Self::Complete,
            "PARTIAL_UNPRICED" | "PARTIAL_MISSING_QUOTE" | "PARTIAL_MISSING_VALUE" => {
                Self::PartialUnpriced
            }
            "UNAVAILABLE" | "MISSING_QUOTE" | "MISSING_VALUE" | "MISSING_FX" => Self::Unavailable,
            _ => Self::Unavailable,
        }
    }

    pub fn is_complete(self) -> bool {
        matches!(self, Self::Complete)
    }

    pub fn is_unavailable_for_returns(self) -> bool {
        matches!(self, Self::Unavailable)
    }

    pub fn is_degraded(self) -> bool {
        !self.is_complete()
    }

    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::Unavailable, _) | (_, Self::Unavailable) => Self::Unavailable,
            (Self::PartialUnpriced, _) | (_, Self::PartialUnpriced) => Self::PartialUnpriced,
            (Self::Complete, Self::Complete) => Self::Complete,
        }
    }
}

/// Details about an account that has a negative total_value in its history.
#[derive(Debug, Clone)]
pub struct NegativeBalanceInfo {
    pub account_id: String,
    /// First date the total_value went negative.
    pub first_negative_date: NaiveDate,
    /// Cash balance on that date (account currency).
    pub cash_balance: Decimal,
    /// Total value on that date (account currency).
    pub total_value: Decimal,
    /// Account currency (e.g. "EUR").
    pub account_currency: String,
}

/// Domain model for daily account valuation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyAccountValuation {
    pub id: String,
    pub account_id: String,
    pub valuation_date: NaiveDate,
    pub account_currency: String,
    pub base_currency: String,
    pub fx_rate_to_base: Decimal,
    pub cash_balance: Decimal,
    pub investment_market_value: Decimal,
    pub total_value: Decimal,
    pub cost_basis: Decimal,
    pub book_basis: Decimal,
    pub net_contribution: Decimal,
    pub cash_balance_base: Decimal,
    pub investment_market_value_base: Decimal,
    pub total_value_base: Decimal,
    pub cost_basis_base: Decimal,
    pub book_basis_base: Decimal,
    pub net_contribution_base: Decimal,
    pub external_inflow_base: Decimal,
    pub external_outflow_base: Decimal,
    pub external_flow_source: ExternalFlowSource,
    pub performance_eligible_value_base: Decimal,
    #[serde(default)]
    pub value_status: ValuationStatus,
    #[serde(default)]
    pub basis_status: BasisStatus,
    pub calculated_at: DateTime<Utc>,
}

/// Live account valuation derived from the latest holdings snapshot, latest
/// quotes, and latest FX. This is intentionally separate from daily historical
/// valuation rows because it has no external-flow/performance semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAccountValuation {
    pub account_id: String,
    pub account_currency: String,
    pub base_currency: String,
    pub cash_balance: Decimal,
    pub investment_market_value: Decimal,
    pub total_value: Decimal,
    pub cash_balance_base: Decimal,
    pub investment_market_value_base: Decimal,
    pub total_value_base: Decimal,
    pub source_data_as_of: Option<DateTime<Utc>>,
    pub calculated_at: DateTime<Utc>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentValuationSplit {
    pub currency: String,
    pub value_base: Decimal,
    pub value_local: Option<Decimal>,
    pub percentage: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentValuationSummary {
    pub scope_id: String,
    pub base_currency: String,
    pub cash_balance_base: Decimal,
    pub investment_market_value_base: Decimal,
    pub total_value_base: Decimal,
    pub holdings_count: usize,
    pub account_count: usize,
    pub currency_split: Vec<CurrentValuationSplit>,
    pub cash_currency_split: Vec<CurrentValuationSplit>,
    pub source_data_as_of: Option<DateTime<Utc>>,
    pub calculated_at: DateTime<Utc>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentValuationResponse {
    pub summary: CurrentValuationSummary,
    pub accounts: Vec<CurrentAccountValuation>,
}
