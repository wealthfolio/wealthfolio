//! Health service implementation.
//!
//! The HealthService orchestrates health checks, manages dismissals,
//! and handles fix actions.

use async_trait::async_trait;
use chrono::{Duration, NaiveDate, Utc};
use log::{debug, info, warn};
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::accounts::{
    account_types, is_liability_account_type, Account, AccountServiceTrait, TrackingMode,
};
use crate::activities::{
    Activity, ActivityServiceTrait, TransferPairResolution, ACTIVITY_TYPE_BUY,
    ACTIVITY_TYPE_TRANSFER_IN,
};
use crate::assets::{Asset, AssetKind, AssetServiceTrait, InstrumentType, QuoteMode};
use crate::errors::Result;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::economic_events::BasisStatus;
use crate::portfolio::holdings::{HoldingType, HoldingsServiceTrait};
use crate::portfolio::performance::is_external_transfer;
use crate::portfolio::snapshot::holdings_calculator::economics::{
    gross_trade_amount, AssetPositionInfo,
};
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotServiceTrait};
use crate::portfolio::valuation::{
    DailyAccountValuation, ExternalFlowSource, ValuationServiceTrait, ValuationStatus,
};
use crate::quotes::QuoteServiceTrait;
use crate::taxonomies::TaxonomyServiceTrait;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

use super::checks::{
    AccountConfigurationCheck, AssetHoldingInfo, ClassificationCheck, ConsistencyIssueInfo,
    DataConsistencyCheck, FxIntegrityCheck, FxPairInfo, InvalidTransferGroupInfo,
    LegacyMigrationInfo, PriceStalenessCheck, QuoteSyncCheck, QuoteSyncErrorInfo,
    TransferIntegrityCheck, TransferLegDetail, UnclassifiedAssetInfo, UnconfiguredAccountInfo,
    ValuationIssueReason,
};
use super::errors::HealthError;
use super::model::{FixAction, HealthConfig, HealthIssue, HealthStatus, IssueDismissal};
use super::traits::{HealthContext, HealthDismissalStore, HealthServiceTrait};

/// Cache entry for health status.
struct CachedStatus {
    status: HealthStatus,
    cached_at: chrono::DateTime<chrono::Utc>,
}

/// Service for running health checks and managing health status.
pub struct HealthService {
    /// Storage for dismissals
    dismissal_store: Arc<dyn HealthDismissalStore>,

    /// Current configuration
    config: RwLock<HealthConfig>,

    /// Cached health status
    cached_status: RwLock<Option<CachedStatus>>,

    /// Individual check implementations
    price_check: PriceStalenessCheck,
    quote_sync_check: QuoteSyncCheck,
    fx_check: FxIntegrityCheck,
    classification_check: ClassificationCheck,
    consistency_check: DataConsistencyCheck,
    account_config_check: AccountConfigurationCheck,
    transfer_integrity_check: TransferIntegrityCheck,
}

fn is_price_staleness_candidate(
    holding_type: &HoldingType,
    asset_kind: Option<&AssetKind>,
) -> bool {
    !matches!(holding_type, HoldingType::Cash) && !matches!(asset_kind, Some(AssetKind::Fx))
}

impl HealthService {
    /// Creates a new health service.
    pub fn new(dismissal_store: Arc<dyn HealthDismissalStore>) -> Self {
        Self {
            dismissal_store,
            config: RwLock::new(HealthConfig::default()),
            cached_status: RwLock::new(None),
            price_check: PriceStalenessCheck::new(),
            quote_sync_check: QuoteSyncCheck::new(),
            fx_check: FxIntegrityCheck::new(),
            classification_check: ClassificationCheck::new(),
            consistency_check: DataConsistencyCheck::new(),
            account_config_check: AccountConfigurationCheck::new(),
            transfer_integrity_check: TransferIntegrityCheck::new(),
        }
    }

    /// Creates a health service with custom configuration.
    pub fn with_config(
        dismissal_store: Arc<dyn HealthDismissalStore>,
        config: HealthConfig,
    ) -> Self {
        Self {
            dismissal_store,
            config: RwLock::new(config),
            cached_status: RwLock::new(None),
            price_check: PriceStalenessCheck::new(),
            quote_sync_check: QuoteSyncCheck::new(),
            fx_check: FxIntegrityCheck::new(),
            classification_check: ClassificationCheck::new(),
            consistency_check: DataConsistencyCheck::new(),
            account_config_check: AccountConfigurationCheck::new(),
            transfer_integrity_check: TransferIntegrityCheck::new(),
        }
    }

    /// Runs all health checks with the provided data.
    ///
    /// This is the main entry point for running checks. The caller is responsible
    /// for gathering the necessary data from the portfolio.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_checks_with_data(
        &self,
        base_currency: &str,
        total_portfolio_value: f64,
        holdings: &[AssetHoldingInfo],
        latest_quote_times: &std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>,
        quote_sync_errors: &[QuoteSyncErrorInfo],
        fx_pairs: &[FxPairInfo],
        unclassified_assets: &[UnclassifiedAssetInfo],
        consistency_issues: &[ConsistencyIssueInfo],
        legacy_migration_info: &Option<LegacyMigrationInfo>,
        unconfigured_accounts: &[UnconfiguredAccountInfo],
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
        invalid_transfer_groups: &[InvalidTransferGroupInfo],
    ) -> Result<HealthStatus> {
        let config = self.config.read().await.clone();
        let ctx = HealthContext::new(config, base_currency, total_portfolio_value);

        info!(
            "Running health checks for portfolio (base currency: {})",
            base_currency
        );

        let mut all_issues = Vec::new();

        // Run price staleness check
        debug!(
            "Running price staleness check on {} holdings",
            holdings.len()
        );
        let price_issues = self.price_check.analyze(holdings, latest_quote_times, &ctx);
        debug!("Price staleness check found {} issues", price_issues.len());
        all_issues.extend(price_issues);

        // Run quote sync error check
        debug!(
            "Running quote sync check on {} assets with errors",
            quote_sync_errors.len()
        );
        let sync_issues = self.quote_sync_check.analyze(quote_sync_errors, &ctx);
        debug!("Quote sync check found {} issues", sync_issues.len());
        all_issues.extend(sync_issues);

        // Run FX integrity check
        debug!("Running FX integrity check on {} pairs", fx_pairs.len());
        let fx_issues = self.fx_check.analyze(fx_pairs, &ctx);
        debug!("FX integrity check found {} issues", fx_issues.len());
        all_issues.extend(fx_issues);

        // Run classification check
        debug!(
            "Running classification check on {} unclassified assets",
            unclassified_assets.len()
        );
        let class_issues = self.classification_check.analyze(unclassified_assets, &ctx);
        debug!("Classification check found {} issues", class_issues.len());
        all_issues.extend(class_issues);

        // Run legacy migration check
        debug!("Running legacy migration check");
        let migration_issues = self
            .classification_check
            .analyze_legacy_migration(legacy_migration_info, &ctx);
        debug!(
            "Legacy migration check found {} issues",
            migration_issues.len()
        );
        all_issues.extend(migration_issues);

        // Run data consistency check
        debug!(
            "Running data consistency check with {} potential issues",
            consistency_issues.len()
        );
        let consistency_health_issues = self.consistency_check.analyze(consistency_issues, &ctx);
        debug!(
            "Data consistency check found {} issues",
            consistency_health_issues.len()
        );
        all_issues.extend(consistency_health_issues);

        // Run account configuration check
        debug!(
            "Running account configuration check on {} unconfigured accounts",
            unconfigured_accounts.len()
        );
        let account_config_issues = self.account_config_check.analyze(
            unconfigured_accounts,
            configured_timezone,
            client_timezone,
            &ctx,
        );
        debug!(
            "Account configuration check found {} issues",
            account_config_issues.len()
        );
        all_issues.extend(account_config_issues);

        // Run transfer integrity check (invalid / incomplete transfer groups)
        debug!(
            "Running transfer integrity check on {} invalid groups",
            invalid_transfer_groups.len()
        );
        let transfer_issues = self
            .transfer_integrity_check
            .analyze(invalid_transfer_groups, &ctx);
        debug!(
            "Transfer integrity check found {} issues",
            transfer_issues.len()
        );
        all_issues.extend(transfer_issues);

        // Filter out dismissed issues (unless data has changed)
        let filtered_issues = self.filter_dismissed_issues(all_issues).await?;

        // Build status
        let status = HealthStatus::from_issues(filtered_issues);

        // Cache the result
        let cached = CachedStatus {
            status: status.clone(),
            cached_at: Utc::now(),
        };
        *self.cached_status.write().await = Some(cached);

        info!(
            "Health check complete: {} issues found (overall severity: {:?})",
            status.total_count(),
            status.overall_severity
        );

        Ok(status)
    }

    /// Runs all health checks by gathering data from the provided services.
    ///
    /// This is the main entry point for health checks that handles all data gathering.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_full_checks(
        &self,
        base_currency: &str,
        account_service: Arc<dyn AccountServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        valuation_service: Arc<dyn ValuationServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        activity_service: Arc<dyn ActivityServiceTrait>,
        lot_repository: Arc<dyn LotRepositoryTrait>,
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
    ) -> Result<HealthStatus> {
        // Gather holdings data from all accounts
        let accounts = account_service.get_active_non_archived_accounts()?;

        // Use a map to consolidate holdings by asset_id (same asset in multiple accounts)
        let mut holdings_map: HashMap<String, AssetHoldingInfo> = HashMap::new();
        let mut latest_quote_times: HashMap<String, chrono::DateTime<chrono::Utc>> = HashMap::new();
        let mut total_portfolio_value = 0.0;
        // Track FX pairs needed: (from_currency, to_currency) → affected market value
        let mut fx_pair_mv: HashMap<(String, String), f64> = HashMap::new();

        for account in &accounts {
            let holdings = holdings_service
                .get_holdings(&account.id, base_currency)
                .await?;

            for holding in holdings {
                // Collect FX pair info before filtering to instrument-only
                if holding.local_currency != holding.base_currency {
                    let mv = holding
                        .market_value
                        .base
                        .to_string()
                        .parse::<f64>()
                        .unwrap_or(0.0)
                        .abs();
                    *fx_pair_mv
                        .entry((
                            holding.local_currency.clone(),
                            holding.base_currency.clone(),
                        ))
                        .or_default() += mv;
                }

                if !is_price_staleness_candidate(&holding.holding_type, holding.asset_kind.as_ref())
                {
                    continue;
                }

                if let Some(ref instrument) = holding.instrument {
                    let market_value_f64 = holding
                        .market_value
                        .base
                        .to_string()
                        .parse::<f64>()
                        .unwrap_or(0.0);
                    total_portfolio_value += market_value_f64;

                    // Determine if uses market pricing
                    let uses_market_pricing = instrument.pricing_mode.to_uppercase() == "MARKET";

                    // Consolidate by asset_id - if same asset appears in multiple accounts,
                    // combine market values
                    holdings_map
                        .entry(instrument.id.clone())
                        .and_modify(|existing| {
                            existing.market_value += market_value_f64;
                        })
                        .or_insert(AssetHoldingInfo {
                            asset_id: instrument.id.clone(),
                            symbol: instrument.symbol.clone(),
                            name: instrument.name.clone(),
                            exchange_mic: instrument.exchange_mic.clone(),
                            market_value: market_value_f64,
                            uses_market_pricing,
                        });
                }
            }
        }

        let all_holdings: Vec<AssetHoldingInfo> = holdings_map.into_values().collect();

        // Get latest quote timestamps for held assets
        let asset_ids: Vec<String> = all_holdings.iter().map(|h| h.asset_id.clone()).collect();
        if !asset_ids.is_empty() {
            if let Ok(quotes) = quote_service.get_latest_quotes(&asset_ids) {
                for (asset_id, quote) in quotes {
                    latest_quote_times.insert(asset_id, quote.timestamp);
                }
            }
        }

        // Gather legacy migration status
        let legacy_migration_info = super::gather_legacy_migration_status(
            asset_service.as_ref(),
            taxonomy_service.as_ref(),
        );

        // Gather quote sync errors
        let holding_mv_map: HashMap<String, f64> = all_holdings
            .iter()
            .map(|h| (h.asset_id.clone(), h.market_value))
            .collect();
        let quote_sync_errors = super::gather_quote_sync_errors(
            quote_service.as_ref(),
            asset_service.as_ref(),
            &holding_mv_map,
            &latest_quote_times,
        );

        // Gather FX pairs from holdings where local_currency != base_currency
        let fx_pairs: Vec<FxPairInfo> = if fx_pair_mv.is_empty() {
            Vec::new()
        } else {
            // Build instrument_key → asset_id map for FX assets only
            let fx_asset_map: HashMap<String, String> = asset_service
                .get_assets()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|a| {
                    a.instrument_key
                        .filter(|k| k.starts_with("FX:"))
                        .map(|k| (k, a.id))
                })
                .collect();
            let fx_pair_asset_ids: HashSet<String> = fx_pair_mv
                .keys()
                .filter_map(|(from_ccy, to_ccy)| {
                    let key_direct = format!("FX:{}/{}", from_ccy, to_ccy);
                    let key_inverse = format!("FX:{}/{}", to_ccy, from_ccy);
                    fx_asset_map
                        .get(&key_direct)
                        .or_else(|| fx_asset_map.get(&key_inverse))
                        .cloned()
                })
                .collect();
            let fx_latest_quote_times: HashMap<String, chrono::DateTime<Utc>> = if fx_pair_asset_ids
                .is_empty()
            {
                HashMap::new()
            } else {
                let fx_pair_asset_id_list: Vec<String> = fx_pair_asset_ids.into_iter().collect();
                quote_service
                    .get_latest_quotes(&fx_pair_asset_id_list)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(asset_id, quote)| (asset_id, quote.timestamp))
                    .collect()
            };

            fx_pair_mv
                .iter()
                .map(|((from_ccy, to_ccy), affected_mv)| {
                    // Check both directions since FX asset could be stored either way
                    let key_direct = format!("FX:{}/{}", from_ccy, to_ccy);
                    let key_inverse = format!("FX:{}/{}", to_ccy, from_ccy);
                    let latest_quote_time = fx_asset_map
                        .get(&key_direct)
                        .or_else(|| fx_asset_map.get(&key_inverse))
                        .and_then(|asset_id| fx_latest_quote_times.get(asset_id).copied());

                    FxPairInfo {
                        pair_id: format!("{}:{}", from_ccy, to_ccy),
                        from_currency: from_ccy.clone(),
                        to_currency: to_ccy.clone(),
                        affected_mv: *affected_mv,
                        latest_quote_time,
                    }
                })
                .collect()
        };
        let unclassified_assets = super::gather_unclassified_assets(
            asset_service.as_ref(),
            taxonomy_service.as_ref(),
            &holding_mv_map,
        );

        // Detect accounts with negative portfolio balance in their history.
        // Exclude cash and credit-card accounts; card debt is an expected liability.
        let all_account_ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();
        let account_ids: Vec<String> = accounts
            .iter()
            .filter(|a| {
                a.account_type != account_types::CASH && !is_liability_account_type(&a.account_type)
            })
            .map(|a| a.id.clone())
            .collect();
        let account_name_map: std::collections::HashMap<String, String> = accounts
            .iter()
            .map(|a| (a.id.clone(), a.name.clone()))
            .collect();
        let account_tracking_map: std::collections::HashMap<String, TrackingMode> = accounts
            .iter()
            .map(|a| (a.id.clone(), a.tracking_mode))
            .collect();
        let negative_balance_accounts = valuation_service
            .get_accounts_with_negative_balance(&account_ids)
            .unwrap_or_else(|e| {
                warn!("Failed to check for negative account balances: {}", e);
                Vec::new()
            });
        let mut consistency_issues: Vec<ConsistencyIssueInfo> = negative_balance_accounts
            .into_iter()
            .map(|info| {
                let name = account_name_map
                    .get(&info.account_id)
                    .cloned()
                    .unwrap_or_else(|| info.account_id.clone());
                ConsistencyIssueInfo {
                    issue_type: super::checks::ConsistencyIssueType::NegativeAccountBalance,
                    record_id: info.account_id.clone(),
                    description: name,
                    account_id: Some(info.account_id),
                    asset_id: None,
                    first_negative_date: Some(info.first_negative_date),
                    cash_balance: Some(info.cash_balance),
                    total_value_at_date: Some(info.total_value),
                    account_currency: Some(info.account_currency),
                    activity_date: None,
                    asset_symbol: None,
                    asset_name: None,
                    quantity: None,
                    proceeds: None,
                    reason: None,
                    activity_id: None,
                }
            })
            .collect();

        // Check CASH accounts separately — negative balance may be a normal overdraft (INFO only)
        let cash_account_ids: Vec<String> = accounts
            .iter()
            .filter(|a| a.account_type == account_types::CASH)
            .map(|a| a.id.clone())
            .collect();
        if !cash_account_ids.is_empty() {
            let negative_cash_accounts = valuation_service
                .get_accounts_with_negative_balance(&cash_account_ids)
                .unwrap_or_else(|e| {
                    warn!("Failed to check for negative cash balances: {}", e);
                    Vec::new()
                });
            for info in negative_cash_accounts {
                let name = account_name_map
                    .get(&info.account_id)
                    .cloned()
                    .unwrap_or_else(|| info.account_id.clone());
                consistency_issues.push(ConsistencyIssueInfo {
                    issue_type: super::checks::ConsistencyIssueType::NegativeCashBalance,
                    record_id: info.account_id.clone(),
                    description: name,
                    account_id: Some(info.account_id),
                    asset_id: None,
                    first_negative_date: Some(info.first_negative_date),
                    cash_balance: Some(info.cash_balance),
                    total_value_at_date: Some(info.total_value),
                    account_currency: Some(info.account_currency),
                    activity_date: None,
                    asset_symbol: None,
                    asset_name: None,
                    quantity: None,
                    proceeds: None,
                    reason: None,
                    activity_id: None,
                });
            }
        }

        // Gather accounts without tracking mode set
        let unconfigured_accounts: Vec<UnconfiguredAccountInfo> = accounts
            .iter()
            .filter(|acc| acc.tracking_mode == crate::accounts::TrackingMode::NotSet)
            .map(|acc| UnconfiguredAccountInfo {
                account_id: acc.id.clone(),
                account_name: acc.name.clone(),
            })
            .collect();

        // Detect invalid, incomplete, or unreviewed transfer flows across all
        // activities so the Health Center can surface them.
        let effective_timezone = effective_timezone(configured_timezone, client_timezone);
        let health_activities = activity_service.get_activities().unwrap_or_else(|e| {
            warn!("Failed to load activities for Health checks: {}", e);
            Vec::new()
        });
        let invalid_transfer_groups = invalid_transfer_groups_from_activities(
            &health_activities,
            &account_name_map,
            effective_timezone,
        );
        let valuation_quality_issues = gather_valuation_quality_issues(
            valuation_service.as_ref(),
            snapshot_service.as_ref(),
            asset_service.as_ref(),
            quote_service.as_ref(),
            &all_account_ids,
            &account_name_map,
            &account_tracking_map,
            &latest_quote_times,
        )
        .await;
        consistency_issues.extend(valuation_quality_issues);
        let missing_lot_disposal_sells = gather_missing_lot_disposal_sells(
            lot_repository.as_ref(),
            asset_service.as_ref(),
            &accounts,
            &health_activities,
            effective_timezone,
        )
        .await;
        consistency_issues.extend(missing_lot_disposal_sells);
        let incomplete_basis_trades = gather_incomplete_basis_trade_activities(
            asset_service.as_ref(),
            &accounts,
            &health_activities,
            effective_timezone,
        )
        .await;
        consistency_issues.extend(incomplete_basis_trades);

        // Run checks with gathered data
        self.run_checks_with_data(
            base_currency,
            total_portfolio_value,
            &all_holdings,
            &latest_quote_times,
            &quote_sync_errors,
            &fx_pairs,
            &unclassified_assets,
            &consistency_issues,
            &legacy_migration_info,
            &unconfigured_accounts,
            configured_timezone,
            client_timezone,
            &invalid_transfer_groups,
        )
        .await
    }

    /// Filters out issues that have been dismissed (unless their data has changed).
    async fn filter_dismissed_issues(&self, issues: Vec<HealthIssue>) -> Result<Vec<HealthIssue>> {
        let dismissals = self.dismissal_store.get_dismissals().await?;

        let dismissed_map: std::collections::HashMap<String, &IssueDismissal> =
            dismissals.iter().map(|d| (d.issue_id.clone(), d)).collect();

        let mut filtered = Vec::new();

        for issue in issues {
            if let Some(dismissal) = dismissed_map.get(&issue.id) {
                // Check if data has changed since dismissal
                if dismissal.data_hash != issue.data_hash {
                    // Data changed, restore the issue
                    debug!("Restoring dismissed issue {} due to data change", issue.id);
                    if let Err(e) = self.dismissal_store.remove_dismissal(&issue.id).await {
                        warn!("Failed to remove stale dismissal: {}", e);
                    }
                    filtered.push(issue);
                }
                // Otherwise, skip the dismissed issue
            } else {
                filtered.push(issue);
            }
        }

        Ok(filtered)
    }
}

