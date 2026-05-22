//! Environment abstraction for AI assistant.
//!
//! This module provides the `AiEnvironment` trait that abstracts runtime
//! dependencies like secret stores, services, and configuration. The Tauri
//! and Axum backends implement this trait with their specific service instances.

use async_trait::async_trait;
use std::sync::Arc;
use wealthfolio_core::{
    accounts::AccountServiceTrait,
    activities::ActivityServiceTrait,
    goals::GoalServiceTrait,
    health::HealthServiceTrait,
    portfolio::{
        allocation::AllocationServiceTrait, holdings::HoldingsServiceTrait,
        income::IncomeServiceTrait, performance::PerformanceServiceTrait,
        valuation::ValuationServiceTrait,
    },
    quotes::QuoteServiceTrait,
    secrets::SecretStore,
    settings::SettingsServiceTrait,
};

use crate::types::ChatRepositoryTrait;

/// Environment abstraction for the AI assistant.
///
/// Implementations provide access to:
/// - Service traits for portfolio data access
/// - Secret store for API keys
/// - Configuration (base currency, etc.)
/// - Chat repository for thread/message persistence
/// - Quote service for symbol search
#[async_trait]
pub trait AiEnvironment: Send + Sync {
    /// Get the user's base currency (e.g., "USD", "EUR").
    fn base_currency(&self) -> String;

    /// Get the account service for fetching accounts.
    fn account_service(&self) -> Arc<dyn AccountServiceTrait>;

    /// Get the activity service for fetching/saving activities.
    fn activity_service(&self) -> Arc<dyn ActivityServiceTrait>;

    /// Get the holdings service for fetching holdings.
    fn holdings_service(&self) -> Arc<dyn HoldingsServiceTrait>;

    /// Get the valuation service for fetching valuations.
    fn valuation_service(&self) -> Arc<dyn ValuationServiceTrait>;

    /// Get the goal service for fetching goals.
    fn goal_service(&self) -> Arc<dyn GoalServiceTrait>;

    /// Get the settings service for storing AI settings.
    fn settings_service(&self) -> Arc<dyn SettingsServiceTrait>;

    /// Get the secret store for API keys.
    fn secret_store(&self) -> Arc<dyn SecretStore>;

    /// Get the chat repository for thread/message persistence.
    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait>;

    /// Get the quote service for symbol search.
    fn quote_service(&self) -> Arc<dyn QuoteServiceTrait>;

    /// Get the allocation service for portfolio allocations.
    fn allocation_service(&self) -> Arc<dyn AllocationServiceTrait>;

    /// Get the performance service for portfolio performance metrics.
    fn performance_service(&self) -> Arc<dyn PerformanceServiceTrait>;

    /// Get the income service for income/dividend summaries.
    fn income_service(&self) -> Arc<dyn IncomeServiceTrait>;

    /// Get the health service for portfolio health diagnostics.
    fn health_service(&self) -> Arc<dyn HealthServiceTrait>;
}

#[cfg(test)]
pub mod test_env {
    use super::*;
    use chrono::{DateTime, NaiveDate, Utc};
    use std::collections::{HashMap, HashSet};
    use std::sync::RwLock;
    use wealthfolio_core::{
        accounts::TrackingMode,
        accounts::{Account, AccountServiceTrait, AccountUpdate, NewAccount},
        activities::{
            Activity, ActivityBulkMutationRequest, ActivityBulkMutationResult, ActivityDetails,
            ActivityImport, ActivitySearchResponse, ActivitySearchResponseMeta,
            ActivityServiceTrait, ActivityUpdate, BrokerSyncProfileData, ImportAssetCandidate,
            ImportAssetPreviewItem, ImportMappingData, ImportTemplateData, ImportTemplateScope,
            NewActivity, SaveBrokerSyncProfileRulesRequest, Sort,
        },
        assets::{Asset, AssetServiceTrait, ProviderProfile},
        errors::DatabaseError,
        goals::{
            AccountValuationMap, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan,
            GoalServiceTrait, NewGoal, PreparedRetirementSimulationInput, SaveGoalPlan,
        },
        health::{
            checks::{
                AssetHoldingInfo, ConsistencyIssueInfo, FxPairInfo, LegacyMigrationInfo,
                QuoteSyncErrorInfo, UnclassifiedAssetInfo, UnconfiguredAccountInfo,
            },
            FixAction, HealthConfig, HealthServiceTrait, HealthStatus,
        },
        holdings::{Holding, HoldingsServiceTrait},
        planning::SaveUpOverview,
        portfolio::allocation::{AllocationHoldings, AllocationServiceTrait, PortfolioAllocations},
        portfolio::fire::RetirementOverview,
        portfolio::income::{IncomeServiceTrait, IncomeSummary},
        portfolio::performance::{PerformanceMetrics, PerformanceServiceTrait},
        quotes::{
            LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote, QuoteImport,
            QuoteServiceTrait, QuoteSyncState, SymbolSearchResult, SymbolSyncPlan, SyncMode,
            SyncResult,
        },
        secrets::SecretStore,
        settings::{Settings, SettingsServiceTrait, SettingsUpdate},
        taxonomies::TaxonomyServiceTrait,
        valuation::{
            DailyAccountValuation, NegativeBalanceInfo, ValuationRecalcMode, ValuationServiceTrait,
        },
        Error as CoreError, Result as CoreResult,
    };

    /// Mock secret store for testing.
    #[derive(Default)]
    pub struct MockSecretStore {
        secrets: RwLock<HashMap<String, String>>,
    }

