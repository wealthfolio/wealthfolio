//! Health service implementation.
//!
//! The HealthService orchestrates health checks, manages dismissals,
//! and handles fix actions.

use async_trait::async_trait;
use chrono::{Duration, Utc};
use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::accounts::{account_types, is_liability_account_type, AccountServiceTrait};
use crate::assets::AssetServiceTrait;
use crate::errors::Result;
use crate::portfolio::holdings::HoldingsServiceTrait;
use crate::portfolio::valuation::ValuationServiceTrait;
use crate::quotes::QuoteServiceTrait;
use crate::taxonomies::TaxonomyServiceTrait;

use super::checks::{
    AccountConfigurationCheck, AssetHoldingInfo, ClassificationCheck, ConsistencyIssueInfo,
    DataConsistencyCheck, FxIntegrityCheck, FxPairInfo, LegacyMigrationInfo, PriceStalenessCheck,
    QuoteSyncCheck, QuoteSyncErrorInfo, UnclassifiedAssetInfo, UnconfiguredAccountInfo,
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
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
    ) -> Result<HealthStatus> {
        // Gather holdings data from all accounts
        let accounts = account_service.get_active_accounts()?;

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

            fx_pair_mv
                .iter()
                .map(|((from_ccy, to_ccy), affected_mv)| {
                    // Check both directions since FX asset could be stored either way
                    let key_direct = format!("FX:{}/{}", from_ccy, to_ccy);
                    let key_inverse = format!("FX:{}/{}", to_ccy, from_ccy);
                    let latest_quote_time = fx_asset_map
                        .get(&key_direct)
                        .or_else(|| fx_asset_map.get(&key_inverse))
                        .and_then(|asset_id| {
                            quote_service
                                .get_latest_quotes(std::slice::from_ref(asset_id))
                                .ok()
                                .and_then(|q| q.into_values().next().map(|quote| quote.timestamp))
                        });

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
        let unclassified_assets: Vec<UnclassifiedAssetInfo> = Vec::new();

        // Detect accounts with negative portfolio balance in their history.
        // Exclude cash and credit-card accounts; card debt is an expected liability.
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
            "fetch_fx" => {
                // Parse currency pairs from payload
                let _pairs: Vec<String> = serde_json::from_value(action.payload.clone())
                    .map_err(|e| HealthError::invalid_payload(&action.id, e.to_string()))?;

                // TODO: Call FX service to refresh rates
                warn!("fetch_fx fix action not yet implemented");
                Ok(())
            }
            "migrate_classifications" => {
                // Parse asset IDs from payload
                let _asset_ids: Vec<String> = serde_json::from_value(action.payload.clone())
                    .map_err(|e| HealthError::invalid_payload(&action.id, e.to_string()))?;

                // TODO: Call taxonomy service to migrate legacy data
                warn!("migrate_classifications fix action not yet implemented");
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
            configured_timezone,
            client_timezone,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
            )
            .await
            .unwrap();

        assert_eq!(status.total_count(), 0);
    }
}
