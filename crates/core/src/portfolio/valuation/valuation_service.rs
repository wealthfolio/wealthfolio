//! Daily valuation rows as stored by the coordinator, served to readers.
//! A scoped read sums the accounts' rows per day in base currency.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::NaiveDate;
use log::debug;
use rust_decimal::Decimal;

use super::valuation_model::{DailyAccountValuation, NegativeBalanceInfo, ValuationStatus};
use super::valuation_traits::ValuationRepositoryTrait;
use crate::errors::Result as CoreResult;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::coordinator::{rows, valuation_rows, FactSources};
use crate::portfolio::economic_events::BasisStatus;
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::AccountId;

#[async_trait]
pub trait ValuationServiceTrait: Send + Sync {
    /// Loads the valuation rows of one account within an optional date range.
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads and aggregates valuation history for a concrete account scope.
    /// Transfers between two in-scope accounts are internal and net to zero
    /// in the scope's flows (legacy `PerformanceFlows` semantics), so exports
    /// and assistants see real deposits and withdrawals only.
    async fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Per-day sums of the accounts' stored rows (charts): flows are the
    /// per-account gross flows, not netted.
    fn get_historical_valuation_totals_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads real-account valuation histories in an account-keyed shape.
    fn get_historical_valuations_by_account(
        &self,
        account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<String, Vec<DailyAccountValuation>>> {
        let mut histories = HashMap::with_capacity(account_ids.len());
        for account_id in account_ids {
            histories.insert(
                account_id.clone(),
                self.get_historical_valuations(account_id, start_date_opt, end_date_opt)?,
            );
        }
        Ok(histories)
    }

    /// The latest valuation row of each account that has one.
    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Accounts with at least one negative total value in their history.
    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>>;
}

#[derive(Clone)]
pub struct ValuationService {
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    /// Facts for netting internal transfers in scoped reads.
    sources: FactSources,
    lots: Arc<dyn LotRepositoryTrait>,
    timezone: Arc<RwLock<String>>,
}

impl ValuationService {
    pub fn new(
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        sources: FactSources,
        lots: Arc<dyn LotRepositoryTrait>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            valuation_repository,
            sources,
            lots,
            timezone,
        }
    }

    fn today(&self) -> NaiveDate {
        let timezone = self.timezone.read().unwrap_or_else(|p| p.into_inner());
        user_today(parse_user_timezone_or_default(&timezone))
    }
}

/// Per-day sums of the scope's rows in base currency; statuses and flow
/// provenance combine by their absorption laws (degradation never upgrades).
fn aggregate_rows(
    scope_id: &str,
    base_currency: &str,
    rows: Vec<DailyAccountValuation>,
) -> Vec<DailyAccountValuation> {
    let mut by_date: BTreeMap<NaiveDate, DailyAccountValuation> = BTreeMap::new();
    for row in rows {
        let date = row.valuation_date;
        let entry = by_date
            .entry(date)
            .or_insert_with(|| DailyAccountValuation {
                id: format!("{scope_id}_{date}"),
                account_id: scope_id.to_string(),
                valuation_date: date,
                account_currency: base_currency.to_string(),
                base_currency: base_currency.to_string(),
                fx_rate_to_base: Decimal::ONE,
                cash_balance: Decimal::ZERO,
                investment_market_value: Decimal::ZERO,
                total_value: Decimal::ZERO,
                cost_basis: Decimal::ZERO,
                book_basis: Decimal::ZERO,
                net_contribution: Decimal::ZERO,
                cash_balance_base: Decimal::ZERO,
                investment_market_value_base: Decimal::ZERO,
                total_value_base: Decimal::ZERO,
                cost_basis_base: Decimal::ZERO,
                book_basis_base: Decimal::ZERO,
                net_contribution_base: Decimal::ZERO,
                external_inflow_base: Decimal::ZERO,
                external_outflow_base: Decimal::ZERO,
                external_flow_source: Default::default(),
                performance_eligible_value_base: Decimal::ZERO,
                value_status: ValuationStatus::Complete,
                basis_status: BasisStatus::NotApplicable,
                calculated_at: row.calculated_at,
            });
        entry.cash_balance += row.cash_balance_base;
        entry.investment_market_value += row.investment_market_value_base;
        entry.total_value += row.total_value_base;
        entry.cost_basis += row.cost_basis_base;
        entry.book_basis += row.book_basis_base;
        entry.net_contribution += row.net_contribution_base;
        entry.cash_balance_base += row.cash_balance_base;
        entry.investment_market_value_base += row.investment_market_value_base;
        entry.total_value_base += row.total_value_base;
        entry.cost_basis_base += row.cost_basis_base;
        entry.book_basis_base += row.book_basis_base;
        entry.net_contribution_base += row.net_contribution_base;
        entry.external_inflow_base += row.external_inflow_base;
        entry.external_outflow_base += row.external_outflow_base;
        entry.external_flow_source = entry.external_flow_source.combine(row.external_flow_source);
        entry.performance_eligible_value_base += row.performance_eligible_value_base;
        entry.value_status = entry.value_status.combine(row.value_status);
        entry.basis_status = entry.basis_status.combine(row.basis_status);
        entry.calculated_at = entry.calculated_at.max(row.calculated_at);
    }
    by_date.into_values().collect()
}

