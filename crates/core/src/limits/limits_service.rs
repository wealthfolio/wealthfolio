use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use chrono::{DateTime, TimeZone, Utc};
use rust_decimal::Decimal;

use crate::accounts::{account_supports_purpose, AccountPurpose, AccountServiceTrait};
use crate::activities::ActivityRepositoryTrait;
use crate::errors::{Error, Result, ValidationError};
use crate::fx::FxServiceTrait;
use crate::utils::time_utils::{
    activity_date_in_tz, local_date_start_utc, local_year_utc_bounds,
    parse_user_timezone_or_default, user_date_from_utc,
};

use super::limits_model::{
    AccountDeposit, ContributionActivity, ContributionActivityDetail, ContributionLimit,
    ContributionLimitDetails, ContributionTreatment, DepositsCalculation, NewContributionLimit,
    MAX_CONTRIBUTION_YEAR, MIN_CONTRIBUTION_YEAR,
};
use super::limits_traits::{ContributionLimitRepositoryTrait, ContributionLimitServiceTrait};
use async_trait::async_trait;

pub struct ContributionLimitService {
    fx_service: Arc<dyn FxServiceTrait>,
    limit_repository: Arc<dyn ContributionLimitRepositoryTrait>,
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    timezone: Arc<RwLock<String>>,
}

