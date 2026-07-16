//! Test/eval-only mock implementations of the AiEnvironment trait and
//! every service it returns. Gated behind the `test-utils` feature so the
//! eval binary (`cargo run --bin eval --features eval`) can construct one.

use super::*;
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use wealthfolio_core::{
    accounts::TrackingMode,
    accounts::{Account, AccountServiceTrait, AccountUpdate, NewAccount},
    activities::{
        Activity, ActivityBulkMutationRequest, ActivityBulkMutationResult, ActivityDetails,
        ActivityImport, ActivitySearchResponse, ActivitySearchResponseMeta, ActivityServiceTrait,
        ActivityUpdate, BrokerSyncProfileData, ImportAssetCandidate, ImportAssetPreviewItem,
        ImportMappingData, ImportTemplateData, ImportTemplateScope, InternalTransferPairRequest,
        InternalTransferPairResponse, NewActivity, SaveBrokerSyncProfileRulesRequest, Sort,
        TransferMatchCandidate, TransferMatchCandidateRequest,
    },
    assets::{
        Asset, AssetMetadata, AssetResolutionInput, AssetResolutionOutput, AssetServiceTrait,
        AssetSpec, EnsureAssetsResult, NewAsset, ProviderProfile, UpdateAssetProfile,
    },
    errors::DatabaseError,
    goals::{
        AccountValuationMap, Goal, GoalFundingRule, GoalFundingRuleInput, GoalPlan,
        GoalServiceTrait, NewGoal, PreparedRetirementSimulationInput, SaveGoalPlan,
    },
    health::{
        checks::{
            AssetHoldingInfo, ConsistencyIssueInfo, FxPairInfo, InvalidTransferGroupInfo,
            LegacyMigrationInfo, QuoteSyncErrorInfo, UnclassifiedAssetInfo,
            UnconfiguredAccountInfo,
        },
        FixAction, HealthConfig, HealthServiceTrait, HealthStatus,
    },
    holdings::{Holding, HoldingsServiceTrait},
    planning::SaveUpOverview,
    portfolio::allocation::{
        AllocationHoldings, AllocationServiceTrait, PortfolioAllocations,
        TaxonomyHoldingContributions,
    },
    portfolio::economic_events::BasisStatus,
    portfolio::fire::RetirementOverview,
    portfolio::income::{IncomeServiceTrait, IncomeSummary},
    portfolio::performance::{
        DataQualityStatus, PerformanceAttribution, PerformanceDataQuality, PerformancePeriod,
        PerformanceResult, PerformanceReturns, PerformanceRisk, PerformanceScopeDescriptor,
        PerformanceServiceTrait, PerformanceSummary, PerformanceSummaryProfile, ReturnMethod,
    },
    quotes::{
        LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote, QuoteImport, QuoteServiceTrait,
        QuoteSyncState, SymbolSearchResult, SymbolSyncPlan, SyncMode, SyncResult,
    },
    secrets::SecretStore,
    settings::{Settings, SettingsServiceTrait, SettingsUpdate},
    taxonomies::{
        AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
        Taxonomy, TaxonomyServiceTrait, TaxonomyWithCategories,
    },
    valuation::{
        DailyAccountValuation, NegativeBalanceInfo, ValuationRecalcMode, ValuationServiceTrait,
    },
    Error as CoreError, Result as CoreResult,
};
use wealthfolio_spending::cash_activities::CashActivityServiceTrait;
use wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait;

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
            .ok_or_else(|| CoreError::Database(DatabaseError::NotFound(format!("Account {}", id))))
    }

    fn list_accounts(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> CoreResult<Vec<Account>> {
        Ok(self
            .accounts
            .iter()
            .filter(|account| {
                is_active_filter.is_none_or(|is_active| account.is_active == is_active)
            })
            .filter(|account| {
                is_archived_filter.is_none_or(|is_archived| account.is_archived == is_archived)
            })
            .filter(|account| account_ids.is_none_or(|ids| ids.iter().any(|id| id == &account.id)))
            .cloned()
            .collect())
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
        self.list_accounts(None, Some(false), None)
    }

    fn get_active_non_archived_accounts(&self) -> CoreResult<Vec<Account>> {
        self.list_accounts(Some(true), Some(false), None)
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

/// Mock asset service for testing.
#[derive(Default)]
pub struct MockAssetService {
    pub assets: Vec<Asset>,
}

#[async_trait]
impl AssetServiceTrait for MockAssetService {
    fn get_assets(&self) -> CoreResult<Vec<Asset>> {
        Ok(self.assets.clone())
    }

    fn get_asset_by_id(&self, asset_id: &str) -> CoreResult<Asset> {
        self.assets
            .iter()
            .find(|asset| asset.id == asset_id)
            .cloned()
            .ok_or_else(|| CoreError::Database(DatabaseError::NotFound(asset_id.to_string())))
    }

    async fn delete_asset(&self, _asset_id: &str) -> CoreResult<()> {
        unimplemented!("MockAssetService::delete_asset")
    }

    async fn update_asset_profile(
        &self,
        _asset_id: &str,
        _payload: UpdateAssetProfile,
    ) -> CoreResult<Asset> {
        unimplemented!("MockAssetService::update_asset_profile")
    }

    async fn create_asset(&self, _new_asset: NewAsset) -> CoreResult<Asset> {
        unimplemented!("MockAssetService::create_asset")
    }

    async fn get_or_create_minimal_asset(
        &self,
        _asset_id: &str,
        _context_currency: Option<String>,
        _metadata: Option<AssetMetadata>,
        _quote_mode: Option<String>,
    ) -> CoreResult<Asset> {
        unimplemented!("MockAssetService::get_or_create_minimal_asset")
    }

    async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> CoreResult<Asset> {
        unimplemented!("MockAssetService::update_quote_mode")
    }

    async fn get_assets_by_asset_ids(&self, asset_ids: &[String]) -> CoreResult<Vec<Asset>> {
        Ok(self
            .assets
            .iter()
            .filter(|asset| asset_ids.iter().any(|id| id == &asset.id))
            .cloned()
            .collect())
    }

    async fn enrich_asset_profile(&self, _asset_id: &str) -> CoreResult<Asset> {
        unimplemented!("MockAssetService::enrich_asset_profile")
    }

    async fn enrich_assets(&self, _asset_ids: Vec<String>) -> CoreResult<(usize, usize, usize)> {
        unimplemented!("MockAssetService::enrich_assets")
    }

    async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> CoreResult<()> {
        unimplemented!("MockAssetService::cleanup_legacy_metadata")
    }

    async fn merge_unknown_asset(
        &self,
        _resolved_asset_id: &str,
        _unknown_asset_id: &str,
        _activity_repository: &dyn wealthfolio_core::activities::ActivityRepositoryTrait,
    ) -> CoreResult<u32> {
        unimplemented!("MockAssetService::merge_unknown_asset")
    }

    async fn ensure_assets(
        &self,
        _specs: Vec<AssetSpec>,
        _activity_repository: &dyn wealthfolio_core::activities::ActivityRepositoryTrait,
    ) -> CoreResult<EnsureAssetsResult> {
        unimplemented!("MockAssetService::ensure_assets")
    }

    async fn resolve_import_asset_inputs(
        &self,
        _inputs: Vec<AssetResolutionInput>,
    ) -> CoreResult<Vec<AssetResolutionOutput>> {
        unimplemented!("MockAssetService::resolve_import_asset_inputs")
    }
}

/// Mock taxonomy service for testing.
#[derive(Default)]
pub struct MockTaxonomyService {
    pub taxonomies: Vec<TaxonomyWithCategories>,
    pub assignments: Vec<AssetTaxonomyAssignment>,
}

#[async_trait]
impl TaxonomyServiceTrait for MockTaxonomyService {
    fn get_taxonomies(&self) -> CoreResult<Vec<Taxonomy>> {
        Ok(self
            .taxonomies
            .iter()
            .map(|entry| entry.taxonomy.clone())
            .collect())
    }

    fn get_taxonomy(&self, id: &str) -> CoreResult<Option<TaxonomyWithCategories>> {
        Ok(self
            .taxonomies
            .iter()
            .find(|entry| entry.taxonomy.id == id)
            .cloned())
    }

    fn get_taxonomies_with_categories(&self) -> CoreResult<Vec<TaxonomyWithCategories>> {
        Ok(self.taxonomies.clone())
    }

    async fn create_taxonomy(&self, _taxonomy: NewTaxonomy) -> CoreResult<Taxonomy> {
        unimplemented!("MockTaxonomyService::create_taxonomy")
    }

    async fn update_taxonomy(&self, _taxonomy: Taxonomy) -> CoreResult<Taxonomy> {
        unimplemented!("MockTaxonomyService::update_taxonomy")
    }

    async fn delete_taxonomy(&self, _id: &str) -> CoreResult<usize> {
        unimplemented!("MockTaxonomyService::delete_taxonomy")
    }

    async fn create_category(&self, _category: NewCategory) -> CoreResult<Category> {
        unimplemented!("MockTaxonomyService::create_category")
    }

    async fn update_category(&self, _category: Category) -> CoreResult<Category> {
        unimplemented!("MockTaxonomyService::update_category")
    }

    async fn delete_category(&self, _taxonomy_id: &str, _category_id: &str) -> CoreResult<usize> {
        unimplemented!("MockTaxonomyService::delete_category")
    }

    async fn move_category(
        &self,
        _taxonomy_id: &str,
        _category_id: &str,
        _new_parent_id: Option<String>,
        _position: i32,
    ) -> CoreResult<Category> {
        unimplemented!("MockTaxonomyService::move_category")
    }

    async fn import_taxonomy_json(&self, _json_str: &str) -> CoreResult<Taxonomy> {
        unimplemented!("MockTaxonomyService::import_taxonomy_json")
    }

    fn export_taxonomy_json(&self, _id: &str) -> CoreResult<String> {
        unimplemented!("MockTaxonomyService::export_taxonomy_json")
    }

    fn get_asset_assignments(&self, asset_id: &str) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
        Ok(self
            .assignments
            .iter()
            .filter(|assignment| assignment.asset_id == asset_id)
            .cloned()
            .collect())
    }

    fn get_category_assignments(
        &self,
        taxonomy_id: &str,
        category_id: &str,
    ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
        Ok(self
            .assignments
            .iter()
            .filter(|assignment| {
                assignment.taxonomy_id == taxonomy_id && assignment.category_id == category_id
            })
            .cloned()
            .collect())
    }

    async fn assign_asset_to_category(
        &self,
        _assignment: NewAssetTaxonomyAssignment,
    ) -> CoreResult<AssetTaxonomyAssignment> {
        unimplemented!("MockTaxonomyService::assign_asset_to_category")
    }

    async fn replace_asset_taxonomy_assignments(
        &self,
        _asset_id: &str,
        _taxonomy_id: &str,
        _assignments: Vec<NewAssetTaxonomyAssignment>,
    ) -> CoreResult<Vec<AssetTaxonomyAssignment>> {
        unimplemented!("MockTaxonomyService::replace_asset_taxonomy_assignments")
    }

    async fn remove_asset_assignment(&self, _id: &str) -> CoreResult<usize> {
        unimplemented!("MockTaxonomyService::remove_asset_assignment")
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

    fn get_activities_by_account_ids(&self, _account_ids: &[String]) -> CoreResult<Vec<Activity>> {
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
        _activity_id_filter: Option<Vec<String>>,
    ) -> CoreResult<ActivitySearchResponse> {
        Ok(ActivitySearchResponse {
            data: self.activities.clone(),
            meta: ActivitySearchResponseMeta {
                total_row_count: self.activities.len() as i64,
            },
        })
    }

    fn find_transfer_match_candidates(
        &self,
        _request: TransferMatchCandidateRequest,
    ) -> CoreResult<Vec<TransferMatchCandidate>> {
        Ok(Vec::new())
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

    fn get_transfer_pair_for_activity(
        &self,
        _activity_id: String,
    ) -> CoreResult<InternalTransferPairResponse> {
        unimplemented!("MockActivityService::get_transfer_pair_for_activity")
    }

    async fn save_internal_transfer_pair(
        &self,
        _request: InternalTransferPairRequest,
    ) -> CoreResult<InternalTransferPairResponse> {
        unimplemented!("MockActivityService::save_internal_transfer_pair")
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

    fn get_historical_valuations_for_accounts(
        &self,
        _scope_id: &str,
        _account_ids: &[String],
        _base_currency: &str,
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
            "MockGoalService::prepare_retirement_simulation_input is not implemented".to_string(),
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

    fn get_all_historical_quotes(&self) -> CoreResult<HashMap<String, Vec<(NaiveDate, Quote)>>> {
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

    async fn get_holding_contributions_for_taxonomy_for_accounts(
        &self,
        _account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
        _aggregated_account_id: &str,
    ) -> CoreResult<TaxonomyHoldingContributions> {
        Ok(TaxonomyHoldingContributions {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name: "Mock Taxonomy".to_string(),
            total_value: rust_decimal::Decimal::ZERO,
            currency: base_currency.to_string(),
            contributions: Vec::new(),
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
            IncomeSummary::new("ALL", "USD".to_string()),
            IncomeSummary::new("YTD", "USD".to_string()),
            IncomeSummary::new("LAST_YEAR", "USD".to_string()),
        ])
    }
}

/// Mock performance service for testing.
#[derive(Default)]
pub struct MockPerformanceService;

fn mock_performance_result(id: &str) -> PerformanceResult {
    PerformanceResult {
        scope: PerformanceScopeDescriptor {
            id: id.to_string(),
            currency: "USD".to_string(),
        },
        period: PerformancePeriod {
            start_date: None,
            end_date: None,
        },
        mode: ReturnMethod::NotApplicable,
        returns: PerformanceReturns {
            twr: Some(rust_decimal::Decimal::ZERO),
            annualized_twr: Some(rust_decimal::Decimal::ZERO),
            irr: Some(rust_decimal::Decimal::ZERO),
            annualized_irr: Some(rust_decimal::Decimal::ZERO),
            value_return: Some(rust_decimal::Decimal::ZERO),
            annualized_value_return: Some(rust_decimal::Decimal::ZERO),
        },
        attribution: PerformanceAttribution::default(),
        risk: PerformanceRisk {
            volatility: Some(rust_decimal::Decimal::ZERO),
            max_drawdown: Some(rust_decimal::Decimal::ZERO),
            peak_date: None,
            trough_date: None,
            recovery_date: None,
            drawdown_duration_days: None,
        },
        data_quality: PerformanceDataQuality {
            status: DataQualityStatus::Ok,
            warnings: Vec::new(),
            not_applicable_reasons: Vec::new(),
        },
        basis_status: BasisStatus::NotApplicable,
        summary: PerformanceSummary::default(),
        series: Vec::new(),
        is_holdings_mode: false,
        is_mixed_tracking_mode: false,
    }
}

#[async_trait]
impl PerformanceServiceTrait for MockPerformanceService {
    async fn calculate_performance_history(
        &self,
        _item_type: &str,
        item_id: &str,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
        _tracking_mode: Option<TrackingMode>,
        _account_type: Option<&str>,
    ) -> CoreResult<PerformanceResult> {
        Ok(mock_performance_result(item_id))
    }

    async fn calculate_performance_history_for_accounts(
        &self,
        scope_id: &str,
        _account_ids: &[String],
        _base_currency: &str,
        _account_tracking_modes: &std::collections::HashMap<String, TrackingMode>,
        _account_types: &std::collections::HashMap<String, String>,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
    ) -> CoreResult<PerformanceResult> {
        self.calculate_performance_history("account", scope_id, None, None, None, None)
            .await
    }

    async fn calculate_performance_summary(
        &self,
        _item_type: &str,
        item_id: &str,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
        _tracking_mode: Option<TrackingMode>,
        _account_type: Option<&str>,
        _profile: PerformanceSummaryProfile,
    ) -> CoreResult<PerformanceResult> {
        Ok(mock_performance_result(item_id))
    }

    async fn calculate_performance_summary_for_accounts(
        &self,
        scope_id: &str,
        _account_ids: &[String],
        _base_currency: &str,
        _account_tracking_modes: &std::collections::HashMap<String, TrackingMode>,
        _account_types: &std::collections::HashMap<String, String>,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
        _profile: PerformanceSummaryProfile,
    ) -> CoreResult<PerformanceResult> {
        self.calculate_performance_summary(
            "account",
            scope_id,
            None,
            None,
            None,
            None,
            PerformanceSummaryProfile::Full,
        )
        .await
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
    pub asset_service: Arc<dyn AssetServiceTrait>,
    pub allocation_service: Arc<dyn AllocationServiceTrait>,
    pub performance_service: Arc<dyn PerformanceServiceTrait>,
    pub income_service: Arc<dyn IncomeServiceTrait>,
    pub health_service: Arc<dyn HealthServiceTrait>,
    pub taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    pub cash_activity_service: Arc<dyn CashActivityServiceTrait>,
    pub categorization_rules_service: Arc<dyn CategorizationRulesServiceTrait>,
}

/// Mock cash-activity service for testing. Seed `items` to control both
/// `search` results and `get_by_activity_ids` lookups.
#[derive(Default)]
pub struct MockCashActivityService {
    pub items: Vec<wealthfolio_spending::cash_activities::CashActivity>,
}

#[async_trait]
impl CashActivityServiceTrait for MockCashActivityService {
    async fn search(
        &self,
        req: wealthfolio_spending::cash_activities::CashActivitySearchRequest,
    ) -> anyhow::Result<wealthfolio_spending::cash_activities::CashActivitySearchResponse> {
        let items: Vec<_> = self.items.iter().take(req.limit).cloned().collect();
        let total_count = items.len();
        Ok(
            wealthfolio_spending::cash_activities::CashActivitySearchResponse {
                items,
                total_count,
            },
        )
    }

    async fn get_by_activity_ids(
        &self,
        activity_ids: &[String],
    ) -> anyhow::Result<Vec<wealthfolio_spending::cash_activities::CashActivity>> {
        Ok(self
            .items
            .iter()
            .filter(|item| activity_ids.contains(&item.activity.id))
            .cloned()
            .collect())
    }
}

/// Mock categorization-rules service for testing.
#[derive(Default)]
pub struct MockCategorizationRulesService {
    pub rules: Vec<wealthfolio_spending::categorization_rules::CategorizationRule>,
}

#[async_trait]
impl CategorizationRulesServiceTrait for MockCategorizationRulesService {
    async fn list(
        &self,
    ) -> anyhow::Result<Vec<wealthfolio_spending::categorization_rules::CategorizationRule>> {
        Ok(self.rules.clone())
    }
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
            asset_service: Arc::new(MockAssetService::default()),
            allocation_service: Arc::new(MockAllocationService),
            performance_service: Arc::new(MockPerformanceService),
            income_service: Arc::new(MockIncomeService),
            health_service: Arc::new(MockHealthService::default()),
            taxonomy_service: Arc::new(MockTaxonomyService::default()),
            cash_activity_service: Arc::new(MockCashActivityService::default()),
            categorization_rules_service: Arc::new(MockCategorizationRulesService::default()),
        }
    }

    pub fn with_secret(self, key: &str, value: &str) -> Self {
        self.secret_store.set_secret(key, value).unwrap();
        self
    }
}

impl AgentEnvironment for MockEnvironment {
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

    fn quote_service(&self) -> Arc<dyn QuoteServiceTrait> {
        self.quote_service.clone()
    }

    fn asset_service(&self) -> Arc<dyn AssetServiceTrait> {
        self.asset_service.clone()
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

    fn taxonomy_service(&self) -> Arc<dyn TaxonomyServiceTrait> {
        self.taxonomy_service.clone()
    }

    fn portfolio_service(&self) -> Arc<dyn wealthfolio_core::portfolios::PortfolioServiceTrait> {
        unimplemented!("portfolio_service not used in AI mock environment")
    }

    fn net_worth_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::portfolio::net_worth::NetWorthServiceTrait> {
        unimplemented!("net_worth_service not used in AI mock environment")
    }

    fn contribution_limit_service(
        &self,
    ) -> Arc<dyn wealthfolio_core::limits::ContributionLimitServiceTrait> {
        unimplemented!("contribution_limit_service not used in AI mock environment")
    }

    fn cash_activity_service(&self) -> Arc<dyn CashActivityServiceTrait> {
        self.cash_activity_service.clone()
    }

    fn categorization_rules_service(&self) -> Arc<dyn CategorizationRulesServiceTrait> {
        self.categorization_rules_service.clone()
    }
}

impl AiEnvironment for MockEnvironment {
    fn secret_store(&self) -> Arc<dyn SecretStore> {
        self.secret_store.clone()
    }

    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait> {
        self.chat_repository.clone()
    }

    fn activity_taxonomy_assignment_service(
        &self,
    ) -> Arc<wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentService> {
        unimplemented!("activity_taxonomy_assignment_service not used in AI mock environment")
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
        _invalid_transfer_groups: &[InvalidTransferGroupInfo],
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
        _snapshot_service: Arc<dyn wealthfolio_core::portfolio::snapshot::SnapshotServiceTrait>,
        _activity_service: Arc<dyn ActivityServiceTrait>,
        _lot_repository: Arc<dyn wealthfolio_core::lots::LotRepositoryTrait>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, is_active: bool, is_archived: bool) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_string(),
            is_active,
            is_archived,
            ..Account::default()
        }
    }

    #[test]
    fn mock_account_service_filters_active_non_archived_accounts() {
        let service = MockAccountService {
            accounts: vec![
                account("visible", true, false),
                account("archived", true, true),
                account("hidden", false, false),
            ],
        };

        let ids: Vec<String> = service
            .get_active_non_archived_accounts()
            .expect("accounts")
            .into_iter()
            .map(|account| account.id)
            .collect();

        assert_eq!(ids, vec!["visible"]);
    }
}
