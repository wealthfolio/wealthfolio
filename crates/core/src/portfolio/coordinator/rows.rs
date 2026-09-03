//! Stored rows back into kernel types (the read path of `measure`): the
//! inverse of `persist.rs`.

use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine::model::{
    AccountId, ActivityId, AssetId, BasisStatus as KernelBasisStatus, Currency, DailyFlow,
    DailyValuation, EventId, FlowSource, LotDisposal as KernelDisposal, LotRecord as KernelLot,
    ValuationSeries, ValueStatus,
};

use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::valuation::{DailyAccountValuation, ExternalFlowSource, ValuationStatus};

fn decimal(raw: &str) -> Decimal {
    Decimal::from_str(raw.trim()).unwrap_or(Decimal::ZERO)
}

fn date(raw: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").ok()
}

fn flow_source(source: ExternalFlowSource) -> FlowSource {
    serde_json::from_value(serde_json::Value::String(source.as_str().to_string()))
        .unwrap_or(FlowSource::Unknown)
}

fn value_status(status: ValuationStatus) -> ValueStatus {
    match status {
        ValuationStatus::Complete => ValueStatus::Complete,
        ValuationStatus::PartialUnpriced => ValueStatus::PartialUnpriced,
        ValuationStatus::Unavailable => ValueStatus::Unavailable,
    }
}

fn basis_status(status: BasisStatus) -> KernelBasisStatus {
    match status {
        BasisStatus::Complete => KernelBasisStatus::Complete,
        BasisStatus::PartialUnknown => KernelBasisStatus::PartialUnknown,
        BasisStatus::Unknown => KernelBasisStatus::Unknown,
        BasisStatus::NotApplicable => KernelBasisStatus::NotApplicable,
    }
}

/// Stored valuation rows grouped into per-account series (rows sorted by
/// date within each account).
pub fn stored_series(rows: &[DailyAccountValuation]) -> BTreeMap<AccountId, ValuationSeries> {
    let mut series: BTreeMap<AccountId, ValuationSeries> = BTreeMap::new();
    for row in rows {
        let account = AccountId::new(&row.account_id);
        let entry = series
            .entry(account.clone())
            .or_insert_with(|| ValuationSeries {
                account,
                currency: Currency::parse(&row.account_currency)
                    .unwrap_or_else(|| Currency::parse("USD").expect("valid")),
                days: Vec::new(),
                diagnostics: Vec::new(),
            });
        entry.days.push(DailyValuation {
            date: row.valuation_date,
            fx_rate_to_base: row.fx_rate_to_base,
            cash_balance: row.cash_balance,
            investment_market_value: row.investment_market_value,
            total_value: row.total_value,
            cost_basis: row.cost_basis,
            book_basis: row.book_basis,
            net_contribution: row.net_contribution,
            cash_balance_base: row.cash_balance_base,
            investment_market_value_base: row.investment_market_value_base,
            total_value_base: row.total_value_base,
            cost_basis_base: row.cost_basis_base,
            book_basis_base: row.book_basis_base,
            net_contribution_base: row.net_contribution_base,
            performance_eligible_value_base: row.performance_eligible_value_base,
            value_status: value_status(row.value_status),
            basis_status: basis_status(row.basis_status),
            flow: DailyFlow {
                inflow_base: row.external_inflow_base,
                outflow_base: row.external_outflow_base,
                source: flow_source(row.external_flow_source),
            },
        });
    }
    for entry in series.values_mut() {
        entry.days.sort_by_key(|d| d.date);
        entry.days.dedup_by_key(|d| d.date);
    }
    series
}

