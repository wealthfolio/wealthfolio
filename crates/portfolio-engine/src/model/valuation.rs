//! Valuation outputs: one dense daily series per account, each day carrying
//! values, statuses and the FINALIZED external flow (amount, scope,
//! provenance) that `measure` consumes.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::scalar::{AccountId, Currency, STORED_PRECISION};
use crate::diagnostics::Diagnostic;

/// Legacy three-value valuation status, kept verbatim for parity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ValueStatus {
    #[default]
    Complete,
    PartialUnpriced,
    Unavailable,
}

impl ValueStatus {
    pub fn is_degraded(self) -> bool {
        self != Self::Complete
    }

    pub fn is_unavailable_for_returns(self) -> bool {
        self == Self::Unavailable
    }

    /// Absorption law: degradation never upgrades.
    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::Unavailable, _) | (_, Self::Unavailable) => Self::Unavailable,
            (Self::PartialUnpriced, _) | (_, Self::PartialUnpriced) => Self::PartialUnpriced,
            (Self::Complete, Self::Complete) => Self::Complete,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BasisStatus {
    Complete,
    PartialUnknown,
    Unknown,
    #[default]
    NotApplicable,
}

impl BasisStatus {
    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::PartialUnknown, _) | (_, Self::PartialUnknown) => Self::PartialUnknown,
            (Self::Complete, Self::Unknown) | (Self::Unknown, Self::Complete) => {
                Self::PartialUnknown
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Complete, _) | (_, Self::Complete) => Self::Complete,
            (Self::NotApplicable, Self::NotApplicable) => Self::NotApplicable,
        }
    }
}

/// Provenance of a day's external flow (legacy `ExternalFlowSource` ladder,
/// preserved so return-eligibility gating keeps working).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlowSource {
    /// No external flow: the neutral identity.
    #[default]
    NoFlow,
    /// A real flow whose amount or boundary could not be determined.
    Unknown,
    CashAmount,
    QuoteDerivedMarketValue,
    CostBasisFallback,
    RemovedLotBasisFallback,
    LegacyActivityAmountFallback,
    UnknownBoundaryTransfer,
    UnpricedHoldingsTransition,
    /// Stored amounts whose provenance was not explicit (measure relabel).
    StoredGross,
    NetContributionFallback,
    Mixed,
}

impl FlowSource {
    pub fn is_explicit_gross(self) -> bool {
        matches!(
            self,
            Self::CashAmount
                | Self::QuoteDerivedMarketValue
                | Self::CostBasisFallback
                | Self::RemovedLotBasisFallback
                | Self::LegacyActivityAmountFallback
                | Self::StoredGross
                | Self::Mixed
        )
    }

    pub fn is_degraded(self) -> bool {
        !matches!(
            self,
            Self::NoFlow | Self::CashAmount | Self::QuoteDerivedMarketValue
        )
    }

    pub fn is_unavailable_for_returns(self) -> bool {
        matches!(
            self,
            Self::Unknown | Self::UnknownBoundaryTransfer | Self::UnpricedHoldingsTransition
        )
    }

    /// Legacy merge law: identity, idempotence, then the degraded markers
    /// absorb in a fixed order; anything else is `Mixed`.
    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::NoFlow, source) | (source, Self::NoFlow) => source,
            (left, right) if left == right => left,
            (Self::UnknownBoundaryTransfer, _) | (_, Self::UnknownBoundaryTransfer) => {
                Self::UnknownBoundaryTransfer
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::UnpricedHoldingsTransition, _) | (_, Self::UnpricedHoldingsTransition) => {
                Self::UnpricedHoldingsTransition
            }
            (Self::RemovedLotBasisFallback, _) | (_, Self::RemovedLotBasisFallback) => {
                Self::RemovedLotBasisFallback
            }
            _ => Self::Mixed,
        }
    }
}

/// Finalized external flow of one day (base currency, always non-negative
/// legs).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct DailyFlow {
    #[serde(with = "crate::model::decimal_serde")]
    pub inflow_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub outflow_base: Decimal,
    pub source: FlowSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyValuation {
    pub date: NaiveDate,
    #[serde(with = "crate::model::decimal_serde")]
    pub fx_rate_to_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_balance: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub investment_market_value: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub total_value: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub book_basis: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cash_balance_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub investment_market_value_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub total_value_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub cost_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub book_basis_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub net_contribution_base: Decimal,
    #[serde(with = "crate::model::decimal_serde")]
    pub performance_eligible_value_base: Decimal,
    pub value_status: ValueStatus,
    pub basis_status: BasisStatus,
    pub flow: DailyFlow,
}

impl DailyValuation {
    /// The row as storage keeps it: every amount at storage precision.
    pub fn stored(&self) -> Self {
        let r = |value: Decimal| value.round_dp(STORED_PRECISION);
        Self {
            date: self.date,
            fx_rate_to_base: r(self.fx_rate_to_base),
            cash_balance: r(self.cash_balance),
            investment_market_value: r(self.investment_market_value),
            total_value: r(self.total_value),
            cost_basis: r(self.cost_basis),
            book_basis: r(self.book_basis),
            net_contribution: r(self.net_contribution),
            cash_balance_base: r(self.cash_balance_base),
            investment_market_value_base: r(self.investment_market_value_base),
            total_value_base: r(self.total_value_base),
            cost_basis_base: r(self.cost_basis_base),
            book_basis_base: r(self.book_basis_base),
            net_contribution_base: r(self.net_contribution_base),
            performance_eligible_value_base: r(self.performance_eligible_value_base),
            value_status: self.value_status,
            basis_status: self.basis_status,
            flow: DailyFlow {
                inflow_base: r(self.flow.inflow_base),
                outflow_base: r(self.flow.outflow_base),
                source: self.flow.source,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValuationSeries {
    pub account: AccountId,
    pub currency: Currency,
    pub days: Vec<DailyValuation>,
    pub diagnostics: Vec<Diagnostic>,
}