fn effective_timezone<'a>(
    configured_timezone: Option<&'a str>,
    client_timezone: Option<&'a str>,
) -> Option<&'a str> {
    configured_timezone
        .filter(|tz| !tz.trim().is_empty())
        .or_else(|| client_timezone.filter(|tz| !tz.trim().is_empty()))
}

/// Loads all activities and resolves transfer groups, returning the ones that
/// don't form a valid pair, plus posted ungrouped transfers that are not
/// explicitly marked as external.
fn invalid_transfer_groups_from_activities(
    activities: &[Activity],
    account_names: &HashMap<String, String>,
    timezone: Option<&str>,
) -> Vec<InvalidTransferGroupInfo> {
    let tz = parse_user_timezone_or_default(timezone.unwrap_or_default());
    let resolution = TransferPairResolution::from_activities(activities);
    let by_id: HashMap<&str, &Activity> = activities.iter().map(|a| (a.id.as_str(), a)).collect();
    let eligible_account_ids: HashSet<&str> = account_names.keys().map(String::as_str).collect();

    let mut groups: Vec<InvalidTransferGroupInfo> = resolution
        .invalid_groups()
        .iter()
        .filter_map(|group| {
            let legs: Vec<_> = group
                .activity_ids
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .filter(|act| act.is_posted() && !is_external_transfer(act))
                .filter(|act| eligible_account_ids.contains(act.account_id.as_str()))
                .map(|act| transfer_leg_detail(act, account_names, tz))
                .collect();
            (!legs.is_empty()).then(|| InvalidTransferGroupInfo {
                group_id: group.group_id.clone(),
                legs,
            })
        })
        .collect();

    for activity in activities {
        if activity.is_posted()
            && resolution.is_ungrouped_transfer(&activity.id)
            && !is_external_transfer(activity)
            && eligible_account_ids.contains(activity.account_id.as_str())
        {
            groups.push(InvalidTransferGroupInfo {
                group_id: format!("ungrouped:{}", activity.id),
                legs: vec![transfer_leg_detail(activity, account_names, tz)],
            });
        }
    }

    for pair in resolution.pairs() {
        for activity in [&pair.transfer_in, &pair.transfer_out] {
            if activity.is_posted()
                && is_external_transfer(activity)
                && eligible_account_ids.contains(activity.account_id.as_str())
            {
                groups.push(InvalidTransferGroupInfo {
                    group_id: format!("conflicting_external_marker:{}", activity.id),
                    legs: vec![transfer_leg_detail(activity, account_names, tz)],
                });
            }
        }
    }

    groups
}