impl ContributionLimitService {
    fn validate_year(year: i32) -> Result<()> {
        if !(MIN_CONTRIBUTION_YEAR..=MAX_CONTRIBUTION_YEAR).contains(&year) {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Contribution year must be between {MIN_CONTRIBUTION_YEAR} and {MAX_CONTRIBUTION_YEAR}"
            ))));
        }
        Ok(())
    }

    pub fn new(
        fx_service: Arc<dyn FxServiceTrait>,
        limit_repository: Arc<dyn ContributionLimitRepositoryTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
    ) -> Self {
        Self::new_with_timezone(
            fx_service,
            limit_repository,
            activity_repository,
            Arc::new(RwLock::new(String::new())),
        )
    }

    pub fn new_with_timezone(
        fx_service: Arc<dyn FxServiceTrait>,
        limit_repository: Arc<dyn ContributionLimitRepositoryTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        ContributionLimitService {
            fx_service,
            limit_repository,
            activity_repository,
            timezone,
        }
    }

    fn user_timezone(&self) -> chrono_tz::Tz {
        parse_user_timezone_or_default(
            &self
                .timezone
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// Whether the dates are the form's former defaults for `year`: noon UTC on
    /// 1 January and 31 December. At UTC+12 and beyond those fall on the next
    /// local day, so they are counted as the year instead.
    fn has_former_default_dates(year: i32, start: &str, end: &str) -> bool {
        let is_noon_utc = |date: &str, month: u32, day: u32| {
            let noon = Utc.with_ymd_and_hms(year, month, day, 12, 0, 0).single();
            noon.is_some()
                && DateTime::parse_from_rfc3339(date)
                    .ok()
                    .map(|dt| dt.with_timezone(&Utc))
                    == noon
        };
        is_noon_utc(start, 1, 1) && is_noon_utc(end, 12, 31)
    }

    /// Checks if an activity has metadata.flow.is_external = true
    fn is_external(activity: &ContributionActivity) -> bool {
        activity
            .metadata
            .as_ref()
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .and_then(|v| v.get("flow")?.get("is_external")?.as_bool())
            .unwrap_or(false)
    }

    fn account_ids(limit: &ContributionLimit) -> Vec<String> {
        limit
            .account_ids
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn period(&self, limit: &ContributionLimit) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
        let year = limit.contribution_year;
        if let (Some(start), Some(end)) = (&limit.start_date, &limit.end_date) {
            if !Self::has_former_default_dates(year, start, end) {
                let tz = self.user_timezone();
                let day = |date: &str| {
                    DateTime::parse_from_rfc3339(date)
                        .map(|dt| user_date_from_utc(dt.with_timezone(&Utc), tz))
                        .map_err(|e| Error::Validation(ValidationError::DateTimeParse(e)))
                };
                let start = local_date_start_utc(day(start)?, tz)?;
                let day_after_end = day(end)?
                    .succ_opt()
                    .expect("an RFC 3339 year ends far before chrono's last date");
                return Ok((start, local_date_start_utc(day_after_end, tz)?));
            }
        }
        local_year_utc_bounds(year, self.user_timezone())
    }

    fn classified_activities<'a>(
        activities: &'a [ContributionActivity],
        account_ids: &[String],
    ) -> Vec<(&'a ContributionActivity, ContributionTreatment)> {
        let limit_accounts: HashSet<&str> = account_ids.iter().map(String::as_str).collect();
        let transfer_out_accounts: HashMap<&str, &str> = activities
            .iter()
            .filter(|a| a.activity_type == "TRANSFER_OUT")
            .filter_map(|a| {
                a.source_group_id
                    .as_deref()
                    .map(|group| (group, a.account_id.as_str()))
            })
            .collect();
        activities
            .iter()
            .filter(|a| a.activity_type != "TRANSFER_OUT")
            .map(|activity| {
                let treatment = match activity.activity_type.as_str() {
                    "DEPOSIT" => ContributionTreatment::Counted,
                    "TRANSFER_IN" => match &activity.source_group_id {
                        Some(group)
                            if transfer_out_accounts
                                .get(group.as_str())
                                .is_some_and(|account| limit_accounts.contains(account)) =>
                        {
                            ContributionTreatment::InternalTransfer
                        }
                        Some(_) => ContributionTreatment::Counted,
                        None if Self::is_external(activity) => ContributionTreatment::Counted,
                        None => ContributionTreatment::NotExternal,
                    },
                    "CREDIT" if Self::is_external(activity) => ContributionTreatment::Counted,
                    _ => ContributionTreatment::NotExternal,
                };
                (activity, treatment)
            })
            .collect()
    }

    fn evaluate_contributions_by_period(
        &self,
        account_ids: &[String],
        start_utc: DateTime<Utc>,
        end_exclusive_utc: DateTime<Utc>,
        base_currency: &str,
        excluded_ids: &HashSet<String>,
    ) -> Result<(DepositsCalculation, Vec<ContributionActivityDetail>)> {
        let mut calculation = DepositsCalculation {
            total: Decimal::ZERO,
            base_currency: base_currency.to_string(),
            by_account: HashMap::new(),
        };
        if account_ids.is_empty() {
            return Ok((calculation, Vec::new()));
        }
        let activities = self.activity_repository.get_contribution_activities(
            account_ids,
            start_utc,
            end_exclusive_utc,
        )?;
        let mut details = Vec::new();
        let tz = self.user_timezone();
        for (activity, automatic_treatment) in Self::classified_activities(&activities, account_ids)
        {
            let can_exclude = automatic_treatment == ContributionTreatment::Counted;
            let treatment = if can_exclude && excluded_ids.contains(&activity.id) {
                ContributionTreatment::ExcludedByUser
            } else {
                automatic_treatment
            };
            let mut counted_amount = Decimal::ZERO;
            if treatment == ContributionTreatment::Counted {
                let amount = activity.amount.ok_or_else(|| {
                    Error::Validation(ValidationError::MissingField(format!(
                        "Final amount missing in {} activity for account {}",
                        activity.activity_type, activity.account_id
                    )))
                })?;
                counted_amount = self.fx_service.convert_currency_for_date(
                    amount,
                    &activity.currency,
                    base_currency,
                    activity_date_in_tz(activity.activity_instant, tz),
                )?;
                calculation.total += counted_amount;
                let entry = calculation
                    .by_account
                    .entry(activity.account_id.clone())
                    .or_insert_with(|| AccountDeposit {
                        amount: Decimal::ZERO,
                        currency: activity.currency.clone(),
                        converted_amount: Decimal::ZERO,
                    });
                entry.amount += amount;
                entry.converted_amount += counted_amount;
                entry.currency = activity.currency.clone();
            }
            details.push(ContributionActivityDetail {
                id: activity.id.clone(),
                account_id: activity.account_id.clone(),
                activity_type: activity.activity_type.clone(),
                activity_instant: activity.activity_instant,
                amount: activity.amount,
                currency: activity.currency.clone(),
                counted_amount,
                treatment,
                can_exclude,
            });
        }
        details.sort_by(|a, b| {
            b.activity_instant
                .cmp(&a.activity_instant)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok((calculation, details))
    }

    #[cfg(test)]
    fn calculate_contributions_by_period(
        &self,
        account_ids: &[String],
        start_utc: DateTime<Utc>,
        end_exclusive_utc: DateTime<Utc>,
        base_currency: &str,
    ) -> Result<DepositsCalculation> {
        self.evaluate_contributions_by_period(
            account_ids,
            start_utc,
            end_exclusive_utc,
            base_currency,
            &HashSet::new(),
        )
        .map(|(calculation, _)| calculation)
    }
}

/// Checks the accounts a limit lists before it is saved. Ids of deleted
/// accounts are dropped: limits saved before deletes cleaned them up can still
/// list one, and nothing is counted for it. An account of a type contribution
/// limits don't count is refused.
pub fn check_contribution_limit_accounts(
    accounts: &dyn AccountServiceTrait,
    limit: &mut NewContributionLimit,
) -> Result<()> {
    let Some(account_ids) = limit.account_ids.as_deref() else {
        return Ok(());
    };
    let ids: Vec<String> = account_ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(());
    }

    let found = accounts.get_accounts_by_ids(&ids)?;
    let unsupported: Vec<&str> = found
        .iter()
        .filter(|account| {
            !account_supports_purpose(&account.account_type, AccountPurpose::ContributionLimits)
        })
        .map(|account| account.id.as_str())
        .collect();
    if !unsupported.is_empty() {
        return Err(Error::Validation(ValidationError::InvalidInput(format!(
            "Contribution limits do not support account(s): {}",
            unsupported.join(", ")
        ))));
    }

    let existing: HashSet<&str> = found.iter().map(|account| account.id.as_str()).collect();
    if ids.iter().any(|id| !existing.contains(id.as_str())) {
        let kept: Vec<&str> = ids
            .iter()
            .map(String::as_str)
            .filter(|id| existing.contains(id))
            .collect();
        limit.account_ids = Some(kept.join(","));
    }
    Ok(())
}

#[async_trait]
impl ContributionLimitServiceTrait for ContributionLimitService {
    fn get_contribution_limits(&self) -> Result<Vec<ContributionLimit>> {
        self.limit_repository.get_contribution_limits()
    }

    async fn create_contribution_limit(
        &self,
        new_limit: NewContributionLimit,
    ) -> Result<ContributionLimit> {
        Self::validate_year(new_limit.contribution_year)?;
        self.limit_repository
            .create_contribution_limit(new_limit)
            .await
    }

    async fn update_contribution_limit(
        &self,
        id: &str,
        updated_limit: NewContributionLimit,
    ) -> Result<ContributionLimit> {
        Self::validate_year(updated_limit.contribution_year)?;
        self.limit_repository
            .update_contribution_limit(id, updated_limit)
            .await
    }

    async fn delete_contribution_limit(&self, id: &str) -> Result<()> {
        self.limit_repository.delete_contribution_limit(id).await
    }

    fn get_contribution_limit_details(
        &self,
        limit_id: &str,
        base_currency: &str,
    ) -> Result<ContributionLimitDetails> {
        let limit = self.limit_repository.get_contribution_limit(limit_id)?;
        let excluded = self.limit_repository.get_excluded_activity_ids(limit_id)?;
        let account_ids = Self::account_ids(&limit);
        if account_ids.is_empty() {
            return Ok(ContributionLimitDetails {
                limit,
                calculation: DepositsCalculation {
                    total: Decimal::ZERO,
                    base_currency: base_currency.to_string(),
                    by_account: HashMap::new(),
                },
                activities: Vec::new(),
            });
        }
        let (start, end) = self.period(&limit)?;
        let (calculation, activities) = self.evaluate_contributions_by_period(
            &account_ids,
            start,
            end,
            base_currency,
            &excluded,
        )?;
        Ok(ContributionLimitDetails {
            limit,
            calculation,
            activities,
        })
    }

    async fn set_contribution_activity_excluded(
        &self,
        limit_id: &str,
        activity_id: &str,
        excluded: bool,
    ) -> Result<()> {
        let limit = self.limit_repository.get_contribution_limit(limit_id)?;
        let account_ids = Self::account_ids(&limit);
        let (start, end) = self.period(&limit)?;
        let activities =
            self.activity_repository
                .get_contribution_activities(&account_ids, start, end)?;
        let can_exclude = Self::classified_activities(&activities, &account_ids)
            .iter()
            .any(|(activity, treatment)| {
                activity.id == activity_id && *treatment == ContributionTreatment::Counted
            });
        if !can_exclude {
            return Err(ValidationError::InvalidInput(
                "Only contribution-eligible activities in this limit can be excluded or restored"
                    .to_string(),
            )
            .into());
        }
        self.limit_repository
            .set_activity_excluded(limit_id, activity_id, excluded)
            .await
    }

    fn calculate_deposits_for_contribution_limit(
        &self,
        limit_id: &str,
        base_currency: &str,
    ) -> Result<DepositsCalculation> {
        self.get_contribution_limit_details(limit_id, base_currency)
            .map(|details| details.calculation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::{
        Activity, ActivityBulkMutationResult, ActivityRepositoryTrait, ActivitySearchResponse,
        ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, IncomeData, NewActivity,
        Sort,
    };
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use chrono::{DateTime, NaiveDate, TimeZone, Utc};
    use rust_decimal_macros::dec;
    use std::sync::RwLock;

    // ============== Mock Repositories ==============

    struct MockActivityRepository {
        activities: RwLock<Vec<ContributionActivity>>,
    }

    impl MockActivityRepository {
        fn new(activities: Vec<ContributionActivity>) -> Self {
            Self {
                activities: RwLock::new(activities),
            }
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepository {
        fn get_contribution_activities(
            &self,
            account_ids: &[String],
            start_utc: DateTime<Utc>,
            end_exclusive_utc: DateTime<Utc>,
        ) -> Result<Vec<ContributionActivity>> {
            let account_set: HashSet<&str> = account_ids.iter().map(|s| s.as_str()).collect();
            Ok(self
                .activities
                .read()
                .unwrap()
                .iter()
                .filter(|a| {
                    account_set.contains(a.account_id.as_str())
                        && a.activity_instant >= start_utc
                        && a.activity_instant < end_exclusive_utc
                })
                .cloned()
                .collect())
        }

        // Stub implementations for other trait methods
        fn get_activity(&self, _: &str) -> Result<Activity> {
            unimplemented!()
        }
        fn get_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_id(&self, _: &str) -> Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_ids(&self, _: &[String]) -> Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_trading_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<NaiveDate>,
            _: Option<NaiveDate>,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
        ) -> Result<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _: NewActivity) -> Result<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _: ActivityUpdate) -> Result<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _: String) -> Result<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> Result<ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _: Vec<NewActivity>) -> Result<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(&self, _: Option<&[String]>) -> Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }
        fn get_import_mapping(
            &self,
            _: &str,
            _context_kind: &str,
        ) -> Result<Option<ImportMapping>> {
            unimplemented!()
        }
        async fn save_import_mapping(&self, _: &ImportMapping) -> Result<()> {
            unimplemented!()
        }
        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> Result<()> {
            unimplemented!()
        }
        fn list_import_templates(&self) -> Result<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }
        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            unimplemented!()
        }
        async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
            unimplemented!()
        }
        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }
        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }
        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> Result<()> {
            Ok(())
        }
        fn get_income_activities_data(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<IncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
            unimplemented!()
        }
        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            unimplemented!()
        }
        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            unimplemented!()
        }
        fn check_existing_duplicates(&self, _: &[String]) -> Result<HashMap<String, String>> {
            unimplemented!()
        }
        async fn bulk_upsert(&self, _: Vec<ActivityUpsert>) -> Result<BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
            Ok(0)
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> Result<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    struct MockFxService;

    #[async_trait]
    impl FxServiceTrait for MockFxService {
        fn initialize(&self) -> Result<()> {
            Ok(())
        }

        fn get_historical_rates(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _days: i64,
        ) -> Result<Vec<ExchangeRate>> {
            unimplemented!()
        }

        fn get_latest_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<Decimal> {
            unimplemented!()
        }

        fn get_exchange_rate_for_date(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            unimplemented!()
        }

        fn convert_currency(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            // Simple mock: 1 CAD = 0.75 USD, 1 EUR = 1.1 USD
            if from_currency == to_currency {
                return Ok(amount);
            }
            let rate = match (from_currency, to_currency) {
                ("CAD", "USD") => dec!(0.75),
                ("USD", "CAD") => dec!(1.33),
                ("EUR", "USD") => dec!(1.1),
                ("USD", "EUR") => dec!(0.91),
                _ => dec!(1.0),
            };
            Ok(amount * rate)
        }

        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            self.convert_currency(amount, from_currency, to_currency)
        }

        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            unimplemented!()
        }

        async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> Result<ExchangeRate> {
            unimplemented!()
        }

        async fn update_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _rate: Decimal,
        ) -> Result<ExchangeRate> {
            unimplemented!()
        }

        async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn register_currency_pair(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockLimitRepository {
        limit: Option<ContributionLimit>,
    }

    #[async_trait]
    impl ContributionLimitRepositoryTrait for MockLimitRepository {
        fn get_excluded_activity_ids(&self, _: &str) -> Result<HashSet<String>> {
            Ok(HashSet::new())
        }
        async fn set_activity_excluded(&self, _: &str, _: &str, _: bool) -> Result<()> {
            unimplemented!()
        }

        fn get_contribution_limits(&self) -> Result<Vec<ContributionLimit>> {
            unimplemented!()
        }
        fn get_contribution_limit(&self, _: &str) -> Result<ContributionLimit> {
            Ok(self.limit.clone().expect("the test sets a limit"))
        }
        async fn create_contribution_limit(
            &self,
            _: NewContributionLimit,
        ) -> Result<ContributionLimit> {
            unimplemented!()
        }
        async fn update_contribution_limit(
            &self,
            _: &str,
            _: NewContributionLimit,
        ) -> Result<ContributionLimit> {
            unimplemented!()
        }
        async fn delete_contribution_limit(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
    }

    // ============== Helper Functions ==============

    fn external_metadata() -> Option<String> {
        Some(r#"{"flow":{"is_external":true}}"#.to_string())
    }

    fn internal_metadata() -> Option<String> {
        Some(r#"{"flow":{"is_external":false}}"#.to_string())
    }

    /// Default activity instant for tests (2025-06-15T12:00:00Z)
    fn default_instant() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2025, 6, 15, 12, 0, 0).unwrap()
    }

    fn make_service(activities: Vec<ContributionActivity>) -> ContributionLimitService {
        ContributionLimitService::new(
            Arc::new(MockFxService),
            Arc::new(MockLimitRepository::default()),
            Arc::new(MockActivityRepository::new(activities)),
        )
    }

    #[tokio::test]
    async fn unsupported_contribution_years_are_rejected_before_persistence() {
        let service = make_service(Vec::new());
        for year in [
            MIN_CONTRIBUTION_YEAR - 1,
            MAX_CONTRIBUTION_YEAR + 1,
            i32::MAX,
        ] {
            let limit = NewContributionLimit {
                id: None,
                group_name: "TFSA".to_string(),
                contribution_year: year,
                limit_amount: 7000.0,
                account_ids: None,
                start_date: None,
                end_date: None,
                is_recurring: false,
            };
            assert!(matches!(
                service.create_contribution_limit(limit.clone()).await,
                Err(Error::Validation(ValidationError::InvalidInput(_)))
            ));
            assert!(matches!(
                service.update_contribution_limit("limit", limit).await,
                Err(Error::Validation(ValidationError::InvalidInput(_)))
            ));
        }
        for year in [MIN_CONTRIBUTION_YEAR, MAX_CONTRIBUTION_YEAR] {
            assert!(ContributionLimitService::validate_year(year).is_ok());
        }
    }

    fn make_service_with_timezone(
        activities: Vec<ContributionActivity>,
        timezone: &str,
    ) -> ContributionLimitService {
        ContributionLimitService::new_with_timezone(
            Arc::new(MockFxService),
            Arc::new(MockLimitRepository::default()),
            Arc::new(MockActivityRepository::new(activities)),
            Arc::new(RwLock::new(timezone.to_string())),
        )
    }

    fn dates() -> (DateTime<Utc>, DateTime<Utc>) {
        let start = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        (start, end)
    }

    // ============== Tests ==============

    #[test]
    fn test_empty_accounts_returns_zero() {
        let service = make_service(vec![]);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&[], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
        assert!(result.by_account.is_empty());
    }

    #[test]
    fn test_no_activities_returns_zero() {
        let service = make_service(vec![]);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
        assert!(result.by_account.is_empty());
    }

    #[test]
    fn test_deposit_always_counts() {
        let activities = vec![ContributionActivity {
            id: "activity-1".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "DEPOSIT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: None,
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, dec!(1000));
        assert_eq!(result.by_account.get("acc1").unwrap().amount, dec!(1000));
    }

    #[test]
    fn test_multiple_deposits_sum_correctly() {
        let activities = vec![
            ContributionActivity {
                id: "activity-2".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(500)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            ContributionActivity {
                id: "activity-3".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(300)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, dec!(800));
    }

    #[test]
    fn test_transfer_in_without_external_flag_not_counted() {
        let activities = vec![ContributionActivity {
            id: "activity-4".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: None, // No metadata = internal
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_transfer_in_with_external_false_not_counted() {
        let activities = vec![ContributionActivity {
            id: "activity-5".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: internal_metadata(),
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_transfer_in_external_no_link_counts() {
        let activities = vec![ContributionActivity {
            id: "activity-6".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: external_metadata(),
            source_group_id: None, // From outside Wealthfolio
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, dec!(1000));
    }

    #[test]
    fn test_transfer_in_external_with_link_to_same_limit_not_counted() {
        // Both accounts in same limit - internal transfer within the limit
        let activities = vec![
            ContributionActivity {
                id: "activity-7".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: Some("group1".to_string()),
            },
            ContributionActivity {
                id: "activity-8".to_string(),
                account_id: "acc2".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: Some("group1".to_string()),
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        // Both acc1 and acc2 are in the limit
        let result = service
            .calculate_contributions_by_period(
                &["acc1".to_string(), "acc2".to_string()],
                start,
                end,
                "USD",
            )
            .unwrap();

        // Should not count - it's internal to the limit
        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_transfer_in_external_with_link_to_outside_limit_counts() {
        // TRANSFER_OUT from account outside the limit
        let activities = vec![
            ContributionActivity {
                id: "activity-9".to_string(),
                account_id: "acc_outside".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: Some("group1".to_string()),
            },
            ContributionActivity {
                id: "activity-10".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: Some("group1".to_string()),
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        // Only acc1 is in the limit (acc_outside is not)
        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        // Should count - source is outside this limit
        assert_eq!(result.total, dec!(1000));
    }

    #[test]
    fn test_credit_without_external_flag_not_counted() {
        let activities = vec![ContributionActivity {
            id: "activity-11".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "CREDIT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: None,
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_credit_with_external_true_counts() {
        let activities = vec![ContributionActivity {
            id: "activity-12".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "CREDIT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: external_metadata(),
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, dec!(100));
    }

    #[test]
    fn test_credit_with_external_false_not_counted() {
        let activities = vec![ContributionActivity {
            id: "activity-13".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "CREDIT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: internal_metadata(),
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_transfer_out_never_counts() {
        let activities = vec![ContributionActivity {
            id: "activity-14".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_OUT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: external_metadata(),
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_currency_conversion() {
        let activities = vec![ContributionActivity {
            id: "activity-15".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "DEPOSIT".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "CAD".to_string(),
            metadata: None,
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        // 1000 CAD * 0.75 = 750 USD
        assert_eq!(result.total, dec!(750));
        assert_eq!(result.by_account.get("acc1").unwrap().amount, dec!(1000));
        assert_eq!(
            result.by_account.get("acc1").unwrap().converted_amount,
            dec!(750)
        );
    }

    #[test]
    fn test_multiple_accounts_tracked_separately() {
        let activities = vec![
            ContributionActivity {
                id: "activity-16".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            ContributionActivity {
                id: "activity-17".to_string(),
                account_id: "acc2".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(500)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(
                &["acc1".to_string(), "acc2".to_string()],
                start,
                end,
                "USD",
            )
            .unwrap();

        assert_eq!(result.total, dec!(1500));
        assert_eq!(result.by_account.get("acc1").unwrap().amount, dec!(1000));
        assert_eq!(result.by_account.get("acc2").unwrap().amount, dec!(500));
    }

    #[test]
    fn test_mixed_activity_types() {
        let activities = vec![
            // Counts: deposit
            ContributionActivity {
                id: "activity-18".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            // Counts: external transfer in
            ContributionActivity {
                id: "activity-19".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(500)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: None,
            },
            // Counts: external credit
            ContributionActivity {
                id: "activity-20".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "CREDIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(100)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: None,
            },
            // Does NOT count: internal transfer in
            ContributionActivity {
                id: "activity-21".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(200)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            // Does NOT count: internal credit
            ContributionActivity {
                id: "activity-22".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "CREDIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(50)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            // Does NOT count: transfer out
            ContributionActivity {
                id: "activity-23".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(300)),
                currency: "USD".to_string(),
                metadata: external_metadata(),
                source_group_id: None,
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        // 1000 (deposit) + 500 (external transfer) + 100 (external credit) = 1600
        assert_eq!(result.total, dec!(1600));
    }

    #[test]
    fn test_missing_final_amount_is_an_error() {
        let activities = vec![ContributionActivity {
            id: "activity-24".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "DEPOSIT".to_string(),
            activity_instant: default_instant(),
            amount: None, // Missing amount
            currency: "USD".to_string(),
            metadata: None,
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let error = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("Final amount missing in DEPOSIT activity for account acc1"));
    }

    #[test]
    fn test_malformed_metadata_treated_as_internal() {
        let activities = vec![ContributionActivity {
            id: "activity-25".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(1000)),
            currency: "USD".to_string(),
            metadata: Some("invalid json".to_string()),
            source_group_id: None,
        }];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(&["acc1".to_string()], start, end, "USD")
            .unwrap();

        // Malformed metadata = is_external defaults to false = not counted
        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_is_external_helper() {
        // Test the is_external helper directly
        let external = ContributionActivity {
            id: "activity-26".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: external_metadata(),
            source_group_id: None,
        };
        assert!(ContributionLimitService::is_external(&external));

        let internal = ContributionActivity {
            id: "activity-27".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: internal_metadata(),
            source_group_id: None,
        };
        assert!(!ContributionLimitService::is_external(&internal));

        let no_metadata = ContributionActivity {
            id: "activity-28".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "TRANSFER_IN".to_string(),
            activity_instant: default_instant(),
            amount: Some(dec!(100)),
            currency: "USD".to_string(),
            metadata: None,
            source_group_id: None,
        };
        assert!(!ContributionLimitService::is_external(&no_metadata));
    }

    #[test]
    fn test_complex_scenario_tfsa_contribution_room() {
        // Simulates a TFSA with 2 accounts
        // - acc1: TFSA Savings
        // - acc2: TFSA Investment
        //
        // Activities:
        // 1. Deposit $5000 to acc1 (counts)
        // 2. Transfer $3000 from acc1 to acc2 internally (does NOT count)
        // 3. External transfer $2000 from non-TFSA to acc2 (counts)
        // 4. Credit/rebate $50 to acc1 (internal, does NOT count)
        // 5. Bonus credit $100 to acc1 (external, counts)
        let activities = vec![
            // 1. Deposit
            ContributionActivity {
                id: "activity-29".to_string(),
                account_id: "tfsa_savings".to_string(),
                activity_type: "DEPOSIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(5000)),
                currency: "CAD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            // 2. Internal transfer OUT
            ContributionActivity {
                id: "activity-30".to_string(),
                account_id: "tfsa_savings".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(3000)),
                currency: "CAD".to_string(),
                metadata: external_metadata(), // Even if marked external
                source_group_id: Some("internal_transfer_1".to_string()),
            },
            // 2. Internal transfer IN
            ContributionActivity {
                id: "activity-31".to_string(),
                account_id: "tfsa_invest".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(3000)),
                currency: "CAD".to_string(),
                metadata: external_metadata(), // Even if marked external
                source_group_id: Some("internal_transfer_1".to_string()),
            },
            // 3. External transfer from non-TFSA (not in limit accounts)
            ContributionActivity {
                id: "activity-32".to_string(),
                account_id: "tfsa_invest".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(2000)),
                currency: "CAD".to_string(),
                metadata: external_metadata(),
                source_group_id: Some("external_transfer_1".to_string()),
            },
            // The corresponding TRANSFER_OUT from non-TFSA account (not in our limit)
            // This won't be fetched because non_tfsa is not in account_ids
            // 4. Internal credit/rebate
            ContributionActivity {
                id: "activity-33".to_string(),
                account_id: "tfsa_savings".to_string(),
                activity_type: "CREDIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(50)),
                currency: "CAD".to_string(),
                metadata: None, // Internal
                source_group_id: None,
            },
            // 5. External bonus
            ContributionActivity {
                id: "activity-34".to_string(),
                account_id: "tfsa_savings".to_string(),
                activity_type: "CREDIT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(100)),
                currency: "CAD".to_string(),
                metadata: external_metadata(),
                source_group_id: None,
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(
                &["tfsa_savings".to_string(), "tfsa_invest".to_string()],
                start,
                end,
                "CAD",
            )
            .unwrap();

        // Expected: 5000 (deposit) + 2000 (external transfer) + 100 (external credit) = 7100
        assert_eq!(result.total, dec!(7100));
        assert_eq!(
            result.by_account.get("tfsa_savings").unwrap().amount,
            dec!(5100)
        ); // 5000 + 100
        assert_eq!(
            result.by_account.get("tfsa_invest").unwrap().amount,
            dec!(2000)
        );
    }

    #[test]
    fn test_internal_transfer_from_outside_limit_counts_without_external_flag() {
        // Reproduces GitHub issue #775:
        // Internal transfer (no is_external metadata) from a Cash account
        // outside the limit into a Registered account inside the limit.
        // This should count because the source is outside the limit's scope.
        let activities = vec![
            // TRANSFER_OUT from Cash account (not in the limit)
            ContributionActivity {
                id: "activity-35".to_string(),
                account_id: "cash_account".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "CAD".to_string(),
                metadata: None, // No external flag — it's an internal transfer
                source_group_id: Some("pair1".to_string()),
            },
            // TRANSFER_IN to Registered account (in the limit)
            ContributionActivity {
                id: "activity-36".to_string(),
                account_id: "registered".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(1000)),
                currency: "CAD".to_string(),
                metadata: None, // No external flag
                source_group_id: Some("pair1".to_string()),
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        // Only the registered account is in the limit
        let result = service
            .calculate_contributions_by_period(&["registered".to_string()], start, end, "CAD")
            .unwrap();

        // Should count — source account is outside this limit
        assert_eq!(result.total, dec!(1000));
    }

    #[test]
    fn test_internal_transfer_within_limit_not_counted_without_external_flag() {
        // Internal transfer between two accounts both in the limit — should NOT count.
        let activities = vec![
            ContributionActivity {
                id: "activity-37".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(500)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: Some("pair1".to_string()),
            },
            ContributionActivity {
                id: "activity-38".to_string(),
                account_id: "acc2".to_string(),
                activity_type: "TRANSFER_IN".to_string(),
                activity_instant: default_instant(),
                amount: Some(dec!(500)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: Some("pair1".to_string()),
            },
        ];
        let service = make_service(activities);
        let (start, end) = dates();

        let result = service
            .calculate_contributions_by_period(
                &["acc1".to_string(), "acc2".to_string()],
                start,
                end,
                "USD",
            )
            .unwrap();

        assert_eq!(result.total, Decimal::ZERO);
    }

    #[test]
    fn test_contribution_year_boundary_utc_minus_3() {
        let activities = vec![
            ContributionActivity {
                id: "activity-39".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                // 2025-12-31 23:30 local for UTC-3
                activity_instant: Utc.with_ymd_and_hms(2026, 1, 1, 2, 30, 0).unwrap(),
                amount: Some(dec!(100)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            ContributionActivity {
                id: "activity-40".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                // 2026-01-01 00:30 local for UTC-3 (excluded from 2025)
                activity_instant: Utc.with_ymd_and_hms(2026, 1, 1, 3, 30, 0).unwrap(),
                amount: Some(dec!(50)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
        ];
        let service = make_service_with_timezone(activities, "America/Sao_Paulo");
        let (start_utc, end_exclusive_utc) =
            local_year_utc_bounds(2025, service.user_timezone()).expect("timezone bounds");

        let result = service
            .calculate_contributions_by_period(
                &["acc1".to_string()],
                start_utc,
                end_exclusive_utc,
                "USD",
            )
            .unwrap();

        assert_eq!(result.total, dec!(100));
    }

    #[test]
    fn test_contribution_year_boundary_utc_plus_14() {
        let activities = vec![
            ContributionActivity {
                id: "activity-41".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                // 2025-01-01 01:00 local for UTC+14
                activity_instant: Utc.with_ymd_and_hms(2024, 12, 31, 11, 0, 0).unwrap(),
                amount: Some(dec!(100)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            ContributionActivity {
                id: "activity-42".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                // 2025-12-31 23:30 local for UTC+14
                activity_instant: Utc.with_ymd_and_hms(2025, 12, 31, 9, 30, 0).unwrap(),
                amount: Some(dec!(40)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
            ContributionActivity {
                id: "activity-43".to_string(),
                account_id: "acc1".to_string(),
                activity_type: "DEPOSIT".to_string(),
                // 2026-01-01 00:30 local for UTC+14 (excluded from 2025)
                activity_instant: Utc.with_ymd_and_hms(2025, 12, 31, 10, 30, 0).unwrap(),
                amount: Some(dec!(25)),
                currency: "USD".to_string(),
                metadata: None,
                source_group_id: None,
            },
        ];
        let service = make_service_with_timezone(activities, "Pacific/Kiritimati");
        let (start_utc, end_exclusive_utc) =
            local_year_utc_bounds(2025, service.user_timezone()).expect("timezone bounds");

        let result = service
            .calculate_contributions_by_period(
                &["acc1".to_string()],
                start_utc,
                end_exclusive_utc,
                "USD",
            )
            .unwrap();

        assert_eq!(result.total, dec!(140));
    }

    fn deposit_at(instant: &str, amount: Decimal) -> ContributionActivity {
        ContributionActivity {
            id: "activity-44".to_string(),
            account_id: "acc1".to_string(),
            activity_type: "DEPOSIT".to_string(),
            activity_instant: DateTime::parse_from_rfc3339(instant)
                .unwrap()
                .with_timezone(&Utc),
            amount: Some(amount),
            currency: "USD".to_string(),
            metadata: None,
            source_group_id: None,
        }
    }

    /// Deposits counted by a limit whose dates were saved as `start` and `end`.
    fn dated_limit_total(
        start: &str,
        end: &str,
        timezone: &str,
        activities: Vec<ContributionActivity>,
    ) -> Decimal {
        let now = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let service = ContributionLimitService::new_with_timezone(
            Arc::new(MockFxService),
            Arc::new(MockLimitRepository {
                limit: Some(ContributionLimit {
                    id: "limit1".to_string(),
                    group_name: "TFSA".to_string(),
                    contribution_year: 2026,
                    limit_amount: 7000.0,
                    account_ids: Some("acc1".to_string()),
                    created_at: now,
                    updated_at: now,
                    start_date: Some(start.to_string()),
                    end_date: Some(end.to_string()),
                    is_recurring: false,
                }),
            }),
            Arc::new(MockActivityRepository::new(activities)),
            Arc::new(RwLock::new(timezone.to_string())),
        );
        service
            .calculate_deposits_for_contribution_limit("limit1", "USD")
            .unwrap()
            .total
    }

    #[test]
    fn test_date_range_counts_default_first_and_last_days_whole() {
        // The form's former defaults: noon UTC on 1 January and 31 December.
        let total = dated_limit_total(
            "2026-01-01T12:00:00.000Z",
            "2026-12-31T12:00:00.000Z",
            "UTC",
            vec![
                deposit_at("2025-12-31T23:59:59Z", dec!(1)),
                deposit_at("2026-01-01T00:00:00Z", dec!(10)),
                deposit_at("2026-12-31T18:00:00Z", dec!(100)),
                deposit_at("2027-01-01T00:00:00Z", dec!(1000)),
            ],
        );

        assert_eq!(total, dec!(110));
    }

    #[test]
    fn test_date_range_counts_picked_days_whole_east_of_utc() {
        // 1 April 2026 to 31 March 2027 picked in India: local midnights.
        let total = dated_limit_total(
            "2026-03-31T18:30:00.000Z",
            "2027-03-30T18:30:00.000Z",
            "Asia/Kolkata",
            vec![
                // 31 March 2026, 23:59 local
                deposit_at("2026-03-31T18:29:00Z", dec!(1)),
                // 1 April 2026, 00:00 local
                deposit_at("2026-03-31T18:30:00Z", dec!(10)),
                // 31 March 2027, 09:00 local
                deposit_at("2027-03-31T03:30:00Z", dec!(100)),
                // 1 April 2027, 00:00 local
                deposit_at("2027-03-31T18:30:00Z", dec!(1000)),
            ],
        );

        assert_eq!(total, dec!(110));
    }

    #[test]
    fn test_date_range_counts_picked_days_whole_west_of_utc() {
        // 1 April 2026 to 31 March 2027 picked in New York: local midnights.
        let total = dated_limit_total(
            "2026-04-01T04:00:00.000Z",
            "2027-03-31T04:00:00.000Z",
            "America/New_York",
            vec![
                // 31 March 2026, 23:59 local
                deposit_at("2026-04-01T03:59:00Z", dec!(1)),
                // 1 April 2026, 00:00 local
                deposit_at("2026-04-01T04:00:00Z", dec!(10)),
                // 31 March 2027, 23:59 local
                deposit_at("2027-04-01T03:59:00Z", dec!(100)),
                // 1 April 2027, 00:00 local
                deposit_at("2027-04-01T04:00:00Z", dec!(1000)),
            ],
        );

        assert_eq!(total, dec!(110));
    }

    #[test]
    fn test_date_range_counts_former_defaults_as_the_year_at_utc_plus_13_and_14() {
        // Noon UTC on 1 January is already 2 January at UTC+13 and UTC+14.
        for (timezone, year_start, year_end) in [
            // UTC+13 (summer time)
            (
                "Pacific/Auckland",
                "2025-12-31T11:00:00Z",
                "2026-12-31T11:00:00Z",
            ),
            // UTC+14
            (
                "Pacific/Kiritimati",
                "2025-12-31T10:00:00Z",
                "2026-12-31T10:00:00Z",
            ),
        ] {
            let at = |instant: &str, minutes: i64| {
                (DateTime::parse_from_rfc3339(instant).unwrap()
                    + chrono::Duration::minutes(minutes))
                .to_rfc3339()
            };
            let total = dated_limit_total(
                "2026-01-01T12:00:00.000Z",
                "2026-12-31T12:00:00.000Z",
                timezone,
                vec![
                    deposit_at(&at(year_start, -1), dec!(1)),
                    deposit_at(&at(year_start, 30), dec!(10)),
                    deposit_at(&at(year_end, -30), dec!(100)),
                    deposit_at(year_end, dec!(1000)),
                ],
            );

            assert_eq!(total, dec!(110), "{timezone}");
        }
    }

    #[test]
    fn test_date_range_counts_dst_boundary_days_whole() {
        for (start, next_midnight) in [
            // 8 March 2026: a 23-hour day in New York.
            ("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"),
            // 1 November 2026: a 25-hour day in New York.
            ("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"),
        ] {
            let before = |instant: &str| {
                (DateTime::parse_from_rfc3339(instant).unwrap() - chrono::Duration::milliseconds(1))
                    .to_rfc3339()
            };
            let total = dated_limit_total(
                start,
                start,
                "America/New_York",
                vec![
                    deposit_at(&before(start), dec!(1)),
                    deposit_at(start, dec!(10)),
                    deposit_at(&before(next_midnight), dec!(100)),
                    deposit_at(next_midnight, dec!(1000)),
                ],
            );

            assert_eq!(total, dec!(110), "{start}");
        }
    }

    #[test]
    fn test_date_range_counts_new_local_midnight_defaults_whole() {
        for (timezone, start, end, next_midnight) in [
            (
                "Asia/Kolkata",
                "2025-12-31T18:30:00Z",
                "2026-12-30T18:30:00Z",
                "2026-12-31T18:30:00Z",
            ),
            (
                "America/New_York",
                "2026-01-01T05:00:00Z",
                "2026-12-31T05:00:00Z",
                "2027-01-01T05:00:00Z",
            ),
        ] {
            let before = |instant: &str| {
                (DateTime::parse_from_rfc3339(instant).unwrap() - chrono::Duration::milliseconds(1))
                    .to_rfc3339()
            };
            let total = dated_limit_total(
                start,
                end,
                timezone,
                vec![
                    deposit_at(&before(start), dec!(1)),
                    deposit_at(start, dec!(10)),
                    deposit_at(&before(next_midnight), dec!(100)),
                    deposit_at(next_midnight, dec!(1000)),
                ],
            );

            assert_eq!(total, dec!(110), "{timezone}");
        }
    }

    #[test]
    fn test_date_range_preserves_noon_dates_outside_the_contribution_year() {
        // This is a 2026 limit with custom dates in 2027, not former defaults.
        let total = dated_limit_total(
            "2027-01-01T12:00:00Z",
            "2027-12-31T12:00:00Z",
            "Pacific/Kiritimati",
            vec![
                deposit_at("2027-01-01T09:59:59Z", dec!(1)),
                deposit_at("2027-01-01T10:00:00Z", dec!(10)),
                deposit_at("2028-01-01T09:59:59Z", dec!(100)),
                deposit_at("2028-01-01T10:00:00Z", dec!(1000)),
            ],
        );

        assert_eq!(total, dec!(110));
    }
}