    impl SecretStore for MockSecretStore {
        fn get_secret(&self, key: &str) -> CoreResult<Option<String>> {
            Ok(self.secrets.read().unwrap().get(key).cloned())
        }

        fn set_secret(&self, key: &str, value: &str) -> CoreResult<()> {
            self.secrets
                .write()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn delete_secret(&self, key: &str) -> CoreResult<()> {
            self.secrets.write().unwrap().remove(key);
            Ok(())
        }
    }

    /// Mock account service for testing.
    #[derive(Default)]
    pub struct MockAccountService {
        pub accounts: Vec<Account>,
    }

    #[async_trait]
    impl AccountServiceTrait for MockAccountService {
        fn get_all_accounts(&self) -> CoreResult<Vec<Account>> {
            Ok(self.accounts.clone())
        }

        fn get_active_accounts(&self) -> CoreResult<Vec<Account>> {
            Ok(self
                .accounts
                .iter()
                .filter(|a| a.is_active)
                .cloned()
                .collect())
        }

        fn get_account(&self, id: &str) -> CoreResult<Account> {
            self.accounts
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or_else(|| {
                    CoreError::Database(DatabaseError::NotFound(format!("Account {}", id)))
                })
        }

        fn list_accounts(
            &self,
            is_active_filter: Option<bool>,
            _is_archived_filter: Option<bool>,
            _account_ids: Option<&[String]>,
        ) -> CoreResult<Vec<Account>> {
            let accounts = match is_active_filter {
                Some(true) => self
                    .accounts
                    .iter()
                    .filter(|a| a.is_active)
                    .cloned()
                    .collect(),
                Some(false) => self
                    .accounts
                    .iter()
                    .filter(|a| !a.is_active)
                    .cloned()
                    .collect(),
                None => self.accounts.clone(),
            };
            Ok(accounts)
        }

        fn get_accounts_by_ids(&self, account_ids: &[String]) -> CoreResult<Vec<Account>> {
            Ok(self
                .accounts
                .iter()
                .filter(|a| account_ids.contains(&a.id))
                .cloned()
                .collect())
        }

        fn get_non_archived_accounts(&self) -> CoreResult<Vec<Account>> {
            Ok(self.accounts.clone())
        }

        fn get_active_non_archived_accounts(&self) -> CoreResult<Vec<Account>> {
            Ok(self
                .accounts
                .iter()
                .filter(|a| a.is_active)
                .cloned()
                .collect())
        }

        fn get_base_currency(&self) -> Option<String> {
            Some("USD".to_string())
        }

        async fn create_account(&self, _account: NewAccount) -> CoreResult<Account> {
            unimplemented!("MockAccountService::create_account")
        }

        async fn update_account(&self, _account: AccountUpdate) -> CoreResult<Account> {
            unimplemented!("MockAccountService::update_account")
        }

        async fn delete_account(&self, _id: &str) -> CoreResult<()> {
            unimplemented!("MockAccountService::delete_account")
        }
    }

    /// Mock activity service for testing.
    #[derive(Default)]
    pub struct MockActivityService {
        pub activities: Vec<ActivityDetails>,
    }

    #[async_trait]
    impl ActivityServiceTrait for MockActivityService {
        fn get_activity(&self, _activity_id: &str) -> CoreResult<Activity> {
            unimplemented!("MockActivityService::get_activity")
        }

        fn get_activities(&self) -> CoreResult<Vec<Activity>> {
            unimplemented!("MockActivityService::get_activities")
        }

        fn get_activities_by_account_id(&self, _account_id: &str) -> CoreResult<Vec<Activity>> {
            unimplemented!("MockActivityService::get_activities_by_account_id")
        }

        fn get_activities_by_account_ids(
            &self,
            _account_ids: &[String],
        ) -> CoreResult<Vec<Activity>> {
            unimplemented!("MockActivityService::get_activities_by_account_ids")
        }

        fn get_trading_activities(&self) -> CoreResult<Vec<Activity>> {
            unimplemented!("MockActivityService::get_trading_activities")
        }

        fn get_income_activities(&self) -> CoreResult<Vec<Activity>> {
            unimplemented!("MockActivityService::get_income_activities")
        }

        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<Sort>,
            _needs_review_filter: Option<bool>,
            _date_from: Option<chrono::NaiveDate>,
            _date_to: Option<chrono::NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
        ) -> CoreResult<ActivitySearchResponse> {
            Ok(ActivitySearchResponse {
                data: self.activities.clone(),
                meta: ActivitySearchResponseMeta {
                    total_row_count: self.activities.len() as i64,
                },
            })
        }

        fn get_first_activity_date(
            &self,
            _account_ids: Option<&[String]>,
        ) -> CoreResult<Option<DateTime<Utc>>> {
            Ok(None)
        }

        fn get_import_mapping(
            &self,
            _account_id: String,
            _import_type: String,
        ) -> CoreResult<ImportMappingData> {
            // Return error to simulate no saved mapping (tests will use auto-detection)
            Err(wealthfolio_core::errors::DatabaseError::NotFound(
                "No saved import mapping".to_string(),
            )
            .into())
        }

        async fn create_activity(&self, _activity: NewActivity) -> CoreResult<Activity> {
            unimplemented!("MockActivityService::create_activity")
        }

        async fn update_activity(&self, _activity: ActivityUpdate) -> CoreResult<Activity> {
            unimplemented!("MockActivityService::update_activity")
        }

        async fn delete_activity(&self, _activity_id: String) -> CoreResult<Activity> {
            unimplemented!("MockActivityService::delete_activity")
        }

        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> CoreResult<(Activity, Activity)> {
            unimplemented!("MockActivityService::link_transfer_activities")
        }