async fn gather_missing_lot_disposal_sells(
    lot_repository: &dyn LotRepositoryTrait,
    asset_service: &dyn AssetServiceTrait,
    accounts: &[Account],
    activities: &[Activity],
    timezone: Option<&str>,
) -> Vec<ConsistencyIssueInfo> {
    let eligible_accounts: HashMap<String, &Account> = accounts
        .iter()
        .filter(|account| {
            account.is_active
                && !account.is_archived
                && account.tracking_mode == TrackingMode::Transactions
                && matches!(
                    account.account_type.as_str(),
                    account_types::SECURITIES | account_types::CRYPTOCURRENCY
                )
        })
        .map(|account| (account.id.clone(), account))
        .collect();
    if eligible_accounts.is_empty() {
        return Vec::new();
    }

    let sell_activities: Vec<&Activity> = activities
        .iter()
        .filter(|activity| {
            activity.is_posted()
                && activity.asset_id.is_some()
                && eligible_accounts.contains_key(&activity.account_id)
                && activity.effective_type().eq_ignore_ascii_case("SELL")
        })
        .collect();
    if sell_activities.is_empty() {
        return Vec::new();
    }

    let sell_account_ids: std::collections::HashSet<String> = sell_activities
        .iter()
        .map(|activity| activity.account_id.clone())
        .collect();
    let mut disposal_activity_ids_by_account: HashMap<String, std::collections::HashSet<String>> =
        HashMap::new();
    for account_id in sell_account_ids {
        match lot_repository
            .get_lot_disposals_for_account(&account_id)
            .await
        {
            Ok(disposals) => {
                disposal_activity_ids_by_account.insert(
                    account_id,
                    disposals
                        .into_iter()
                        .map(|d| d.disposal_activity_id)
                        .collect(),
                );
            }
            Err(e) => {
                warn!(
                    "Failed to load lot disposals for account {} during health check: {}",
                    account_id, e
                );
            }
        }
    }

    let asset_ids: Vec<String> = sell_activities
        .iter()
        .filter_map(|activity| activity.asset_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let assets_by_id: HashMap<String, crate::assets::Asset> = asset_service
        .get_assets_by_asset_ids(&asset_ids)
        .await
        .unwrap_or_else(|e| {
            warn!(
                "Failed to load assets for missing lot disposal health check: {}",
                e
            );
            Vec::new()
        })
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect();

    missing_lot_disposal_sells_from_data(
        accounts,
        activities,
        &disposal_activity_ids_by_account,
        &assets_by_id,
        timezone,
    )
}

fn missing_lot_disposal_sells_from_data(
    accounts: &[Account],
    activities: &[Activity],
    disposal_activity_ids_by_account: &HashMap<String, std::collections::HashSet<String>>,
    assets_by_id: &HashMap<String, Asset>,
    timezone: Option<&str>,
) -> Vec<ConsistencyIssueInfo> {
    let eligible_accounts: HashMap<String, &Account> = accounts
        .iter()
        .filter(|account| {
            account.is_active
                && !account.is_archived
                && account.tracking_mode == TrackingMode::Transactions
                && matches!(
                    account.account_type.as_str(),
                    account_types::SECURITIES | account_types::CRYPTOCURRENCY
                )
        })
        .map(|account| (account.id.clone(), account))
        .collect();

    let tz = parse_user_timezone_or_default(timezone.unwrap_or_default());
    activities
        .iter()
        .filter(|activity| {
            activity.is_posted()
                && activity.asset_id.is_some()
                && eligible_accounts.contains_key(&activity.account_id)
                && activity.effective_type().eq_ignore_ascii_case("SELL")
        })
        .filter(|activity| {
            disposal_activity_ids_by_account
                .get(&activity.account_id)
                .is_some_and(|disposal_activity_ids| !disposal_activity_ids.contains(&activity.id))
        })
        .filter_map(|activity| {
            let account = eligible_accounts.get(&activity.account_id)?;
            let asset_id = activity.asset_id.as_ref()?;
            let asset = assets_by_id.get(asset_id);
            let asset_symbol = asset
                .and_then(|a| {
                    a.display_code
                        .clone()
                        .or_else(|| a.instrument_symbol.clone())
                })
                .or_else(|| Some(asset_id.clone()));
            let asset_name = asset.and_then(|a| a.name.clone());
            let proceeds = health_sell_net_proceeds(activity, asset);

            Some(ConsistencyIssueInfo {
                issue_type: super::checks::ConsistencyIssueType::MissingLotDisposalForSell,
                record_id: activity.id.clone(),
                description: account.name.clone(),
                account_id: Some(activity.account_id.clone()),
                asset_id: Some(asset_id.clone()),
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: Some(activity.currency.clone()),
                activity_date: Some(activity_date_in_tz(activity.activity_date, tz)),
                asset_symbol,
                asset_name,
                quantity: activity.quantity.map(|q| q.abs()),
                proceeds: Some(proceeds),
                reason: None,
                activity_id: None,
            })
        })
        .collect()
}

/// Detects incomplete cost basis at the source for TRANSACTIONS-tracked accounts:
/// a lot-creating acquisition with a positive quantity but no price. `add_lot` derives
/// `cost_basis = qty * unit_price + fees` (ignoring `amount`), so a null/zero
/// `unit_price` produces a zero-cost lot and thus an incomplete basis. Reported
/// against the exact activity for a precise deep-link.
async fn gather_incomplete_basis_trade_activities(
    asset_service: &dyn AssetServiceTrait,
    accounts: &[Account],
    activities: &[Activity],
    timezone: Option<&str>,
) -> Vec<ConsistencyIssueInfo> {
    let eligible_account_ids: HashSet<&str> = accounts
        .iter()
        .filter(|account| {
            account.is_active
                && !account.is_archived
                && account.tracking_mode == TrackingMode::Transactions
                && matches!(
                    account.account_type.as_str(),
                    account_types::SECURITIES | account_types::CRYPTOCURRENCY
                )
        })
        .map(|account| account.id.as_str())
        .collect();
    if eligible_account_ids.is_empty() {
        return Vec::new();
    }

    let asset_ids: Vec<String> = activities
        .iter()
        .filter(|activity| {
            activity.is_posted()
                && activity.asset_id.is_some()
                && eligible_account_ids.contains(activity.account_id.as_str())
                && is_lot_creating_basis_source(activity)
                && activity
                    .quantity
                    .is_some_and(|qty| qty.is_sign_positive() && !qty.is_zero())
                && activity.unit_price.is_none_or(|price| price.is_zero())
        })
        .filter_map(|activity| activity.asset_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if asset_ids.is_empty() {
        return Vec::new();
    }
    let assets_by_id: HashMap<String, Asset> = asset_service
        .get_assets_by_asset_ids(&asset_ids)
        .await
        .unwrap_or_else(|e| {
            warn!(
                "Failed to load assets for incomplete cost-basis health check: {}",
                e
            );
            Vec::new()
        })
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect();

    incomplete_basis_trade_activities_from_data(accounts, activities, &assets_by_id, timezone)
}

fn incomplete_basis_trade_activities_from_data(
    accounts: &[Account],
    activities: &[Activity],
    assets_by_id: &HashMap<String, Asset>,
    timezone: Option<&str>,
) -> Vec<ConsistencyIssueInfo> {
    let eligible_accounts: HashMap<String, &Account> = accounts
        .iter()
        .filter(|account| {
            account.is_active
                && !account.is_archived
                && account.tracking_mode == TrackingMode::Transactions
                && matches!(
                    account.account_type.as_str(),
                    account_types::SECURITIES | account_types::CRYPTOCURRENCY
                )
        })
        .map(|account| (account.id.clone(), account))
        .collect();

    let tz = parse_user_timezone_or_default(timezone.unwrap_or_default());
    activities
        .iter()
        .filter(|activity| {
            activity.is_posted()
                && activity.asset_id.is_some()
                && eligible_accounts.contains_key(&activity.account_id)
                && is_lot_creating_basis_source(activity)
                // A positive-quantity acquisition with no price yields a zero-cost lot.
                && activity
                    .quantity
                    .is_some_and(|qty| qty.is_sign_positive() && !qty.is_zero())
                && activity.unit_price.is_none_or(|price| price.is_zero())
        })
        .filter_map(|activity| {
            let account = eligible_accounts.get(&activity.account_id)?;
            let asset_id = activity.asset_id.as_ref()?;
            let asset = assets_by_id.get(asset_id);
            let asset_symbol = asset
                .and_then(|a| {
                    a.display_code
                        .clone()
                        .or_else(|| a.instrument_symbol.clone())
                })
                .or_else(|| Some(asset_id.clone()));
            let asset_name = asset.and_then(|a| a.name.clone());

            Some(ConsistencyIssueInfo {
                issue_type: super::checks::ConsistencyIssueType::IncompleteValuationBasis,
                record_id: activity.id.clone(),
                description: account.name.clone(),
                account_id: Some(activity.account_id.clone()),
                asset_id: Some(asset_id.clone()),
                first_negative_date: None,
                cash_balance: None,
                total_value_at_date: None,
                account_currency: Some(activity.currency.clone()),
                activity_date: Some(activity_date_in_tz(activity.activity_date, tz)),
                asset_symbol,
                asset_name,
                quantity: activity.quantity.map(|qty| qty.abs()),
                proceeds: None,
                reason: Some(ValuationIssueReason::IncompleteBasisActivity),
                activity_id: Some(activity.id.clone()),
            })
        })
        .collect()
}

fn is_lot_creating_basis_source(activity: &Activity) -> bool {
    let activity_type = activity.effective_type();
    if activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_BUY) {
        return true;
    }

    activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_TRANSFER_IN)
        && (activity.source_group_id.is_none() || is_external_transfer(activity))
}

#[allow(clippy::too_many_arguments)]
async fn gather_valuation_quality_issues(
    valuation_service: &dyn ValuationServiceTrait,
    snapshot_service: &dyn SnapshotServiceTrait,
    asset_service: &dyn AssetServiceTrait,
    quote_service: &dyn QuoteServiceTrait,
    account_ids: &[String],
    account_name_map: &HashMap<String, String>,
    account_tracking: &HashMap<String, TrackingMode>,
    latest_quote_times: &HashMap<String, chrono::DateTime<Utc>>,
) -> Vec<ConsistencyIssueInfo> {
    if account_ids.is_empty() {
        return Vec::new();
    }

    let histories = valuation_service
        .get_historical_valuations_by_account(account_ids, None, None)
        .unwrap_or_else(|error| {
            warn!("Failed to check generated valuation quality: {}", error);
            HashMap::new()
        });
    let snapshots_by_account = valuation_snapshots_by_account(snapshot_service, account_ids);
    let expected_dates_by_account = expected_valuation_dates_by_account(&snapshots_by_account);

    let mut issues = valuation_quality_issues_from_histories(
        &histories,
        Some(&expected_dates_by_account),
        account_name_map,
    );

    issues.extend(
        valuation_value_issues_from_snapshots(
            &histories,
            &snapshots_by_account,
            account_name_map,
            asset_service,
            latest_quote_times,
        )
        .await,
    );

    let quote_date_gaps = gather_quote_date_gap_issues(
        &snapshots_by_account,
        account_name_map,
        latest_quote_times,
        quote_service,
        asset_service,
    )
    .await;
    suppress_generic_value_issues(&mut issues, &quote_date_gaps);
    let existing_precise_keys: HashSet<_> = issues
        .iter()
        .filter(|issue| {
            issue.issue_type == super::checks::ConsistencyIssueType::IncompleteValuationValue
                && matches!(
                    issue.reason,
                    Some(ValuationIssueReason::MissingMarketQuote)
                        | Some(ValuationIssueReason::MissingManualValuation)
                )
        })
        .filter_map(value_issue_key)
        .collect();
    issues.extend(quote_date_gaps.into_iter().filter(|issue| {
        value_issue_key(issue).is_none_or(|key| !existing_precise_keys.contains(&key))
    }));

    issues.extend(
        valuation_basis_issues_from_snapshots(
            &snapshots_by_account,
            account_name_map,
            account_tracking,
            asset_service,
        )
        .await,
    );

    issues
}

fn value_issue_key(issue: &ConsistencyIssueInfo) -> Option<(String, String, NaiveDate)> {
    Some((
        issue.account_id.clone()?,
        issue.asset_id.clone()?,
        issue.activity_date?,
    ))
}

fn value_issue_account_date(issue: &ConsistencyIssueInfo) -> Option<(String, NaiveDate)> {
    Some((issue.account_id.clone()?, issue.activity_date?))
}

fn suppress_generic_value_issues(
    issues: &mut Vec<ConsistencyIssueInfo>,
    precise_issues: &[ConsistencyIssueInfo],
) {
    let precise_scopes: HashSet<_> = precise_issues
        .iter()
        .filter_map(value_issue_account_date)
        .collect();

    if precise_scopes.is_empty() {
        return;
    }

    issues.retain(|issue| {
        if issue.issue_type != super::checks::ConsistencyIssueType::IncompleteValuationValue {
            return true;
        }
        if !matches!(
            issue.reason,
            Some(ValuationIssueReason::Unavailable) | Some(ValuationIssueReason::Unknown)
        ) {
            return true;
        }
        value_issue_account_date(issue).is_none_or(|scope| !precise_scopes.contains(&scope))
    });
}

async fn gather_quote_date_gap_issues(
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    latest_quote_times: &HashMap<String, chrono::DateTime<Utc>>,
    quote_service: &dyn QuoteServiceTrait,
    asset_service: &dyn AssetServiceTrait,
) -> Vec<ConsistencyIssueInfo> {
    let mut candidate_asset_ids = HashSet::new();
    let mut min_date: Option<NaiveDate> = None;
    let mut max_date: Option<NaiveDate> = None;

    for snapshots in snapshots_by_account.values() {
        for snapshot in snapshots {
            min_date = Some(min_date.map_or(snapshot.snapshot_date, |date| {
                date.min(snapshot.snapshot_date)
            }));
            max_date = Some(max_date.map_or(snapshot.snapshot_date, |date| {
                date.max(snapshot.snapshot_date)
            }));
            for (asset_id, position) in &snapshot.positions {
                if position.is_alternative
                    || position.quantity.is_zero()
                    || !latest_quote_times.contains_key(asset_id)
                {
                    continue;
                }
                candidate_asset_ids.insert(asset_id.clone());
            }
        }
    }

    let (Some(start), Some(end)) = (min_date, max_date) else {
        return Vec::new();
    };
    if candidate_asset_ids.is_empty() {
        return Vec::new();
    }

    let candidate_asset_id_list: Vec<String> = candidate_asset_ids.iter().cloned().collect();
    let assets_by_id: HashMap<String, Asset> = asset_service
        .get_assets_by_asset_ids(&candidate_asset_id_list)
        .await
        .unwrap_or_else(|error| {
            warn!(
                "Failed to load held assets for quote gap health check: {}",
                error
            );
            Vec::new()
        })
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect();

    let quote_scope_asset_ids: HashSet<String> = assets_by_id
        .values()
        .filter(|asset| market_calendar_key(asset).is_some())
        .map(|asset| asset.id.clone())
        .collect();
    if quote_scope_asset_ids.is_empty() {
        return Vec::new();
    }

    let quote_dates: HashSet<(String, NaiveDate)> = quote_service
        .get_quotes_in_range(&quote_scope_asset_ids, start, end)
        .unwrap_or_else(|error| {
            warn!(
                "Failed to load raw quotes for quote gap health check: {}",
                error
            );
            Vec::new()
        })
        .into_iter()
        .map(|quote| (quote.asset_id, quote.timestamp.date_naive()))
        .collect();

    let market_open_dates: HashSet<(String, NaiveDate)> = quote_dates
        .iter()
        .filter_map(|(asset_id, date)| {
            assets_by_id
                .get(asset_id)
                .and_then(market_calendar_key)
                .map(|key| (key, *date))
        })
        .collect();

    quote_date_gap_issues_from_data(
        snapshots_by_account,
        account_name_map,
        latest_quote_times,
        &quote_dates,
        &market_open_dates,
        &assets_by_id,
    )
}