#[async_trait]
impl ValuationServiceTrait for ValuationService {
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!(
            "Loading historical valuations for account '{}' from {:?} to {:?}",
            account_id, start_date_opt, end_date_opt
        );
        self.valuation_repository.get_historical_valuations(
            account_id,
            start_date_opt,
            end_date_opt,
        )
    }

    async fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        if account_ids.len() == 1 {
            return self.get_historical_valuation_totals_for_accounts(
                scope_id,
                account_ids,
                base_currency,
                start_date_opt,
                end_date_opt,
            );
        }
        // Several accounts: the kernel's scope aggregation nets the transfer
        // pairs whose both legs are in scope. It needs the full stored
        // history plus the facts (activities, disposals) that price the legs.
        let rows = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, None, None)?;
        let measured = rows::MeasureFacts::load(
            &self.sources,
            account_ids,
            base_currency,
            &self.timezone.read().unwrap_or_else(|p| p.into_inner()),
            self.today(),
        )?;
        let mut disposal_rows = Vec::new();
        for account_id in account_ids {
            disposal_rows.extend(self.lots.get_lot_disposals_for_account(account_id).await?);
        }
        let series = rows::stored_series(&rows);
        let disposals = rows::stored_disposals(&disposal_rows);
        let scope: Vec<AccountId> = account_ids.iter().map(AccountId::new).collect();
        let aggregated = engine::aggregate_scope(
            &measured.resolved(),
            &disposals,
            &series,
            &scope,
            engine::Window {
                start: start_date_opt,
                end: end_date_opt,
            },
        )
        .map_err(crate::errors::Error::Unexpected)?;
        Ok(valuation_rows(&aggregated, scope_id, base_currency))
    }

    fn get_historical_valuation_totals_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;
        Ok(aggregate_rows(scope_id, base_currency, rows))
    }

    fn get_historical_valuations_by_account(
        &self,
        account_ids: &[String],
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<HashMap<String, Vec<DailyAccountValuation>>> {
        let records = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;
        let mut histories: HashMap<String, Vec<DailyAccountValuation>> = account_ids
            .iter()
            .map(|id| (id.clone(), Vec::new()))
            .collect();
        for record in records {
            histories
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
        Ok(histories)
    }

    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        self.valuation_repository.get_latest_valuations(account_ids)
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        self.valuation_repository
            .get_valuations_on_date(account_ids, date)
    }

    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>> {
        self.valuation_repository
            .get_accounts_with_negative_balance(account_ids)
    }
}
