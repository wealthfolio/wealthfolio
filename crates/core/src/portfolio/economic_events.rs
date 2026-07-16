use crate::activities::{
    Activity, ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT,
    ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST,
    ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
    ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::portfolio::valuation::ExternalFlowSource;
use crate::quotes::Quote;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EconomicEventKind {
    CashFlow,
    ExternalSecurityDeliveryIn,
    ExternalSecurityDeliveryOut,
    InternalSecurityTransfer,
    Trade,
    Income,
    Fee,
    Tax,
    UnknownBoundaryTransfer,
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasisStatus {
    Complete,
    PartialUnknown,
    Unknown,
    #[default]
    NotApplicable,
}

impl BasisStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "COMPLETE",
            Self::PartialUnknown => "PARTIAL_UNKNOWN",
            Self::Unknown => "UNKNOWN",
            Self::NotApplicable => "NOT_APPLICABLE",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "COMPLETE" => Self::Complete,
            "PARTIAL_UNKNOWN" | "PARTIAL" => Self::PartialUnknown,
            "UNKNOWN" => Self::Unknown,
            "NOT_APPLICABLE" | "N/A" | "NA" => Self::NotApplicable,
            _ => Self::Unknown,
        }
    }

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferBoundary {
    Internal,
    External,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedActivityEconomics {
    pub kind: EconomicEventKind,
    pub lot_cost_basis_value: Decimal,
    pub lot_cost_basis_currency: String,
    pub performance_flow_value: Decimal,
    pub performance_flow_currency: String,
    pub performance_flow_source: ExternalFlowSource,
    pub basis_status: BasisStatus,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EconomicEventEffect {
    pub activity_id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub date: NaiveDate,
    pub event_kind: EconomicEventKind,
    /// Signed external flow. Positive means contribution; negative means distribution.
    pub external_flow: Decimal,
    pub realized_pnl: Decimal,
    pub unrealized_movement: Decimal,
    pub income: Decimal,
    pub fee: Decimal,
    pub tax: Decimal,
    pub fx_effect: Decimal,
    pub diagnostics: Vec<String>,
}

impl EconomicEventEffect {
    pub fn empty(activity: &Activity, date: NaiveDate, event_kind: EconomicEventKind) -> Self {
        Self {
            activity_id: activity.id.clone(),
            account_id: activity.account_id.clone(),
            asset_id: activity.asset_id.clone(),
            date,
            event_kind,
            external_flow: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
            unrealized_movement: Decimal::ZERO,
            income: Decimal::ZERO,
            fee: Decimal::ZERO,
            tax: Decimal::ZERO,
            fx_effect: Decimal::ZERO,
            diagnostics: Vec::new(),
        }
    }
}

pub struct ActivityEconomicsResolver;

impl ActivityEconomicsResolver {
    pub fn compile_activity(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
    ) -> ResolvedActivityEconomics {
        Self::compile_activity_with_unit_multiplier(
            activity,
            quote,
            transfer_boundary,
            Decimal::ONE,
        )
    }

    pub fn compile_activity_with_unit_multiplier(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
        unit_multiplier: Decimal,
    ) -> ResolvedActivityEconomics {
        let activity_currency = normalize_currency_code(&activity.currency).to_string();
        let kind = Self::event_kind(activity, transfer_boundary);
        let is_security_transfer = Self::is_security_transfer(activity);
        let unit_multiplier = Self::valid_unit_multiplier(unit_multiplier);
        let lot_cost_basis_value = if is_security_transfer {
            Self::lot_cost_basis_value_with_unit_multiplier(activity, unit_multiplier)
        } else {
            Decimal::ZERO
        };
        let lot_cost_basis_uses_legacy_amount =
            is_security_transfer && Self::lot_cost_basis_uses_legacy_amount(activity);
        let mut diagnostics = Vec::new();

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            diagnostics.push(format!(
                "Transfer activity {} has no valid pair and is not explicitly external.",
                activity.id
            ));
        }

        if kind == EconomicEventKind::InternalSecurityTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::Unknown,
                basis_status: if is_security_transfer {
                    Self::security_transfer_basis_status(activity)
                } else {
                    BasisStatus::NotApplicable
                },
                diagnostics,
            };
        }

        if is_security_transfer {
            if let Some(quote) = quote {
                let (normalized_price, normalized_currency) =
                    normalize_amount(quote.close, &quote.currency);
                let market_value = activity.qty() * normalized_price * unit_multiplier;
                if !market_value.is_zero() {
                    return ResolvedActivityEconomics {
                        kind,
                        lot_cost_basis_value,
                        lot_cost_basis_currency: activity_currency,
                        performance_flow_value: market_value.abs(),
                        performance_flow_currency: normalize_currency_code(normalized_currency)
                            .to_string(),
                        performance_flow_source: if kind
                            == EconomicEventKind::UnknownBoundaryTransfer
                        {
                            ExternalFlowSource::UnknownBoundaryTransfer
                        } else {
                            ExternalFlowSource::QuoteDerivedMarketValue
                        },
                        basis_status: Self::security_transfer_basis_status(activity),
                        diagnostics,
                    };
                }
            }

            if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_OUT {
                diagnostics.push(format!(
                    "Security transfer-out activity {} deferred performance flow to removed lot basis because no transfer-date quote was available.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: Decimal::ZERO,
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::Unknown
                    },
                    basis_status: if lot_cost_basis_value.is_zero() {
                        BasisStatus::Unknown
                    } else {
                        BasisStatus::Complete
                    },
                    diagnostics,
                };
            }

            if !lot_cost_basis_value.is_zero() {
                if lot_cost_basis_uses_legacy_amount {
                    diagnostics.push(format!(
                        "Security transfer activity {} used legacy activity amount as cost basis and performance flow fallback because quote and unit price were unavailable.",
                        activity.id
                    ));
                } else {
                    diagnostics.push(format!(
                        "Security transfer activity {} used cost basis as performance flow fallback because no transfer-date quote was available.",
                        activity.id
                    ));
                }
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: lot_cost_basis_value.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else if lot_cost_basis_uses_legacy_amount {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    } else {
                        ExternalFlowSource::CostBasisFallback
                    },
                    basis_status: BasisStatus::Complete,
                    diagnostics,
                };
            }

            if let Some(amount) = activity.amount.filter(|amount| !amount.is_zero()) {
                diagnostics.push(format!(
                    "Security transfer activity {} used legacy activity amount as performance flow fallback because quote and cost basis were unavailable.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: amount.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    },
                    basis_status: BasisStatus::Unknown,
                    diagnostics,
                };
            }

            diagnostics.push(format!(
                "Security transfer activity {} has no quote, cost basis, or legacy amount for performance flow.",
                activity.id
            ));
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::Unknown,
                diagnostics,
            };
        }

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::NotApplicable,
                diagnostics,
            };
        }

        let performance_flow_value = Self::cash_or_legacy_flow_amount(activity);
        let performance_flow_source = if performance_flow_value.is_zero() {
            ExternalFlowSource::Unknown
        } else {
            ExternalFlowSource::CashAmount
        };

        ResolvedActivityEconomics {
            kind,
            lot_cost_basis_value,
            lot_cost_basis_currency: activity_currency.clone(),
            performance_flow_value,
            performance_flow_currency: activity_currency,
            performance_flow_source,
            basis_status: BasisStatus::NotApplicable,
            diagnostics,
        }
    }

    pub fn is_security_transfer(activity: &Activity) -> bool {
        matches!(
            activity.effective_type(),
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
        ) && activity
            .asset_id
            .as_deref()
            .is_some_and(|asset_id| !asset_id.trim().is_empty())
    }

    pub fn lot_cost_basis_value(activity: &Activity) -> Decimal {
        Self::lot_cost_basis_value_with_unit_multiplier(activity, Decimal::ONE)
    }

    pub fn lot_cost_basis_value_with_unit_multiplier(
        activity: &Activity,
        unit_multiplier: Decimal,
    ) -> Decimal {
        let quantity = activity.qty();
        let price_basis =
            quantity * activity.price() * Self::valid_unit_multiplier(unit_multiplier);
        if !price_basis.is_zero() {
            return price_basis;
        }

        if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN && !quantity.is_zero() {
            activity.amount.unwrap_or(Decimal::ZERO).abs()
        } else {
            Decimal::ZERO
        }
    }

    fn lot_cost_basis_uses_legacy_amount(activity: &Activity) -> bool {
        let unit_price_missing_or_zero = activity
            .unit_price
            .map(|unit_price| unit_price.is_zero())
            .unwrap_or(true);

        activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && unit_price_missing_or_zero
            && activity.amount.is_some_and(|amount| !amount.is_zero())
    }

    pub fn security_transfer_has_book_basis(activity: &Activity) -> bool {
        Self::is_security_transfer(activity)
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && (activity.unit_price.is_some_and(|price| !price.is_zero())
                || (activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
                    && activity.amount.is_some_and(|amount| !amount.is_zero())))
    }

    fn security_transfer_basis_status(activity: &Activity) -> BasisStatus {
        if Self::security_transfer_has_book_basis(activity) {
            BasisStatus::Complete
        } else {
            BasisStatus::Unknown
        }
    }

    fn event_kind(activity: &Activity, transfer_boundary: TransferBoundary) -> EconomicEventKind {
        match activity.effective_type() {
            ACTIVITY_TYPE_DEPOSIT | ACTIVITY_TYPE_WITHDRAWAL => EconomicEventKind::CashFlow,
            ACTIVITY_TYPE_CREDIT
                if activity.subtype.as_deref().is_some_and(|subtype| {
                    subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_BONUS)
                }) =>
            {
                EconomicEventKind::CashFlow
            }
            ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL => EconomicEventKind::Trade,
            ACTIVITY_TYPE_DIVIDEND | ACTIVITY_TYPE_INTEREST | ACTIVITY_TYPE_CREDIT => {
                EconomicEventKind::Income
            }
            ACTIVITY_TYPE_FEE => EconomicEventKind::Fee,
            ACTIVITY_TYPE_TAX => EconomicEventKind::Tax,
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT => {
                Self::transfer_event_kind(activity, transfer_boundary)
            }
            _ => EconomicEventKind::Other,
        }
    }

    fn transfer_event_kind(
        activity: &Activity,
        transfer_boundary: TransferBoundary,
    ) -> EconomicEventKind {
        match transfer_boundary {
            TransferBoundary::Internal => EconomicEventKind::InternalSecurityTransfer,
            TransferBoundary::Unknown => EconomicEventKind::UnknownBoundaryTransfer,
            TransferBoundary::External => match activity.effective_type() {
                ACTIVITY_TYPE_TRANSFER_IN if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryIn
                }
                ACTIVITY_TYPE_TRANSFER_OUT if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryOut
                }
                _ => EconomicEventKind::CashFlow,
            },
        }
    }

    fn cash_or_legacy_flow_amount(activity: &Activity) -> Decimal {
        activity
            .amount
            .or_else(|| Some(activity.quantity? * activity.unit_price?))
            .unwrap_or(Decimal::ZERO)
            .abs()
    }

    fn valid_unit_multiplier(unit_multiplier: Decimal) -> Decimal {
        if unit_multiplier > Decimal::ZERO {
            unit_multiplier
        } else {
            Decimal::ONE
        }
    }
}