fn quote_date_gap_issues_from_data(
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    latest_quote_times: &HashMap<String, chrono::DateTime<Utc>>,
    quote_dates: &HashSet<(String, NaiveDate)>,
    market_open_dates: &HashSet<(String, NaiveDate)>,
    assets_by_id: &HashMap<String, Asset>,
) -> Vec<ConsistencyIssueInfo> {
    let mut issues = Vec::new();
    let mut seen = HashSet::new();

    let mut account_ids: Vec<_> = snapshots_by_account.keys().collect();
    account_ids.sort();
    for account_id in account_ids {
        let account_name = account_name_map
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| account_id.clone());
        let mut snapshots: Vec<_> = snapshots_by_account[account_id].iter().collect();
        snapshots.sort_by_key(|snapshot| snapshot.snapshot_date);

        for snapshot in snapshots {
            let mut positions: Vec<_> = snapshot.positions.iter().collect();
            positions.sort_by_key(|(asset_id, _)| (*asset_id).clone());
            for (asset_id, position) in positions {
                if position.is_alternative
                    || position.quantity.is_zero()
                    || !latest_quote_times.contains_key(asset_id)
                    || quote_dates.contains(&(asset_id.clone(), snapshot.snapshot_date))
                {
                    continue;
                }

                let Some(asset) = assets_by_id.get(asset_id) else {
                    continue;
                };
                if matches!(asset.kind, AssetKind::Fx)
                    || asset_is_manual(asset)
                    || !market_was_open(asset, snapshot.snapshot_date, market_open_dates)
                {
                    continue;
                }
                if !seen.insert((account_id.clone(), asset_id.clone(), snapshot.snapshot_date)) {
                    continue;
                }

                let symbol = asset
                    .display_code
                    .clone()
                    .or_else(|| asset.instrument_symbol.clone())
                    .unwrap_or_else(|| asset_id.clone());
                issues.push(ConsistencyIssueInfo {
                    issue_type: super::checks::ConsistencyIssueType::IncompleteValuationValue,
                    record_id: format!(
                        "quote_gap:{}:{}:{}",
                        account_id, asset_id, snapshot.snapshot_date
                    ),
                    description: format!("{} in {}", symbol, account_name),
                    account_id: Some(account_id.clone()),
                    asset_id: Some(asset_id.clone()),
                    first_negative_date: None,
                    cash_balance: None,
                    total_value_at_date: None,
                    account_currency: Some(snapshot.currency.clone()),
                    activity_date: Some(snapshot.snapshot_date),
                    asset_symbol: Some(symbol),
                    asset_name: asset.name.clone(),
                    quantity: Some(position.quantity),
                    proceeds: None,
                    reason: Some(ValuationIssueReason::MissingMarketQuote),
                    activity_id: None,
                });
            }
        }
    }

    issues
}

fn market_calendar_key(asset: &Asset) -> Option<String> {
    if asset.quote_mode != QuoteMode::Market || matches!(asset.kind, AssetKind::Fx) {
        return None;
    }
    if matches!(asset.instrument_type, Some(InstrumentType::Crypto)) {
        return Some("continuous:crypto".to_string());
    }
    asset
        .instrument_exchange_mic
        .as_deref()
        .map(str::trim)
        .filter(|mic| !mic.is_empty())
        .map(|mic| format!("mic:{}", mic.to_ascii_uppercase()))
}

fn market_was_open(
    asset: &Asset,
    date: NaiveDate,
    market_open_dates: &HashSet<(String, NaiveDate)>,
) -> bool {
    if matches!(asset.instrument_type, Some(InstrumentType::Crypto)) {
        return true;
    }
    market_calendar_key(asset).is_some_and(|key| market_open_dates.contains(&(key, date)))
}

/// A held asset that could not be priced across one or more valuation dates.
#[derive(Debug)]
struct ValueAssetIssue {
    account_id: String,
    account_name: String,
    asset_id: String,
    first_date: NaiveDate,
    last_date: NaiveDate,
    valuation_days: usize,
    unavailable: bool,
}

/// Classifies incomplete-market-value rows down to the specific unpriced
/// asset(s) and their root cause, using the daily snapshots (held positions)
/// and per-asset quote presence.
///
/// A held quotable position is treated as the culprit when the asset has no
/// market quotes at all (`latest_quote_times` miss). The reason is then refined
/// to `MissingManualValuation` for manual/custom assets, or `MissingMarketQuote`
/// otherwise. Dates whose culprit cannot be pinned to a specific asset fall back
/// to an account-level issue (`Unavailable` when nothing is priced, else
/// `Unknown`).
async fn valuation_value_issues_from_snapshots(
    histories: &HashMap<String, Vec<DailyAccountValuation>>,
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    asset_service: &dyn AssetServiceTrait,
    latest_quote_times: &HashMap<String, chrono::DateTime<Utc>>,
) -> Vec<ConsistencyIssueInfo> {
    let (per_asset, account_fallbacks) = value_asset_issues_from_snapshots(
        histories,
        snapshots_by_account,
        account_name_map,
        latest_quote_times,
    );

    let asset_ids: Vec<String> = per_asset
        .iter()
        .map(|issue| issue.asset_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let assets_by_id: HashMap<String, Asset> = if asset_ids.is_empty() {
        HashMap::new()
    } else {
        asset_service
            .get_assets_by_asset_ids(&asset_ids)
            .await
            .unwrap_or_else(|error| {
                warn!(
                    "Failed to load assets for incomplete market-value health check: {}",
                    error
                );
                Vec::new()
            })
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect()
    };

    let mut issues = account_fallbacks;
    issues.extend(
        per_asset
            .into_iter()
            .map(|issue| value_asset_consistency_issue(issue, &assets_by_id)),
    );
    issues
}

/// Derives the per-asset unpriced culprits and the account-level fallbacks from
/// snapshots + quote presence. Pure/sync so it can be unit-tested without an
/// asset service; asset display + manual classification are applied later in
/// [`value_asset_consistency_issue`].
fn value_asset_issues_from_snapshots(
    histories: &HashMap<String, Vec<DailyAccountValuation>>,
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    latest_quote_times: &HashMap<String, chrono::DateTime<Utc>>,
) -> (Vec<ValueAssetIssue>, Vec<ConsistencyIssueInfo>) {
    let mut per_asset: HashMap<(String, String), ValueAssetIssue> = HashMap::new();
    let mut account_fallbacks: Vec<ConsistencyIssueInfo> = Vec::new();

    let mut account_ids: Vec<&String> = histories.keys().collect();
    account_ids.sort();

    for account_id in account_ids {
        let history = &histories[account_id];
        let account_name = account_name_map
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| account_id.clone());
        let snapshots = snapshots_by_account.get(account_id);

        let mut rows: Vec<&DailyAccountValuation> = history
            .iter()
            .filter(|row| row.value_status != ValuationStatus::Complete)
            .collect();
        rows.sort_by_key(|row| row.valuation_date);

        let mut snapshot_idx = 0usize;
        for row in rows {
            let unavailable = row.value_status == ValuationStatus::Unavailable;

            // Held quotable positions whose asset has no market quotes at all.
            let positions_culprits: Vec<String> = match snapshots {
                Some(snapshots) if !snapshots.is_empty() => {
                    while snapshot_idx + 1 < snapshots.len()
                        && snapshots[snapshot_idx + 1].snapshot_date <= row.valuation_date
                    {
                        snapshot_idx += 1;
                    }
                    if snapshots[snapshot_idx].snapshot_date > row.valuation_date {
                        Vec::new()
                    } else {
                        snapshots[snapshot_idx]
                            .positions
                            .values()
                            .filter(|position| {
                                !position.is_alternative && !position.quantity.is_zero()
                            })
                            .map(|position| position.asset_id.clone())
                            .filter(|asset_id| !latest_quote_times.contains_key(asset_id))
                            .collect()
                    }
                }
                _ => Vec::new(),
            };

            if positions_culprits.is_empty() {
                // Cause not attributable to a specific held asset (e.g. missing
                // FX, or a per-date gap for an asset that has quotes elsewhere).
                let reason = if unavailable {
                    ValuationIssueReason::Unavailable
                } else {
                    ValuationIssueReason::Unknown
                };
                account_fallbacks.push(valuation_quality_issue(
                    super::checks::ConsistencyIssueType::IncompleteValuationValue,
                    row,
                    &account_name,
                    Some(reason),
                ));
                continue;
            }

            for asset_id in positions_culprits {
                per_asset
                    .entry((account_id.clone(), asset_id.clone()))
                    .and_modify(|issue| {
                        issue.first_date = issue.first_date.min(row.valuation_date);
                        issue.last_date = issue.last_date.max(row.valuation_date);
                        issue.valuation_days += 1;
                        issue.unavailable = issue.unavailable || unavailable;
                    })
                    .or_insert_with(|| ValueAssetIssue {
                        account_id: account_id.clone(),
                        account_name: account_name.clone(),
                        asset_id,
                        first_date: row.valuation_date,
                        last_date: row.valuation_date,
                        valuation_days: 1,
                        unavailable,
                    });
            }
        }
    }

    let mut per_asset: Vec<ValueAssetIssue> = per_asset.into_values().collect();
    per_asset.sort_by(|a, b| {
        a.account_id
            .cmp(&b.account_id)
            .then_with(|| a.asset_id.cmp(&b.asset_id))
    });
    (per_asset, account_fallbacks)
}

/// Labels a derived value-coverage issue with asset display info and classifies
/// it as a missing manual valuation vs a missing market quote.
fn value_asset_consistency_issue(
    issue: ValueAssetIssue,
    assets_by_id: &HashMap<String, Asset>,
) -> ConsistencyIssueInfo {
    let asset = assets_by_id.get(&issue.asset_id);
    let symbol = asset
        .and_then(|asset| asset.display_code.clone())
        .unwrap_or_else(|| issue.asset_id.clone());
    let asset_name = asset.and_then(|asset| asset.name.clone());
    let is_manual = asset.map(asset_is_manual).unwrap_or(false);
    let reason = if is_manual {
        ValuationIssueReason::MissingManualValuation
    } else {
        ValuationIssueReason::MissingMarketQuote
    };
    let coverage = if issue.unavailable {
        "unavailable"
    } else {
        "degraded"
    };
    let description = format!(
        "{} in {} - {} from {} to {} ({} day(s))",
        symbol,
        issue.account_name,
        coverage,
        issue.first_date,
        issue.last_date,
        issue.valuation_days
    );

    ConsistencyIssueInfo {
        issue_type: super::checks::ConsistencyIssueType::IncompleteValuationValue,
        record_id: format!(
            "{}:{}:{}:{}",
            issue.account_id, issue.asset_id, issue.first_date, issue.last_date
        ),
        description,
        account_id: Some(issue.account_id),
        asset_id: Some(issue.asset_id),
        first_negative_date: None,
        cash_balance: None,
        total_value_at_date: None,
        account_currency: None,
        activity_date: Some(issue.first_date),
        asset_symbol: Some(symbol),
        asset_name,
        quantity: None,
        proceeds: None,
        reason: Some(reason),
        activity_id: None,
    }
}

/// Returns true when an asset is priced manually (no automatic market feed).
fn asset_is_manual(asset: &Asset) -> bool {
    asset.quote_mode == QuoteMode::Manual
}

fn valuation_snapshots_by_account(
    snapshot_service: &dyn SnapshotServiceTrait,
    account_ids: &[String],
) -> HashMap<String, Vec<AccountStateSnapshot>> {
    let mut snapshots_by_account = HashMap::new();

    for account_id in account_ids {
        match snapshot_service.get_daily_holdings_snapshots(account_id, None, None) {
            Ok(mut snapshots) => {
                snapshots.sort_by_key(|snapshot| snapshot.snapshot_date);
                if !snapshots.is_empty() {
                    snapshots_by_account.insert(account_id.clone(), snapshots);
                }
            }
            Err(error) => {
                warn!(
                    "Failed to check generated valuation coverage for account {}: {}",
                    account_id, error
                );
            }
        }
    }

    snapshots_by_account
}

