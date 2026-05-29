use super::activities_model::*;
use crate::limits::ContributionActivity;
use crate::Result;
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};

/// Trait defining the contract for Activity repository operations.
#[async_trait]
pub trait ActivityRepositoryTrait: Send + Sync {
    fn get_activity(&self, activity_id: &str) -> Result<Activity>;
    fn get_activities(&self) -> Result<Vec<Activity>>;
    fn get_activities_by_ids(&self, activity_ids: &[String]) -> Result<Vec<Activity>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }

        let requested: HashSet<&str> = activity_ids.iter().map(String::as_str).collect();
        let mut activities = self.get_activities()?;
        activities.retain(|activity| requested.contains(activity.id.as_str()));
        Ok(activities)
    }
    fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>>;
    fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>>;
    fn get_activities_by_account_ids_in_date_range(
        &self,
        account_ids: &[String],
        start_utc: DateTime<Utc>,
        end_utc: DateTime<Utc>,
    ) -> Result<Vec<Activity>> {
        let mut activities = self.get_activities_by_account_ids(account_ids)?;
        activities.retain(|activity| {
            activity.activity_date >= start_utc && activity.activity_date <= end_utc
        });
        Ok(activities)
    }
    fn get_trading_activities(&self) -> Result<Vec<Activity>>;
    fn get_income_activities(&self) -> Result<Vec<Activity>>;
    /// Fetches contribution-eligible activities (DEPOSIT, TRANSFER_IN, TRANSFER_OUT, CREDIT)
    /// for the given accounts within the date range. Filtering logic applied in service layer.
    fn get_contribution_activities(
        &self,
        account_ids: &[String],
        start_utc: DateTime<Utc>,
        end_exclusive_utc: DateTime<Utc>,
    ) -> Result<Vec<ContributionActivity>>;
    #[allow(clippy::too_many_arguments)]
    fn search_activities(
        &self,
        page: i64,
        page_size: i64,
        account_id_filter: Option<Vec<String>>,
        activity_type_filter: Option<Vec<String>>,
        asset_id_keyword: Option<String>,
        sort: Option<Sort>,
        needs_review_filter: Option<bool>,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        instrument_type_filter: Option<Vec<String>>,
    ) -> Result<ActivitySearchResponse>;
    async fn create_activity(&self, new_activity: NewActivity) -> Result<Activity>;
    async fn update_activity(&self, activity_update: ActivityUpdate) -> Result<Activity>;
    async fn delete_activity(&self, activity_id: String) -> Result<Activity>;
    /// Pairs two existing transfer activities by writing a shared `source_group_id`
    /// and clearing `metadata.flow.is_external` on both. Order of `activity_a_id` /
    /// `activity_b_id` is irrelevant; the impl resolves which is IN vs OUT.
    async fn link_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)>;
    /// Unpairs two linked transfer activities by clearing their shared `source_group_id`
    /// and marking `metadata.flow.is_external` as true on both rows.
    async fn unlink_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)>;
    async fn bulk_mutate_activities(
        &self,
        creates: Vec<NewActivity>,
        updates: Vec<ActivityUpdate>,
        delete_ids: Vec<String>,
    ) -> Result<ActivityBulkMutationResult>;
    async fn create_activities(&self, activities: Vec<NewActivity>) -> Result<usize>;
    fn get_first_activity_date(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Option<DateTime<Utc>>>;
    fn get_import_mapping(
        &self,
        account_id: &str,
        context_kind: &str,
    ) -> Result<Option<ImportMapping>>;
    async fn save_import_mapping(&self, mapping: &ImportMapping) -> Result<()>;
    async fn link_account_template(
        &self,
        account_id: &str,
        template_id: &str,
        context_kind: &str,
    ) -> Result<()>;
    fn list_import_templates(&self) -> Result<Vec<ImportTemplate>>;
    fn get_import_template(&self, template_id: &str) -> Result<Option<ImportTemplate>>;
    async fn save_import_template(&self, template: &ImportTemplate) -> Result<()>;
    async fn delete_import_template(&self, template_id: &str) -> Result<()>;
    fn get_broker_sync_profile(
        &self,
        account_id: &str,
        source_system: &str,
    ) -> Result<Option<ImportTemplate>>;
    async fn save_broker_sync_profile(&self, template: &ImportTemplate) -> Result<()>;
    async fn link_broker_sync_profile(
        &self,
        account_id: &str,
        template_id: &str,
        source_system: &str,
    ) -> Result<()>;
    // Add other repository methods if necessary, e.g., calculate_average_cost, get_deposit_activities
    fn calculate_average_cost(&self, account_id: &str, asset_id: &str) -> Result<Decimal>;
    fn get_income_activities_data(&self, account_ids: Option<&[String]>)
        -> Result<Vec<IncomeData>>;
    fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>>;

    /// Gets the first and last activity dates for each asset in the provided list.
    ///
    /// This is useful for sync planning to determine the date range needed for quotes.
    /// The implementation should chunk the query if asset_ids.len() exceeds SQLite parameter limits.
    ///
    /// # Returns
    ///
    /// A map from asset_id to a tuple of (first_activity_date, last_activity_date).
    /// Both dates may be None if no activities exist for the asset.
    #[allow(clippy::type_complexity)]
    fn get_activity_bounds_for_assets(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>;

    /// Gets the first and last non-archived holdings snapshot dates where each
    /// asset appears.
    ///
    /// Holdings-mode assets can have historical valuation exposure without any
    /// activity rows, so quote planning must include these bounds too.
    #[allow(clippy::type_complexity)]
    fn get_holdings_snapshot_bounds_for_assets(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>;

    /// Checks for existing activities with the given idempotency keys.
    ///
    /// Returns a map of {idempotency_key: existing_activity_id} for keys that already exist.
    fn check_existing_duplicates(
        &self,
        idempotency_keys: &[String],
    ) -> Result<HashMap<String, String>>;

    /// Upserts multiple activities (insert or update on conflict by ID or idempotency_key).
    /// Respects is_user_modified flag - skips updates to user-modified activities.
    ///
    /// Returns statistics about the operation.
    async fn bulk_upsert(
        &self,
        activities: Vec<super::ActivityUpsert>,
    ) -> Result<super::BulkUpsertResult>;

    /// Reassigns all activities from one asset to another.
    /// Used when merging UNKNOWN assets into resolved ones.
    /// Returns the number of activities updated.
    async fn reassign_asset(&self, old_asset_id: &str, new_asset_id: &str) -> Result<u32>;

    /// Returns distinct account_ids and currencies for activities with the given asset_id.
    /// Used to plan recalculations after asset merges.
    async fn get_activity_accounts_and_currencies_by_asset_id(
        &self,
        asset_id: &str,
    ) -> Result<(Vec<String>, Vec<String>)>;
}

/// Trait defining the contract for Activity service operations.
#[async_trait]
pub trait ActivityServiceTrait: Send + Sync {
    fn get_activity(&self, activity_id: &str) -> Result<Activity>;
    fn get_activities(&self) -> Result<Vec<Activity>>;
    fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>>;
    fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>>;
    fn get_trading_activities(&self) -> Result<Vec<Activity>>;
    fn get_income_activities(&self) -> Result<Vec<Activity>>;
    #[allow(clippy::too_many_arguments)]
    fn search_activities(
        &self,
        page: i64,
        page_size: i64,
        account_id_filter: Option<Vec<String>>,
        activity_type_filter: Option<Vec<String>>,
        asset_id_keyword: Option<String>,
        sort: Option<Sort>,
        needs_review_filter: Option<bool>,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        instrument_type_filter: Option<Vec<String>>,
    ) -> Result<ActivitySearchResponse>;
    fn get_first_activity_date(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Option<DateTime<Utc>>>;
    fn get_import_mapping(
        &self,
        account_id: String,
        context_kind: String,
    ) -> Result<ImportMappingData>;
    fn list_import_templates(&self) -> Result<Vec<ImportTemplateData>>;
    fn get_import_template(&self, template_id: String) -> Result<ImportTemplateData>;
    async fn create_activity(&self, activity: NewActivity) -> Result<Activity>;
    async fn update_activity(&self, activity: ActivityUpdate) -> Result<Activity>;
    async fn delete_activity(&self, activity_id: String) -> Result<Activity>;
    async fn link_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)>;
    async fn unlink_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)>;
    async fn bulk_mutate_activities(
        &self,
        request: ActivityBulkMutationRequest,
    ) -> Result<ActivityBulkMutationResult>;
    async fn check_activities_import(
        &self,
        activities: Vec<ActivityImport>,
    ) -> Result<Vec<ActivityImport>>;
    async fn preview_import_assets(
        &self,
        candidates: Vec<ImportAssetCandidate>,
    ) -> Result<Vec<ImportAssetPreviewItem>>;
    async fn import_activities(
        &self,
        activities: Vec<ActivityImport>,
    ) -> Result<ImportActivitiesResult>;
    async fn link_account_template(
        &self,
        account_id: String,
        template_id: String,
        context_kind: String,
    ) -> Result<()>;
    async fn save_import_mapping(
        &self,
        mapping_data: ImportMappingData,
    ) -> Result<ImportMappingData>;
    async fn save_import_template(
        &self,
        template_data: ImportTemplateData,
    ) -> Result<ImportTemplateData>;
    async fn delete_import_template(&self, template_id: String) -> Result<()>;

    /// Checks for existing activities with the given idempotency keys.
    ///
    /// Returns a map of {idempotency_key: existing_activity_id} for keys that already exist.
    fn check_existing_duplicates(
        &self,
        idempotency_keys: Vec<String>,
    ) -> Result<HashMap<String, String>>;

    /// Parses CSV content with the given configuration.
    fn parse_csv(
        &self,
        content: &[u8],
        config: &super::csv_parser::ParseConfig,
    ) -> Result<super::csv_parser::ParsedCsvResult>;

    /// Upserts multiple activities (insert or update on conflict).
    /// Used by broker sync to efficiently sync activities.
    /// Emits a single aggregated ActivitiesChanged event for all upserted activities.
    async fn upsert_activities_bulk(
        &self,
        activities: Vec<super::ActivityUpsert>,
    ) -> Result<super::BulkUpsertResult>;

    /// Prepares activities for normal save/create flows.
    /// Uses only payload metadata (no live symbol/provider resolution).
    ///
    /// Steps:
    /// 1. Build canonical asset specs from payload data
    /// 2. Compute canonical asset IDs
    /// 3. Ensure all assets exist (batch)
    /// 4. Register FX pairs (batch)
    /// 5. Validate each activity
    ///
    async fn prepare_activities_for_save(
        &self,
        activities: Vec<NewActivity>,
        account: &crate::accounts::Account,
    ) -> Result<PrepareActivitiesResult>;

    /// Prepares activities for import apply flows.
    /// Uses only pre-validated payload metadata (no live resolution).
    async fn prepare_activities_for_import(
        &self,
        activities: Vec<NewActivity>,
        account: &crate::accounts::Account,
    ) -> Result<PrepareActivitiesResult>;

    /// Prepares activities for automated broker sync.
    /// Live symbol/provider resolution is allowed because no user review step exists.
    async fn prepare_activities_for_sync(
        &self,
        activities: Vec<NewActivity>,
        account: &crate::accounts::Account,
    ) -> Result<PrepareActivitiesResult>;

    fn get_broker_sync_profile(
        &self,
        account_id: String,
        source_system: String,
    ) -> Result<BrokerSyncProfileData>;
    async fn save_broker_sync_profile_rules(
        &self,
        request: SaveBrokerSyncProfileRulesRequest,
    ) -> Result<BrokerSyncProfileData>;
}