pub fn stored_lots(rows: &[LotRecord]) -> Vec<KernelLot> {
    rows.iter()
        .filter_map(|lot| {
            Some(KernelLot {
                id: lot.id.clone(),
                account: AccountId::new(&lot.account_id),
                asset: AssetId::new(&lot.asset_id),
                open_date: date(&lot.open_date)?,
                open_activity: lot.open_activity_id.as_deref().map(ActivityId::new),
                original_quantity: decimal(&lot.original_quantity),
                remaining_quantity: decimal(&lot.remaining_quantity),
                cost_per_unit: decimal(&lot.cost_per_unit),
                original_cost_basis: decimal(&lot.original_cost_basis),
                remaining_cost_basis: decimal(&lot.remaining_cost_basis),
                original_cost_basis_base: decimal(&lot.original_cost_basis_base),
                remaining_cost_basis_base: decimal(&lot.remaining_cost_basis_base),
                fee_allocated: decimal(&lot.fee_allocated),
                fee_allocated_base: decimal(&lot.fee_allocated_base),
                tax_allocated: decimal(&lot.tax_allocated),
                tax_allocated_base: decimal(&lot.tax_allocated_base),
                currency: Currency::parse(&lot.currency)?,
                fx_rate_to_base: decimal(&lot.fx_rate_to_base),
                fx_rate_to_account: lot.fx_rate_to_account.as_deref().map(decimal),
                split_ratio: decimal(&lot.split_ratio),
                close_date: lot.close_date.as_deref().and_then(date),
                close_event: lot.close_activity_id.as_deref().map(EventId::new),
            })
        })
        .collect()
}

pub fn stored_disposals(rows: &[LotDisposal]) -> Vec<KernelDisposal> {
    rows.iter()
        .filter_map(|d| {
            Some(KernelDisposal {
                id: d.id.clone(),
                lot_id: d.lot_id.clone(),
                account: AccountId::new(&d.account_id),
                asset: AssetId::new(&d.asset_id),
                event: EventId::new(&d.disposal_activity_id),
                date: date(&d.disposal_date)?,
                quantity: decimal(&d.quantity),
                proceeds: decimal(&d.proceeds),
                cost_basis: decimal(&d.cost_basis),
                realized_pnl: decimal(&d.realized_pnl),
                proceeds_base: decimal(&d.proceeds_base),
                cost_basis_base: decimal(&d.cost_basis_base),
                realized_pnl_base: decimal(&d.realized_pnl_base),
                currency: Currency::parse(&d.currency)?,
                fx_rate_to_base: decimal(&d.fx_rate_to_base),
            })
        })
        .collect()
}

/// Facts resolved for a read (`measure`, scoped valuation aggregation): the
/// scope's transfer closure normalised, compiled and surfaced once.
pub struct MeasureFacts {
    pub facts: wealthfolio_portfolio_engine::model::CanonicalFacts,
    pub ledger: wealthfolio_portfolio_engine::CompiledLedger,
    pub surfaces: wealthfolio_portfolio_engine::ResolvedSurfaces,
    pub range: wealthfolio_portfolio_engine::model::DateRange,
}

impl MeasureFacts {
    pub fn load(
        sources: &super::FactSources,
        account_ids: &[String],
        base_currency: &str,
        timezone: &str,
        as_of: chrono::NaiveDate,
    ) -> crate::errors::Result<Self> {
        let raw = sources.load_for_measure(account_ids, base_currency, timezone, as_of)?;
        let normalized = wealthfolio_portfolio_engine::normalize(raw)?;
        let facts = normalized.facts;
        let ledger = wealthfolio_portfolio_engine::compile(&facts);
        let range = wealthfolio_portfolio_engine::model::DateRange {
            start: facts
                .activities
                .iter()
                .map(|a| a.date)
                .min()
                .unwrap_or(as_of)
                .min(as_of),
            end: as_of,
        };
        let surfaces = wealthfolio_portfolio_engine::resolve_surfaces(&facts, range);
        Ok(Self {
            facts,
            ledger,
            surfaces,
            range,
        })
    }

    pub fn resolved(&self) -> wealthfolio_portfolio_engine::Resolved<'_> {
        wealthfolio_portfolio_engine::Resolved {
            facts: &self.facts,
            ledger: &self.ledger,
            surfaces: &self.surfaces,
            range: self.range,
        }
    }
}