fn expected_valuation_dates_by_account(
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
) -> HashMap<String, HashSet<NaiveDate>> {
    snapshots_by_account
        .iter()
        .map(|(account_id, snapshots)| {
            (
                account_id.clone(),
                snapshots
                    .iter()
                    .map(|snapshot| snapshot.snapshot_date)
                    .collect(),
            )
        })
        .collect()
}

fn valuation_quality_issues_from_histories(
    histories: &HashMap<String, Vec<DailyAccountValuation>>,
    expected_dates_by_account: Option<&HashMap<String, HashSet<NaiveDate>>>,
    account_name_map: &HashMap<String, String>,
) -> Vec<ConsistencyIssueInfo> {
    let mut issues = Vec::new();

    let mut account_ids: HashSet<String> = histories.keys().cloned().collect();
    if let Some(expected_dates_by_account) = expected_dates_by_account {
        account_ids.extend(expected_dates_by_account.keys().cloned());
    }
    let mut account_ids: Vec<String> = account_ids.into_iter().collect();
    account_ids.sort();

    for account_id in account_ids {
        let account_name = account_name_map
            .get(&account_id)
            .cloned()
            .unwrap_or_else(|| account_id.clone());
        let history = histories
            .get(&account_id)
            .map(Vec::as_slice)
            .unwrap_or_default();

        if let Some(expected_dates_by_account) = expected_dates_by_account {
            if let Some(expected_dates) = expected_dates_by_account.get(&account_id) {
                let valuation_dates: HashSet<NaiveDate> =
                    history.iter().map(|row| row.valuation_date).collect();
                let mut missing_dates: Vec<NaiveDate> = expected_dates
                    .iter()
                    .copied()
                    .filter(|date| !valuation_dates.contains(date))
                    .collect();
                missing_dates.sort_unstable();

                for date in missing_dates {
                    issues.push(missing_valuation_issue(&account_id, date, &account_name));
                }
            }
        }

        // Incomplete market-value rows are classified per-asset (with root cause)
        // in `valuation_value_issues_from_snapshots`, which has snapshot + quote
        // context. Here we only surface the flow-source classification.
        for row in history {
            if matches!(
                row.external_flow_source,
                ExternalFlowSource::Unknown | ExternalFlowSource::UnknownBoundaryTransfer
            ) {
                issues.push(valuation_quality_issue(
                    super::checks::ConsistencyIssueType::UnknownPerformanceFlowSource,
                    row,
                    &account_name,
                    None,
                ));
            }
        }
    }

    issues
}

/// A source-precise incomplete-cost-basis issue: either a specific acquiring
/// activity (transactions-tracked) or a holdings snapshot position
/// (holdings-tracked) that carries no cost basis.
#[derive(Debug)]
struct BasisSourceIssue {
    account_id: String,
    account_name: String,
    asset_id: String,
    /// The acquiring activity to fix (transactions-tracked only).
    activity_id: Option<String>,
    /// Date the incomplete basis is observed.
    observed_date: NaiveDate,
    reason: ValuationIssueReason,
}

/// Detects incomplete cost basis at its source. On a HOLDINGS-tracked account
/// the cost lives on each snapshot
/// position; on a TRANSACTIONS-tracked account it comes from the acquiring
/// activity that opened the lot, so each unpriced lot is reported against its
/// `source_activity_id` for a precise deep-link.
async fn valuation_basis_issues_from_snapshots(
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    account_tracking: &HashMap<String, TrackingMode>,
    asset_service: &dyn AssetServiceTrait,
) -> Vec<ConsistencyIssueInfo> {
    let raws = basis_source_issues_from_snapshots(
        snapshots_by_account,
        account_name_map,
        account_tracking,
    );

    let asset_ids: Vec<String> = raws
        .iter()
        .map(|raw| raw.asset_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let assets_by_id: HashMap<String, Asset> = if asset_ids.is_empty() {
        HashMap::new()
    } else {
        asset_service
            .get_assets_by_asset_ids(&asset_ids)
            .await
            .unwrap_or_else(|error| {
                warn!(
                    "Failed to load assets for incomplete cost-basis health check: {}",
                    error
                );
                Vec::new()
            })
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect()
    };

    raws.into_iter()
        .map(|raw| basis_source_consistency_issue(raw, &assets_by_id))
        .collect()
}

/// Pure detection (sync, testable) for HOLDINGS-tracked accounts: a snapshot
/// position with no cost basis. Transaction-tracked accounts are handled at the
/// source by [`gather_incomplete_basis_trade_activities`], which points at the
/// exact acquiring activity that lacks a price.
fn basis_source_issues_from_snapshots(
    snapshots_by_account: &HashMap<String, Vec<AccountStateSnapshot>>,
    account_name_map: &HashMap<String, String>,
    account_tracking: &HashMap<String, TrackingMode>,
) -> Vec<BasisSourceIssue> {
    let mut raws: Vec<BasisSourceIssue> = Vec::new();
    let mut account_ids: Vec<&String> = snapshots_by_account.keys().collect();
    account_ids.sort();

    for account_id in account_ids {
        // Only holdings-tracked accounts derive cost basis from the snapshot.
        if !matches!(
            account_tracking.get(account_id),
            Some(TrackingMode::Holdings)
        ) {
            continue;
        }
        let account_name = account_name_map
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| account_id.clone());
        let mut snapshots: Vec<_> = snapshots_by_account[account_id].iter().collect();
        snapshots.sort_by_key(|snapshot| snapshot.snapshot_date);

        for snapshot in snapshots {
            let mut positions: Vec<&Position> = snapshot
                .positions
                .values()
                .filter(|position| !position.is_alternative && !position.quantity.is_zero())
                .filter(|position| {
                    matches!(
                        position.basis_status(),
                        BasisStatus::Unknown | BasisStatus::PartialUnknown
                    )
                })
                .collect();
            positions.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));

            for position in positions {
                raws.push(BasisSourceIssue {
                    account_id: account_id.clone(),
                    account_name: account_name.clone(),
                    asset_id: position.asset_id.clone(),
                    activity_id: None,
                    observed_date: snapshot.snapshot_date,
                    reason: ValuationIssueReason::IncompleteBasisSnapshot,
                });
            }
        }
    }

    raws
}

fn basis_source_consistency_issue(
    raw: BasisSourceIssue,
    assets_by_id: &HashMap<String, Asset>,
) -> ConsistencyIssueInfo {
    let asset = assets_by_id.get(&raw.asset_id);
    let symbol = asset
        .and_then(|asset| asset.display_code.clone())
        .unwrap_or_else(|| raw.asset_id.clone());
    let asset_name = asset.and_then(|asset| asset.name.clone());

    let record_id = match &raw.activity_id {
        Some(activity_id) => format!("basis:{}:{}", raw.account_id, activity_id),
        None => format!(
            "basis:{}:{}:{}",
            raw.account_id, raw.asset_id, raw.observed_date
        ),
    };
    let description = format!("{} in {} - missing cost basis", symbol, raw.account_name);

    ConsistencyIssueInfo {
        issue_type: super::checks::ConsistencyIssueType::IncompleteValuationBasis,
        record_id,
        description,
        account_id: Some(raw.account_id),
        asset_id: Some(raw.asset_id),
        first_negative_date: None,
        cash_balance: None,
        total_value_at_date: None,
        account_currency: None,
        activity_date: Some(raw.observed_date),
        asset_symbol: Some(symbol),
        asset_name,
        quantity: None,
        proceeds: None,
        reason: Some(raw.reason),
        activity_id: raw.activity_id,
    }
}

fn missing_valuation_issue(
    account_id: &str,
    date: NaiveDate,
    account_name: &str,
) -> ConsistencyIssueInfo {
    ConsistencyIssueInfo {
        issue_type: super::checks::ConsistencyIssueType::MissingGeneratedValuation,
        record_id: format!("{}:{}", account_id, date),
        description: account_name.to_string(),
        account_id: Some(account_id.to_string()),
        asset_id: None,
        first_negative_date: None,
        cash_balance: None,
        total_value_at_date: None,
        account_currency: None,
        activity_date: Some(date),
        asset_symbol: None,
        asset_name: None,
        quantity: None,
        proceeds: None,
        reason: None,
        activity_id: None,
    }
}

fn valuation_quality_issue(
    issue_type: super::checks::ConsistencyIssueType,
    row: &DailyAccountValuation,
    account_name: &str,
    reason: Option<ValuationIssueReason>,
) -> ConsistencyIssueInfo {
    ConsistencyIssueInfo {
        issue_type,
        record_id: format!("{}:{}", row.account_id, row.valuation_date),
        description: account_name.to_string(),
        account_id: Some(row.account_id.clone()),
        asset_id: None,
        first_negative_date: None,
        cash_balance: None,
        total_value_at_date: None,
        account_currency: Some(row.account_currency.clone()),
        activity_date: Some(row.valuation_date),
        asset_symbol: None,
        asset_name: None,
        quantity: None,
        proceeds: None,
        reason,
        activity_id: None,
    }
}

fn health_sell_net_proceeds(activity: &Activity, asset: Option<&Asset>) -> Decimal {
    // Mirrors the holdings calculator's sell cash booking
    // (`gross_trade_amount(..) - fee - tax`, see handlers/trades.rs); only
    // `is_bond` and `contract_multiplier` affect the gross amount.
    let mut asset_info = AssetPositionInfo::fallback(&activity.currency);
    if let Some(asset) = asset {
        asset_info.is_bond = asset.is_bond();
        asset_info.contract_multiplier = asset.contract_multiplier();
    }

    gross_trade_amount(activity, &asset_info) - activity.fee_amt() - activity.tax_amt()
}

fn transfer_leg_detail(
    activity: &Activity,
    account_names: &HashMap<String, String>,
    timezone: chrono_tz::Tz,
) -> TransferLegDetail {
    TransferLegDetail {
        account_id: activity.account_id.clone(),
        account_name: account_names
            .get(&activity.account_id)
            .cloned()
            .unwrap_or_else(|| "Account".to_string()),
        activity_type: activity.effective_type().to_string(),
        amount: activity.amount,
        currency: activity.currency.clone(),
        date: activity_date_in_tz(activity.activity_date, timezone),
    }
}

#[async_trait]
impl HealthServiceTrait for HealthService {
    async fn run_checks(&self, _base_currency: &str) -> Result<HealthStatus> {
        // This method requires external data gathering
        // In practice, the caller should use run_checks_with_data instead
        // Return cached status or empty status
        if let Some(cached) = self.cached_status.read().await.as_ref() {
            return Ok(cached.status.clone());
        }
        Ok(HealthStatus::healthy())
    }

    async fn run_checks_with_data(
        &self,
        base_currency: &str,
        total_portfolio_value: f64,
        holdings: &[AssetHoldingInfo],
        latest_quote_times: &std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>,
        quote_sync_errors: &[QuoteSyncErrorInfo],
        fx_pairs: &[FxPairInfo],
        unclassified_assets: &[UnclassifiedAssetInfo],
        consistency_issues: &[ConsistencyIssueInfo],
        legacy_migration_info: &Option<LegacyMigrationInfo>,
        unconfigured_accounts: &[UnconfiguredAccountInfo],
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
        invalid_transfer_groups: &[InvalidTransferGroupInfo],
    ) -> Result<HealthStatus> {
        // Call the inherent method
        HealthService::run_checks_with_data(
            self,
            base_currency,
            total_portfolio_value,
            holdings,
            latest_quote_times,
            quote_sync_errors,
            fx_pairs,
            unclassified_assets,
            consistency_issues,
            legacy_migration_info,
            unconfigured_accounts,
            configured_timezone,
            client_timezone,
            invalid_transfer_groups,
        )
        .await
    }

    async fn get_cached_status(&self) -> Option<HealthStatus> {
        let cache = self.cached_status.read().await;
        cache.as_ref().map(|c| {
            let mut status = c.status.clone();
            // Mark as stale if older than 5 minutes
            if Utc::now() - c.cached_at > Duration::minutes(5) {
                status.mark_stale();
            }
            status
        })
    }

    async fn dismiss_issue(&self, issue_id: &str, data_hash: &str) -> Result<()> {
        let dismissal = IssueDismissal::new(issue_id, data_hash);
        self.dismissal_store.save_dismissal(&dismissal).await?;
        self.clear_cache().await;
        info!("Dismissed health issue: {}", issue_id);
        Ok(())
    }

    async fn restore_issue(&self, issue_id: &str) -> Result<()> {
        self.dismissal_store.remove_dismissal(issue_id).await?;
        self.clear_cache().await;
        info!("Restored health issue: {}", issue_id);
        Ok(())
    }

    async fn get_dismissed_ids(&self) -> Result<Vec<String>> {
        let dismissals = self.dismissal_store.get_dismissals().await?;
        Ok(dismissals.into_iter().map(|d| d.issue_id).collect())
    }