        async fn unlink_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> CoreResult<(Activity, Activity)> {
            unimplemented!("MockActivityService::unlink_transfer_activities")
        }

        async fn bulk_mutate_activities(
            &self,
            _request: ActivityBulkMutationRequest,
        ) -> CoreResult<ActivityBulkMutationResult> {
            unimplemented!("MockActivityService::bulk_mutate_activities")
        }

        async fn check_activities_import(
            &self,
            _activities: Vec<ActivityImport>,
        ) -> CoreResult<Vec<ActivityImport>> {
            unimplemented!("MockActivityService::check_activities_import")
        }

        async fn import_activities(
            &self,
            _activities: Vec<ActivityImport>,
        ) -> CoreResult<wealthfolio_core::activities::ImportActivitiesResult> {
            unimplemented!("MockActivityService::import_activities")
        }

        async fn save_import_mapping(
            &self,
            _mapping_data: ImportMappingData,
        ) -> CoreResult<ImportMappingData> {
            unimplemented!("MockActivityService::save_import_mapping")
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: Vec<String>,
        ) -> CoreResult<std::collections::HashMap<String, String>> {
            Ok(std::collections::HashMap::new())
        }

        fn parse_csv(
            &self,
            content: &[u8],
            config: &wealthfolio_core::activities::ParseConfig,
        ) -> CoreResult<wealthfolio_core::activities::ParsedCsvResult> {
            // Delegate to the actual core parser for testing
            wealthfolio_core::activities::parse_csv(content, config)
        }

        async fn prepare_activities_for_save(
            &self,
            _activities: Vec<NewActivity>,
            _account: &Account,
        ) -> CoreResult<wealthfolio_core::activities::PrepareActivitiesResult> {
            unimplemented!("MockActivityService::prepare_activities_for_save")
        }

        async fn prepare_activities_for_import(
            &self,
            _activities: Vec<NewActivity>,
            _account: &Account,
        ) -> CoreResult<wealthfolio_core::activities::PrepareActivitiesResult> {
            unimplemented!("MockActivityService::prepare_activities_for_import")
        }

        async fn prepare_activities_for_sync(
            &self,
            _activities: Vec<NewActivity>,
            _account: &Account,
        ) -> CoreResult<wealthfolio_core::activities::PrepareActivitiesResult> {
            unimplemented!("MockActivityService::prepare_activities_for_sync")
        }

        async fn upsert_activities_bulk(
            &self,
            _activities: Vec<wealthfolio_core::activities::ActivityUpsert>,
        ) -> CoreResult<wealthfolio_core::activities::BulkUpsertResult> {
            unimplemented!("MockActivityService::upsert_activities_bulk")
        }

        fn list_import_templates(&self) -> CoreResult<Vec<ImportTemplateData>> {
            Ok(vec![])
        }

        fn get_import_template(&self, _template_id: String) -> CoreResult<ImportTemplateData> {
            Ok(ImportTemplateData::default())
        }

        async fn preview_import_assets(
            &self,
            _candidates: Vec<ImportAssetCandidate>,
        ) -> CoreResult<Vec<ImportAssetPreviewItem>> {
            Ok(vec![])
        }

        async fn link_account_template(
            &self,
            _account_id: String,
            _template_id: String,
            _context_kind: String,
        ) -> CoreResult<()> {
            Ok(())
        }

        async fn save_import_template(
            &self,
            template: ImportTemplateData,
        ) -> CoreResult<ImportTemplateData> {
            Ok(template)
        }

        async fn delete_import_template(&self, _template_id: String) -> CoreResult<()> {
            Ok(())
        }

        fn get_broker_sync_profile(
            &self,
            _account_id: String,
            _source_system: String,
        ) -> CoreResult<BrokerSyncProfileData> {
            Ok(BrokerSyncProfileData {
                id: String::new(),
                name: String::new(),
                scope: ImportTemplateScope::User,
                source_system: String::new(),
                activity_mappings: std::collections::HashMap::new(),
                symbol_mappings: std::collections::HashMap::new(),
                symbol_mapping_meta: std::collections::HashMap::new(),
            })
        }

        async fn save_broker_sync_profile_rules(
            &self,
            _request: SaveBrokerSyncProfileRulesRequest,
        ) -> CoreResult<BrokerSyncProfileData> {
            Ok(BrokerSyncProfileData {
                id: String::new(),
                name: String::new(),
                scope: ImportTemplateScope::User,
                source_system: String::new(),
                activity_mappings: std::collections::HashMap::new(),
                symbol_mappings: std::collections::HashMap::new(),
                symbol_mapping_meta: std::collections::HashMap::new(),
            })
        }
    }

    /// Mock holdings service for testing.
    #[derive(Default)]
    pub struct MockHoldingsService {
        pub holdings: Vec<Holding>,
    }

    #[async_trait]
    impl HoldingsServiceTrait for MockHoldingsService {
        async fn get_holdings(
            &self,
            _account_id: &str,
            _base_currency: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }

        async fn get_holdings_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(self.holdings.clone())
        }

        async fn get_holding(
            &self,
            _account_id: &str,
            _asset_id: &str,
            _base_currency: &str,
        ) -> CoreResult<Option<Holding>> {
            Ok(None)
        }

