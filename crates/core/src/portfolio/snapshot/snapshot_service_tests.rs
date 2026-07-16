#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::{DateTime, NaiveDate, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::sync::{Arc, RwLock};

    use crate::accounts::{
        Account, AccountAccountingSettings, AccountRepositoryTrait, AccountUpdate, CostBasisMethod,
        NewAccount,
    };
    use crate::activities::{
        Activity, ActivityRepositoryTrait, ActivitySearchResponse, ActivityStatus, ActivityUpdate,
        ImportMapping as ActivityImportMapping, IncomeData as ActivityIncomeData, NewActivity,
        Sort as ActivitySort,
    };
    use crate::assets::{
        Asset, AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode, UpdateAssetProfile,
    };
    use crate::constants::DECIMAL_PRECISION;
    use crate::errors::{Error, Result as AppResult};
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::lots::{AssetLotView, LotClosure, LotDisposal, LotRecord, LotRepositoryTrait};
    use crate::portfolio::snapshot::{
        AccountStateSnapshot, Position, SnapshotRecalcMode, SnapshotRepositoryTrait,
        SnapshotService, SnapshotServiceTrait,
    };
    use crate::utils::time_utils::valuation_date_today;

    #[derive(Clone, Debug)]
    struct MockFxService {
        rates: HashMap<(String, String, NaiveDate), Decimal>,
    }

    impl MockFxService {
        fn new() -> Self {
            Self {
                rates: HashMap::new(),
            }
        }
        fn add_bidirectional_rate(&mut self, from: &str, to: &str, date: NaiveDate, rate: Decimal) {
            self.rates
                .insert((from.to_string(), to.to_string(), date), rate);
            if rate != Decimal::ZERO {
                self.rates
                    .insert((to.to_string(), from.to_string(), date), dec!(1) / rate);
            }
        }
    }

    #[async_trait]
    impl FxServiceTrait for MockFxService {
        fn initialize(&self) -> AppResult<()> {
            Ok(())
        }
        async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> AppResult<ExchangeRate> {
            unimplemented!()
        }
        fn get_historical_rates(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _days: i64,
        ) -> AppResult<Vec<ExchangeRate>> {
            unimplemented!()
        }
        async fn update_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _rate: Decimal,
        ) -> AppResult<ExchangeRate> {
            unimplemented!()
        }
        fn get_latest_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> AppResult<Decimal> {
            unimplemented!()
        }
        fn get_exchange_rate_for_date(
            &self,
            from_currency: &str,
            to_currency: &str,
            date: NaiveDate,
        ) -> AppResult<Decimal> {
            if from_currency == to_currency {
                return Ok(Decimal::ONE);
            }
            self.rates
                .get(&(from_currency.to_string(), to_currency.to_string(), date))
                .copied()
                .ok_or_else(|| {
                    Error::Fx(crate::fx::FxError::RateNotFound(format!(
                        "Rate not found for {}->{} on {}",
                        from_currency, to_currency, date
                    )))
                })
        }
        fn convert_currency(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
        ) -> AppResult<Decimal> {
            if from_currency == to_currency {
                return Ok(amount);
            }
            let rate = self.get_latest_exchange_rate(from_currency, to_currency)?;
            Ok(amount * rate)
        }
        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
            date: NaiveDate,
        ) -> AppResult<Decimal> {
            if from_currency == to_currency {
                return Ok(amount);
            }
            let rate = self.get_exchange_rate_for_date(from_currency, to_currency, date)?;
            Ok(amount * rate)
        }
        fn get_latest_exchange_rates(&self) -> AppResult<Vec<ExchangeRate>> {
            unimplemented!()
        }
        async fn delete_exchange_rate(&self, _rate_id: &str) -> AppResult<()> {
            unimplemented!()
        }
        async fn register_currency_pair(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> AppResult<()> {
            Ok(())
        }
        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> AppResult<()> {
            Ok(())
        }

        async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> AppResult<()> {
            Ok(())
        }
    }

    #[derive(Clone, Debug)]
    struct MockAssetRepository {
        assets: HashMap<String, Asset>,
    }

    impl MockAssetRepository {
        fn new() -> Self {
            let mut assets = HashMap::new();

            // Add predefined test assets with their listing currencies
            assets.insert(
                "AAPL".to_string(),
                Asset {
                    id: "AAPL".to_string(),
                    kind: AssetKind::Investment,
                    name: Some("Apple Inc.".to_string()),
                    display_code: Some("AAPL".to_string()),
                    quote_ccy: "USD".to_string(), // USD listing
                    quote_mode: QuoteMode::Market,
                    created_at: chrono::Utc::now().naive_utc(),
                    updated_at: chrono::Utc::now().naive_utc(),
                    ..Default::default()
                },
            );

            assets.insert(
                "SHOP".to_string(),
                Asset {
                    id: "SHOP".to_string(),
                    kind: AssetKind::Investment,
                    name: Some("Shopify Inc.".to_string()),
                    display_code: Some("SHOP".to_string()),
                    quote_ccy: "CAD".to_string(), // CAD listing
                    quote_mode: QuoteMode::Market,
                    created_at: chrono::Utc::now().naive_utc(),
                    updated_at: chrono::Utc::now().naive_utc(),
                    ..Default::default()
                },
            );

            Self { assets }
        }
    }

    #[async_trait]
    impl AssetRepositoryTrait for MockAssetRepository {
        async fn create(&self, _new_asset: NewAsset) -> AppResult<Asset> {
            unimplemented!("create not implemented for MockAssetRepository")
        }

        async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> AppResult<Vec<Asset>> {
            unimplemented!("create_batch not implemented for MockAssetRepository")
        }

        async fn update_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> AppResult<Asset> {
            unimplemented!("update_profile not implemented for MockAssetRepository")
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> AppResult<Asset> {
            unimplemented!("update_quote_mode not implemented for MockAssetRepository")
        }

        fn find_by_instrument_key(&self, _instrument_key: &str) -> AppResult<Option<Asset>> {
            Ok(None)
        }

        async fn delete(&self, _asset_id: &str) -> AppResult<()> {
            Ok(())
        }

        fn get_by_id(&self, asset_id: &str) -> AppResult<Asset> {
            self.assets
                .get(asset_id)
                .cloned()
                .ok_or_else(|| Error::Asset(format!("Asset not found: {}", asset_id)))
        }

        fn list(&self) -> AppResult<Vec<Asset>> {
            Ok(self.assets.values().cloned().collect())
        }

        fn list_by_asset_ids(&self, asset_ids: &[String]) -> AppResult<Vec<Asset>> {
            Ok(self
                .assets
                .values()
                .filter(|asset| asset_ids.contains(&asset.id))
                .cloned()
                .collect())
        }

        fn search_by_symbol(&self, _query: &str) -> AppResult<Vec<Asset>> {
            Ok(Vec::new())
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> AppResult<()> {
            Ok(())
        }

        async fn deactivate(&self, _asset_id: &str) -> AppResult<()> {
            Ok(())
        }

        async fn reactivate(&self, _asset_id: &str) -> AppResult<()> {
            Ok(())
        }

        async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> AppResult<()> {
            Ok(())
        }

        async fn deactivate_orphaned_investments(&self) -> AppResult<Vec<String>> {
            Ok(vec![])
        }
    }

    #[derive(Clone, Debug)]
    struct MockAccountRepository {
        accounts: Arc<RwLock<HashMap<String, Account>>>,
        accounting_settings: Arc<RwLock<HashMap<String, AccountAccountingSettings>>>,
    }
    impl MockAccountRepository {
        fn new() -> Self {
            Self {
                accounts: Arc::new(RwLock::new(HashMap::new())),
                accounting_settings: Arc::new(RwLock::new(HashMap::new())),
            }
        }
        #[allow(dead_code)]
        fn add_account(&mut self, account: Account) {
            self.accounts
                .write()
                .unwrap()
                .insert(account.id.clone(), account);
        }

        fn set_accounting_settings(&mut self, settings: AccountAccountingSettings) {
            self.accounting_settings
                .write()
                .unwrap()
                .insert(settings.account_id.clone(), settings);
        }
    }
    #[async_trait]
    impl AccountRepositoryTrait for MockAccountRepository {
        fn get_by_id(&self, id: &str) -> AppResult<Account> {
            self.accounts
                .read()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or(Error::Repository(format!("Account {} not found", id)))
        }
        fn list(
            &self,
            active_only: Option<bool>,
            is_archived_filter: Option<bool>,
            account_ids: Option<&[String]>,
        ) -> AppResult<Vec<Account>> {
            let mut filtered_accounts: Vec<Account> = self
                .accounts
                .read()
                .unwrap()
                .values()
                .filter(|a| active_only.is_none_or(|active| a.is_active == active))
                .filter(|a| is_archived_filter.is_none_or(|archived| a.is_archived == archived))
                .cloned()
                .collect();

            if let Some(ids_filter) = account_ids {
                filtered_accounts.retain(|acc| ids_filter.contains(&acc.id));
            }
            Ok(filtered_accounts)
        }
        fn get_accounting_settings_by_account_ids(
            &self,
            account_ids: &[String],
        ) -> AppResult<HashMap<String, AccountAccountingSettings>> {
            let explicit = self.accounting_settings.read().unwrap();
            Ok(account_ids
                .iter()
                .map(|account_id| {
                    (
                        account_id.clone(),
                        explicit.get(account_id).cloned().unwrap_or_else(|| {
                            AccountAccountingSettings::default_for_account(account_id.clone())
                        }),
                    )
                })
                .collect())
        }
        async fn update(&self, _account_update: AccountUpdate) -> AppResult<Account> {
            unimplemented!("MockAccountRepository::update")
        }
        async fn delete(&self, _id: &str) -> AppResult<usize> {
            unimplemented!("MockAccountRepository::delete");
        }
        async fn create(&self, _new_account: NewAccount) -> AppResult<Account> {
            unimplemented!("MockAccountRepository::create not suitable for simple mock")
        }
    }

    #[derive(Clone, Debug)]
    struct MockActivityRepository;
    impl MockActivityRepository {
        fn new() -> Self {
            Self
        }
    }
    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepository {
        fn get_activity(&self, _activity_id: &str) -> AppResult<Activity> {
            unimplemented!()
        }
        fn find_transfer_counterpart(
            &self,
            _group_id: &str,
            _exclude_id: &str,
        ) -> AppResult<Option<Activity>> {
            Ok(None)
        }
        fn get_activities(&self) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_id(&self, _account_id: &str) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_ids(
            &self,
            _account_ids: &[String],
        ) -> AppResult<Vec<Activity>> {
            Ok(Vec::new())
        }
        fn get_trading_activities(&self) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_contribution_activities(
            &self,
            _account_ids: &[String],
            _start_date: DateTime<Utc>,
            _end_date: DateTime<Utc>,
        ) -> AppResult<Vec<crate::limits::ContributionActivity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<ActivitySort>,
            _is_draft_filter: Option<bool>,
            _date_from: Option<NaiveDate>,
            _date_to: Option<NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
            _activity_id_filter: Option<Vec<String>>,
        ) -> AppResult<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _new_activity: NewActivity) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _activity_update: ActivityUpdate) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _activity_id: String) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> AppResult<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> AppResult<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _creates: Vec<NewActivity>,
            _updates: Vec<ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> AppResult<crate::activities::ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _activities: Vec<NewActivity>) -> AppResult<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(
            &self,
            _account_ids: Option<&[String]>,
        ) -> AppResult<Option<DateTime<Utc>>> {
            unimplemented!()
        }
        fn get_import_mapping(
            &self,
            _account_id: &str,
            _context_kind: &str,
        ) -> AppResult<Option<ActivityImportMapping>> {
            unimplemented!()
        }
        async fn save_import_mapping(&self, _mapping: &ActivityImportMapping) -> AppResult<()> {
            unimplemented!()
        }
        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> AppResult<()> {
            unimplemented!()
        }
        fn list_import_templates(&self) -> AppResult<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }
        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> AppResult<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> AppResult<()> {
            unimplemented!()
        }
        async fn delete_import_template(&self, _template_id: &str) -> AppResult<()> {
            unimplemented!()
        }
        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> AppResult<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> AppResult<()> {
            Ok(())
        }
        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> AppResult<()> {
            Ok(())
        }
        fn calculate_average_cost(&self, _account_id: &str, _asset_id: &str) -> AppResult<Decimal> {
            unimplemented!()
        }
        fn get_income_activities_data(
            &self,

            _account_ids: Option<&[String]>,
        ) -> AppResult<Vec<ActivityIncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> AppResult<DateTime<Utc>> {
            unimplemented!()
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> AppResult<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> AppResult<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: &[String],
        ) -> AppResult<std::collections::HashMap<String, String>> {
            Ok(std::collections::HashMap::new())
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> AppResult<crate::activities::BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> AppResult<u32> {
            Ok(0)
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> AppResult<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    #[derive(Clone, Debug)]
    struct MockActivityRepositoryWithData {
        activities: Vec<Activity>,
    }
    impl MockActivityRepositoryWithData {
        fn new(activities: Vec<Activity>) -> Self {
            Self { activities }
        }
    }
    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepositoryWithData {
        fn get_activity(&self, activity_id: &str) -> AppResult<Activity> {
            self.activities
                .iter()
                .find(|a| a.id == activity_id)
                .cloned()
                .ok_or_else(|| Error::Repository(format!("Activity {} not found", activity_id)))
        }
        fn find_transfer_counterpart(
            &self,
            _group_id: &str,
            _exclude_id: &str,
        ) -> AppResult<Option<Activity>> {
            Ok(None)
        }
        fn get_activities(&self) -> AppResult<Vec<Activity>> {
            Ok(self.activities.clone())
        }
        fn get_activities_by_account_id(&self, account_id: &str) -> AppResult<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|&a| a.account_id == account_id)
                .cloned()
                .collect())
        }
        fn get_activities_by_account_ids(
            &self,
            account_ids: &[String],
        ) -> AppResult<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|&a| account_ids.contains(&a.account_id))
                .cloned()
                .collect())
        }
        fn get_trading_activities(&self) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> AppResult<Vec<Activity>> {
            unimplemented!()
        }
        fn get_contribution_activities(
            &self,
            _ids: &[String],
            _s: DateTime<Utc>,
            _e: DateTime<Utc>,
        ) -> AppResult<Vec<crate::limits::ContributionActivity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _page: i64,
            _size: i64,
            _acc: Option<Vec<String>>,
            _typ: Option<Vec<String>>,
            _kw: Option<String>,
            _sort: Option<ActivitySort>,
            _is_draft_filter: Option<bool>,
            _date_from: Option<NaiveDate>,
            _date_to: Option<NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
            _activity_id_filter: Option<Vec<String>>,
        ) -> AppResult<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _n: NewActivity) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _u: ActivityUpdate) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _id: String) -> AppResult<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _a: String,
            _b: String,
        ) -> AppResult<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _a: String,
            _b: String,
        ) -> AppResult<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _creates: Vec<NewActivity>,
            _updates: Vec<ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> AppResult<crate::activities::ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _a: Vec<NewActivity>) -> AppResult<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(
            &self,
            _ids: Option<&[String]>,
        ) -> AppResult<Option<DateTime<Utc>>> {
            Ok(None)
        }
        fn get_import_mapping(
            &self,
            _id: &str,
            _context_kind: &str,
        ) -> AppResult<Option<ActivityImportMapping>> {
            Ok(None)
        }
        async fn save_import_mapping(&self, _m: &ActivityImportMapping) -> AppResult<()> {
            Ok(())
        }
        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> AppResult<()> {
            Ok(())
        }
        fn list_import_templates(&self) -> AppResult<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }
        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> AppResult<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> AppResult<()> {
            Ok(())
        }
        async fn delete_import_template(&self, _template_id: &str) -> AppResult<()> {
            Ok(())
        }
        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> AppResult<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> AppResult<()> {
            Ok(())
        }
        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> AppResult<()> {
            Ok(())
        }
        fn calculate_average_cost(&self, _acc: &str, _asset: &str) -> AppResult<Decimal> {
            unimplemented!()
        }
        fn get_income_activities_data(
            &self,

            _account_ids: Option<&[String]>,
        ) -> AppResult<Vec<ActivityIncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> AppResult<DateTime<Utc>> {
            unimplemented!()
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> AppResult<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> AppResult<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: &[String],
        ) -> AppResult<std::collections::HashMap<String, String>> {
            Ok(std::collections::HashMap::new())
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> AppResult<crate::activities::BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> AppResult<u32> {
            Ok(0)
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> AppResult<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    #[derive(Clone, Debug)]
    struct FailingLotRepository;

    impl FailingLotRepository {
        fn failure() -> Error {
            Error::Database(crate::errors::DatabaseError::QueryFailed(
                "forced lot sync failure".to_string(),
            ))
        }
    }

    #[async_trait]
    impl LotRepositoryTrait for FailingLotRepository {
        async fn replace_lots_for_account(
            &self,
            _account_id: &str,
            _lots: &[LotRecord],
        ) -> AppResult<()> {
            Err(Self::failure())
        }

        async fn get_open_lots_for_account(&self, _account_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_open_lots(&self) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_lots_as_of_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_lots_for_account(&self, _account_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_lots_for_asset(&self, _asset_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_asset_lot_view(
            &self,
            _asset_id: &str,
            _include_snapshot_positions: bool,
        ) -> AppResult<Vec<AssetLotView>> {
            Ok(Vec::new())
        }

        async fn get_all_lots(&self) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn sync_lots_for_account(
            &self,
            _account_id: &str,
            _open_lots: &[LotRecord],
            _closures: &[LotClosure],
        ) -> AppResult<()> {
            Err(Self::failure())
        }

        async fn get_open_position_quantities(&self) -> AppResult<HashMap<String, Decimal>> {
            Ok(HashMap::new())
        }

        fn get_lot_disposals_for_accounts_in_date_range_sync(
            &self,
            _account_ids: &[String],
            _start_date_exclusive: NaiveDate,
            _end_date_inclusive: NaiveDate,
        ) -> AppResult<Vec<LotDisposal>> {
            Ok(Vec::new())
        }

        fn count_lots(&self) -> AppResult<i64> {
            Ok(0)
        }
    }

    #[derive(Clone, Debug)]
    struct RecordingLotRepository {
        replaced_accounts: Arc<RwLock<Vec<String>>>,
        synced_lots: Arc<RwLock<Vec<LotRecord>>>,
        synced_closures: Arc<RwLock<Vec<LotClosure>>>,
        synced_disposals: Arc<RwLock<Vec<LotDisposal>>>,
    }

    impl RecordingLotRepository {
        fn new() -> Self {
            Self {
                replaced_accounts: Arc::new(RwLock::new(Vec::new())),
                synced_lots: Arc::new(RwLock::new(Vec::new())),
                synced_closures: Arc::new(RwLock::new(Vec::new())),
                synced_disposals: Arc::new(RwLock::new(Vec::new())),
            }
        }

        fn replaced_accounts(&self) -> Vec<String> {
            self.replaced_accounts.read().unwrap().clone()
        }

        fn synced_lots(&self) -> Vec<LotRecord> {
            self.synced_lots.read().unwrap().clone()
        }

        fn synced_disposals(&self) -> Vec<LotDisposal> {
            self.synced_disposals.read().unwrap().clone()
        }
    }

    #[async_trait]
    impl LotRepositoryTrait for RecordingLotRepository {
        async fn replace_lots_for_account(
            &self,
            account_id: &str,
            _lots: &[LotRecord],
        ) -> AppResult<()> {
            self.replaced_accounts
                .write()
                .unwrap()
                .push(account_id.to_string());
            Ok(())
        }

        async fn get_open_lots_for_account(&self, _account_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_open_lots(&self) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_lots_as_of_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_all_lots_for_account(&self, _account_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_lots_for_asset(&self, _asset_id: &str) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn get_asset_lot_view(
            &self,
            _asset_id: &str,
            _include_snapshot_positions: bool,
        ) -> AppResult<Vec<AssetLotView>> {
            Ok(Vec::new())
        }

        async fn get_all_lots(&self) -> AppResult<Vec<LotRecord>> {
            Ok(Vec::new())
        }

        async fn sync_lots_for_account(
            &self,
            _account_id: &str,
            open_lots: &[LotRecord],
            closures: &[LotClosure],
        ) -> AppResult<()> {
            self.synced_lots
                .write()
                .unwrap()
                .extend(open_lots.iter().cloned());
            self.synced_closures
                .write()
                .unwrap()
                .extend(closures.iter().cloned());
            Ok(())
        }

        async fn sync_lot_disposals_for_account(
            &self,
            _account_id: &str,
            _affected_activity_ids: &[String],
            disposals: &[LotDisposal],
            _replace_all: bool,
        ) -> AppResult<()> {
            self.synced_disposals
                .write()
                .unwrap()
                .extend(disposals.iter().cloned());
            Ok(())
        }

        async fn get_open_position_quantities(&self) -> AppResult<HashMap<String, Decimal>> {
            Ok(HashMap::new())
        }

        fn get_lot_disposals_for_accounts_in_date_range_sync(
            &self,
            account_ids: &[String],
            start_date_exclusive: NaiveDate,
            end_date_inclusive: NaiveDate,
        ) -> AppResult<Vec<LotDisposal>> {
            Ok(self
                .synced_disposals
                .read()
                .unwrap()
                .iter()
                .filter(|disposal| account_ids.contains(&disposal.account_id))
                .filter(|disposal| {
                    NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                        .is_ok_and(|date| date > start_date_exclusive && date <= end_date_inclusive)
                })
                .cloned()
                .collect())
        }

        fn count_lots(&self) -> AppResult<i64> {
            Ok(0)
        }
    }

    // Mock SnapshotRepository that implements the trait
    #[derive(Clone, Debug)]
    struct MockSnapshotRepository {
        snapshots: Arc<RwLock<HashMap<String, Vec<AccountStateSnapshot>>>>, // account_id -> snapshots
        saved_snapshots: Arc<RwLock<Vec<AccountStateSnapshot>>>, // track what was saved via replace_all_snapshots
    }

    impl MockSnapshotRepository {
        fn new() -> Self {
            Self {
                snapshots: Arc::new(RwLock::new(HashMap::new())),
                saved_snapshots: Arc::new(RwLock::new(Vec::new())),
            }
        }

        fn add_snapshots(&self, snapshots: Vec<AccountStateSnapshot>) {
            let mut store = self.snapshots.write().unwrap();
            for snapshot in snapshots {
                store
                    .entry(snapshot.account_id.clone())
                    .or_default()
                    .push(snapshot);
            }
        }

        fn get_saved_snapshots(&self) -> Vec<AccountStateSnapshot> {
            self.saved_snapshots.read().unwrap().clone()
        }
    }

    #[async_trait]
    impl SnapshotRepositoryTrait for MockSnapshotRepository {
        async fn save_snapshots(
            &self,
            snapshots_to_save: &[AccountStateSnapshot],
        ) -> AppResult<()> {
            let mut saved_store = self.saved_snapshots.write().unwrap();
            saved_store.clear(); // Clear previous state, as test verifies the result of one operation.
            saved_store.extend(snapshots_to_save.iter().cloned());

            // Also update the main `self.snapshots` store for the saved snapshots.
            let mut main_store = self.snapshots.write().unwrap();
            for s in snapshots_to_save {
                let account_snaps = main_store.entry(s.account_id.clone()).or_default();
                // Remove existing snapshot for the same date before adding the new one
                account_snaps.retain(|existing_s| existing_s.snapshot_date != s.snapshot_date);
                account_snaps.push(s.clone());
                account_snaps.sort_by_key(|k| k.snapshot_date); // Keep them sorted
            }
            Ok(())
        }

        fn get_snapshots_by_account(
            &self,
            account_id: &str,
            start_date: Option<NaiveDate>,
            end_date: Option<NaiveDate>,
        ) -> AppResult<Vec<AccountStateSnapshot>> {
            let store = self.snapshots.read().unwrap();
            if let Some(account_snapshots) = store.get(account_id) {
                let filtered: Vec<AccountStateSnapshot> = account_snapshots
                    .iter()
                    .filter(|snap| {
                        start_date.is_none_or(|start| snap.snapshot_date >= start)
                            && end_date.is_none_or(|end| snap.snapshot_date <= end)
                    })
                    .cloned()
                    .collect();
                Ok(filtered)
            } else {
                Ok(Vec::new())
            }
        }

        fn get_latest_snapshot_before_date(
            &self,
            _account_id: &str,
            _date: NaiveDate,
        ) -> AppResult<Option<AccountStateSnapshot>> {
            // For test_calculate_total_portfolio_snapshots_aggregation, this might not be directly hit
            // but good to have a basic mock if other flows use it.
            let store = self.snapshots.read().unwrap();
            if let Some(account_snapshots) = store.get(_account_id) {
                return Ok(account_snapshots
                    .iter()
                    .filter(|s| s.snapshot_date <= _date)
                    .max_by_key(|s| s.snapshot_date)
                    .cloned());
            }
            Ok(None)
        }

        fn get_latest_snapshots_before_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> AppResult<HashMap<String, AccountStateSnapshot>> {
            unimplemented!("get_latest_snapshots_before_date mock")
        }

        fn get_all_latest_snapshots(
            &self,
            _account_ids: &[String],
        ) -> AppResult<HashMap<String, AccountStateSnapshot>> {
            unimplemented!("get_all_latest_snapshots mock")
        }

        async fn delete_snapshots_by_account_ids(
            &self,
            account_ids_to_delete: &[String],
        ) -> AppResult<usize> {
            let mut store = self.snapshots.write().unwrap();
            let mut count = 0;
            for id in account_ids_to_delete {
                if let Some(removed) = store.remove(id) {
                    count += removed.len();
                }
            }
            // This method should NOT clear self.saved_snapshots, as that's used for assertions AFTER save.
            Ok(count)
        }

        async fn delete_snapshots_for_account_and_dates(
            &self,
            _account_id: &str,
            _dates_to_delete: &[NaiveDate],
        ) -> AppResult<()> {
            unimplemented!("delete_snapshots_for_account_and_dates mock")
        }

        async fn delete_snapshots_for_account_in_range(
            &self,
            _account_id: &str,
            _start_date: NaiveDate,
            _end_date: NaiveDate,
        ) -> AppResult<()> {
            // This was identified as the panic point.
            unimplemented!("delete_snapshots_for_account_in_range mock")
        }

        fn get_all_non_archived_account_snapshots(
            &self,
            start_date: Option<NaiveDate>,
            end_date: Option<NaiveDate>,
        ) -> AppResult<Vec<AccountStateSnapshot>> {
            let store = self.snapshots.read().unwrap();
            let mut all_snapshots = Vec::new();

            for (_account_id, account_snapshots) in store.iter() {
                let filtered: Vec<AccountStateSnapshot> = account_snapshots
                    .iter()
                    .filter(|snap| {
                        start_date.is_none_or(|start| snap.snapshot_date >= start)
                            && end_date.is_none_or(|end| snap.snapshot_date <= end)
                    })
                    .cloned()
                    .collect();
                all_snapshots.extend(filtered);
            }
            Ok(all_snapshots)
        }

        fn get_earliest_snapshot_date(&self, account_id: &str) -> AppResult<Option<NaiveDate>> {
            let store = self.snapshots.read().unwrap();
            if let Some(account_snapshots) = store.get(account_id) {
                return Ok(account_snapshots.iter().map(|s| s.snapshot_date).min());
            }
            Ok(None)
        }

        async fn overwrite_snapshots_for_account_in_range(
            &self,
            account_id: &str,
            start_date: NaiveDate,
            end_date: NaiveDate,
            snapshots_to_save: &[AccountStateSnapshot],
        ) -> AppResult<()> {
            let mut saved_store = self.saved_snapshots.write().unwrap();
            saved_store.clear();
            saved_store.extend(snapshots_to_save.iter().cloned());

            let mut store = self.snapshots.write().unwrap();
            if let Some(account_snaps) = store.get_mut(account_id) {
                account_snaps.retain(|snap| {
                    snap.snapshot_date < start_date || snap.snapshot_date > end_date
                });
            }
            if !snapshots_to_save.is_empty() {
                let account_snaps = store.entry(account_id.to_string()).or_default();
                account_snaps.extend(snapshots_to_save.iter().cloned());
                account_snaps.sort_by_key(|snap| snap.snapshot_date);
            }
            Ok(())
        }

        async fn overwrite_multiple_account_snapshot_ranges(
            &self,
            new_snaps: &[AccountStateSnapshot],
        ) -> AppResult<()> {
            self.save_snapshots(new_snaps).await
        }

        async fn overwrite_all_snapshots_for_account(
            &self,
            account_id: &str,
            snapshots_to_save: &[AccountStateSnapshot],
        ) -> AppResult<()> {
            let mut store = self.snapshots.write().unwrap();
            // Delete all existing snapshots for the account
            store.remove(account_id);
            // Insert the new snapshots if there are any
            if !snapshots_to_save.is_empty() {
                store.insert(account_id.to_string(), snapshots_to_save.to_vec());
            }

            // Also update saved_snapshots for assertion purposes.
            let mut saved_store = self.saved_snapshots.write().unwrap();
            saved_store.clear();
            saved_store.extend(snapshots_to_save.iter().cloned());
            Ok(())
        }

        async fn update_snapshots_source(
            &self,
            _account_id: &str,
            _new_source: &str,
        ) -> AppResult<usize> {
            // Mock implementation - just return 0 for tests that don't need this
            Ok(0)
        }

        async fn save_or_update_snapshot(&self, snapshot: &AccountStateSnapshot) -> AppResult<()> {
            let mut store = self.snapshots.write().unwrap();
            let account_snaps = store.entry(snapshot.account_id.clone()).or_default();

            // Remove any existing snapshot for the same date
            account_snaps.retain(|s| s.snapshot_date != snapshot.snapshot_date);

            // Add the new/updated snapshot
            account_snaps.push(snapshot.clone());
            account_snaps.sort_by_key(|k| k.snapshot_date);

            // Also update saved_snapshots for assertion purposes
            let mut saved_store = self.saved_snapshots.write().unwrap();
            saved_store.clear();
            saved_store.push(snapshot.clone());

            Ok(())
        }

        fn get_non_calculated_snapshot_count(&self, account_id: &str) -> AppResult<usize> {
            let store = self.snapshots.read().unwrap();
            if let Some(account_snapshots) = store.get(account_id) {
                let count = account_snapshots
                    .iter()
                    .filter(|s| s.source.is_non_calculated())
                    .count();
                return Ok(count);
            }
            Ok(0)
        }

        fn get_earliest_non_calculated_snapshot(
            &self,
            account_id: &str,
        ) -> AppResult<Option<AccountStateSnapshot>> {
            let store = self.snapshots.read().unwrap();
            if let Some(account_snapshots) = store.get(account_id) {
                return Ok(account_snapshots
                    .iter()
                    .filter(|s| s.source.is_non_calculated())
                    .min_by_key(|s| s.snapshot_date)
                    .cloned());
            }
            Ok(None)
        }

        fn get_snapshot_positions(
            &self,
            _snapshot_id: &str,
        ) -> AppResult<HashMap<String, Position>> {
            Ok(HashMap::new())
        }

        fn get_snapshot_positions_batch(
            &self,
            _snapshot_ids: &[String],
        ) -> AppResult<HashMap<String, HashMap<String, Position>>> {
            Ok(HashMap::new())
        }
    }

    fn create_test_account(id: &str, currency: &str, name: &str) -> Account {
        Account {
            id: id.to_string(),
            name: name.to_string(),
            currency: currency.to_string(),
            is_active: true,
            account_type: "SECURITIES".to_string(),
            group: None,
            is_default: false,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: crate::accounts::TrackingMode::NotSet,
        }
    }

    fn create_blank_snapshot(
        account_id: &str,
        currency: &str,
        date_str: &str,
    ) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: format!("{}_{}", account_id, date_str),
            account_id: account_id.to_string(),
            snapshot_date: NaiveDate::parse_from_str(date_str, "%Y-%m-%d").unwrap(),
            currency: currency.to_string(),
            calculated_at: Utc::now().naive_utc(),
            ..Default::default()
        }
    }

    /// Helper to create test activities with the new Activity model
    #[allow(clippy::too_many_arguments)]
    fn create_test_activity(
        id: &str,
        account_id: &str,
        asset_id: Option<&str>,
        activity_type: &str,
        date: NaiveDate,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
        amount: Option<Decimal>,
        currency: &str,
    ) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.map(String::from),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: DateTime::from_naive_utc_and_offset(
                date.and_hms_opt(0, 0, 0).unwrap(),
                Utc,
            ),
            settlement_date: None,
            quantity,
            unit_price,
            amount,
            fee: Some(Decimal::ZERO),
            tax: None,
            currency: currency.to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_calculate_holdings_snapshots_persists() {
        let base_currency_arc = Arc::new(RwLock::new("CAD".to_string()));

        // one CAD account
        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "Test ACC");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        // two deposit activities
        let d1 = NaiveDate::from_ymd_opt(2025, 5, 8).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();
        let act1 = create_test_activity(
            "act1",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "CAD",
        );
        let act2 = create_test_activity(
            "act2",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(10000)),
            "CAD",
        );
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![act1, act2]));

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo.clone(),
            activity_repo.clone(),
            snapshot_repo.clone(),
            asset_repo,
            fx.clone(),
        );

        // should insert keyframes without error
        let saved = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert!(saved >= 2, "at least two keyframes expected");
    }

    #[tokio::test]
    async fn test_recalculate_holdings_snapshots_surfaces_lot_sync_errors() {
        let base_currency_arc = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        let activity_date = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            activity_date,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );
        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            activity_date,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, buy]));

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo,
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        )
        .with_lot_repository(Arc::new(FailingLotRepository));

        let err = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .expect_err("lot sync failure should be returned");

        assert!(err.to_string().contains("lot sync failed for 1 account(s)"));
        assert!(err.to_string().contains("forced lot sync failure"));
        assert!(
            !snapshot_repo.get_saved_snapshots().is_empty(),
            "snapshot write should happen before the dual-write error is surfaced"
        );
    }

    #[tokio::test]
    async fn test_since_date_recalc_clears_snapshots_and_lots_when_last_activity_deleted() {
        let base_currency_arc = Arc::new(RwLock::new("CAD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "Deleted Activity Account");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(Vec::new()));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let today = valuation_date_today();
        let stale_date = today.pred_opt().unwrap_or(today);
        snapshot_repo.add_snapshots(vec![create_blank_snapshot(
            &acc.id,
            "CAD",
            &stale_date.format("%Y-%m-%d").to_string(),
        )]);

        let lot_repo = RecordingLotRepository::new();
        let lot_repo_assert = lot_repo.clone();
        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo,
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        )
        .with_lot_repository(Arc::new(lot_repo));

        let saved = svc
            .recalculate_holdings_snapshots(
                Some(std::slice::from_ref(&acc.id)),
                SnapshotRecalcMode::SinceDate(stale_date),
            )
            .await
            .unwrap();

        assert_eq!(saved, 0);
        assert!(
            snapshot_repo
                .get_snapshots_by_account(&acc.id, None, None)
                .unwrap()
                .is_empty(),
            "stale snapshots for the account should be deleted"
        );
        assert_eq!(lot_repo_assert.replaced_accounts(), vec![acc.id]);
    }

    #[tokio::test]
    async fn test_lot_dual_write_records_fifo_method() {
        let base_currency_arc = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Lot Method Account");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        let today = valuation_date_today();
        let buy_date = today.pred_opt().unwrap_or(today);
        let deposit_date = buy_date.pred_opt().unwrap_or(buy_date);
        let deposit = create_test_activity(
            "deposit1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            deposit_date,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );
        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            buy_date,
            Some(dec!(10)),
            Some(dec!(100)),
            Some(dec!(1000)),
            "USD",
        );
        let sell = create_test_activity(
            "sell1",
            &acc.id,
            Some("AAPL"),
            "SELL",
            today,
            Some(dec!(4)),
            Some(dec!(120)),
            Some(dec!(480)),
            "USD",
        );
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy, sell,
        ]));

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());
        let lot_repo = RecordingLotRepository::new();
        let lot_repo_assert = lot_repo.clone();

        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo,
            activity_repo,
            snapshot_repo,
            asset_repo,
            fx,
        )
        .with_lot_repository(Arc::new(lot_repo));

        svc.recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
            .await
            .unwrap();

        let synced_lots = lot_repo_assert.synced_lots();
        assert_eq!(synced_lots.len(), 1);
        assert_eq!(synced_lots[0].cost_basis_method, "FIFO");

        let synced_disposals = lot_repo_assert.synced_disposals();
        assert_eq!(synced_disposals.len(), 1);
        assert_eq!(synced_disposals[0].cost_basis_method, "FIFO");
    }

    #[tokio::test]
    async fn test_non_fifo_accounting_method_is_rejected_by_snapshot_calculator() {
        let base_currency_arc = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "LIFO Account");
        account_repo.add_account(acc.clone());
        let mut settings = AccountAccountingSettings::default_for_account(acc.id.clone());
        settings.cost_basis_method = CostBasisMethod::Lifo;
        account_repo.set_accounting_settings(settings);
        let account_repo = Arc::new(account_repo);

        let today = valuation_date_today();
        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            today,
            Some(dec!(10)),
            Some(dec!(100)),
            Some(dec!(1000)),
            "USD",
        );
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![buy]));

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo,
            activity_repo,
            snapshot_repo,
            asset_repo,
            fx,
        );

        let err = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
            .await
            .expect_err("non-FIFO methods should not run through the FIFO calculator");

        assert!(err.to_string().contains("only FIFO is supported"));
        assert!(err.to_string().contains("LIFO"));
    }

    #[tokio::test]
    async fn test_calculate_holdings_snapshots_skips_when_latest_keyframe_is_up_to_date() {
        let base_currency_arc = Arc::new(RwLock::new("CAD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "Test ACC");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        let today = valuation_date_today();
        let activity_date = today.pred_opt().unwrap_or(today);
        let act = create_test_activity(
            "act1",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            activity_date,
            None,
            None,
            Some(dec!(5000)),
            "CAD",
        );
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![act]));

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        // Seed an existing keyframe for "today" to simulate a fully up-to-date snapshot store.
        let today_str = today.format("%Y-%m-%d").to_string();
        snapshot_repo.add_snapshots(vec![create_blank_snapshot(&acc.id, "CAD", &today_str)]);

        let svc = SnapshotService::new(
            base_currency_arc,
            account_repo,
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // No new dates remain to calculate (effective_start_date would be tomorrow), so no writes.
        let saved = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert_eq!(saved, 0);
        assert!(snapshot_repo.get_saved_snapshots().is_empty());
    }

    #[tokio::test]
    async fn test_calculate_holdings_snapshots_persists_keyframes() {
        let base = Arc::new(RwLock::new("CAD".to_string()));

        // one active CAD account
        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "Cash-Only");
        account_repo.add_account(acc.clone());

        // two DEPOSIT activities + 1 DIVIDEND (dividend shouldn't alter net_contribution)
        let d1 = NaiveDate::from_ymd_opt(2025, 5, 8).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "CAD",
        );
        let dividend = create_test_activity(
            "div1",
            &acc.id,
            Some("CASH:CAD"),
            "DIVIDEND",
            d2,
            None,
            None,
            Some(dec!(100000)),
            "CAD",
        );
        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(10000)),
            "CAD",
        );

        let act_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            dep1, dividend, dep2,
        ]));

        let fx = Arc::new(MockFxService::new());
        let snaps = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base.clone(),
            Arc::new(account_repo),
            act_repo,
            snaps.clone(),
            asset_repo,
            fx,
        );

        // should compile & run without type errors and save >= 1 frame
        let saved = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert!(saved >= 1, "expected at least one keyframe saved");

        // dividend must NOT change net_contribution, but other activities (like deposits) should.
        let frames = snaps.get_saved_snapshots();
        let mut frames_sorted = frames.clone();
        frames_sorted.sort_by_key(|s| s.snapshot_date);

        assert_eq!(
            frames_sorted.len(),
            2,
            "Expected exactly two keyframes for the two activity dates."
        );

        // First keyframe from the first deposit
        let first_frame = &frames_sorted[0];
        assert_eq!(
            first_frame.net_contribution,
            dec!(5000),
            "First keyframe should only reflect the first deposit."
        );
        assert_eq!(first_frame.snapshot_date, d1);

        // Second keyframe should include the second deposit, but the dividend should have no impact on net contribution.
        let second_frame = &frames_sorted[1];
        assert_eq!(
            second_frame.net_contribution,
            dec!(15000),
            "Second keyframe should reflect both deposits, ignoring the dividend for net contribution calculation."
        );
        assert_eq!(second_frame.snapshot_date, d2);
    }

    // ==================== BUY ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_buy_activity_creates_position_and_updates_cash() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        // Deposit first to have cash
        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        // Buy 10 shares of AAPL at $150
        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, buy]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let saved = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert!(saved >= 1);

        let frames = snapshot_repo.get_saved_snapshots();
        assert!(!frames.is_empty());

        let frame = &frames[0];
        // Check position created
        assert!(frame.positions.contains_key("AAPL"));
        let pos = frame.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(10));
        assert_eq!(pos.total_cost_basis, dec!(1500));
        assert_eq!(pos.average_cost, dec!(150));

        // Check cash balance reduced (10000 deposit - 1500 buy = 8500)
        assert_eq!(frame.cash_balances.get("USD"), Some(&dec!(8500)));

        // Net contribution should be 10000 (only deposit counts)
        assert_eq!(frame.net_contribution, dec!(10000));
    }

    // ==================== SELL ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_sell_activity_reduces_position_and_increases_cash() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        // Deposit and buy first
        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        // Sell 5 shares at $180
        let sell = create_test_activity(
            "sell1",
            &acc.id,
            Some("AAPL"),
            "SELL",
            d2,
            Some(dec!(5)),
            Some(dec!(180)),
            Some(dec!(900)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy, sell,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        // Should have 2 keyframes (d1 and d2)
        assert_eq!(sorted.len(), 2);

        let frame_d2 = &sorted[1];
        assert_eq!(frame_d2.snapshot_date, d2);

        // Position should be reduced
        let pos = frame_d2.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(5));
        // Cost basis reduced proportionally (5 shares * $150 avg = $750)
        assert_eq!(pos.total_cost_basis, dec!(750));

        // Cash should be 8500 + 900 = 9400
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(9400)));

        // Net contribution unchanged by sell
        assert_eq!(frame_d2.net_contribution, dec!(10000));
    }

    // ==================== WITHDRAWAL ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_withdrawal_reduces_cash_and_net_contribution() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let withdrawal = create_test_activity(
            "wd1",
            &acc.id,
            Some("CASH:USD"),
            "WITHDRAWAL",
            d2,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, withdrawal,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];
        assert_eq!(frame_d2.snapshot_date, d2);

        // Cash reduced
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(7000)));

        // Net contribution reduced by withdrawal
        assert_eq!(frame_d2.net_contribution, dec!(7000));
    }

    // ==================== INCOME ACTIVITY TESTS (Dividend, Interest) ====================

    #[tokio::test]
    async fn test_dividend_increases_cash_but_not_net_contribution() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dividend = create_test_activity(
            "div1",
            &acc.id,
            Some("AAPL"),
            "DIVIDEND",
            d2,
            None,
            None,
            Some(dec!(100)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, dividend]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash increased by dividend
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(5100)));

        // Net contribution NOT affected by dividend
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    #[tokio::test]
    async fn test_interest_increases_cash_but_not_net_contribution() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let interest = create_test_activity(
            "int1",
            &acc.id,
            Some("CASH:USD"),
            "INTEREST",
            d2,
            None,
            None,
            Some(dec!(50)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, interest]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash increased by interest
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(5050)));

        // Net contribution NOT affected by interest
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    // ==================== FEE AND TAX ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_fee_reduces_cash_but_not_net_contribution() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let fee = create_test_activity(
            "fee1",
            &acc.id,
            Some("CASH:USD"),
            "FEE",
            d2,
            None,
            None,
            Some(dec!(25)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, fee]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash reduced by fee
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(4975)));

        // Net contribution NOT affected by fee
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    #[tokio::test]
    async fn test_tax_reduces_cash_but_not_net_contribution() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let tax = create_test_activity(
            "tax1",
            &acc.id,
            Some("CASH:USD"),
            "TAX",
            d2,
            None,
            None,
            Some(dec!(100)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, tax]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash reduced by tax
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(4900)));

        // Net contribution NOT affected by tax
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    // ==================== CREDIT ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_credit_bonus_increases_cash_and_net_contribution() {
        // CREDIT with BONUS subtype is an external flow (new capital)
        // It should increase cash AND net_contribution (like DEPOSIT)
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        // Create CREDIT activity with BONUS subtype
        let mut credit_bonus = create_test_activity(
            "credit1",
            &acc.id,
            Some("CASH:USD"),
            "CREDIT",
            d2,
            None,
            None,
            Some(dec!(100)),
            "USD",
        );
        credit_bonus.subtype = Some("BONUS".to_string());

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit,
            credit_bonus,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash increased by CREDIT/BONUS
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(5100)));

        // Net contribution ALSO increased by CREDIT/BONUS (external flow)
        assert_eq!(frame_d2.net_contribution, dec!(5100));
    }

    #[tokio::test]
    async fn test_credit_rebate_increases_cash_but_not_net_contribution() {
        // CREDIT with REBATE subtype is an internal flow (trading rebate)
        // It should increase cash but NOT net_contribution
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        // Create CREDIT activity with REBATE subtype
        let mut credit_rebate = create_test_activity(
            "credit1",
            &acc.id,
            Some("CASH:USD"),
            "CREDIT",
            d2,
            None,
            None,
            Some(dec!(50)),
            "USD",
        );
        credit_rebate.subtype = Some("REBATE".to_string());

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit,
            credit_rebate,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash increased by CREDIT/REBATE
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(5050)));

        // Net contribution NOT affected by CREDIT/REBATE (internal flow)
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    #[tokio::test]
    async fn test_credit_no_subtype_increases_cash_but_not_net_contribution() {
        // CREDIT with no subtype is an internal flow
        // It should increase cash but NOT net_contribution
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        // Create CREDIT activity with no subtype
        let credit = create_test_activity(
            "credit1",
            &acc.id,
            Some("CASH:USD"),
            "CREDIT",
            d2,
            None,
            None,
            Some(dec!(75)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, credit]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];

        // Cash increased by CREDIT
        assert_eq!(frame_d2.cash_balances.get("USD"), Some(&dec!(5075)));

        // Net contribution NOT affected by CREDIT without subtype (internal flow)
        assert_eq!(frame_d2.net_contribution, dec!(5000));
    }

    // ==================== TRANSFER ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_transfer_in_asset_adds_position() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        // Transfer in 20 shares of AAPL valued at $160 each
        let transfer_in = create_test_activity(
            "tin1",
            &acc.id,
            Some("AAPL"),
            "TRANSFER_IN",
            d1,
            Some(dec!(20)),
            Some(dec!(160)),
            Some(dec!(3200)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![transfer_in]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        assert!(!frames.is_empty());

        let frame = &frames[0];
        let pos = frame.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(20));
        assert_eq!(pos.total_cost_basis, dec!(3200));

        // Transfers affect account-level net_contribution
        assert_eq!(frame.net_contribution, dec!(3200));
    }

    #[tokio::test]
    async fn test_transfer_out_asset_removes_position() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        // Transfer in first
        let transfer_in = create_test_activity(
            "tin1",
            &acc.id,
            Some("AAPL"),
            "TRANSFER_IN",
            d1,
            Some(dec!(20)),
            Some(dec!(160)),
            Some(dec!(3200)),
            "USD",
        );

        // Transfer out 10 shares
        let transfer_out = create_test_activity(
            "tout1",
            &acc.id,
            Some("AAPL"),
            "TRANSFER_OUT",
            d2,
            Some(dec!(10)),
            Some(dec!(160)),
            Some(dec!(1600)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            transfer_in,
            transfer_out,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];
        let pos = frame_d2.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(10));
        assert_eq!(pos.total_cost_basis, dec!(1600));
    }

    // ==================== SPLIT ACTIVITY TESTS ====================

    #[tokio::test]
    async fn test_split_adjusts_historical_quantities() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 20).unwrap();

        // Buy 10 shares at $200
        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(200)),
            Some(dec!(2000)),
            "USD",
        );

        // 2:1 split (ratio = 2) - each share becomes 2 shares
        let split = create_test_activity(
            "split1",
            &acc.id,
            Some("AAPL"),
            "SPLIT",
            d2,
            None,
            None,
            Some(dec!(2)), // Split ratio
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy, split,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        // After the split, position should have 20 shares (10 * 2)
        // The buy activity was adjusted for the split
        let frame_d2 = &sorted[1];
        let pos = frame_d2.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(20), "Position should be split-adjusted");

        // Cost basis stays the same
        assert_eq!(pos.total_cost_basis, dec!(2000));

        // Average cost should be halved (200 / 2 = 100)
        assert_eq!(pos.average_cost, dec!(100));
    }

    #[tokio::test]
    async fn test_split_added_after_snapshots_restarts_from_earliest_activity() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());
        let account_repo = Arc::new(account_repo);

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let split_date = NaiveDate::from_ymd_opt(2025, 4, 29).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("HDV"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(100)),
            Some(dec!(1000)),
            "USD",
        );

        let split = create_test_activity(
            "split1",
            &acc.id,
            Some("HDV"),
            "SPLIT",
            split_date,
            None,
            None,
            Some(dec!(5)),
            "USD",
        );

        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let initial_activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit.clone(),
            buy.clone(),
        ]));
        let initial_svc = SnapshotService::new(
            base.clone(),
            account_repo.clone(),
            initial_activity_repo,
            snapshot_repo.clone(),
            asset_repo.clone(),
            fx.clone(),
        );

        initial_svc
            .recalculate_holdings_snapshots(
                Some(std::slice::from_ref(&acc.id)),
                SnapshotRecalcMode::Full,
            )
            .await
            .unwrap();

        let seeded = snapshot_repo
            .get_latest_snapshot_before_date(&acc.id, split_date.pred_opt().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(seeded.positions.get("HDV").unwrap().quantity, dec!(10));

        let split_activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy, split,
        ]));
        let split_svc = SnapshotService::new(
            base,
            account_repo,
            split_activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        split_svc
            .recalculate_holdings_snapshots(
                Some(std::slice::from_ref(&acc.id)),
                SnapshotRecalcMode::SinceDate(split_date),
            )
            .await
            .unwrap();

        let split_frame = snapshot_repo
            .get_snapshots_by_account(&acc.id, Some(split_date), Some(split_date))
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let pos = split_frame.positions.get("HDV").unwrap();
        assert_eq!(
            pos.quantity,
            dec!(50),
            "Backdated split recalc should not seed from pre-split snapshots"
        );
        assert_eq!(pos.total_cost_basis, dec!(1000));
        assert_eq!(pos.average_cost, dec!(20));
    }

    #[tokio::test]
    async fn test_split_multi_account_no_double_counting() {
        // Regression: when the same asset is held in multiple accounts, sync_splits inserts
        // one SPLIT activity per account. calculate_split_factors must deduplicate by date so
        // the split is applied only once, not N times.
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc1 = create_test_account("acc1", "USD", "Account 1");
        let acc2 = create_test_account("acc2", "USD", "Account 2");
        account_repo.add_account(acc1.clone());
        account_repo.add_account(acc2.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 20).unwrap();

        // Each account buys 10 AAPL at $200
        let deposit1 = create_test_activity(
            "dep1",
            &acc1.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(2000)),
            "USD",
        );
        let buy1 = create_test_activity(
            "buy1",
            &acc1.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(200)),
            Some(dec!(2000)),
            "USD",
        );
        let deposit2 = create_test_activity(
            "dep2",
            &acc2.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(2000)),
            "USD",
        );
        let buy2 = create_test_activity(
            "buy2",
            &acc2.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(200)),
            Some(dec!(2000)),
            "USD",
        );

        // One SPLIT activity per account for the same 2:1 event (as sync_splits produces)
        let split1 = create_test_activity(
            "split-acc1",
            &acc1.id,
            Some("AAPL"),
            "SPLIT",
            d2,
            None,
            None,
            Some(dec!(2)),
            "USD",
        );
        let split2 = create_test_activity(
            "split-acc2",
            &acc2.id,
            Some("AAPL"),
            "SPLIT",
            d2,
            None,
            None,
            Some(dec!(2)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit1, buy1, deposit2, buy2, split1, split2,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        // Each account should have 20 shares (10 * 2), not 40 (10 * 2 * 2)
        let frame_d2: Vec<_> = sorted.iter().filter(|s| s.snapshot_date == d2).collect();
        for frame in &frame_d2 {
            if let Some(pos) = frame.positions.get("AAPL") {
                assert_eq!(
                    pos.quantity,
                    dec!(20),
                    "account {}: expected 20 shares after 2:1 split, got {} (double-counting?)",
                    frame.account_id,
                    pos.quantity
                );
            }
        }
    }

    // ==================== FX CONVERSION TESTS ====================

    #[tokio::test]
    async fn test_cross_currency_buy_with_fx_rate() {
        let base = Arc::new(RwLock::new("CAD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "CAD Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        // Deposit CAD
        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "CAD",
        );

        // Buy AAPL (USD asset) with CAD account - activity has fx_rate
        let mut buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),  // USD price
            Some(dec!(1500)), // USD amount
            "USD",
        );
        buy.fx_rate = Some(dec!(1.35)); // 1 USD = 1.35 CAD

        let mut fx = MockFxService::new();
        fx.add_bidirectional_rate("USD", "CAD", d1, dec!(1.35));

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, buy]));
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            Arc::new(fx),
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        assert!(!frames.is_empty());

        let frame = &frames[0];

        // Position created in USD (asset currency)
        let pos = frame.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(10));
        assert_eq!(pos.currency, "USD");
        assert_eq!(pos.total_cost_basis, dec!(1500)); // USD cost basis

        // With fx_rate provided, cash is debited in account currency (CAD)
        // CAD cash: 10000 - (1500 * 1.35) = 10000 - 2025 = 7975
        assert_eq!(frame.cash_balances.get("CAD"), Some(&dec!(7975)));
        assert_eq!(frame.cash_balances.get("USD"), None);
    }

    // ==================== MULTI-ACCOUNT TESTS ====================

    #[tokio::test]
    async fn test_multiple_accounts_calculated_independently() {
        let base = Arc::new(RwLock::new("CAD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc1 = create_test_account("acc1", "CAD", "CAD Account");
        let acc2 = create_test_account("acc2", "USD", "USD Account");
        account_repo.add_account(acc1.clone());
        account_repo.add_account(acc2.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc1.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "CAD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc2.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        // Use get_snapshots_by_account instead of get_saved_snapshots since
        // the mock clears saved_snapshots on each save operation
        let acc1_frames = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        let acc2_frames = snapshot_repo
            .get_snapshots_by_account("acc2", None, None)
            .unwrap();

        // Each account should have its own snapshot
        assert!(!acc1_frames.is_empty(), "acc1 should have snapshots");
        assert!(!acc2_frames.is_empty(), "acc2 should have snapshots");

        let acc1_frame = &acc1_frames[0];
        let acc2_frame = &acc2_frames[0];

        assert_eq!(acc1_frame.cash_balances.get("CAD"), Some(&dec!(5000)));
        assert_eq!(acc1_frame.currency, "CAD");

        assert_eq!(acc2_frame.cash_balances.get("USD"), Some(&dec!(3000)));
        assert_eq!(acc2_frame.currency, "USD");
    }

    // ==================== KEYFRAME TESTS ====================

    #[tokio::test]
    async fn test_keyframes_created_only_on_activity_days() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        // Activities on non-consecutive days
        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(); // 5 days gap
        let d3 = NaiveDate::from_ymd_opt(2025, 1, 20).unwrap(); // 5 days gap

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(1000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(2000)),
            "USD",
        );

        let dep3 = create_test_activity(
            "dep3",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d3,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2, dep3]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();

        // Should only have 3 keyframes (one per activity day)
        assert_eq!(frames.len(), 3);

        let dates: HashSet<NaiveDate> = frames.iter().map(|f| f.snapshot_date).collect();
        assert!(dates.contains(&d1));
        assert!(dates.contains(&d2));
        assert!(dates.contains(&d3));

        // No keyframes for days in between
        let d_between = NaiveDate::from_ymd_opt(2025, 1, 12).unwrap();
        assert!(!dates.contains(&d_between));
    }

    // ==================== GET DAILY HOLDINGS SNAPSHOTS TESTS ====================

    #[tokio::test]
    async fn test_get_daily_holdings_snapshots_fills_gaps() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(2000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // First calculate to create keyframes
        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        // Now get daily snapshots with gap filling
        let daily = svc
            .get_daily_holdings_snapshots(&acc.id, Some(d1), Some(d2))
            .unwrap();

        // Should have 6 days (Jan 10-15 inclusive)
        assert_eq!(daily.len(), 6);

        // All days should be present
        let dates: Vec<NaiveDate> = daily.iter().map(|s| s.snapshot_date).collect();
        assert_eq!(dates[0], d1);
        assert_eq!(dates[5], d2);

        // Gap days (Jan 11-14) should carry forward d1's value
        for (i, snapshot) in daily[1..5].iter().enumerate() {
            assert_eq!(
                snapshot.cash_balances.get("USD"),
                Some(&dec!(5000)),
                "Day {} should carry forward",
                i + 1
            );
        }

        // Final day should have cumulative deposits
        assert_eq!(daily[5].cash_balances.get("USD"), Some(&dec!(7000)));
    }

    // ==================== GET HOLDINGS KEYFRAMES TESTS ====================

    #[tokio::test]
    async fn test_get_holdings_keyframes_returns_only_saved() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(2000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        // Get keyframes only (no gap filling)
        let keyframes = svc
            .get_holdings_keyframes(&acc.id, Some(d1), Some(d2))
            .unwrap();

        // Should have exactly 2 keyframes (activity days only)
        assert_eq!(keyframes.len(), 2);
        assert_eq!(keyframes[0].snapshot_date, d1);
        assert_eq!(keyframes[1].snapshot_date, d2);
    }

    // ==================== FORCE RECALCULATE TESTS ====================

    #[tokio::test]
    async fn test_force_recalculate_clears_and_rebuilds() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // First calculation
        let first_count = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert!(first_count >= 1);

        // Force recalculation
        let second_count = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
            .await
            .unwrap();
        assert!(second_count >= 1);

        // Should still have same number of keyframes
        let frames = snapshot_repo.get_saved_snapshots();
        assert!(!frames.is_empty());
        assert_eq!(frames[0].cash_balances.get("USD"), Some(&dec!(5000)));
    }

    // ==================== EDGE CASE TESTS ====================

    #[tokio::test]
    async fn test_empty_account_no_activities() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Empty Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let count = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert_eq!(count, 0, "Empty account should create no keyframes");
    }

    #[tokio::test]
    async fn test_multiple_activities_same_day_processed_correctly() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        // Multiple activities on same day
        let dep = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        let fee = create_test_activity(
            "fee1",
            &acc.id,
            Some("CASH:USD"),
            "FEE",
            d1,
            None,
            None,
            Some(dec!(10)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep, buy, fee]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        assert_eq!(frames.len(), 1); // Single keyframe for the day

        let frame = &frames[0];
        // All activities processed: 10000 - 1500 - 10 = 8490
        assert_eq!(frame.cash_balances.get("USD"), Some(&dec!(8490)));
        assert_eq!(frame.positions.get("AAPL").unwrap().quantity, dec!(10));
        assert_eq!(frame.net_contribution, dec!(10000)); // Only deposit counts
    }

    #[tokio::test]
    async fn test_get_latest_holdings_snapshot() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d2,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let latest = svc.get_latest_holdings_snapshot(&acc.id).unwrap();
        assert!(latest.is_some());

        let snapshot = latest.unwrap();
        // Should be the most recent snapshot (d2)
        assert_eq!(snapshot.snapshot_date, d2);
        assert_eq!(snapshot.cash_balances.get("USD"), Some(&dec!(8000)));
    }

    #[tokio::test]
    async fn test_get_latest_holdings_snapshot_excludes_future_dated_activity() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let today = valuation_date_today();
        let d1 = today.pred_opt().unwrap_or(today);
        let d_future = today.succ_opt().unwrap_or(today);

        let dep1 = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d_future,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let latest = svc.get_latest_holdings_snapshot(&acc.id).unwrap().unwrap();
        assert!(latest.snapshot_date < d_future);
        assert_eq!(latest.cash_balances.get("USD"), Some(&dec!(5000)));
    }

    #[tokio::test]
    async fn test_no_account_returns_empty() {
        let base = Arc::new(RwLock::new("USD".to_string()));
        let account_repo = MockAccountRepository::new(); // Empty
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let count = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_global_snapshot_recalc_keeps_hidden_and_excludes_archived_accounts() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let active = create_test_account("active", "USD", "Active Account");
        let mut hidden = create_test_account("hidden", "USD", "Hidden Account");
        hidden.is_active = false;
        let mut archived = create_test_account("archived", "USD", "Archived Account");
        archived.is_archived = true;
        account_repo.add_account(active.clone());
        account_repo.add_account(hidden.clone());
        account_repo.add_account(archived.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            create_test_activity(
                "active-deposit",
                &active.id,
                Some("CASH:USD"),
                "DEPOSIT",
                d1,
                None,
                None,
                Some(dec!(1000)),
                "USD",
            ),
            create_test_activity(
                "hidden-deposit",
                &hidden.id,
                Some("CASH:USD"),
                "DEPOSIT",
                d1,
                None,
                None,
                Some(dec!(2000)),
                "USD",
            ),
            create_test_activity(
                "archived-deposit",
                &archived.id,
                Some("CASH:USD"),
                "DEPOSIT",
                d1,
                None,
                None,
                Some(dec!(3000)),
                "USD",
            ),
        ]));
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            Arc::new(MockAssetRepository::new()),
            Arc::new(MockFxService::new()),
        );

        svc.recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        assert!(!snapshot_repo
            .get_snapshots_by_account("active", None, None)
            .unwrap()
            .is_empty());
        assert!(!snapshot_repo
            .get_snapshots_by_account("hidden", None, None)
            .unwrap()
            .is_empty());
        assert!(snapshot_repo
            .get_snapshots_by_account("archived", None, None)
            .unwrap()
            .is_empty());
    }

    // ==================== CASH AGGREGATION CALCULATION TESTS ====================

    #[tokio::test]
    async fn test_cash_total_account_currency_calculated() {
        let base = Arc::new(RwLock::new("CAD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "CAD", "CAD Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        // Deposit in CAD (account currency)
        let dep_cad = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:CAD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "CAD",
        );

        // Deposit in USD (different from account currency)
        let dep_usd = create_test_activity(
            "dep2",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(1000)),
            "USD",
        );

        let mut fx = MockFxService::new();
        fx.add_bidirectional_rate("USD", "CAD", d1, dec!(1.35));

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep_cad, dep_usd]));
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            Arc::new(fx),
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let frame = &frames[0];

        // cash_balances should have both currencies
        assert_eq!(frame.cash_balances.get("CAD"), Some(&dec!(5000)));
        assert_eq!(frame.cash_balances.get("USD"), Some(&dec!(1000)));

        // cash_total_account_currency should be sum converted to CAD
        // 5000 CAD + 1000 USD * 1.35 = 5000 + 1350 = 6350
        assert_eq!(
            frame.cash_total_account_currency.round_dp(2),
            dec!(6350).round_dp(2)
        );
    }

    // ==================== POSITION LOT TESTS ====================

    #[tokio::test]
    async fn test_buy_creates_lot_with_correct_details() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(10000)),
            "USD",
        );

        let buy = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![deposit, buy]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let frame = &frames[0];
        let pos = frame.positions.get("AAPL").unwrap();

        // Should have exactly one lot
        assert_eq!(pos.lots.len(), 1);

        let lot = &pos.lots[0];
        assert_eq!(lot.quantity, dec!(10));
        assert_eq!(lot.cost_basis, dec!(1500));
        assert_eq!(lot.acquisition_price, dec!(150));
    }

    #[tokio::test]
    async fn test_multiple_buys_create_multiple_lots() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(20000)),
            "USD",
        );

        let buy1 = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        let buy2 = create_test_activity(
            "buy2",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d2,
            Some(dec!(5)),
            Some(dec!(160)),
            Some(dec!(800)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy1, buy2,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        let frame_d2 = &sorted[1];
        let pos = frame_d2.positions.get("AAPL").unwrap();

        // Should have two lots
        assert_eq!(pos.lots.len(), 2);
        assert_eq!(pos.quantity, dec!(15));
        assert_eq!(pos.total_cost_basis, dec!(2300)); // 1500 + 800

        // Average cost: 2300 / 15 = 153.33...
        // Round both sides to same precision for comparison
        let expected_avg = (dec!(2300) / dec!(15)).round_dp(DECIMAL_PRECISION);
        assert_eq!(pos.average_cost.round_dp(DECIMAL_PRECISION), expected_avg);
    }

    // ==================== SPECIFIC ACCOUNT CALCULATION TESTS ====================

    #[tokio::test]
    async fn test_calculate_specific_accounts_only() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc1 = create_test_account("acc1", "USD", "Account 1");
        let acc2 = create_test_account("acc2", "USD", "Account 2");
        account_repo.add_account(acc1.clone());
        account_repo.add_account(acc2.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();

        let dep1 = create_test_activity(
            "dep1",
            &acc1.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(5000)),
            "USD",
        );

        let dep2 = create_test_activity(
            "dep2",
            &acc2.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(3000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![dep1, dep2]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Calculate only for acc1
        let _ = svc
            .recalculate_holdings_snapshots(
                Some(&["acc1".to_string()]),
                SnapshotRecalcMode::IncrementalFromLast,
            )
            .await
            .unwrap();

        let frames = snapshot_repo.get_saved_snapshots();

        // Should only have snapshot for acc1
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].account_id, "acc1");
        assert_eq!(frames[0].cash_balances.get("USD"), Some(&dec!(5000)));
    }

    // ==================== COST BASIS TESTS ====================

    #[tokio::test]
    async fn test_cost_basis_aggregated_correctly() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        let deposit = create_test_activity(
            "dep1",
            &acc.id,
            Some("CASH:USD"),
            "DEPOSIT",
            d1,
            None,
            None,
            Some(dec!(50000)),
            "USD",
        );

        // Buy first lot of AAPL
        let buy_aapl1 = create_test_activity(
            "buy1",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(150)),
            Some(dec!(1500)),
            "USD",
        );

        // Buy second lot of AAPL at different price
        let buy_aapl2 = create_test_activity(
            "buy2",
            &acc.id,
            Some("AAPL"),
            "BUY",
            d2,
            Some(dec!(20)),
            Some(dec!(100)),
            Some(dec!(2000)),
            "USD",
        );

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            deposit, buy_aapl1, buy_aapl2,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let _ = svc
            .recalculate_holdings_snapshots(None, SnapshotRecalcMode::IncrementalFromLast)
            .await
            .unwrap();

        let frames = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        let mut sorted = frames.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        // Check final snapshot (d2) has correct total cost basis
        let frame_d2 = &sorted[1];

        // Total cost basis should be sum of both lots
        // 1500 (first AAPL buy) + 2000 (second AAPL buy) = 3500
        assert_eq!(frame_d2.cost_basis, dec!(3500));

        // Verify the position details
        let pos = frame_d2.positions.get("AAPL").unwrap();
        assert_eq!(pos.quantity, dec!(30)); // 10 + 20
        assert_eq!(pos.total_cost_basis, dec!(3500)); // 1500 + 2000
    }

    // ==================== MANUAL SNAPSHOT TESTS ====================

    use crate::portfolio::snapshot::SnapshotSource;

    #[tokio::test]
    async fn test_save_manual_snapshot_creates_new_snapshot() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        let snapshot_date = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        let mut manual_snapshot = create_blank_snapshot("acc1", "USD", "2025-01-15");
        manual_snapshot.source = SnapshotSource::ManualEntry; // Caller sets the source
        manual_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(5000));
        manual_snapshot.net_contribution = dec!(5000);
        manual_snapshot.net_contribution_base = dec!(5000);

        // Save the manual snapshot
        let result = svc
            .save_manual_snapshot("acc1", manual_snapshot.clone())
            .await;
        assert!(result.is_ok(), "save_manual_snapshot should succeed");

        // Verify only the user-authored snapshot was saved.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(
            saved.len(),
            1,
            "Should have one manual snapshot without synthetic backfill"
        );

        // Find and verify the manual snapshot
        let saved_snapshot = saved
            .iter()
            .find(|s| s.snapshot_date == snapshot_date)
            .unwrap();
        assert_eq!(
            saved_snapshot.source,
            SnapshotSource::ManualEntry,
            "Source should be ManualEntry"
        );
        assert_eq!(saved_snapshot.cash_balances.get("USD"), Some(&dec!(5000)));
    }

    #[tokio::test]
    async fn test_save_manual_snapshot_updates_existing_same_date() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        // Pre-populate with an existing snapshot for the same date
        let mut existing_snapshot = create_blank_snapshot("acc1", "USD", "2025-01-15");
        existing_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(3000));
        existing_snapshot.source = SnapshotSource::ManualEntry;
        snapshot_repo.add_snapshots(vec![existing_snapshot]);

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Create updated snapshot for same date with different values
        let mut updated_snapshot = create_blank_snapshot("acc1", "USD", "2025-01-15");
        updated_snapshot.source = SnapshotSource::ManualEntry; // Caller sets the source
        updated_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(7500));
        updated_snapshot.net_contribution = dec!(7500);

        let result = svc.save_manual_snapshot("acc1", updated_snapshot).await;
        assert!(
            result.is_ok(),
            "save_manual_snapshot should succeed for update"
        );

        // Verify: the same-date manual snapshot was updated without synthetic backfill.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(saved.len(), 1, "Should have 1 updated manual snapshot");

        // Find and verify the manual snapshot was updated
        let manual_date = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        let saved_snapshot = saved
            .iter()
            .find(|s| s.snapshot_date == manual_date)
            .unwrap();
        assert_eq!(saved_snapshot.source, SnapshotSource::ManualEntry);
        assert_eq!(
            saved_snapshot.cash_balances.get("USD"),
            Some(&dec!(7500)),
            "Cash should be updated"
        );
    }

    #[tokio::test]
    async fn test_save_manual_snapshot_creates_new_for_different_date() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        // Pre-populate with an existing snapshot
        let mut existing_snapshot = create_blank_snapshot("acc1", "USD", "2025-01-10");
        existing_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(3000));
        existing_snapshot.source = SnapshotSource::ManualEntry;
        snapshot_repo.add_snapshots(vec![existing_snapshot]);

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Create new snapshot for a different date
        let mut new_snapshot = create_blank_snapshot("acc1", "USD", "2025-01-20");
        new_snapshot.source = SnapshotSource::ManualEntry; // Caller sets the source
        new_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(8000));
        new_snapshot.net_contribution = dec!(8000);

        let result = svc.save_manual_snapshot("acc1", new_snapshot).await;
        assert!(
            result.is_ok(),
            "save_manual_snapshot should succeed for new date"
        );

        // Verify two snapshots exist
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(saved.len(), 2, "Should have two snapshots");

        // Verify dates and sources
        let mut sorted = saved.clone();
        sorted.sort_by_key(|s| s.snapshot_date);

        assert_eq!(
            sorted[0].snapshot_date,
            NaiveDate::from_ymd_opt(2025, 1, 10).unwrap()
        );
        assert_eq!(sorted[0].source, SnapshotSource::ManualEntry);
        assert_eq!(sorted[0].cash_balances.get("USD"), Some(&dec!(3000)));

        assert_eq!(
            sorted[1].snapshot_date,
            NaiveDate::from_ymd_opt(2025, 1, 20).unwrap()
        );
        assert_eq!(sorted[1].source, SnapshotSource::ManualEntry);
        assert_eq!(sorted[1].cash_balances.get("USD"), Some(&dec!(8000)));
    }

    #[tokio::test]
    async fn test_save_manual_snapshot_preserves_source_from_input() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Create a snapshot with CsvImport source (caller sets source appropriately)
        let mut snapshot = create_blank_snapshot("acc1", "USD", "2025-01-15");
        snapshot.source = SnapshotSource::CsvImport; // Caller sets source for CSV imports
        snapshot.cash_balances.insert("USD".to_string(), dec!(5000));

        let result = svc.save_manual_snapshot("acc1", snapshot).await;
        assert!(result.is_ok());

        // Verify: CsvImport snapshot only.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(
            saved.len(),
            1,
            "Should have 1 CSV import snapshot without synthetic backfill"
        );

        // Find and verify the CSV import snapshot preserves source
        let csv_date = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        let csv_snapshot = saved.iter().find(|s| s.snapshot_date == csv_date).unwrap();
        assert_eq!(
            csv_snapshot.source,
            SnapshotSource::CsvImport,
            "Source should be preserved from input"
        );
    }

    // ==================== Synthetic Backfill Regression Tests ====================

    #[tokio::test]
    async fn test_ensure_holdings_history_no_synthetic_when_two_snapshots_exist() {
        // When 2+ non-calculated snapshots exist, no synthetic should be created
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        // Pre-populate with 2 manual snapshots (enough for performance calculation)
        let mut snap1 = create_blank_snapshot("acc1", "USD", "2025-01-01");
        snap1.source = SnapshotSource::ManualEntry;
        let mut snap2 = create_blank_snapshot("acc1", "USD", "2025-01-15");
        snap2.source = SnapshotSource::ManualEntry;
        snapshot_repo.add_snapshots(vec![snap1, snap2]);

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Save another snapshot
        let mut new_snapshot = create_blank_snapshot("acc1", "USD", "2025-02-01");
        new_snapshot.source = SnapshotSource::ManualEntry;
        new_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(10000));

        let result = svc.save_manual_snapshot("acc1", new_snapshot).await;
        assert!(result.is_ok());

        // Should have 3 snapshots total, no synthetic created
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(
            saved.len(),
            3,
            "Should have 3 manual snapshots, no synthetic"
        );

        let synthetic_count = saved
            .iter()
            .filter(|s| s.source == SnapshotSource::Synthetic)
            .count();
        assert_eq!(synthetic_count, 0, "No synthetic snapshots should exist");
    }

    #[tokio::test]
    async fn test_single_manual_snapshot_does_not_create_synthetic_backfill() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Create snapshot with specific holdings data
        let mut manual_snapshot = create_blank_snapshot("acc1", "USD", "2025-06-15");
        manual_snapshot.source = SnapshotSource::ManualEntry;
        manual_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(5000));
        manual_snapshot.cost_basis = dec!(10000);
        manual_snapshot.net_contribution = dec!(15000);

        // Add a position with required fields
        let position = Position {
            id: "pos1".to_string(),
            account_id: "acc1".to_string(),
            asset_id: "asset1".to_string(),
            quantity: dec!(100),
            average_cost: dec!(100),
            total_cost_basis: dec!(10000),
            currency: "USD".to_string(),
            inception_date: Utc::now(),
            lots: VecDeque::new(),
            created_at: Utc::now(),
            last_updated: Utc::now(),
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        };
        manual_snapshot
            .positions
            .insert("asset1".to_string(), position);

        let result = svc.save_manual_snapshot("acc1", manual_snapshot).await;
        assert!(result.is_ok());

        // Verify no synthetic row was created and the manual data is intact.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(saved.len(), 1);
        let saved_snapshot = saved
            .iter()
            .find(|s| s.source == SnapshotSource::ManualEntry)
            .unwrap();
        assert_eq!(saved_snapshot.cash_balances.get("USD"), Some(&dec!(5000)));
        assert_eq!(saved_snapshot.cost_basis, dec!(10000));
        assert_eq!(saved_snapshot.net_contribution, dec!(15000));
        assert!(saved_snapshot.positions.contains_key("asset1"));
        assert_eq!(
            saved_snapshot.positions.get("asset1").unwrap().quantity,
            dec!(100)
        );
        assert!(saved.iter().all(|s| s.source != SnapshotSource::Synthetic));
    }

    #[tokio::test]
    async fn test_daily_holdings_snapshots_ignore_legacy_synthetic_keyframes() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let mut synthetic = create_blank_snapshot("acc1", "USD", "2025-01-01");
        synthetic.source = SnapshotSource::Synthetic;
        synthetic
            .cash_balances
            .insert("USD".to_string(), dec!(1000));

        let mut manual = create_blank_snapshot("acc1", "USD", "2025-04-01");
        manual.source = SnapshotSource::ManualEntry;
        manual.cash_balances.insert("USD".to_string(), dec!(5000));

        snapshot_repo.add_snapshots(vec![synthetic, manual]);

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo,
            asset_repo,
            fx,
        );

        let frames = svc
            .get_daily_holdings_snapshots(
                "acc1",
                None,
                Some(NaiveDate::from_ymd_opt(2025, 4, 1).unwrap()),
            )
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].snapshot_date,
            NaiveDate::from_ymd_opt(2025, 4, 1).unwrap()
        );
        assert_eq!(frames[0].cash_balances.get("USD"), Some(&dec!(5000)));
    }

    #[tokio::test]
    async fn test_broker_imported_snapshot_does_not_create_synthetic_backfill() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Create broker imported snapshot
        let mut broker_snapshot = create_blank_snapshot("acc1", "USD", "2025-03-15");
        broker_snapshot.source = SnapshotSource::BrokerImported;
        broker_snapshot
            .cash_balances
            .insert("USD".to_string(), dec!(8000));

        let result = svc.save_manual_snapshot("acc1", broker_snapshot).await;
        assert!(result.is_ok());

        // Should have only the broker snapshot.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(saved.len(), 1);

        let broker = saved
            .iter()
            .find(|s| s.source == SnapshotSource::BrokerImported);
        let synthetic = saved.iter().find(|s| s.source == SnapshotSource::Synthetic);

        assert!(broker.is_some(), "Broker snapshot should exist");
        assert!(synthetic.is_none(), "Synthetic snapshot should not exist");
    }

    // ==================== Snapshot Source Filtering Tests ====================

    #[tokio::test]
    async fn test_calculated_snapshots_do_not_trigger_synthetic_backfill() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc = create_test_account("acc1", "USD", "Test Account");
        account_repo.add_account(acc.clone());

        let activity_repo = Arc::new(MockActivityRepository::new());
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        // Pre-populate with CALCULATED snapshots (should be ignored)
        let mut calc1 = create_blank_snapshot("acc1", "USD", "2025-01-01");
        calc1.source = SnapshotSource::Calculated;
        let mut calc2 = create_blank_snapshot("acc1", "USD", "2025-01-05");
        calc2.source = SnapshotSource::Calculated;
        snapshot_repo.add_snapshots(vec![calc1, calc2]);

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        // Save a manual snapshot
        let mut manual = create_blank_snapshot("acc1", "USD", "2025-01-15");
        manual.source = SnapshotSource::ManualEntry;
        manual.cash_balances.insert("USD".to_string(), dec!(5000));

        let result = svc.save_manual_snapshot("acc1", manual).await;
        assert!(result.is_ok());

        // Should have: 2 calculated + 1 manual. Synthetic backfill is not created.
        let saved = snapshot_repo
            .get_snapshots_by_account("acc1", None, None)
            .unwrap();
        assert_eq!(saved.len(), 3);

        let synthetic_count = saved
            .iter()
            .filter(|s| s.source == SnapshotSource::Synthetic)
            .count();
        assert_eq!(
            synthetic_count, 0,
            "Synthetic backfill should not be created"
        );
    }

    #[tokio::test]
    async fn test_newly_created_account_has_default_archive_values() {
        // Verify that newly created accounts have is_archived=false by default
        let account = Account::default();
        assert!(
            !account.is_archived,
            "New accounts should not be archived by default"
        );

        let account = create_test_account("new_acc", "USD", "New Account");
        assert!(
            !account.is_archived,
            "Test helper should create non-archived accounts"
        );
        assert!(
            account.is_active,
            "Test helper should create active accounts"
        );
    }

    // ==================== LOT-LEVEL TRANSFER ORDERING TESTS ====================

    /// Integration test: internal security transfer between two accounts preserves
    /// cost basis via lot-level transfer. This exercises the snapshot service's
    /// account ordering (topological sort) to ensure TRANSFER_OUT is processed
    /// before TRANSFER_IN regardless of HashMap iteration order.
    #[tokio::test]
    async fn test_internal_transfer_preserves_cost_basis_via_snapshot_service() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc_a = create_test_account("acc_a", "USD", "Account A");
        let acc_b = create_test_account("acc_b", "USD", "Account B");
        account_repo.add_account(acc_a.clone());
        account_repo.add_account(acc_b.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        // Day 1: Buy 10 AAPL @ $100 in Account A
        let buy = create_test_activity(
            "buy1",
            "acc_a",
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(100)),
            Some(dec!(1000)),
            "USD",
        );

        // Day 2: Transfer 10 AAPL from A to B (paired via source_group_id)
        let mut xfer_out = create_test_activity(
            "xfer_out",
            "acc_a",
            Some("AAPL"),
            "TRANSFER_OUT",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_out.source_group_id = Some("grp_test".to_string());

        let mut xfer_in = create_test_activity(
            "xfer_in",
            "acc_b",
            Some("AAPL"),
            "TRANSFER_IN",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_in.source_group_id = Some("grp_test".to_string());

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            buy, xfer_out, xfer_in,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        svc.recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
            .await
            .unwrap();

        // Find Account B's final snapshot (latest date)
        let acc_b_snaps = snapshot_repo
            .get_snapshots_by_account("acc_b", None, None)
            .unwrap();
        let acc_b_snap = acc_b_snaps
            .iter()
            .max_by_key(|s| s.snapshot_date)
            .expect("Account B should have a snapshot");

        let pos = acc_b_snap
            .positions
            .get("AAPL")
            .expect("Account B should have AAPL position after transfer");

        assert_eq!(pos.quantity, dec!(10), "Should have 10 shares");
        // Cost basis must be preserved from the original buy: 10 * $100 = $1000
        // If ordering were wrong, this would be 0 (fallback with no unit_price)
        assert_eq!(
            pos.total_cost_basis,
            dec!(1000),
            "Cost basis must be preserved from original buy, not zero"
        );

        // Account A should have no position
        let acc_a_snaps = snapshot_repo
            .get_snapshots_by_account("acc_a", None, None)
            .unwrap();
        let acc_a_snap = acc_a_snaps
            .iter()
            .max_by_key(|s| s.snapshot_date)
            .expect("Account A should have a snapshot");

        let pos_a = acc_a_snap.positions.get("AAPL");
        assert!(
            pos_a.is_none() || pos_a.unwrap().quantity == dec!(0),
            "Account A should have 0 AAPL after transfer out"
        );
    }

    /// Integration test for transfer chain: A→B→C on the same day.
    /// Tests that the topological sort handles multi-hop dependencies.
    #[tokio::test]
    async fn test_transfer_chain_a_to_b_to_c_same_day() {
        let base = Arc::new(RwLock::new("USD".to_string()));

        let mut account_repo = MockAccountRepository::new();
        let acc_a = create_test_account("acc_a", "USD", "Account A");
        let acc_b = create_test_account("acc_b", "USD", "Account B");
        let acc_c = create_test_account("acc_c", "USD", "Account C");
        account_repo.add_account(acc_a.clone());
        account_repo.add_account(acc_b.clone());
        account_repo.add_account(acc_c.clone());

        let d1 = NaiveDate::from_ymd_opt(2025, 1, 10).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();

        // Day 1: Buy 10 AAPL @ $50 in Account A
        let buy = create_test_activity(
            "buy1",
            "acc_a",
            Some("AAPL"),
            "BUY",
            d1,
            Some(dec!(10)),
            Some(dec!(50)),
            Some(dec!(500)),
            "USD",
        );

        // Day 2: A→B (grp1), then B→C (grp2), all same day
        let mut xfer_out_a = create_test_activity(
            "xo_a",
            "acc_a",
            Some("AAPL"),
            "TRANSFER_OUT",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_out_a.source_group_id = Some("grp1".to_string());

        let mut xfer_in_b = create_test_activity(
            "xi_b",
            "acc_b",
            Some("AAPL"),
            "TRANSFER_IN",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_in_b.source_group_id = Some("grp1".to_string());

        let mut xfer_out_b = create_test_activity(
            "xo_b",
            "acc_b",
            Some("AAPL"),
            "TRANSFER_OUT",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_out_b.source_group_id = Some("grp2".to_string());

        let mut xfer_in_c = create_test_activity(
            "xi_c",
            "acc_c",
            Some("AAPL"),
            "TRANSFER_IN",
            d2,
            Some(dec!(10)),
            None,
            None,
            "USD",
        );
        xfer_in_c.source_group_id = Some("grp2".to_string());

        let activity_repo = Arc::new(MockActivityRepositoryWithData::new(vec![
            buy, xfer_out_a, xfer_in_b, xfer_out_b, xfer_in_c,
        ]));
        let fx = Arc::new(MockFxService::new());
        let snapshot_repo = Arc::new(MockSnapshotRepository::new());
        let asset_repo = Arc::new(MockAssetRepository::new());

        let svc = SnapshotService::new(
            base,
            Arc::new(account_repo),
            activity_repo,
            snapshot_repo.clone(),
            asset_repo,
            fx,
        );

        svc.recalculate_holdings_snapshots(None, SnapshotRecalcMode::Full)
            .await
            .unwrap();

        // Account C should end up with the original cost basis
        let acc_c_snaps = snapshot_repo
            .get_snapshots_by_account("acc_c", None, None)
            .unwrap();
        let acc_c_snap = acc_c_snaps
            .iter()
            .max_by_key(|s| s.snapshot_date)
            .expect("Account C should have a snapshot");

        let pos_c = acc_c_snap
            .positions
            .get("AAPL")
            .expect("Account C should have AAPL");
        assert_eq!(pos_c.quantity, dec!(10));
        assert_eq!(
            pos_c.total_cost_basis,
            dec!(500),
            "Cost basis must carry through A→B→C chain: 10 * $50 = $500"
        );
    }
}