    async fn execute_fix(&self, action: &FixAction) -> Result<()> {
        info!("Executing fix action: {} ({})", action.label, action.id);

        let result = match action.id.as_str() {
            "sync_prices" | "retry_sync" => {
                // Parse asset IDs from payload
                let _asset_ids: Vec<String> = serde_json::from_value(action.payload.clone())
                    .map_err(|e| HealthError::invalid_payload(&action.id, e.to_string()))?;

                // TODO: Call quote sync service to refresh prices
                // This will be wired up when integrating with the service context
                warn!("{} fix action not yet implemented", action.id);
                Ok(())
            }
            _ => Err(HealthError::UnknownFixAction(action.id.clone()).into()),
        };

        // Clear cache after fix so next check shows updated results
        self.clear_cache().await;
        result
    }

    async fn clear_cache(&self) {
        *self.cached_status.write().await = None;
        debug!("Health status cache cleared");
    }

    async fn get_config(&self) -> HealthConfig {
        self.config.read().await.clone()
    }

    async fn update_config(&self, config: HealthConfig) -> Result<()> {
        // Validate config
        if config.price_stale_warning_hours == 0 {
            return Err(HealthError::InvalidConfig(
                "price_stale_warning_hours must be > 0".to_string(),
            )
            .into());
        }
        if config.price_stale_warning_hours >= config.price_stale_critical_hours {
            return Err(HealthError::InvalidConfig(
                "price_stale_warning_hours must be < price_stale_critical_hours".to_string(),
            )
            .into());
        }
        if config.fx_stale_warning_hours == 0 {
            return Err(HealthError::InvalidConfig(
                "fx_stale_warning_hours must be > 0".to_string(),
            )
            .into());
        }
        if config.fx_stale_warning_hours >= config.fx_stale_critical_hours {
            return Err(HealthError::InvalidConfig(
                "fx_stale_warning_hours must be < fx_stale_critical_hours".to_string(),
            )
            .into());
        }

        *self.config.write().await = config;
        info!("Health configuration updated");
        Ok(())
    }