        async fn holdings_from_snapshot(
            &self,
            _snapshot: &wealthfolio_core::portfolio::snapshot::AccountStateSnapshot,
            _base_currency: &str,
        ) -> CoreResult<Vec<Holding>> {
            Ok(Vec::new())
        }
    }

    /// Mock valuation service for testing.
    #[derive(Default)]
    pub struct MockValuationService {
        pub valuations: Vec<DailyAccountValuation>,
    }

    #[async_trait]
    impl ValuationServiceTrait for MockValuationService {
        fn get_latest_valuations(
            &self,
            _account_ids: &[String],
        ) -> CoreResult<Vec<DailyAccountValuation>> {
            Ok(self.valuations.clone())
        }

        fn get_historical_valuations(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> CoreResult<Vec<DailyAccountValuation>> {
            Ok(self.valuations.clone())
        }

        fn get_valuations_on_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> CoreResult<Vec<DailyAccountValuation>> {
            Ok(self.valuations.clone())
        }

        fn get_accounts_with_negative_balance(
            &self,
            _account_ids: &[String],
        ) -> CoreResult<Vec<NegativeBalanceInfo>> {
            Ok(Vec::new())
        }

        async fn calculate_valuation_history(
            &self,
            _account_id: &str,
            _mode: ValuationRecalcMode,
        ) -> CoreResult<()> {
            Ok(())
        }
    }

    /// Mock goal service for testing.
    #[derive(Default)]
    pub struct MockGoalService {
        pub goals: Vec<Goal>,
    }

    #[async_trait]
    impl GoalServiceTrait for MockGoalService {
        fn get_goals(&self) -> CoreResult<Vec<Goal>> {
            Ok(self.goals.clone())
        }

        fn get_goal(&self, _goal_id: &str) -> CoreResult<Goal> {
            unimplemented!("MockGoalService::get_goal")
        }

        async fn create_goal(&self, _goal: NewGoal) -> CoreResult<Goal> {
            unimplemented!("MockGoalService::create_goal")
        }

        async fn update_goal(&self, _goal: Goal) -> CoreResult<Goal> {
            unimplemented!("MockGoalService::update_goal")
        }

        async fn delete_goal(&self, _goal_id: String) -> CoreResult<usize> {
            unimplemented!("MockGoalService::delete_goal")
        }

        fn get_goal_funding(&self, _goal_id: &str) -> CoreResult<Vec<GoalFundingRule>> {
            Ok(Vec::new())
        }

        async fn save_goal_funding(
            &self,
            _goal_id: &str,
            _rules: Vec<GoalFundingRuleInput>,
        ) -> CoreResult<Vec<GoalFundingRule>> {
            unimplemented!("MockGoalService::save_goal_funding")
        }

        fn get_goal_plan(&self, _goal_id: &str) -> CoreResult<Option<GoalPlan>> {
            Ok(None)
        }

        async fn save_goal_plan(&self, _plan: SaveGoalPlan) -> CoreResult<GoalPlan> {
            unimplemented!("MockGoalService::save_goal_plan")
        }

        async fn delete_goal_plan(&self, _goal_id: &str) -> CoreResult<usize> {
            unimplemented!("MockGoalService::delete_goal_plan")
        }

        async fn refresh_goal_summary(
            &self,
            _goal_id: &str,
            _valuations: &AccountValuationMap,
        ) -> CoreResult<Goal> {
            unimplemented!("MockGoalService::refresh_goal_summary")
        }

        async fn compute_retirement_overview(
            &self,
            _goal_id: &str,
            _valuation_map: &AccountValuationMap,
        ) -> CoreResult<RetirementOverview> {
            Err(CoreError::Unexpected(
                "MockGoalService::compute_retirement_overview is not implemented".to_string(),
            ))
        }

        async fn prepare_retirement_simulation_input(
            &self,
            _goal_id: &str,
            _valuation_map: &AccountValuationMap,
        ) -> CoreResult<PreparedRetirementSimulationInput> {
            Err(CoreError::Unexpected(
                "MockGoalService::prepare_retirement_simulation_input is not implemented"
                    .to_string(),
            ))
        }

        async fn compute_save_up_overview(
            &self,
            _goal_id: &str,
            _valuation_map: &AccountValuationMap,
        ) -> CoreResult<SaveUpOverview> {
            Err(CoreError::Unexpected(
                "MockGoalService::compute_save_up_overview is not implemented".to_string(),
            ))
        }
    }

    /// Mock settings service for testing.
    #[derive(Default)]
    pub struct MockSettingsService {
        pub settings: RwLock<HashMap<String, String>>,
    }

    #[async_trait]
    impl SettingsServiceTrait for MockSettingsService {
        fn get_settings(&self) -> CoreResult<Settings> {
            Ok(Settings::default())
        }

        async fn update_settings(&self, _new_settings: &SettingsUpdate) -> CoreResult<()> {
            Ok(())
        }

        fn get_base_currency(&self) -> CoreResult<Option<String>> {
            Ok(Some("USD".to_string()))
        }

        async fn update_base_currency(&self, _new_base_currency: &str) -> CoreResult<()> {
            Ok(())
        }

        fn is_auto_update_check_enabled(&self) -> CoreResult<bool> {
            Ok(true)
        }

        fn is_sync_enabled(&self) -> CoreResult<bool> {
            Ok(false)
        }

        fn get_setting_value(&self, key: &str) -> CoreResult<Option<String>> {
            Ok(self.settings.read().unwrap().get(key).cloned())
        }

        async fn set_setting_value(&self, key: &str, value: &str) -> CoreResult<()> {
            self.settings
                .write()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
    }

    /// Mock chat repository for testing.
    #[derive(Default)]
    pub struct MockChatRepository {
        pub threads: RwLock<HashMap<String, crate::types::ChatThread>>,
        pub messages: RwLock<HashMap<String, Vec<crate::types::ChatMessage>>>,
    }

    #[async_trait]
    impl crate::types::ChatRepositoryTrait for MockChatRepository {
        async fn create_thread(
            &self,
            thread: crate::types::ChatThread,
        ) -> crate::types::ChatRepositoryResult<crate::types::ChatThread> {
            self.threads
                .write()
                .unwrap()
                .insert(thread.id.clone(), thread.clone());
            Ok(thread)
        }

        fn get_thread(
            &self,
            thread_id: &str,
        ) -> crate::types::ChatRepositoryResult<Option<crate::types::ChatThread>> {
            Ok(self.threads.read().unwrap().get(thread_id).cloned())
        }

        fn list_threads(
            &self,
            limit: i64,
            _offset: i64,
        ) -> crate::types::ChatRepositoryResult<Vec<crate::types::ChatThread>> {
            let threads = self.threads.read().unwrap();
            let mut list: Vec<_> = threads.values().cloned().collect();
            list.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
            list.truncate(limit as usize);
            Ok(list)
        }

        fn list_threads_paginated(
            &self,
            request: &crate::types::ListThreadsRequest,
        ) -> crate::types::ChatRepositoryResult<crate::types::ThreadPage> {
            let threads = self.threads.read().unwrap();
            let mut list: Vec<_> = threads.values().cloned().collect();
            list.sort_by_key(|b| std::cmp::Reverse(b.updated_at));

            // Apply search filter if provided
            if let Some(ref search) = request.search {
                let search_lower = search.to_lowercase();
                list.retain(|t| {
                    t.title
                        .as_ref()
                        .map(|title| title.to_lowercase().contains(&search_lower))
                        .unwrap_or(false)
                });
            }

            let limit = request.limit.unwrap_or(20).min(100) as usize;
            let has_more = list.len() > limit;
            list.truncate(limit);

            let next_cursor = if has_more {
                list.last().map(|t| t.id.clone())
            } else {
                None
            };

            Ok(crate::types::ThreadPage {
                threads: list,
                next_cursor,
                has_more,
            })
        }

        async fn update_thread(
            &self,
            thread: crate::types::ChatThread,
        ) -> crate::types::ChatRepositoryResult<crate::types::ChatThread> {
            self.threads
                .write()
                .unwrap()
                .insert(thread.id.clone(), thread.clone());
            Ok(thread)
        }

        async fn delete_thread(&self, thread_id: &str) -> crate::types::ChatRepositoryResult<()> {
            self.threads.write().unwrap().remove(thread_id);
            self.messages.write().unwrap().remove(thread_id);
            Ok(())
        }

        async fn create_message(
            &self,
            message: crate::types::ChatMessage,
        ) -> crate::types::ChatRepositoryResult<crate::types::ChatMessage> {
            self.messages
                .write()
                .unwrap()
                .entry(message.thread_id.clone())
                .or_default()
                .push(message.clone());
            Ok(message)
        }

        fn get_message(
            &self,
            message_id: &str,
        ) -> crate::types::ChatRepositoryResult<Option<crate::types::ChatMessage>> {
            let messages = self.messages.read().unwrap();
            for msgs in messages.values() {
                if let Some(msg) = msgs.iter().find(|m| m.id == message_id) {
                    return Ok(Some(msg.clone()));
                }
            }
            Ok(None)
        }

        fn get_messages_by_thread(
            &self,
            thread_id: &str,
        ) -> crate::types::ChatRepositoryResult<Vec<crate::types::ChatMessage>> {
            Ok(self
                .messages
                .read()
                .unwrap()
                .get(thread_id)
                .cloned()
                .unwrap_or_default())
        }

        async fn update_message(
            &self,
            message: crate::types::ChatMessage,
        ) -> crate::types::ChatRepositoryResult<crate::types::ChatMessage> {
            let mut messages = self.messages.write().unwrap();
            if let Some(msgs) = messages.get_mut(&message.thread_id) {
                if let Some(pos) = msgs.iter().position(|m| m.id == message.id) {
                    msgs[pos] = message.clone();
                }
            }
            Ok(message)
        }

        async fn add_tag(
            &self,
            _thread_id: &str,
            _tag: &str,
        ) -> crate::types::ChatRepositoryResult<()> {
            Ok(())
        }

        async fn remove_tag(
            &self,
            _thread_id: &str,
            _tag: &str,
        ) -> crate::types::ChatRepositoryResult<()> {
            Ok(())
        }

        fn get_tags(&self, _thread_id: &str) -> crate::types::ChatRepositoryResult<Vec<String>> {
            Ok(Vec::new())
        }
    }

    /// Mock quote service for testing.
    #[derive(Default)]
    pub struct MockQuoteService {
        pub search_results: RwLock<Vec<SymbolSearchResult>>,
    }

    #[async_trait]
    impl QuoteServiceTrait for MockQuoteService {
        fn get_latest_quote(&self, _symbol: &str) -> CoreResult<Quote> {
            unimplemented!("MockQuoteService::get_latest_quote")
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> CoreResult<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_as_of(
            &self,
            _symbols: &[String],
            _as_of: chrono::NaiveDate,
        ) -> CoreResult<HashMap<String, Quote>> {
            Ok(HashMap::new())
        }

        fn get_latest_quotes_snapshot(
            &self,
            asset_ids: &[String],
        ) -> CoreResult<HashMap<String, LatestQuoteSnapshot>> {
            let today = Utc::now().date_naive();
            let quotes = self.get_latest_quotes(asset_ids)?;
            Ok(quotes
                .into_iter()
                .map(|(asset_id, quote)| {
                    let quote_day = quote.timestamp.date_naive();
                    (
                        asset_id,
                        LatestQuoteSnapshot {
                            quote: Some(quote),
                            is_stale: quote_day < today,
                            effective_market_date: today.to_string(),
                            quote_date: Some(quote_day.to_string()),
                            no_quote_reason: None,
                        },
                    )
                })
                .collect())
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> CoreResult<HashMap<String, LatestQuotePair>> {
            Ok(HashMap::new())
        }

        fn get_historical_quotes(&self, _symbol: &str) -> CoreResult<Vec<Quote>> {
            Ok(Vec::new())
        }

        fn get_all_historical_quotes(
            &self,
        ) -> CoreResult<HashMap<String, Vec<(NaiveDate, Quote)>>> {
            Ok(HashMap::new())
        }

        fn get_quotes_in_range(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> CoreResult<Vec<Quote>> {
            Ok(Vec::new())
        }

        fn get_quotes_in_range_filled(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> CoreResult<Vec<Quote>> {
            Ok(Vec::new())
        }

        async fn get_daily_quotes(
            &self,
            _asset_ids: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> CoreResult<HashMap<NaiveDate, HashMap<String, Quote>>> {
            Ok(HashMap::new())
        }

        async fn add_quote(&self, quote: &Quote) -> CoreResult<Quote> {
            Ok(quote.clone())
        }

        async fn update_quote(&self, quote: Quote) -> CoreResult<Quote> {
            Ok(quote)
        }

        async fn delete_quote(&self, _quote_id: &str) -> CoreResult<()> {
            Ok(())
        }

        async fn bulk_upsert_quotes(&self, quotes: Vec<Quote>) -> CoreResult<usize> {
            Ok(quotes.len())
        }

        async fn search_symbol(&self, query: &str) -> CoreResult<Vec<SymbolSearchResult>> {
            self.search_symbol_with_currency(query, None).await
        }

        async fn search_symbol_with_currency(
            &self,
            _query: &str,
            _account_currency: Option<&str>,
        ) -> CoreResult<Vec<SymbolSearchResult>> {
            Ok(self.search_results.read().unwrap().clone())
        }

        async fn get_asset_profile(&self, _asset: &Asset) -> CoreResult<ProviderProfile> {
            unimplemented!("MockQuoteService::get_asset_profile")
        }

        async fn fetch_quotes_from_provider(
            &self,
            _asset_id: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> CoreResult<Vec<Quote>> {
            Ok(Vec::new())
        }

        async fn fetch_quotes_for_symbol(
            &self,
            _symbol: &str,
            _currency: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> CoreResult<Vec<Quote>> {
            Ok(Vec::new())
        }

        async fn sync(
            &self,
            _mode: SyncMode,
            _asset_ids: Option<Vec<String>>,
        ) -> CoreResult<SyncResult> {
            Ok(SyncResult::default())
        }

        async fn resync(&self, _asset_ids: Option<Vec<String>>) -> CoreResult<SyncResult> {
            Ok(SyncResult::default())
        }

        async fn refresh_sync_state(&self) -> CoreResult<()> {
            Ok(())
        }

        fn get_sync_plan(&self) -> CoreResult<Vec<SymbolSyncPlan>> {
            Ok(Vec::new())
        }

        async fn handle_activity_created(
            &self,
            _symbol: &str,
            _activity_date: NaiveDate,
        ) -> CoreResult<()> {
            Ok(())
        }

        async fn handle_activity_deleted(&self, _symbol: &str) -> CoreResult<()> {
            Ok(())
        }

        async fn delete_sync_state(&self, _symbol: &str) -> CoreResult<()> {
            Ok(())
        }

        fn get_symbols_needing_sync(&self) -> CoreResult<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        fn get_sync_state(&self, _symbol: &str) -> CoreResult<Option<QuoteSyncState>> {
            Ok(None)
        }

        async fn mark_profile_enriched(&self, _symbol: &str) -> CoreResult<()> {
            Ok(())
        }

        fn get_assets_needing_profile_enrichment(&self) -> CoreResult<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        async fn update_position_status_from_holdings(
            &self,
            _current_holdings: &std::collections::HashMap<String, rust_decimal::Decimal>,
        ) -> CoreResult<()> {
            Ok(())
        }

        fn get_sync_states_with_errors(&self) -> CoreResult<Vec<QuoteSyncState>> {
            Ok(Vec::new())
        }

        async fn reset_sync_errors(&self, _asset_ids: &[String]) -> CoreResult<()> {
            Ok(())
        }

        async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> CoreResult<()> {
            Ok(())
        }

        async fn get_providers_info(&self) -> CoreResult<Vec<ProviderInfo>> {
            Ok(Vec::new())
        }

        async fn update_provider_settings(
            &self,
            _provider_id: &str,
            _priority: i32,
            _enabled: bool,
        ) -> CoreResult<()> {
            Ok(())
        }

        async fn check_quotes_import(
            &self,
            _content: &[u8],
            _has_header_row: bool,
        ) -> CoreResult<Vec<QuoteImport>> {
            Ok(vec![])
        }

        async fn import_quotes(
            &self,
            quotes: Vec<QuoteImport>,
            _overwrite: bool,
        ) -> CoreResult<Vec<QuoteImport>> {
            Ok(quotes)
        }
    }

    /// Mock allocation service for testing.
    #[derive(Default)]
    pub struct MockAllocationService;

    #[async_trait]
    impl AllocationServiceTrait for MockAllocationService {
        async fn get_portfolio_allocations(
            &self,
            _account_id: &str,
            _base_currency: &str,
        ) -> CoreResult<PortfolioAllocations> {
            Ok(PortfolioAllocations::default())
        }

        async fn get_portfolio_allocations_for_accounts(
            &self,
            _account_ids: &[String],
            _base_currency: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<PortfolioAllocations> {
            Ok(PortfolioAllocations::default())
        }

        async fn get_holdings_by_allocation(
            &self,
            _account_id: &str,
            base_currency: &str,
            taxonomy_id: &str,
            category_id: &str,
        ) -> CoreResult<AllocationHoldings> {
            Ok(AllocationHoldings {
                taxonomy_id: taxonomy_id.to_string(),
                taxonomy_name: "Mock Taxonomy".to_string(),
                category_id: category_id.to_string(),
                category_name: "Mock Category".to_string(),
                color: "#808080".to_string(),
                holdings: Vec::new(),
                total_value: rust_decimal::Decimal::ZERO,
                currency: base_currency.to_string(),
            })
        }

        async fn get_holdings_by_allocation_for_accounts(
            &self,
            _account_ids: &[String],
            base_currency: &str,
            taxonomy_id: &str,
            category_id: &str,
            _aggregated_account_id: &str,
        ) -> CoreResult<AllocationHoldings> {
            Ok(AllocationHoldings {
                taxonomy_id: taxonomy_id.to_string(),
                taxonomy_name: "Mock Taxonomy".to_string(),
                category_id: category_id.to_string(),
                category_name: "Mock Category".to_string(),
                color: "#808080".to_string(),
                holdings: Vec::new(),
                total_value: rust_decimal::Decimal::ZERO,
                currency: base_currency.to_string(),
            })
        }
    }

    /// Mock income service for testing.
    #[derive(Default)]
    pub struct MockIncomeService;

    impl IncomeServiceTrait for MockIncomeService {
        fn get_income_summary(
            &self,
            _account_ids: Option<&[String]>,
        ) -> CoreResult<Vec<IncomeSummary>> {
            Ok(vec![
                IncomeSummary::new("TOTAL", "USD".to_string()),
                IncomeSummary::new("YTD", "USD".to_string()),
                IncomeSummary::new("LAST_YEAR", "USD".to_string()),
            ])
        }
    }

    /// Mock performance service for testing.
    #[derive(Default)]
    pub struct MockPerformanceService;

    #[async_trait]
    impl PerformanceServiceTrait for MockPerformanceService {
        async fn calculate_performance_history(
            &self,
            _item_type: &str,
            item_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
            _tracking_mode: Option<TrackingMode>,
        ) -> CoreResult<PerformanceMetrics> {
            Ok(PerformanceMetrics {
                id: item_id.to_string(),
                returns: Vec::new(),
                period_start_date: None,
                period_end_date: None,
                currency: "USD".to_string(),
                period_gain: rust_decimal::Decimal::ZERO,
                period_return: Some(rust_decimal::Decimal::ZERO),
                cumulative_twr: Some(rust_decimal::Decimal::ZERO),
                gain_loss_amount: Some(rust_decimal::Decimal::ZERO),
                annualized_twr: Some(rust_decimal::Decimal::ZERO),
                simple_return: rust_decimal::Decimal::ZERO,
                annualized_simple_return: rust_decimal::Decimal::ZERO,
                cumulative_mwr: Some(rust_decimal::Decimal::ZERO),
                annualized_mwr: Some(rust_decimal::Decimal::ZERO),
                volatility: rust_decimal::Decimal::ZERO,
                max_drawdown: rust_decimal::Decimal::ZERO,
                is_holdings_mode: false,
            })
        }

        async fn calculate_performance_summary(
            &self,
            _item_type: &str,
            item_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
            _tracking_mode: Option<TrackingMode>,
        ) -> CoreResult<PerformanceMetrics> {
            Ok(PerformanceMetrics {
                id: item_id.to_string(),
                returns: Vec::new(),
                period_start_date: None,
                period_end_date: None,
                currency: "USD".to_string(),
                period_gain: rust_decimal::Decimal::ZERO,
                period_return: Some(rust_decimal::Decimal::ZERO),
                cumulative_twr: Some(rust_decimal::Decimal::ZERO),
                gain_loss_amount: Some(rust_decimal::Decimal::ZERO),
                annualized_twr: Some(rust_decimal::Decimal::ZERO),
                simple_return: rust_decimal::Decimal::ZERO,
                annualized_simple_return: rust_decimal::Decimal::ZERO,
                cumulative_mwr: Some(rust_decimal::Decimal::ZERO),
                annualized_mwr: Some(rust_decimal::Decimal::ZERO),
                volatility: rust_decimal::Decimal::ZERO,
                max_drawdown: rust_decimal::Decimal::ZERO,
                is_holdings_mode: false,
            })
        }

        fn calculate_accounts_simple_performance(
            &self,
            _account_ids: &[String],
        ) -> CoreResult<Vec<wealthfolio_core::performance::SimplePerformanceMetrics>> {
            Ok(Vec::new())
        }
    }

    /// Mock environment for testing.
    pub struct MockEnvironment {
        pub base_currency: String,
        pub account_service: Arc<dyn AccountServiceTrait>,
        pub activity_service: Arc<dyn ActivityServiceTrait>,
        pub holdings_service: Arc<dyn HoldingsServiceTrait>,
        pub valuation_service: Arc<dyn ValuationServiceTrait>,
        pub goal_service: Arc<dyn GoalServiceTrait>,
        pub settings_service: Arc<dyn SettingsServiceTrait>,
        pub secret_store: Arc<dyn SecretStore>,
        pub chat_repository: Arc<dyn ChatRepositoryTrait>,
        pub quote_service: Arc<dyn QuoteServiceTrait>,
        pub allocation_service: Arc<dyn AllocationServiceTrait>,
        pub performance_service: Arc<dyn PerformanceServiceTrait>,
        pub income_service: Arc<dyn IncomeServiceTrait>,
        pub health_service: Arc<dyn HealthServiceTrait>,
    }

    impl Default for MockEnvironment {
        fn default() -> Self {
            Self::new()
        }
    }

    impl MockEnvironment {
        pub fn new() -> Self {
            Self {
                base_currency: "USD".to_string(),
                account_service: Arc::new(MockAccountService::default()),
                activity_service: Arc::new(MockActivityService::default()),
                holdings_service: Arc::new(MockHoldingsService::default()),
                valuation_service: Arc::new(MockValuationService::default()),
                goal_service: Arc::new(MockGoalService::default()),
                settings_service: Arc::new(MockSettingsService::default()),
                secret_store: Arc::new(MockSecretStore::default()),
                chat_repository: Arc::new(MockChatRepository::default()),
                quote_service: Arc::new(MockQuoteService::default()),
                allocation_service: Arc::new(MockAllocationService),
                performance_service: Arc::new(MockPerformanceService),
                income_service: Arc::new(MockIncomeService),
                health_service: Arc::new(MockHealthService::default()),
            }
        }

        pub fn with_secret(self, key: &str, value: &str) -> Self {
            self.secret_store.set_secret(key, value).unwrap();
            self
        }
    }

    #[async_trait]
    impl AiEnvironment for MockEnvironment {
        fn base_currency(&self) -> String {
            self.base_currency.clone()
        }

        fn account_service(&self) -> Arc<dyn AccountServiceTrait> {
            self.account_service.clone()
        }

        fn activity_service(&self) -> Arc<dyn ActivityServiceTrait> {
            self.activity_service.clone()
        }

        fn holdings_service(&self) -> Arc<dyn HoldingsServiceTrait> {
            self.holdings_service.clone()
        }

        fn valuation_service(&self) -> Arc<dyn ValuationServiceTrait> {
            self.valuation_service.clone()
        }

        fn goal_service(&self) -> Arc<dyn GoalServiceTrait> {
            self.goal_service.clone()
        }

        fn settings_service(&self) -> Arc<dyn SettingsServiceTrait> {
            self.settings_service.clone()
        }

        fn secret_store(&self) -> Arc<dyn SecretStore> {
            self.secret_store.clone()
        }

        fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait> {
            self.chat_repository.clone()
        }

        fn quote_service(&self) -> Arc<dyn QuoteServiceTrait> {
            self.quote_service.clone()
        }

        fn allocation_service(&self) -> Arc<dyn AllocationServiceTrait> {
            self.allocation_service.clone()
        }

        fn performance_service(&self) -> Arc<dyn PerformanceServiceTrait> {
            self.performance_service.clone()
        }

        fn income_service(&self) -> Arc<dyn IncomeServiceTrait> {
            self.income_service.clone()
        }

        fn health_service(&self) -> Arc<dyn HealthServiceTrait> {
            self.health_service.clone()
        }
    }

    #[derive(Default)]
    pub struct MockHealthService {
        pub cached_status: Option<HealthStatus>,
    }

    #[async_trait::async_trait]
    impl HealthServiceTrait for MockHealthService {
        async fn run_checks(&self, _base_currency: &str) -> CoreResult<HealthStatus> {
            Ok(HealthStatus::healthy())
        }

        async fn run_checks_with_data(
            &self,
            _base_currency: &str,
            _total_portfolio_value: f64,
            _holdings: &[AssetHoldingInfo],
            _latest_quote_times: &std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>,
            _quote_sync_errors: &[QuoteSyncErrorInfo],
            _fx_pairs: &[FxPairInfo],
            _unclassified_assets: &[UnclassifiedAssetInfo],
            _consistency_issues: &[ConsistencyIssueInfo],
            _legacy_migration_info: &Option<LegacyMigrationInfo>,
            _unconfigured_accounts: &[UnconfiguredAccountInfo],
            _configured_timezone: Option<&str>,
            _client_timezone: Option<&str>,
        ) -> CoreResult<HealthStatus> {
            Ok(HealthStatus::healthy())
        }

        async fn run_full_checks(
            &self,
            _base_currency: &str,
            _account_service: Arc<dyn wealthfolio_core::accounts::AccountServiceTrait>,
            _holdings_service: Arc<dyn HoldingsServiceTrait>,
            _quote_service: Arc<dyn QuoteServiceTrait>,
            _asset_service: Arc<dyn AssetServiceTrait>,
            _taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
            _valuation_service: Arc<dyn ValuationServiceTrait>,
            _configured_timezone: Option<&str>,
            _client_timezone: Option<&str>,
        ) -> CoreResult<HealthStatus> {
            Ok(HealthStatus::healthy())
        }

        async fn get_cached_status(&self) -> Option<HealthStatus> {
            self.cached_status.clone()
        }

        async fn dismiss_issue(&self, _issue_id: &str, _data_hash: &str) -> CoreResult<()> {
            Ok(())
        }

        async fn restore_issue(&self, _issue_id: &str) -> CoreResult<()> {
            Ok(())
        }

        async fn get_dismissed_ids(&self) -> CoreResult<Vec<String>> {
            Ok(Vec::new())
        }

        async fn execute_fix(&self, _action: &FixAction) -> CoreResult<()> {
            Ok(())
        }

        async fn clear_cache(&self) {}

        async fn get_config(&self) -> HealthConfig {
            HealthConfig::default()
        }

        async fn update_config(&self, _config: HealthConfig) -> CoreResult<()> {
            Ok(())
        }
    }
}