    async fn run_full_checks(
        &self,
        base_currency: &str,
        account_service: Arc<dyn AccountServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        valuation_service: Arc<dyn ValuationServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        activity_service: Arc<dyn ActivityServiceTrait>,
        lot_repository: Arc<dyn LotRepositoryTrait>,
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
    ) -> Result<HealthStatus> {
        HealthService::run_full_checks(
            self,
            base_currency,
            account_service,
            holdings_service,
            quote_service,
            asset_service,
            taxonomy_service,
            valuation_service,
            snapshot_service,
            activity_service,
            lot_repository,
            configured_timezone,
            client_timezone,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::{
        ActivityStatus, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
    };
    use crate::assets::{Asset, AssetKind, InstrumentType, QuoteMode};
    use crate::portfolio::snapshot::Position;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    /// Mock dismissal store for testing.
    struct MockDismissalStore {
        dismissals: RwLock<Vec<IssueDismissal>>,
    }

    impl MockDismissalStore {
        fn new() -> Self {
            Self {
                dismissals: RwLock::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl HealthDismissalStore for MockDismissalStore {
        async fn save_dismissal(&self, dismissal: &IssueDismissal) -> Result<()> {
            let mut dismissals = self.dismissals.write().await;
            dismissals.retain(|d| d.issue_id != dismissal.issue_id);
            dismissals.push(dismissal.clone());
            Ok(())
        }

        async fn remove_dismissal(&self, issue_id: &str) -> Result<()> {
            let mut dismissals = self.dismissals.write().await;
            dismissals.retain(|d| d.issue_id != issue_id);
            Ok(())
        }

        async fn get_dismissals(&self) -> Result<Vec<IssueDismissal>> {
            Ok(self.dismissals.read().await.clone())
        }

        async fn get_dismissal(&self, issue_id: &str) -> Result<Option<IssueDismissal>> {
            let dismissals = self.dismissals.read().await;
            Ok(dismissals.iter().find(|d| d.issue_id == issue_id).cloned())
        }

        async fn clear_all(&self) -> Result<()> {
            self.dismissals.write().await.clear();
            Ok(())
        }
    }

    fn transfer_activity(
        id: &str,
        account_id: &str,
        activity_type: &str,
        source_group_id: Option<&str>,
        is_external: bool,
        status: ActivityStatus,
    ) -> Activity {
        let now = Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap();
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status,
            activity_date: now,
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(dec!(100)),
            fee: None,
            tax: None,
            currency: "CAD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: is_external.then(|| json!({ "flow": { "is_external": true } })),
            source_system: Some("CSV".to_string()),
            source_record_id: None,
            source_group_id: source_group_id.map(str::to_string),
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn health_account(id: &str, account_type: &str, tracking_mode: TrackingMode) -> Account {
        let now = Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap();
        Account {
            id: id.to_string(),
            name: "Business Investment".to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: now.naive_utc(),
            updated_at: now.naive_utc(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode,
        }
    }

    fn sell_activity(id: &str, account_id: &str, asset_id: &str) -> Activity {
        let now = Utc.with_ymd_and_hms(2026, 6, 2, 2, 30, 0).unwrap();
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: Some(asset_id.to_string()),
            activity_type: "SELL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: now,
            settlement_date: None,
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(291.10598755)),
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: Some("CSV".to_string()),
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn buy_activity(
        id: &str,
        account_id: &str,
        asset_id: &str,
        unit_price: Option<Decimal>,
    ) -> Activity {
        let now = Utc.with_ymd_and_hms(2026, 6, 1, 2, 30, 0).unwrap();
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: Some(asset_id.to_string()),
            activity_type: "BUY".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: now,
            settlement_date: None,
            quantity: Some(dec!(2)),
            unit_price,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: Some("CSV".to_string()),
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn health_asset(id: &str) -> Asset {
        let now = Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap();
        Asset {
            id: id.to_string(),
            kind: AssetKind::Investment,
            name: Some("Apple Inc.".to_string()),
            display_code: Some("AAPL".to_string()),
            notes: None,
            metadata: None,
            is_active: true,
            quote_mode: QuoteMode::Market,
            quote_ccy: "USD".to_string(),
            instrument_type: Some(InstrumentType::Equity),
            instrument_symbol: Some("AAPL".to_string()),
            instrument_exchange_mic: Some("XNAS".to_string()),
            instrument_key: None,
            provider_config: None,
            exchange_name: None,
            created_at: now.naive_utc(),
            updated_at: now.naive_utc(),
        }
    }

    fn valuation_row(account_id: &str) -> DailyAccountValuation {
        let date = chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        valuation_row_on(account_id, date)
    }

    fn valuation_row_on(account_id: &str, date: NaiveDate) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{}_{}", account_id, date),
            account_id: account_id.to_string(),
            valuation_date: date,
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: dec!(1),
            cash_balance: Decimal::ZERO,
            investment_market_value: dec!(100),
            total_value: dec!(100),
            cost_basis: dec!(90),
            book_basis: dec!(90),
            net_contribution: dec!(90),
            cash_balance_base: Decimal::ZERO,
            investment_market_value_base: dec!(100),
            total_value_base: dec!(100),
            cost_basis_base: dec!(90),
            book_basis_base: dec!(90),
            net_contribution_base: dec!(90),
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            external_flow_source: ExternalFlowSource::NoFlow,
            performance_eligible_value_base: dec!(100),
            value_status: ValuationStatus::Complete,
            basis_status: BasisStatus::Complete,
            calculated_at: Utc::now(),
        }
    }

    fn snapshot_with_positions(
        account_id: &str,
        snapshot_date: NaiveDate,
        positions: HashMap<String, Position>,
    ) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(account_id, snapshot_date),
            account_id: account_id.to_string(),
            snapshot_date,
            currency: "USD".to_string(),
            positions,
            ..Default::default()
        }
    }

    fn position_with_basis_status(account_id: &str, asset_id: &str, has_basis: bool) -> Position {
        let mut position = Position::new(
            account_id.to_string(),
            asset_id.to_string(),
            "USD".to_string(),
            Utc.with_ymd_and_hms(2026, 6, 1, 12, 0, 0).unwrap(),
        );
        position.quantity = dec!(2);
        position.total_cost_basis = if has_basis { dec!(200) } else { Decimal::ZERO };
        position.average_cost = if has_basis { dec!(100) } else { Decimal::ZERO };
        position
    }

    #[test]
    fn ungrouped_non_external_transfer_is_reported_to_health_center() {
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let activities = vec![transfer_activity(
            "transfer-in-1",
            "acc_tfsa",
            ACTIVITY_TYPE_TRANSFER_IN,
            None,
            false,
            ActivityStatus::Posted,
        )];

        let groups = invalid_transfer_groups_from_activities(&activities, &account_names, None);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].group_id, "ungrouped:transfer-in-1");
        assert_eq!(groups[0].legs.len(), 1);
        assert_eq!(groups[0].legs[0].account_name, "TFSA");
        assert_eq!(groups[0].legs[0].activity_type, ACTIVITY_TYPE_TRANSFER_IN);
    }

    #[test]
    fn transfer_integrity_ignores_accounts_outside_health_scope() {
        let account_names = HashMap::from([("active".to_string(), "Active".to_string())]);
        let activities = vec![transfer_activity(
            "archived-transfer",
            "archived",
            ACTIVITY_TYPE_TRANSFER_IN,
            None,
            false,
            ActivityStatus::Posted,
        )];

        let groups = invalid_transfer_groups_from_activities(&activities, &account_names, None);

        assert!(groups.is_empty());
    }

    #[test]
    fn valuation_quality_rows_are_reported_to_health_center() {
        let mut row = valuation_row("acc_tfsa");
        row.value_status = ValuationStatus::PartialUnpriced;
        row.basis_status = BasisStatus::PartialUnknown;
        row.external_flow_source = ExternalFlowSource::UnknownBoundaryTransfer;
        let histories = HashMap::from([("acc_tfsa".to_string(), vec![row])]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);

        let consistency_issues =
            valuation_quality_issues_from_histories(&histories, None, &account_names);

        // The histories path surfaces the flow-source classification; incomplete
        // market value is now classified per-asset in the snapshot-aware path.
        assert!(consistency_issues.iter().any(|issue| {
            issue.issue_type
                == crate::health::checks::ConsistencyIssueType::UnknownPerformanceFlowSource
        }));

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&consistency_issues, &ctx);

        assert!(health_issues.iter().any(|issue| {
            issue.id.starts_with("unknown_performance_flow_source:")
                && issue.severity == crate::health::Severity::Error
        }));
    }

    #[test]
    fn incomplete_value_rows_are_classified_per_asset_with_diagnostics() {
        // acc_tfsa holds a priced asset (asset_aapl) and an unpriced one
        // (asset_xyz, absent from latest_quote_times) across two degraded days.
        let mut row_1 = valuation_row_on("acc_tfsa", NaiveDate::from_ymd_opt(2026, 6, 1).unwrap());
        row_1.value_status = ValuationStatus::PartialUnpriced;
        let mut row_2 = valuation_row_on("acc_tfsa", NaiveDate::from_ymd_opt(2026, 6, 2).unwrap());
        row_2.value_status = ValuationStatus::PartialUnpriced;
        let histories = HashMap::from([("acc_tfsa".to_string(), vec![row_1, row_2])]);
        let snapshots_by_account = HashMap::from([(
            "acc_tfsa".to_string(),
            vec![snapshot_with_positions(
                "acc_tfsa",
                NaiveDate::from_ymd_opt(2026, 6, 1).unwrap(),
                HashMap::from([
                    (
                        "asset_aapl".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_aapl", false),
                    ),
                    (
                        "asset_xyz".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_xyz", false),
                    ),
                ]),
            )],
        )]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        // asset_aapl has a quote; asset_xyz does not.
        let latest_quote_times = HashMap::from([("asset_aapl".to_string(), chrono::Utc::now())]);

        let (per_asset, fallbacks) = value_asset_issues_from_snapshots(
            &histories,
            &snapshots_by_account,
            &account_names,
            &latest_quote_times,
        );

        assert!(fallbacks.is_empty());
        assert_eq!(per_asset.len(), 1);
        assert_eq!(per_asset[0].asset_id, "asset_xyz");
        assert_eq!(per_asset[0].valuation_days, 2);

        // A market-priced asset (not manual) → MissingMarketQuote + sync action.
        let assets_by_id = HashMap::from([("asset_xyz".to_string(), health_asset("asset_xyz"))]);
        let consistency_issue =
            value_asset_consistency_issue(per_asset.into_iter().next().unwrap(), &assets_by_id);
        assert_eq!(consistency_issue.asset_id.as_deref(), Some("asset_xyz"));
        assert_eq!(
            consistency_issue.reason,
            Some(crate::health::checks::ValuationIssueReason::MissingMarketQuote)
        );

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&[consistency_issue], &ctx);

        let issue = health_issues
            .iter()
            .find(|i| i.id.starts_with("incomplete_valuation_value:"))
            .expect("incomplete value issue");
        let diagnostics = issue.diagnostics.as_ref().expect("diagnostics present");
        assert_eq!(diagnostics[0].code, "MISSING_MARKET_QUOTE");
        assert!(diagnostics[0].actions.iter().any(|a| a.primary));
        assert!(issue
            .affected_items
            .as_ref()
            .is_some_and(|items| items.iter().any(|i| i.id == "asset_xyz")));
    }

    #[test]
    fn missing_weekday_quote_date_is_reported_even_when_latest_quote_exists() {
        let monday = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        let tuesday = NaiveDate::from_ymd_opt(2026, 6, 2).unwrap();
        let snapshots_by_account = HashMap::from([(
            "acc_tfsa".to_string(),
            vec![
                snapshot_with_positions(
                    "acc_tfsa",
                    monday,
                    HashMap::from([(
                        "asset_aapl".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_aapl", true),
                    )]),
                ),
                snapshot_with_positions(
                    "acc_tfsa",
                    tuesday,
                    HashMap::from([(
                        "asset_aapl".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_aapl", true),
                    )]),
                ),
            ],
        )]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let latest_quote_times = HashMap::from([(
            "asset_aapl".to_string(),
            Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap(),
        )]);
        // Monday has a direct quote; Tuesday was deleted. Latest quote still
        // exists, so the old latest-quote-only Health path would stay silent.
        // A peer quote on the same exchange proves Tuesday was a market day.
        let quote_dates = HashSet::from([
            ("asset_aapl".to_string(), monday),
            ("asset_msft".to_string(), tuesday),
        ]);
        let market_open_dates = HashSet::from([("mic:XNAS".to_string(), tuesday)]);
        let assets_by_id = HashMap::from([
            ("asset_aapl".to_string(), health_asset("asset_aapl")),
            ("asset_msft".to_string(), health_asset("asset_msft")),
        ]);

        let issues = quote_date_gap_issues_from_data(
            &snapshots_by_account,
            &account_names,
            &latest_quote_times,
            &quote_dates,
            &market_open_dates,
            &assets_by_id,
        );

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].asset_id.as_deref(), Some("asset_aapl"));
        assert_eq!(issues[0].activity_date, Some(tuesday));
        assert_eq!(
            issues[0].reason,
            Some(crate::health::checks::ValuationIssueReason::MissingMarketQuote)
        );

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&issues, &ctx);
        let issue = health_issues
            .iter()
            .find(|issue| issue.id.starts_with("incomplete_valuation_value:"))
            .expect("missing quote health issue");
        let diagnostics = issue.diagnostics.as_ref().expect("diagnostics");
        assert_eq!(diagnostics[0].code, "MISSING_MARKET_QUOTE");
        assert!(diagnostics[0]
            .evidence
            .iter()
            .any(|evidence| evidence.value == "2026-06-02"));
        assert!(diagnostics[0].evidence.iter().any(|evidence| evidence
            .route
            .as_deref()
            .is_some_and(|route| route.contains("date=2026-06-02"))));
    }

    #[test]
    fn weekday_without_market_open_evidence_is_not_reported() {
        // 2025-01-01 is a Wednesday, but US/Canadian markets are closed. Without
        // an exchange-specific quote from another asset, this must not be flagged.
        let new_years_day = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let snapshots_by_account = HashMap::from([(
            "acc_tfsa".to_string(),
            vec![snapshot_with_positions(
                "acc_tfsa",
                new_years_day,
                HashMap::from([
                    (
                        "asset_aapl".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_aapl", true),
                    ),
                    (
                        "asset_msft".to_string(),
                        position_with_basis_status("acc_tfsa", "asset_msft", true),
                    ),
                ]),
            )],
        )]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let latest_quote_times = HashMap::from([
            (
                "asset_aapl".to_string(),
                Utc.with_ymd_and_hms(2025, 1, 2, 12, 0, 0).unwrap(),
            ),
            (
                "asset_msft".to_string(),
                Utc.with_ymd_and_hms(2025, 1, 2, 12, 0, 0).unwrap(),
            ),
        ]);
        let assets_by_id = HashMap::from([
            ("asset_aapl".to_string(), health_asset("asset_aapl")),
            ("asset_msft".to_string(), health_asset("asset_msft")),
        ]);

        let issues = quote_date_gap_issues_from_data(
            &snapshots_by_account,
            &account_names,
            &latest_quote_times,
            &HashSet::new(),
            &HashSet::new(),
            &assets_by_id,
        );

        assert!(issues.is_empty());
    }

    #[test]
    fn missing_weekend_quote_date_is_not_reported() {
        let saturday = NaiveDate::from_ymd_opt(2026, 6, 6).unwrap();
        let snapshots_by_account = HashMap::from([(
            "acc_tfsa".to_string(),
            vec![snapshot_with_positions(
                "acc_tfsa",
                saturday,
                HashMap::from([(
                    "asset_aapl".to_string(),
                    position_with_basis_status("acc_tfsa", "asset_aapl", true),
                )]),
            )],
        )]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let latest_quote_times = HashMap::from([(
            "asset_aapl".to_string(),
            Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap(),
        )]);
        let assets_by_id = HashMap::from([("asset_aapl".to_string(), health_asset("asset_aapl"))]);

        let issues = quote_date_gap_issues_from_data(
            &snapshots_by_account,
            &account_names,
            &latest_quote_times,
            &HashSet::new(),
            &HashSet::new(),
            &assets_by_id,
        );

        assert!(issues.is_empty());
    }

    #[test]
    fn missing_weekend_quote_date_is_reported_for_crypto() {
        let saturday = NaiveDate::from_ymd_opt(2026, 6, 6).unwrap();
        let snapshots_by_account = HashMap::from([(
            "acc_crypto".to_string(),
            vec![snapshot_with_positions(
                "acc_crypto",
                saturday,
                HashMap::from([(
                    "asset_btc".to_string(),
                    position_with_basis_status("acc_crypto", "asset_btc", true),
                )]),
            )],
        )]);
        let account_names = HashMap::from([("acc_crypto".to_string(), "Crypto".to_string())]);
        let latest_quote_times = HashMap::from([(
            "asset_btc".to_string(),
            Utc.with_ymd_and_hms(2026, 6, 8, 12, 0, 0).unwrap(),
        )]);
        let mut crypto = health_asset("asset_btc");
        crypto.instrument_type = Some(InstrumentType::Crypto);
        crypto.display_code = Some("BTC-USD".to_string());
        crypto.instrument_symbol = Some("BTC-USD".to_string());
        crypto.instrument_exchange_mic = None;
        let assets_by_id = HashMap::from([("asset_btc".to_string(), crypto)]);

        let issues = quote_date_gap_issues_from_data(
            &snapshots_by_account,
            &account_names,
            &latest_quote_times,
            &HashSet::new(),
            &HashSet::new(),
            &assets_by_id,
        );

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].asset_id.as_deref(), Some("asset_btc"));
        assert_eq!(issues[0].activity_date, Some(saturday));
        assert_eq!(
            issues[0].reason,
            Some(crate::health::checks::ValuationIssueReason::MissingMarketQuote)
        );
    }

    #[test]
    fn incomplete_basis_buy_without_price_is_flagged_and_deep_links_to_activity() {
        // Transaction-tracked acquisitions with no unit price yield zero-cost lots.
        let accounts = vec![health_account(
            "acc_tfsa",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        )];
        let mut transfer_in_noprice =
            buy_activity("transfer-in-noprice", "acc_tfsa", "asset_aapl", None);
        transfer_in_noprice.activity_type = ACTIVITY_TYPE_TRANSFER_IN.to_string();
        let activities = vec![
            buy_activity("buy-noprice", "acc_tfsa", "asset_aapl", None),
            buy_activity("buy-zero", "acc_tfsa", "asset_aapl", Some(dec!(0))),
            transfer_in_noprice,
            // A priced buy must NOT be flagged.
            buy_activity("buy-priced", "acc_tfsa", "asset_aapl", Some(dec!(100))),
        ];
        let assets_by_id = HashMap::from([("asset_aapl".to_string(), health_asset("asset_aapl"))]);

        let issues = incomplete_basis_trade_activities_from_data(
            &accounts,
            &activities,
            &assets_by_id,
            None,
        );

        // The null-price buy, 0-price buy, and unpaired transfer-in are flagged;
        // the priced buy is not.
        assert_eq!(issues.len(), 3);
        let ids: Vec<&str> = issues.iter().map(|i| i.record_id.as_str()).collect();
        assert!(ids.contains(&"buy-noprice"));
        assert!(ids.contains(&"buy-zero"));
        assert!(ids.contains(&"transfer-in-noprice"));
        assert!(!ids.contains(&"buy-priced"));

        let issue = issues
            .iter()
            .find(|i| i.record_id == "buy-noprice")
            .unwrap()
            .clone();
        assert_eq!(issue.activity_id.as_deref(), Some("buy-noprice"));
        assert_eq!(
            issue.reason,
            Some(crate::health::checks::ValuationIssueReason::IncompleteBasisActivity)
        );

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&[issue], &ctx);
        let diagnostics = health_issues[0].diagnostics.as_ref().expect("diagnostics");
        assert_eq!(diagnostics[0].code, "INCOMPLETE_BASIS_ACTIVITY");
        // Primary action deep-links to the exact offending activity.
        assert!(diagnostics[0].actions.iter().any(|a| a.primary
            && matches!(&a.action, crate::health::model::ActionRef::Navigate { action }
                if action.route == "/activities"
                    && action.query.as_ref().is_some_and(|q| q["activity"] == "buy-noprice"))));
    }

    #[test]
    fn incomplete_basis_holdings_routes_to_snapshot_editor() {
        // Holdings-tracked account: cost basis lives on the snapshot (no lots).
        let snapshots_by_account = HashMap::from([(
            "acc_hold".to_string(),
            vec![snapshot_with_positions(
                "acc_hold",
                NaiveDate::from_ymd_opt(2026, 6, 1).unwrap(),
                HashMap::from([(
                    "asset_xyz".to_string(),
                    position_with_basis_status("acc_hold", "asset_xyz", false),
                )]),
            )],
        )]);
        let account_names = HashMap::from([("acc_hold".to_string(), "Manual".to_string())]);
        let account_tracking = HashMap::from([("acc_hold".to_string(), TrackingMode::Holdings)]);

        let raws = basis_source_issues_from_snapshots(
            &snapshots_by_account,
            &account_names,
            &account_tracking,
        );
        assert_eq!(raws.len(), 1);
        assert!(raws[0].activity_id.is_none());

        let assets_by_id = HashMap::from([("asset_xyz".to_string(), health_asset("asset_xyz"))]);
        let issue = basis_source_consistency_issue(raws.into_iter().next().unwrap(), &assets_by_id);
        assert_eq!(
            issue.reason,
            Some(crate::health::checks::ValuationIssueReason::IncompleteBasisSnapshot)
        );

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&[issue], &ctx);
        let diagnostics = health_issues[0].diagnostics.as_ref().expect("diagnostics");
        assert_eq!(diagnostics[0].code, "INCOMPLETE_BASIS_SNAPSHOT");
        assert!(diagnostics[0].actions.iter().any(|a| a.primary
            && matches!(&a.action, crate::health::model::ActionRef::Navigate { action }
                if action.route == "/holdings/asset_xyz"
                    && action.query.as_ref().is_some_and(|q| q["tab"] == "snapshots"))));
    }

    #[test]
    fn incomplete_basis_holdings_reports_historical_snapshot_gap() {
        let first_date = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        let second_date = NaiveDate::from_ymd_opt(2026, 6, 2).unwrap();
        let snapshots_by_account = HashMap::from([(
            "acc_hold".to_string(),
            vec![
                snapshot_with_positions(
                    "acc_hold",
                    first_date,
                    HashMap::from([(
                        "asset_xyz".to_string(),
                        position_with_basis_status("acc_hold", "asset_xyz", false),
                    )]),
                ),
                snapshot_with_positions(
                    "acc_hold",
                    second_date,
                    HashMap::from([(
                        "asset_xyz".to_string(),
                        position_with_basis_status("acc_hold", "asset_xyz", true),
                    )]),
                ),
            ],
        )]);
        let account_names = HashMap::from([("acc_hold".to_string(), "Manual".to_string())]);
        let account_tracking = HashMap::from([("acc_hold".to_string(), TrackingMode::Holdings)]);

        let raws = basis_source_issues_from_snapshots(
            &snapshots_by_account,
            &account_names,
            &account_tracking,
        );

        assert_eq!(raws.len(), 1);
        assert_eq!(raws[0].asset_id, "asset_xyz");
        assert_eq!(raws[0].observed_date, first_date);
        assert!(raws[0].activity_id.is_none());
    }

    #[test]
    fn incomplete_basis_trade_scan_ignores_non_eligible_activities() {
        // Holdings-tracked accounts are covered by the snapshot check, not the
        // trade scan; SELLs and non-security accounts are never trades-without-cost.
        let accounts = vec![
            health_account(
                "acc_hold",
                account_types::SECURITIES,
                TrackingMode::Holdings,
            ),
            health_account(
                "acc_txn",
                account_types::SECURITIES,
                TrackingMode::Transactions,
            ),
        ];
        let activities = vec![
            // Holdings-tracked buy without price: excluded (wrong tracking mode).
            buy_activity("hold-buy", "acc_hold", "asset_aapl", None),
            // A sell is not an acquiring trade.
            sell_activity("txn-sell", "acc_txn", "asset_aapl"),
            {
                let mut transfer_in =
                    buy_activity("paired-transfer-in", "acc_txn", "asset_aapl", None);
                transfer_in.activity_type = ACTIVITY_TYPE_TRANSFER_IN.to_string();
                transfer_in.source_group_id = Some("paired-group".to_string());
                transfer_in
            },
        ];
        let assets_by_id = HashMap::from([("asset_aapl".to_string(), health_asset("asset_aapl"))]);

        let issues = incomplete_basis_trade_activities_from_data(
            &accounts,
            &activities,
            &assets_by_id,
            None,
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn price_staleness_input_excludes_cash_and_fx_infrastructure_assets() {
        assert!(!is_price_staleness_candidate(&HoldingType::Cash, None));
        assert!(!is_price_staleness_candidate(
            &HoldingType::Security,
            Some(&AssetKind::Fx)
        ));
        assert!(is_price_staleness_candidate(
            &HoldingType::Security,
            Some(&AssetKind::Investment)
        ));
        assert!(is_price_staleness_candidate(
            &HoldingType::AlternativeAsset,
            Some(&AssetKind::Other)
        ));
    }

    #[test]
    fn missing_generated_valuation_dates_are_reported_to_health_center() {
        let row = valuation_row("acc_tfsa");
        let histories = HashMap::from([("acc_tfsa".to_string(), vec![row])]);
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let expected_dates = HashMap::from([(
            "acc_tfsa".to_string(),
            HashSet::from([
                NaiveDate::from_ymd_opt(2026, 6, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 6, 2).unwrap(),
            ]),
        )]);

        let consistency_issues = valuation_quality_issues_from_histories(
            &histories,
            Some(&expected_dates),
            &account_names,
        );

        assert!(consistency_issues.iter().any(|issue| {
            issue.issue_type
                == crate::health::checks::ConsistencyIssueType::MissingGeneratedValuation
                && issue.account_id.as_deref() == Some("acc_tfsa")
                && issue.activity_date == Some(NaiveDate::from_ymd_opt(2026, 6, 2).unwrap())
        }));

        let check = DataConsistencyCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);
        let health_issues = check.analyze(&consistency_issues, &ctx);

        assert!(health_issues.iter().any(|issue| {
            issue.id.starts_with("missing_generated_valuation:")
                && issue.details.as_deref().is_some_and(|details| {
                    details.contains("TFSA") && details.contains("2026-06-02")
                })
        }));
    }

    #[test]
    fn invalid_transfer_group_dates_use_configured_timezone() {
        let account_names = HashMap::from([("acc_tfsa".to_string(), "TFSA".to_string())]);
        let mut activity = transfer_activity(
            "transfer-in-1",
            "acc_tfsa",
            ACTIVITY_TYPE_TRANSFER_IN,
            None,
            false,
            ActivityStatus::Posted,
        );
        activity.activity_date = Utc.with_ymd_and_hms(2024, 1, 4, 2, 13, 0).unwrap();
        let activities = vec![activity];

        let groups = invalid_transfer_groups_from_activities(
            &activities,
            &account_names,
            Some("America/Toronto"),
        );

        assert_eq!(groups.len(), 1);
        assert_eq!(
            groups[0].legs[0].date,
            chrono::NaiveDate::from_ymd_opt(2024, 1, 3).unwrap()
        );
    }

    #[test]
    fn explicit_external_pending_and_valid_grouped_transfers_are_not_reported() {
        let account_names = HashMap::from([
            ("acc_cash".to_string(), "Cash".to_string()),
            ("acc_tfsa".to_string(), "TFSA".to_string()),
        ]);
        let activities = vec![
            transfer_activity(
                "external-transfer",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                None,
                true,
                ActivityStatus::Posted,
            ),
            transfer_activity(
                "pending-transfer",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                None,
                false,
                ActivityStatus::Pending,
            ),
            transfer_activity(
                "external-orphan-transfer",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                Some("orphan-transfer-group"),
                true,
                ActivityStatus::Posted,
            ),
            transfer_activity(
                "pending-orphan-transfer",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                Some("pending-transfer-group"),
                false,
                ActivityStatus::Pending,
            ),
            transfer_activity(
                "paired-out",
                "acc_cash",
                ACTIVITY_TYPE_TRANSFER_OUT,
                Some("transfer-group-1"),
                false,
                ActivityStatus::Posted,
            ),
            transfer_activity(
                "paired-in",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                Some("transfer-group-1"),
                false,
                ActivityStatus::Posted,
            ),
        ];

        let groups = invalid_transfer_groups_from_activities(&activities, &account_names, None);

        assert!(groups.is_empty());
    }

    #[test]
    fn valid_paired_transfer_with_external_marker_is_reported_as_conflicting_metadata() {
        let account_names = HashMap::from([
            ("acc_cash".to_string(), "Cash".to_string()),
            ("acc_tfsa".to_string(), "TFSA".to_string()),
        ]);
        let activities = vec![
            transfer_activity(
                "paired-out",
                "acc_cash",
                ACTIVITY_TYPE_TRANSFER_OUT,
                Some("transfer-group-1"),
                true,
                ActivityStatus::Posted,
            ),
            transfer_activity(
                "paired-in",
                "acc_tfsa",
                ACTIVITY_TYPE_TRANSFER_IN,
                Some("transfer-group-1"),
                false,
                ActivityStatus::Posted,
            ),
        ];

        let groups = invalid_transfer_groups_from_activities(&activities, &account_names, None);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].group_id, "conflicting_external_marker:paired-out");
        assert_eq!(groups[0].legs.len(), 1);
        assert_eq!(groups[0].legs[0].account_name, "Cash");
    }

    #[test]
    fn sell_with_matching_lot_disposal_is_not_reported() {
        let accounts = vec![health_account(
            "business",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        )];
        let activities = vec![sell_activity("sell-aapl", "business", "aapl")];
        let disposals = HashMap::from([(
            "business".to_string(),
            HashSet::from(["sell-aapl".to_string()]),
        )]);
        let assets = HashMap::from([("aapl".to_string(), health_asset("aapl"))]);

        let issues = missing_lot_disposal_sells_from_data(
            &accounts,
            &activities,
            &disposals,
            &assets,
            Some("America/Toronto"),
        );

        assert!(issues.is_empty());
    }

    #[test]
    fn sell_without_lot_disposal_is_reported_with_local_date() {
        let accounts = vec![health_account(
            "business",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        )];
        let activities = vec![sell_activity("sell-aapl", "business", "aapl")];
        let disposals = HashMap::from([("business".to_string(), HashSet::new())]);
        let assets = HashMap::from([("aapl".to_string(), health_asset("aapl"))]);

        let issues = missing_lot_disposal_sells_from_data(
            &accounts,
            &activities,
            &disposals,
            &assets,
            Some("America/Toronto"),
        );

        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].issue_type,
            crate::health::checks::ConsistencyIssueType::MissingLotDisposalForSell
        );
        assert_eq!(issues[0].asset_symbol.as_deref(), Some("AAPL"));
        assert_eq!(
            issues[0].activity_date,
            Some(chrono::NaiveDate::from_ymd_opt(2026, 6, 1).unwrap())
        );
        assert_eq!(issues[0].proceeds, Some(dec!(291.10598755)));
    }

    #[test]
    fn missing_lot_sell_proceeds_follow_core_trade_amount_rules() {
        let mut option_sell = sell_activity("sell-option", "business", "option");
        option_sell.quantity = Some(dec!(2));
        option_sell.unit_price = Some(dec!(1.5));
        option_sell.amount = Some(dec!(999));
        option_sell.fee = Some(dec!(0.25));

        let mut option_asset = health_asset("option");
        option_asset.instrument_type = Some(InstrumentType::Option);

        assert_eq!(
            health_sell_net_proceeds(&option_sell, Some(&option_asset)),
            dec!(299.75)
        );

        let mut bond_sell = option_sell.clone();
        bond_sell.id = "sell-bond".to_string();
        bond_sell.amount = Some(dec!(950));

        let mut bond_asset = health_asset("bond");
        bond_asset.instrument_type = Some(InstrumentType::Bond);

        assert_eq!(
            health_sell_net_proceeds(&bond_sell, Some(&bond_asset)),
            dec!(949.75)
        );

        // Without a booked amount the calculator falls back to qty * price
        // (has_amount gate in should_use_activity_amount), so the health
        // check must too — not amt() == 0.
        let mut bond_sell_no_amount = bond_sell.clone();
        bond_sell_no_amount.id = "sell-bond-no-amount".to_string();
        bond_sell_no_amount.amount = None;

        assert_eq!(
            health_sell_net_proceeds(&bond_sell_no_amount, Some(&bond_asset)),
            dec!(2.75)
        );

        let mut taxed_sell = sell_activity("sell-taxed", "business", "aapl");
        taxed_sell.quantity = Some(dec!(10));
        taxed_sell.unit_price = Some(dec!(100));
        taxed_sell.fee = Some(dec!(5));
        taxed_sell.tax = Some(dec!(15));

        assert_eq!(
            health_sell_net_proceeds(&taxed_sell, Some(&health_asset("aapl"))),
            dec!(980)
        );
    }

    #[tokio::test]
    async fn test_health_service_empty_portfolio() {
        let store = Arc::new(MockDismissalStore::new());
        let service = HealthService::new(store);

        let status = service
            .run_checks_with_data(
                "USD",
                0.0,
                &[],
                &HashMap::new(),
                &[],
                &[],
                &[],
                &[],
                &None,
                &[],
                Some("UTC"),
                None,
                &[],
            )
            .await
            .unwrap();

        assert_eq!(status.total_count(), 0);
        assert_eq!(status.overall_severity, crate::health::Severity::Info);
    }

    #[tokio::test]
    async fn test_dismiss_and_restore() {
        let store = Arc::new(MockDismissalStore::new());
        let service = HealthService::new(store.clone());

        // Dismiss an issue
        service
            .dismiss_issue("test_issue", "hash123")
            .await
            .unwrap();

        let dismissed = service.get_dismissed_ids().await.unwrap();
        assert_eq!(dismissed.len(), 1);
        assert_eq!(dismissed[0], "test_issue");

        // Restore the issue
        service.restore_issue("test_issue").await.unwrap();

        let dismissed = service.get_dismissed_ids().await.unwrap();
        assert!(dismissed.is_empty());
    }

    #[tokio::test]
    async fn test_config_validation() {
        let store = Arc::new(MockDismissalStore::new());
        let service = HealthService::new(store);

        // Invalid: warning >= critical
        let bad_config = HealthConfig {
            price_stale_warning_hours: 72,
            price_stale_critical_hours: 24, // Should be > warning
            ..Default::default()
        };

        let result = service.update_config(bad_config).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_health_check_with_issues() {
        let store = Arc::new(MockDismissalStore::new());
        let service = HealthService::new(store);

        let holdings = vec![AssetHoldingInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            name: Some("Apple Inc.".to_string()),
            exchange_mic: None,
            market_value: 10_000.0,
            uses_market_pricing: true,
        }];

        // No quotes = stale
        let quote_times = HashMap::new();

        let status = service
            .run_checks_with_data(
                "USD",
                100_000.0,
                &holdings,
                &quote_times,
                &[],
                &[],
                &[],
                &[],
                &None,
                &[],
                Some("UTC"),
                None,
                &[],
            )
            .await
            .unwrap();

        assert_eq!(status.total_count(), 1);
        assert!(status.overall_severity >= crate::health::Severity::Error);
    }

    #[tokio::test]
    async fn test_dismissed_issues_filtered() {
        let store = Arc::new(MockDismissalStore::new());
        let service = HealthService::new(store);

        // First, run checks to get an issue
        let holdings = vec![AssetHoldingInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            name: Some("Apple Inc.".to_string()),
            exchange_mic: None,
            market_value: 10_000.0,
            uses_market_pricing: true,
        }];
        let quote_times = HashMap::new();

        let status = service
            .run_checks_with_data(
                "USD",
                100_000.0,
                &holdings,
                &quote_times,
                &[],
                &[],
                &[],
                &[],
                &None,
                &[],
                Some("UTC"),
                None,
                &[],
            )
            .await
            .unwrap();

        assert_eq!(status.total_count(), 1);
        let issue = &status.issues[0];

        // Dismiss the issue
        service
            .dismiss_issue(&issue.id, &issue.data_hash)
            .await
            .unwrap();

        // Run checks again - issue should be filtered out
        let status = service
            .run_checks_with_data(
                "USD",
                100_000.0,
                &holdings,
                &quote_times,
                &[],
                &[],
                &[],
                &[],
                &None,
                &[],
                Some("UTC"),
                None,
                &[],
            )
            .await
            .unwrap();

        assert_eq!(status.total_count(), 0);
    }
}
