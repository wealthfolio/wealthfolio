use chrono::{DateTime, NaiveDate, Utc};
use diesel::expression_methods::ExpressionMethods;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::{Nullable, Text};
use diesel::sqlite::Sqlite;
use diesel::sqlite::SqliteConnection;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

use wealthfolio_core::activities::ActivityError;
use wealthfolio_core::activities::{
    import_type, Activity, ActivityBulkIdentifierMapping, ActivityBulkMutationResult,
    ActivityDetails, ActivityRepositoryTrait, ActivitySearchResponse, ActivitySearchResponseMeta,
    ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate, IncomeData,
    NewActivity, Sort, INCOME_ACTIVITY_TYPES, TRADING_ACTIVITY_TYPES,
};
use wealthfolio_core::limits::ContributionActivity;
use wealthfolio_core::{Error, Result};

use super::model::{ActivityDB, ActivityDetailsDB, ImportAccountTemplateDB, ImportTemplateDB};
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{accounts, activities, assets, import_account_templates, import_templates};
use crate::utils::chunk_for_sqlite;
use async_trait::async_trait;
use diesel::dsl::{max, min};
use num_traits::Zero;

/// Repository for managing activity data in the database
pub struct ActivityRepository {
    pool: Arc<Pool<ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

fn apply_decimal_patch(existing: Option<String>, patch: Option<Option<Decimal>>) -> Option<String> {
    match patch {
        None => existing,
        Some(None) => None,
        Some(Some(value)) => Some(value.to_string()),
    }
}

fn set_transfer_flow_external(metadata: Option<String>, is_external: bool) -> Option<String> {
    let mut value = metadata
        .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if !value.is_object() {
        value = serde_json::json!({});
    }

    let object = value
        .as_object_mut()
        .expect("transfer metadata value should be an object");
    let flow = object
        .entry("flow")
        .or_insert_with(|| serde_json::json!({}));
    if !flow.is_object() {
        *flow = serde_json::json!({});
    }
    if let Some(flow_object) = flow.as_object_mut() {
        flow_object.insert("is_external".to_string(), serde_json::json!(is_external));
    }

    Some(value.to_string())
}

// Inherent methods for ActivityRepository
impl ActivityRepository {
    /// Creates a new ActivityRepository instance
    pub fn new(pool: Arc<Pool<ConnectionManager<SqliteConnection>>>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

// Implement the trait for the repository
#[async_trait]
impl ActivityRepositoryTrait for ActivityRepository {
    fn get_activity(&self, activity_id: &str) -> Result<Activity> {
        let mut conn = get_connection(&self.pool)?;
        let activity_db = activities::table
            .select(ActivityDB::as_select())
            .find(activity_id)
            .first::<ActivityDB>(&mut conn)
            .map_err(|e| Error::from(ActivityError::NotFound(e.to_string())))?;
        Ok(Activity::from(activity_db))
    }

    fn get_trading_activities(&self) -> Result<Vec<Activity>> {
        let mut conn = get_connection(&self.pool)?;

        let activities_db = activities::table
            .inner_join(accounts::table.on(accounts::id.eq(activities::account_id)))
            .filter(accounts::is_archived.eq(false))
            .filter(activities::activity_type.eq_any(TRADING_ACTIVITY_TYPES))
            .select(ActivityDB::as_select())
            .order(activities::activity_date.asc())
            .load::<ActivityDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(activities_db.into_iter().map(Activity::from).collect())
    }

    fn get_income_activities(&self) -> Result<Vec<Activity>> {
        let mut conn = get_connection(&self.pool)?;

        let activities_db = activities::table
            .inner_join(accounts::table.on(accounts::id.eq(activities::account_id)))
            .filter(accounts::is_archived.eq(false))
            .filter(activities::activity_type.eq_any(INCOME_ACTIVITY_TYPES))
            .select(ActivityDB::as_select())
            .order(activities::activity_date.asc())
            .load::<ActivityDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(activities_db.into_iter().map(Activity::from).collect())
    }

    fn get_activities(&self) -> Result<Vec<Activity>> {
        let mut conn = get_connection(&self.pool)?;

        let activities_db = activities::table
            .inner_join(accounts::table.on(accounts::id.eq(activities::account_id)))
            .filter(accounts::is_archived.eq(false))
            .select(ActivityDB::as_select())
            .order(activities::activity_date.asc())
            .load::<ActivityDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(activities_db.into_iter().map(Activity::from).collect())
    }

    fn search_activities(
        &self,
        page: i64,                                   // Page number, 0-based
        page_size: i64,                              // Number of items per page
        account_id_filter: Option<Vec<String>>,      // Optional account_id filter
        activity_type_filter: Option<Vec<String>>,   // Optional activity_type filter
        asset_id_keyword: Option<String>,            // Optional asset_id keyword for search
        sort: Option<Sort>,                          // Optional sort
        needs_review_filter: Option<bool>, // Optional needs_review filter (maps to DRAFT status)
        date_from: Option<NaiveDate>,      // Optional start date filter (inclusive)
        date_to: Option<NaiveDate>,        // Optional end date filter (inclusive)
        instrument_type_filter: Option<Vec<String>>, // Optional instrument_type filter
    ) -> Result<ActivitySearchResponse> {
        let mut conn = get_connection(&self.pool)?;

        let offset = page * page_size;

        // Function to create base query - now using LEFT JOIN for assets since asset_id can be NULL
        let create_base_query = |_conn: &SqliteConnection| {
            let mut query = activities::table
                .inner_join(accounts::table.on(activities::account_id.eq(accounts::id)))
                .left_join(assets::table.on(activities::asset_id.eq(assets::id.nullable())))
                .filter(accounts::is_archived.eq(false))
                .into_boxed();

            if let Some(ref account_ids) = account_id_filter {
                query = query.filter(activities::account_id.eq_any(account_ids));
            }
            if let Some(ref activity_types) = activity_type_filter {
                query = query.filter(activities::activity_type.eq_any(activity_types));
            }
            if let Some(ref keyword) = asset_id_keyword {
                let pattern = format!("%{}%", keyword);
                query = query.filter(
                    assets::id
                        .like(pattern.clone())
                        .or(assets::name.like(pattern.clone()))
                        .or(assets::display_code.like(pattern.clone()))
                        .or(activities::notes.like(pattern)),
                );
            }
            // Map needs_review_filter to status filter (DRAFT status means needs review)
            if let Some(needs_review) = needs_review_filter {
                if needs_review {
                    query = query.filter(activities::status.eq("DRAFT"));
                } else {
                    query = query.filter(activities::status.ne("DRAFT"));
                }
            }
            // Date range filters (activity_date is stored as RFC3339 string, compare lexicographically)
            if let Some(from_date) = date_from {
                // Start of day in RFC3339 format for lexicographic comparison
                let from_str = format!("{}T00:00:00", from_date);
                query = query.filter(activities::activity_date.ge(from_str));
            }
            if let Some(to_date) = date_to {
                // End of day in RFC3339 format for lexicographic comparison
                let to_str = format!("{}T23:59:59", to_date);
                query = query.filter(activities::activity_date.le(to_str));
            }
            if let Some(ref instrument_types) = instrument_type_filter {
                query = query.filter(assets::instrument_type.eq_any(instrument_types));
            }

            // Apply sorting
            if let Some(ref sort) = sort {
                match sort.id.as_str() {
                    "date" => {
                        if sort.desc {
                            query = query.order((
                                activities::activity_date.desc(),
                                activities::created_at.asc(),
                            ));
                        } else {
                            query = query.order((
                                activities::activity_date.asc(),
                                activities::created_at.asc(),
                            ));
                        }
                    }
                    "activityType" => {
                        if sort.desc {
                            query = query.order(activities::activity_type.desc());
                        } else {
                            query = query.order(activities::activity_type.asc());
                        }
                    }
                    "assetSymbol" => {
                        if sort.desc {
                            query = query.order(activities::asset_id.desc());
                        } else {
                            query = query.order(activities::asset_id.asc());
                        }
                    }
                    "accountName" => {
                        if sort.desc {
                            query = query.order(accounts::name.desc());
                        } else {
                            query = query.order(accounts::name.asc());
                        }
                    }
                    _ => {
                        query = query.order((
                            activities::activity_date.desc(),
                            activities::created_at.asc(),
                        ))
                    } // Default order
                }
            } else {
                query = query.order((
                    activities::activity_date.desc(),
                    activities::created_at.asc(),
                )); // Default order
            }

            query
        };

        // Count query
        let total_row_count = create_base_query(&conn)
            .count()
            .get_result::<i64>(&mut conn)
            .map_err(StorageError::from)?;

        // Data fetching query - updated to match new schema fields
        let results_db = create_base_query(&conn)
            .select((
                activities::id,
                activities::account_id,
                activities::asset_id,
                activities::activity_type,
                activities::subtype,
                activities::status,
                activities::activity_date,
                activities::quantity,
                activities::unit_price,
                activities::currency,
                activities::fee,
                activities::amount,
                activities::notes,
                activities::fx_rate,
                activities::needs_review,
                activities::is_user_modified,
                activities::source_system,
                activities::source_record_id,
                activities::source_group_id,
                activities::idempotency_key,
                activities::import_run_id,
                activities::created_at,
                activities::updated_at,
                accounts::name,
                accounts::currency,
                assets::display_code.nullable(),
                assets::name.nullable(),
                assets::instrument_exchange_mic.nullable(),
                assets::quote_mode.nullable(),
                assets::instrument_type.nullable(),
                activities::metadata,
            ))
            .limit(page_size)
            .offset(offset)
            .load::<ActivityDetailsDB>(&mut conn)
            .map_err(StorageError::from)?;

        let results: Vec<ActivityDetails> =
            results_db.into_iter().map(ActivityDetails::from).collect();

        Ok(ActivitySearchResponse {
            data: results,
            meta: ActivitySearchResponseMeta { total_row_count },
        })
    }

    async fn create_activity(&self, new_activity: NewActivity) -> Result<Activity> {
        new_activity.validate()?;
        let activity_db_owned: ActivityDB = new_activity.into();

        self.writer
            .exec_tx(move |tx| -> Result<Activity> {
                let mut activity_to_insert = activity_db_owned;
                activity_to_insert.id = Uuid::new_v4().to_string();
                let inserted_activity = diesel::insert_into(activities::table)
                    .values(&activity_to_insert)
                    .get_result::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let activity = Activity::from(inserted_activity);
                tx.insert(&activity_to_insert)?;
                Ok(activity)
            })
            .await
    }

    async fn update_activity(&self, activity_update: ActivityUpdate) -> Result<Activity> {
        activity_update.validate()?;
        let activity_update_owned = activity_update.clone();
        let activity_db_owned: ActivityDB = activity_update.into();
        let activity_id_owned = activity_db_owned.id.clone();

        self.writer
            .exec_tx(move |tx| -> Result<Activity> {
                let mut activity_to_update = activity_db_owned;
                let subtype_patch = activity_update_owned.subtype.clone();
                let existing = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_id_owned)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;

                // Preserve fields from existing record that shouldn't be overwritten
                let ActivityDB {
                    created_at,
                    fx_rate,
                    source_system,
                    source_record_id,
                    source_group_id,
                    idempotency_key,
                    import_run_id,
                    activity_type_override,
                    source_type,
                    subtype,
                    settlement_date,
                    metadata,
                    quantity,
                    unit_price,
                    amount,
                    fee,
                    ..
                } = existing;

                activity_to_update.created_at = created_at;
                activity_to_update.quantity =
                    apply_decimal_patch(quantity, activity_update_owned.quantity);
                activity_to_update.unit_price =
                    apply_decimal_patch(unit_price, activity_update_owned.unit_price);
                activity_to_update.amount =
                    apply_decimal_patch(amount, activity_update_owned.amount);
                activity_to_update.fee = apply_decimal_patch(fee, activity_update_owned.fee);
                activity_to_update.fx_rate =
                    apply_decimal_patch(fx_rate, activity_update_owned.fx_rate);
                // Preserve source identity fields
                if activity_to_update.source_system.is_none() {
                    activity_to_update.source_system = source_system;
                }
                if activity_to_update.source_record_id.is_none() {
                    activity_to_update.source_record_id = source_record_id;
                }
                if activity_to_update.source_group_id.is_none() {
                    activity_to_update.source_group_id = source_group_id;
                }
                if activity_to_update.idempotency_key.is_none() {
                    activity_to_update.idempotency_key = idempotency_key;
                }
                if activity_to_update.import_run_id.is_none() {
                    activity_to_update.import_run_id = import_run_id;
                }
                // Preserve classification fields
                if activity_to_update.activity_type_override.is_none() {
                    activity_to_update.activity_type_override = activity_type_override;
                }
                if activity_to_update.source_type.is_none() {
                    activity_to_update.source_type = source_type;
                }
                activity_to_update.subtype = match subtype_patch {
                    Some(value) if value.trim().is_empty() => None,
                    Some(value) => Some(value),
                    None => subtype,
                };
                if activity_to_update.settlement_date.is_none() {
                    activity_to_update.settlement_date = settlement_date;
                }
                if activity_to_update.metadata.is_none() {
                    activity_to_update.metadata = metadata;
                }
                activity_to_update.updated_at = chrono::Utc::now().to_rfc3339();

                let updated_activity =
                    diesel::update(activities::table.find(&activity_to_update.id))
                        .set(&activity_to_update)
                        .get_result::<ActivityDB>(tx.conn())
                        .map_err(StorageError::from)?;
                let activity = Activity::from(updated_activity);
                tx.update(&activity_to_update)?;
                Ok(activity)
            })
            .await
    }

    async fn delete_activity(&self, activity_id: String) -> Result<Activity> {
        self.writer
            .exec_tx(move |tx| -> Result<Activity> {
                let activity = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_id)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                diesel::delete(activities::table.filter(activities::id.eq(&activity_id)))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.delete::<ActivityDB>(activity_id.clone());
                Ok(activity.into())
            })
            .await
    }

    async fn link_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        use wealthfolio_core::activities::{ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT};

        if activity_a_id == activity_b_id {
            return Err(Error::from(ActivityError::InvalidData(
                "Cannot link an activity to itself".to_string(),
            )));
        }

        self.writer
            .exec_tx(move |tx| -> Result<(Activity, Activity)> {
                let a = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_a_id)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(|e| Error::from(ActivityError::NotFound(e.to_string())))?;
                let b = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_b_id)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(|e| Error::from(ActivityError::NotFound(e.to_string())))?;

                let (mut transfer_in, mut transfer_out) =
                    match (a.activity_type.as_str(), b.activity_type.as_str()) {
                        (ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT) => (a, b),
                        (ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_TRANSFER_IN) => (b, a),
                        _ => {
                            return Err(Error::from(ActivityError::InvalidData(
                                "Linking requires one TRANSFER_IN and one TRANSFER_OUT activity"
                                    .to_string(),
                            )));
                        }
                    };

                if transfer_in.source_group_id.is_some() || transfer_out.source_group_id.is_some() {
                    return Err(Error::from(ActivityError::InvalidData(
                        "One or both activities are already linked to another transfer".to_string(),
                    )));
                }
                if transfer_in.account_id == transfer_out.account_id {
                    return Err(Error::from(ActivityError::InvalidData(
                        "Both transfer legs share the same account".to_string(),
                    )));
                }

                let group_id = Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();

                transfer_in.source_group_id = Some(group_id.clone());
                transfer_in.metadata = set_transfer_flow_external(transfer_in.metadata, false);
                transfer_in.is_user_modified = 1;
                transfer_in.updated_at = now.clone();
                transfer_out.source_group_id = Some(group_id);
                transfer_out.metadata = set_transfer_flow_external(transfer_out.metadata, false);
                transfer_out.is_user_modified = 1;
                transfer_out.updated_at = now;

                let updated_in = diesel::update(activities::table.find(&transfer_in.id))
                    .set((
                        activities::source_group_id.eq(transfer_in.source_group_id.clone()),
                        activities::metadata.eq(transfer_in.metadata.clone()),
                        activities::is_user_modified.eq(transfer_in.is_user_modified),
                        activities::updated_at.eq(&transfer_in.updated_at),
                    ))
                    .get_result::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let updated_out = diesel::update(activities::table.find(&transfer_out.id))
                    .set((
                        activities::source_group_id.eq(transfer_out.source_group_id.clone()),
                        activities::metadata.eq(transfer_out.metadata.clone()),
                        activities::is_user_modified.eq(transfer_out.is_user_modified),
                        activities::updated_at.eq(&transfer_out.updated_at),
                    ))
                    .get_result::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;

                tx.update(&updated_in)?;
                tx.update(&updated_out)?;

                Ok((Activity::from(updated_in), Activity::from(updated_out)))
            })
            .await
    }

    async fn unlink_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        use wealthfolio_core::activities::{ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT};

        if activity_a_id == activity_b_id {
            return Err(Error::from(ActivityError::InvalidData(
                "Cannot unlink an activity from itself".to_string(),
            )));
        }

        self.writer
            .exec_tx(move |tx| -> Result<(Activity, Activity)> {
                let a = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_a_id)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(|e| Error::from(ActivityError::NotFound(e.to_string())))?;
                let b = activities::table
                    .select(ActivityDB::as_select())
                    .find(&activity_b_id)
                    .first::<ActivityDB>(tx.conn())
                    .map_err(|e| Error::from(ActivityError::NotFound(e.to_string())))?;

                let (mut transfer_in, mut transfer_out) =
                    match (a.activity_type.as_str(), b.activity_type.as_str()) {
                        (ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT) => (a, b),
                        (ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_TRANSFER_IN) => (b, a),
                        _ => {
                            return Err(Error::from(ActivityError::InvalidData(
                                "Unlinking requires one TRANSFER_IN and one TRANSFER_OUT activity"
                                    .to_string(),
                            )));
                        }
                    };

                let Some(in_group_id) = transfer_in.source_group_id.clone() else {
                    return Err(Error::from(ActivityError::InvalidData(
                        "Both activities must already be linked".to_string(),
                    )));
                };
                let Some(out_group_id) = transfer_out.source_group_id.clone() else {
                    return Err(Error::from(ActivityError::InvalidData(
                        "Both activities must already be linked".to_string(),
                    )));
                };
                if in_group_id != out_group_id {
                    return Err(Error::from(ActivityError::InvalidData(
                        "Selected activities belong to different linked transfers".to_string(),
                    )));
                }

                let now = chrono::Utc::now().to_rfc3339();
                transfer_in.source_group_id = None;
                transfer_in.metadata = set_transfer_flow_external(transfer_in.metadata, true);
                transfer_in.is_user_modified = 1;
                transfer_in.updated_at = now.clone();
                transfer_out.source_group_id = None;
                transfer_out.metadata = set_transfer_flow_external(transfer_out.metadata, true);
                transfer_out.is_user_modified = 1;
                transfer_out.updated_at = now;

                let updated_in = diesel::update(activities::table.find(&transfer_in.id))
                    .set((
                        activities::source_group_id.eq(None::<String>),
                        activities::metadata.eq(transfer_in.metadata.clone()),
                        activities::is_user_modified.eq(1),
                        activities::updated_at.eq(&transfer_in.updated_at),
                    ))
                    .get_result::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                let updated_out = diesel::update(activities::table.find(&transfer_out.id))
                    .set((
                        activities::source_group_id.eq(None::<String>),
                        activities::metadata.eq(transfer_out.metadata.clone()),
                        activities::is_user_modified.eq(1),
                        activities::updated_at.eq(&transfer_out.updated_at),
                    ))
                    .get_result::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;

                tx.update(&updated_in)?;
                tx.update(&updated_out)?;

                Ok((Activity::from(updated_in), Activity::from(updated_out)))
            })
            .await
    }

    async fn bulk_mutate_activities(
        &self,
        creates: Vec<NewActivity>,
        updates: Vec<ActivityUpdate>,
        delete_ids: Vec<String>,
    ) -> Result<ActivityBulkMutationResult> {
        self.writer
            .exec_tx(move |tx| -> Result<ActivityBulkMutationResult> {
                let mut outcome = ActivityBulkMutationResult::default();

                for delete_id in delete_ids {
                    let activity_db = activities::table
                        .select(ActivityDB::as_select())
                        .find(&delete_id)
                        .first::<ActivityDB>(tx.conn())
                        .map_err(StorageError::from)?;
                    diesel::delete(activities::table.filter(activities::id.eq(&delete_id)))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.delete::<ActivityDB>(delete_id.clone());
                    outcome.deleted.push(Activity::from(activity_db));
                }

                for update in updates {
                    update.validate()?;
                    let update_owned = update.clone();
                    let subtype_patch = update_owned.subtype.clone();
                    let mut activity_db: ActivityDB = update.into();
                    let existing = activities::table
                        .select(ActivityDB::as_select())
                        .find(&activity_db.id)
                        .first::<ActivityDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    // Preserve fields from existing record
                    let ActivityDB {
                        created_at,
                        source_system,
                        source_record_id,
                        source_group_id,
                        idempotency_key,
                        import_run_id,
                        activity_type_override,
                        source_type,
                        subtype,
                        settlement_date,
                        metadata,
                        quantity,
                        unit_price,
                        amount,
                        fee,
                        fx_rate,
                        ..
                    } = existing;

                    activity_db.created_at = created_at;
                    activity_db.quantity = apply_decimal_patch(quantity, update_owned.quantity);
                    activity_db.unit_price =
                        apply_decimal_patch(unit_price, update_owned.unit_price);
                    activity_db.amount = apply_decimal_patch(amount, update_owned.amount);
                    activity_db.fee = apply_decimal_patch(fee, update_owned.fee);
                    activity_db.fx_rate = apply_decimal_patch(fx_rate, update_owned.fx_rate);
                    if activity_db.source_system.is_none() {
                        activity_db.source_system = source_system;
                    }
                    if activity_db.source_record_id.is_none() {
                        activity_db.source_record_id = source_record_id;
                    }
                    if activity_db.source_group_id.is_none() {
                        activity_db.source_group_id = source_group_id;
                    }
                    if activity_db.idempotency_key.is_none() {
                        activity_db.idempotency_key = idempotency_key;
                    }
                    if activity_db.import_run_id.is_none() {
                        activity_db.import_run_id = import_run_id;
                    }
                    if activity_db.activity_type_override.is_none() {
                        activity_db.activity_type_override = activity_type_override;
                    }
                    if activity_db.source_type.is_none() {
                        activity_db.source_type = source_type;
                    }
                    activity_db.subtype = match subtype_patch {
                        Some(value) if value.trim().is_empty() => None,
                        Some(value) => Some(value),
                        None => subtype,
                    };
                    if activity_db.settlement_date.is_none() {
                        activity_db.settlement_date = settlement_date;
                    }
                    if activity_db.metadata.is_none() {
                        activity_db.metadata = metadata;
                    }
                    activity_db.updated_at = chrono::Utc::now().to_rfc3339();

                    let updated_activity = diesel::update(activities::table.find(&activity_db.id))
                        .set(&activity_db)
                        .get_result::<ActivityDB>(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.update(&activity_db)?;
                    outcome.updated.push(Activity::from(updated_activity));
                }

                for new_activity in creates {
                    new_activity.validate()?;
                    let temp_id = new_activity.id.clone();
                    let mut activity_db: ActivityDB = new_activity.into();
                    // Always generate a new UUID for created activities
                    let generated_id = Uuid::new_v4().to_string();
                    activity_db.id = generated_id.clone();
                    let inserted_activity = diesel::insert_into(activities::table)
                        .values(&activity_db)
                        .get_result::<ActivityDB>(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.insert(&inserted_activity)?;
                    outcome
                        .created
                        .push(Activity::from(inserted_activity.clone()));
                    outcome
                        .created_mappings
                        .push(ActivityBulkIdentifierMapping {
                            temp_id: temp_id.filter(|id| !id.is_empty()),
                            activity_id: generated_id,
                        });
                }

                Ok(outcome)
            })
            .await
    }

    /// Retrieves activities by account ID
    fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
        let mut conn = get_connection(&self.pool)?;

        let activities_db = activities::table
            .inner_join(accounts::table.on(accounts::id.eq(activities::account_id)))
            .filter(accounts::is_archived.eq(false))
            .filter(activities::account_id.eq(account_id))
            .select(ActivityDB::as_select())
            .order(activities::activity_date.asc())
            .load::<ActivityDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(activities_db.into_iter().map(Activity::from).collect())
    }

    /// Retrieves activities by account IDs
    /// Note: Filters by is_archived (not is_active) so hidden accounts still have their
    /// activities included in calculations. Only archived accounts are excluded.
    fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>> {
        let mut conn = get_connection(&self.pool)?;

        let activities_db = activities::table
            .inner_join(accounts::table.on(activities::account_id.eq(accounts::id)))
            .filter(accounts::is_archived.eq(false))
            .filter(activities::account_id.eq_any(account_ids))
            .select(ActivityDB::as_select())
            .order(activities::activity_date.asc())
            .load::<ActivityDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(activities_db.into_iter().map(Activity::from).collect())
    }

    /// Calculates the average cost for an asset in an account
    fn calculate_average_cost(&self, account_id: &str, asset_id: &str) -> Result<Decimal> {
        let mut conn = get_connection(&self.pool)?;

        #[derive(QueryableByName, Debug)]
        struct AverageCost {
            #[diesel(sql_type = diesel::sql_types::Text)]
            average_cost: String,
        }

        let result: AverageCost = diesel::sql_query(
            r#"
            WITH running_totals AS (
                SELECT
                    CAST(quantity AS TEXT) as quantity,
                    CAST(unit_price AS TEXT) as unit_price,
                    CAST(quantity AS TEXT) AS quantity_change,
                    CAST(CAST(quantity AS DECIMAL) * CAST(unit_price AS DECIMAL) AS TEXT) AS value_change,
                    CAST(SUM(CAST(quantity AS DECIMAL)) OVER (ORDER BY activity_date, id) AS TEXT) AS running_quantity,
                    CAST(SUM(CAST(quantity AS DECIMAL) * CAST(unit_price AS DECIMAL)) OVER (ORDER BY activity_date, id) AS TEXT) AS running_value
                FROM activities
                WHERE account_id = ?1 AND asset_id = ?2
                  AND activity_type IN ('BUY', 'TRANSFER_IN')
            )
            SELECT
                CASE
                    WHEN SUM(CAST(quantity_change AS DECIMAL)) > 0
                    THEN CAST(CAST(SUM(CAST(value_change AS DECIMAL)) AS DECIMAL) / CAST(SUM(CAST(quantity_change AS DECIMAL)) AS DECIMAL) AS TEXT)
                    ELSE '0'
                END AS average_cost
            FROM running_totals
            "#,
        )
        .bind::<diesel::sql_types::Text, _>(account_id)
        .bind::<diesel::sql_types::Text, _>(asset_id)
        .get_result(&mut conn)
        .map_err(StorageError::from)?;

        Ok(Decimal::from_str(&result.average_cost).unwrap_or_default())
    }

    /// Gets the import mapping for a given account ID and context kind by joining import_account_templates + import_templates
    fn get_import_mapping(
        &self,
        some_account_id: &str,
        some_context_kind: &str,
    ) -> Result<Option<ImportMapping>> {
        let mut conn = get_connection(&self.pool)?;

        let result = import_account_templates::table
            .inner_join(
                import_templates::table
                    .on(import_templates::id.eq(import_account_templates::template_id)),
            )
            .filter(import_account_templates::account_id.eq(some_account_id))
            .filter(import_account_templates::context_kind.eq(some_context_kind))
            .select((
                import_account_templates::account_id,
                import_account_templates::context_kind,
                import_account_templates::source_system,
                import_templates::id,
                import_templates::name,
                import_templates::config,
                import_account_templates::created_at,
                import_account_templates::updated_at,
            ))
            .first::<(
                String,
                String,
                String,
                String,
                String,
                String,
                chrono::NaiveDateTime,
                chrono::NaiveDateTime,
            )>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(
            |(
                account_id,
                context_kind,
                source_system,
                template_id,
                name,
                config,
                created_at,
                updated_at,
            )| {
                ImportMapping {
                    account_id,
                    context_kind,
                    source_system,
                    template_id: Some(template_id),
                    name,
                    config,
                    created_at,
                    updated_at,
                }
            },
        ))
    }

    async fn save_import_mapping(&self, mapping: &ImportMapping) -> Result<()> {
        let mapping = mapping.clone();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                use chrono::Utc;

                // Check if account already has a linked template for this context kind
                let existing_link = import_account_templates::table
                    .filter(import_account_templates::account_id.eq(&mapping.account_id))
                    .filter(import_account_templates::context_kind.eq(&mapping.context_kind))
                    .first::<ImportAccountTemplateDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;

                let now = Utc::now().naive_utc();
                // Preserve the existing row id so the sync entity_id stays stable across
                // updates. Generating a new UUID on every upsert would cause the outbox to
                // emit a different entity_id than the row that already lives on remote devices,
                // making their replay INSERT collide on UNIQUE(account_id, context_kind, source_system).
                let existing_link_id = existing_link.as_ref().map(|l| l.id.clone());
                let account_local_id = if mapping.context_kind == import_type::HOLDINGS {
                    format!("acct_{}_holdings", mapping.account_id)
                } else {
                    format!("acct_{}", mapping.account_id)
                };
                let template_id = if let Some(link) =
                    existing_link.filter(|l| l.template_id == account_local_id)
                {
                    // Update the existing account-local template in place
                    diesel::update(
                        import_templates::table.filter(import_templates::id.eq(&link.template_id)),
                    )
                    .set((
                        import_templates::name.eq(&mapping.name),
                        import_templates::config.eq(&mapping.config),
                        import_templates::updated_at.eq(now),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                    link.template_id
                } else {
                    // Linked template is shared/system or no link — create a new account-local one
                    let new_id = account_local_id;
                    let template_db = ImportTemplateDB {
                        id: new_id.clone(),
                        name: mapping.name.clone(),
                        scope: "user".to_string(),
                        kind: mapping.context_kind.clone(),
                        source_system: String::new(),
                        config_version: 1,
                        config: mapping.config.clone(),
                        created_at: now,
                        updated_at: now,
                    };
                    diesel::insert_into(import_templates::table)
                        .values(&template_db)
                        .on_conflict(import_templates::id)
                        .do_update()
                        .set(&template_db)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    new_id
                };

                // Upsert the account → template link
                let link_db = ImportAccountTemplateDB {
                    id: existing_link_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    account_id: mapping.account_id.clone(),
                    context_kind: mapping.context_kind.clone(),
                    source_system: String::new(),
                    template_id,
                    created_at: now,
                    updated_at: now,
                };
                diesel::insert_into(import_account_templates::table)
                    .values(&link_db)
                    .on_conflict((
                        import_account_templates::account_id,
                        import_account_templates::context_kind,
                        import_account_templates::source_system,
                    ))
                    .do_update()
                    .set(&link_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&link_db)?;
                Ok(())
            })
            .await
    }

    async fn link_account_template(
        &self,
        account_id: &str,
        template_id: &str,
        context_kind: &str,
    ) -> Result<()> {
        let account_id = account_id.to_string();
        let template_id = template_id.to_string();
        let context_kind = context_kind.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                use chrono::Utc;
                let now = Utc::now().naive_utc();
                // Reuse the existing row id to keep the sync entity_id stable across updates.
                let existing_id: Option<String> = import_account_templates::table
                    .filter(import_account_templates::account_id.eq(&account_id))
                    .filter(import_account_templates::context_kind.eq(&context_kind))
                    .select(import_account_templates::id)
                    .first::<String>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let link_db = ImportAccountTemplateDB {
                    id: existing_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    account_id: account_id.clone(),
                    context_kind,
                    source_system: String::new(),
                    template_id,
                    created_at: now,
                    updated_at: now,
                };
                diesel::insert_into(import_account_templates::table)
                    .values(&link_db)
                    .on_conflict((
                        import_account_templates::account_id,
                        import_account_templates::context_kind,
                        import_account_templates::source_system,
                    ))
                    .do_update()
                    .set(&link_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&link_db)?;
                Ok(())
            })
            .await
    }

    fn list_import_templates(&self) -> Result<Vec<ImportTemplate>> {
        let mut conn = get_connection(&self.pool)?;

        let rows = import_templates::table
            .filter(import_templates::kind.eq_any(vec!["CSV_ACTIVITY", "CSV_HOLDINGS"]))
            .order((import_templates::scope.asc(), import_templates::name.asc()))
            .load::<ImportTemplateDB>(&mut conn)
            .map_err(StorageError::from)?;

        Ok(rows.into_iter().map(ImportTemplate::from).collect())
    }

    fn get_import_template(&self, template_id: &str) -> Result<Option<ImportTemplate>> {
        let mut conn = get_connection(&self.pool)?;

        let result = import_templates::table
            .filter(import_templates::id.eq(template_id))
            .first::<ImportTemplateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(result.map(ImportTemplate::from))
    }

    async fn save_import_template(&self, template: &ImportTemplate) -> Result<()> {
        let template_db: ImportTemplateDB = template.clone().into();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                diesel::insert_into(import_templates::table)
                    .values(&template_db)
                    .on_conflict(import_templates::id)
                    .do_update()
                    .set(&template_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&template_db)?;
                Ok(())
            })
            .await
    }

    async fn delete_import_template(&self, template_id: &str) -> Result<()> {
        let template_id = template_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                diesel::delete(
                    import_templates::table.filter(import_templates::id.eq(&template_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;
                tx.delete::<ImportTemplateDB>(&template_id);
                Ok(())
            })
            .await
    }

    fn get_broker_sync_profile(
        &self,
        account_id: &str,
        source_system: &str,
    ) -> Result<Option<ImportTemplate>> {
        let mut conn = get_connection(&self.pool)?;

        // Precedence: account-specific user -> broker-wide user -> system for source_system

        // 1. Account-specific user profile: find template_id from link table
        let account_template_id: Option<String> = import_account_templates::table
            .filter(import_account_templates::account_id.eq(account_id))
            .filter(import_account_templates::context_kind.eq("BROKER_ACTIVITY"))
            .filter(import_account_templates::source_system.eq(source_system))
            .select(import_account_templates::template_id)
            .first::<String>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        if let Some(tid) = account_template_id {
            let template = import_templates::table
                .filter(import_templates::id.eq(&tid))
                .filter(import_templates::scope.eq("USER"))
                .first::<ImportTemplateDB>(&mut conn)
                .optional()
                .map_err(StorageError::from)?;
            if let Some(t) = template {
                return Ok(Some(ImportTemplate::from(t)));
            }
        }

        // 2. Broker-wide user profile (not linked to any account)
        let all_linked_ids: Vec<String> = import_account_templates::table
            .filter(import_account_templates::context_kind.eq("BROKER_ACTIVITY"))
            .filter(import_account_templates::source_system.eq(source_system))
            .select(import_account_templates::template_id)
            .load::<String>(&mut conn)
            .map_err(StorageError::from)?;

        let broker_wide = import_templates::table
            .filter(import_templates::kind.eq("BROKER_ACTIVITY"))
            .filter(import_templates::source_system.eq(source_system))
            .filter(import_templates::scope.eq("USER"))
            .filter(import_templates::id.ne_all(&all_linked_ids))
            .first::<ImportTemplateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        if let Some(t) = broker_wide {
            return Ok(Some(ImportTemplate::from(t)));
        }

        // 3. System profile for this source_system
        let system_profile = import_templates::table
            .filter(import_templates::kind.eq("BROKER_ACTIVITY"))
            .filter(import_templates::source_system.eq(source_system))
            .filter(import_templates::scope.eq("SYSTEM"))
            .first::<ImportTemplateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(system_profile.map(ImportTemplate::from))
    }

    async fn save_broker_sync_profile(&self, template: &ImportTemplate) -> Result<()> {
        let template_db: ImportTemplateDB = template.clone().into();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                diesel::insert_into(import_templates::table)
                    .values(&template_db)
                    .on_conflict(import_templates::id)
                    .do_update()
                    .set(&template_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&template_db)?;
                Ok(())
            })
            .await
    }

    async fn link_broker_sync_profile(
        &self,
        account_id: &str,
        template_id: &str,
        source_system: &str,
    ) -> Result<()> {
        let account_id = account_id.to_string();
        let template_id = template_id.to_string();
        let source_system = source_system.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<()> {
                use chrono::Utc;
                let now = Utc::now().naive_utc();
                let existing_id: Option<String> = import_account_templates::table
                    .filter(import_account_templates::account_id.eq(&account_id))
                    .filter(import_account_templates::context_kind.eq("BROKER_ACTIVITY"))
                    .filter(import_account_templates::source_system.eq(&source_system))
                    .select(import_account_templates::id)
                    .first::<String>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let link_db = ImportAccountTemplateDB {
                    id: existing_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    account_id,
                    context_kind: "BROKER_ACTIVITY".to_string(),
                    source_system,
                    template_id,
                    created_at: now,
                    updated_at: now,
                };
                diesel::insert_into(import_account_templates::table)
                    .values(&link_db)
                    .on_conflict((
                        import_account_templates::account_id,
                        import_account_templates::context_kind,
                        import_account_templates::source_system,
                    ))
                    .do_update()
                    .set(&link_db)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&link_db)?;
                Ok(())
            })
            .await
    }

    async fn create_activities(&self, activities_vec: Vec<NewActivity>) -> Result<usize> {
        if activities_vec.is_empty() {
            return Ok(0);
        }
        // Validate all activities first
        for new_act in &activities_vec {
            new_act.validate()?;
        }
        // Convert to ActivityDB and assign IDs
        let activities_db_owned: Vec<ActivityDB> = activities_vec
            .into_iter() // Consumes activities_vec
            .map(|new_act| {
                let mut db: ActivityDB = new_act.into();
                db.id = Uuid::new_v4().to_string();
                db
            })
            .collect();

        self.writer
            .exec_tx(move |tx| -> Result<usize> {
                let num_inserted = diesel::insert_into(activities::table)
                    .values(&activities_db_owned)
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                for activity_db in &activities_db_owned {
                    tx.insert(activity_db)?;
                }

                Ok(num_inserted)
            })
            .await
    }

    /// Fetches contribution-eligible activities (DEPOSIT, TRANSFER_IN, TRANSFER_OUT, CREDIT)
    /// for the given accounts within the date range.
    fn get_contribution_activities(
        &self,
        account_ids: &[String],
        start_utc: chrono::DateTime<Utc>,
        end_exclusive_utc: chrono::DateTime<Utc>,
    ) -> Result<Vec<ContributionActivity>> {
        let mut conn = get_connection(&self.pool)?;

        const CONTRIBUTION_TYPES: [&str; 4] = ["DEPOSIT", "TRANSFER_IN", "TRANSFER_OUT", "CREDIT"];

        let results = activities::table
            .inner_join(accounts::table.on(activities::account_id.eq(accounts::id)))
            .filter(accounts::id.eq_any(account_ids))
            .filter(accounts::is_archived.eq(false))
            .filter(activities::activity_type.eq_any(CONTRIBUTION_TYPES))
            .filter(activities::activity_date.ge(start_utc.to_rfc3339()))
            .filter(activities::activity_date.lt(end_exclusive_utc.to_rfc3339()))
            .select((
                activities::account_id,
                activities::activity_type,
                activities::activity_date,
                activities::amount,
                activities::currency,
                activities::metadata,
                activities::source_group_id,
            ))
            .load::<(
                String,
                String,
                String,
                Option<String>,
                String,
                Option<String>,
                Option<String>,
            )>(&mut conn)
            .map_err(ActivityError::from)?;

        // Convert to ContributionActivity structs
        let activities = results
            .into_iter()
            .filter_map(
                |(
                    account_id,
                    activity_type,
                    activity_date_str,
                    amount_str,
                    currency,
                    metadata,
                    source_group_id,
                )| {
                    // Parse activity instant as UTC; fallback date-only values to UTC midnight.
                    let activity_instant = chrono::DateTime::parse_from_rfc3339(&activity_date_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .or_else(|_| {
                            NaiveDate::parse_from_str(&activity_date_str, "%Y-%m-%d").map(|date| {
                                date.and_hms_opt(0, 0, 0)
                                    .expect("midnight is always valid")
                                    .and_utc()
                            })
                        })
                        .ok()?;

                    let amount = amount_str.and_then(|s| Decimal::from_str(&s).ok());

                    Some(ContributionActivity {
                        account_id,
                        activity_type,
                        activity_instant,
                        amount,
                        currency,
                        metadata,
                        source_group_id,
                    })
                },
            )
            .collect();

        Ok(activities)
    }

    fn get_income_activities_data(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<IncomeData>> {
        let mut conn = get_connection(&self.pool)?;

        // For income reporting, we need to handle different subtypes:
        // - Regular DIVIDEND/INTEREST: use the `amount` field directly
        // - Valid asset-backed income pairs: if amount is 0, calculate from:
        //   1. quantity * unit_price (if unit_price is available)
        //   2. quantity * market_price from quotes table (fallback)
        // IDs are internal UUIDs — safe to interpolate directly; escape single quotes defensively.
        let account_filter = match account_ids {
            Some(ids) if !ids.is_empty() => {
                let escaped = ids
                    .iter()
                    .map(|id| format!("'{}'", id.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("AND a.account_id IN ({escaped})")
            }
            _ => String::new(),
        };

        let query = format!(
            "SELECT strftime('%Y-%m', a.activity_date) as date,
             a.activity_type as income_type,
             COALESCE(a.asset_id, 'CASH') as asset_id,
             COALESCE(ast.kind, 'CASH') as asset_kind,
             COALESCE(ast.display_code, 'CASH') as symbol,
             COALESCE(ast.name, 'Cash') as symbol_name,
             a.currency,
             a.account_id,
             acc.name as account_name,
             CASE
                 WHEN (
                       (a.activity_type = 'INTEREST' AND UPPER(a.subtype) = 'STAKING_REWARD')
                       OR (a.activity_type = 'DIVIDEND' AND UPPER(a.subtype) IN ('DRIP', 'DIVIDEND_IN_KIND'))
                      )
                      AND (a.amount IS NULL OR CAST(a.amount AS REAL) = 0)
                 THEN CASE
                     WHEN a.unit_price IS NOT NULL AND CAST(a.unit_price AS REAL) > 0
                     THEN CAST(CAST(a.quantity AS REAL) * CAST(a.unit_price AS REAL) AS TEXT)
                     WHEN q.close IS NOT NULL
                     THEN CAST(CAST(a.quantity AS REAL) * CAST(q.close AS REAL) AS TEXT)
                     ELSE '0'
                 END
                 ELSE COALESCE(a.amount, '0')
             END as amount
             FROM activities a
             LEFT JOIN assets ast ON a.asset_id = ast.id
             INNER JOIN accounts acc ON a.account_id = acc.id
             LEFT JOIN quotes q ON a.asset_id = q.asset_id
                 AND date(a.activity_date) = q.day
             WHERE a.activity_type IN ('DIVIDEND', 'INTEREST', 'OTHER_INCOME')
             AND acc.is_archived = 0
             {account_filter}
             ORDER BY a.activity_date"
        );

        // Define a struct to hold the raw query results
        #[derive(QueryableByName, Debug)]
        struct RawIncomeData {
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub date: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub income_type: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub asset_id: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub asset_kind: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub symbol: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub symbol_name: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub currency: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub account_id: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub account_name: String,
            #[diesel(sql_type = diesel::sql_types::Text)]
            pub amount: String,
        }

        let raw_results = diesel::sql_query(&query)
            .load::<RawIncomeData>(&mut conn)
            .map_err(ActivityError::from)?;

        // Transform raw results into IncomeData
        let results = raw_results
            .into_iter()
            .map(|raw| {
                let amount = Decimal::from_str(&raw.amount).unwrap_or_else(|_| Decimal::zero());
                Ok(IncomeData {
                    date: raw.date,
                    income_type: raw.income_type,
                    asset_id: raw.asset_id,
                    asset_kind: raw.asset_kind,
                    symbol: raw.symbol,
                    symbol_name: raw.symbol_name,
                    currency: raw.currency,
                    amount,
                    account_id: raw.account_id,
                    account_name: raw.account_name,
                })
            })
            .collect::<Result<Vec<IncomeData>>>()?; // Collect into Result

        Ok(results)
    }

    fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
        let mut conn = get_connection(&self.pool)?;

        let min_date_str = activities::table
            .inner_join(accounts::table.on(activities::account_id.eq(accounts::id)))
            .filter(accounts::is_archived.eq(false))
            .select(min(activities::activity_date))
            .first::<Option<String>>(&mut conn)
            .map_err(StorageError::from)?
            .ok_or(ActivityError::NotFound("No activities found.".to_string()))?;

        // Parse the string result
        DateTime::parse_from_rfc3339(&min_date_str)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(|e| ActivityError::InvalidData(format!("Failed to parse date: {}", e)).into())
    }

    /// Gets the first activity date for given account IDs
    fn get_first_activity_date(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Option<DateTime<Utc>>> {
        let mut conn = get_connection(&self.pool)?;

        let mut query = activities::table
            .inner_join(accounts::table.on(accounts::id.eq(activities::account_id)))
            .filter(accounts::is_archived.eq(false))
            .select(min(activities::activity_date))
            .into_boxed();

        if let Some(ids) = account_ids {
            query = query.filter(activities::account_id.eq_any(ids));
        }

        let min_date_str_opt = query
            .first::<Option<String>>(&mut conn)
            .map_err(StorageError::from)?;

        match min_date_str_opt {
            Some(date_str) => DateTime::parse_from_rfc3339(&date_str)
                .map(|dt| Some(dt.with_timezone(&Utc)))
                .map_err(|e| {
                    ActivityError::InvalidData(format!("Failed to parse date: {}", e)).into()
                }),
            None => Ok(None), // If no activity found, return None
        }
    }

    /// Gets the first and last activity dates for each asset in the provided list.
    ///
    /// Uses chunking to avoid SQLite's parameter limit in IN (...) queries.
    fn get_activity_bounds_for_assets(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map: HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)> =
            HashMap::new();

        // Chunk the asset_ids to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(asset_ids) {
            // Query to get MIN and MAX activity dates per asset_id
            let results = activities::table
                .inner_join(accounts::table.on(activities::account_id.eq(accounts::id)))
                .filter(accounts::is_archived.eq(false))
                .filter(activities::asset_id.eq_any(chunk))
                .group_by(activities::asset_id)
                .select((
                    activities::asset_id.assume_not_null(),
                    min(activities::activity_date),
                    max(activities::activity_date),
                ))
                .load::<(String, Option<String>, Option<String>)>(&mut conn)
                .map_err(StorageError::from)?;

            for (asset_id, min_date_str, max_date_str) in results {
                // Parse the date strings (they are stored as RFC3339, extract the date portion)
                let first_date = min_date_str.and_then(|s| {
                    // Activity dates are stored as RFC3339, parse to get the date
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|dt| dt.date_naive())
                });

                let last_date = max_date_str.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|dt| dt.date_naive())
                });

                result_map.insert(asset_id, (first_date, last_date));
            }
        }

        Ok(result_map)
    }

    fn get_holdings_snapshot_bounds_for_assets(
        &self,
        asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }

        #[derive(QueryableByName)]
        struct HoldingsBoundsRow {
            #[diesel(sql_type = Text)]
            asset_id: String,
            #[diesel(sql_type = Nullable<Text>)]
            min_date: Option<String>,
            #[diesel(sql_type = Nullable<Text>)]
            max_date: Option<String>,
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map: HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)> =
            HashMap::new();

        for chunk in chunk_for_sqlite(asset_ids) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!(
                "SELECT position.key AS asset_id, \
                        MIN(snapshot.snapshot_date) AS min_date, \
                        MAX(snapshot.snapshot_date) AS max_date \
                 FROM holdings_snapshots snapshot \
                 JOIN accounts account ON account.id = snapshot.account_id \
                 JOIN json_each(snapshot.positions) position \
                 WHERE account.is_archived = 0 \
                   AND position.key IN ({}) \
                   AND CAST(COALESCE(json_extract(position.value, '$.quantity'), '0') AS REAL) <> 0 \
                 GROUP BY position.key",
                placeholders
            );

            let mut query_builder = Box::new(sql_query(sql)).into_boxed::<Sqlite>();
            for asset_id in chunk {
                query_builder = query_builder.bind::<Text, _>(asset_id);
            }

            let rows: Vec<HoldingsBoundsRow> = query_builder
                .load::<HoldingsBoundsRow>(&mut conn)
                .map_err(StorageError::from)?;

            for row in rows {
                let first_date = row
                    .min_date
                    .and_then(|date| NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok());
                let last_date = row
                    .max_date
                    .and_then(|date| NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok());

                result_map.insert(row.asset_id, (first_date, last_date));
            }
        }

        Ok(result_map)
    }

    /// Checks for existing activities with the given idempotency keys.
    ///
    /// Returns a map of {idempotency_key: existing_activity_id} for keys that already exist.
    fn check_existing_duplicates(
        &self,
        idempotency_keys: &[String],
    ) -> Result<HashMap<String, String>> {
        if idempotency_keys.is_empty() {
            return Ok(HashMap::new());
        }

        let mut conn = get_connection(&self.pool)?;
        let mut result_map: HashMap<String, String> = HashMap::new();

        // Chunk the keys to avoid SQLite parameter limits
        for chunk in chunk_for_sqlite(idempotency_keys) {
            let results = activities::table
                .filter(activities::idempotency_key.eq_any(chunk))
                .select((activities::id, activities::idempotency_key))
                .load::<(String, Option<String>)>(&mut conn)
                .map_err(StorageError::from)?;

            for (activity_id, key_opt) in results {
                if let Some(key) = key_opt {
                    result_map.insert(key, activity_id);
                }
            }
        }

        Ok(result_map)
    }

    /// Upserts multiple activities (insert or update on conflict by ID or idempotency_key).
    /// Respects is_user_modified flag - skips updates to user-modified activities.
    ///
    /// Returns statistics about the operation.
    async fn bulk_upsert(&self, activities_vec: Vec<ActivityUpsert>) -> Result<BulkUpsertResult> {
        use diesel::upsert::excluded;

        if activities_vec.is_empty() {
            return Ok(BulkUpsertResult::default());
        }

        // Convert to ActivityDB
        let activity_rows: Vec<ActivityDB> =
            activities_vec.into_iter().map(ActivityDB::from).collect();

        self.writer
            .exec_tx(move |tx| -> Result<BulkUpsertResult> {
                // Collect all activity IDs, source identities, and idempotency keys for batch lookup.
                let activity_ids: Vec<String> =
                    activity_rows.iter().map(|a| a.id.clone()).collect();
                let source_identities: Vec<(String, String, String)> = activity_rows
                    .iter()
                    .filter_map(|a| {
                        let source_system = a.source_system.as_deref()?.trim();
                        let source_record_id = a.source_record_id.as_deref()?.trim();
                        if source_system.is_empty() || source_record_id.is_empty() {
                            return None;
                        }
                        Some((
                            source_system.to_string(),
                            a.account_id.clone(),
                            source_record_id.to_string(),
                        ))
                    })
                    .collect();
                let idempotency_keys: Vec<String> = activity_rows
                    .iter()
                    .filter_map(|a| a.idempotency_key.clone())
                    .collect();

                // Fetch existing activities by ID or idempotency_key in one query.
                let existing_activities: Vec<(String, Option<String>, i32)> = activities::table
                    .filter(
                        activities::id
                            .eq_any(&activity_ids)
                            .or(activities::idempotency_key.eq_any(&idempotency_keys)),
                    )
                    .select((
                        activities::id,
                        activities::idempotency_key,
                        activities::is_user_modified,
                    ))
                    .load::<(String, Option<String>, i32)>(tx.conn())
                    .map_err(StorageError::from)?;

                let existing_source_activities: Vec<(String, String, Option<String>, Option<String>, i32)> =
                    if source_identities.is_empty() {
                        Vec::new()
                    } else {
                        let source_systems: Vec<Option<String>> = source_identities
                            .iter()
                            .map(|(source_system, _, _)| Some(source_system.clone()))
                            .collect();
                        let account_ids: Vec<String> = source_identities
                            .iter()
                            .map(|(_, account_id, _)| account_id.clone())
                            .collect();
                        let source_record_ids: Vec<Option<String>> = source_identities
                            .iter()
                            .map(|(_, _, source_record_id)| Some(source_record_id.clone()))
                            .collect();

                        activities::table
                            .filter(activities::account_id.eq_any(&account_ids))
                            .filter(activities::source_system.eq_any(&source_systems))
                            .filter(activities::source_record_id.eq_any(&source_record_ids))
                            .select((
                                activities::id,
                                activities::account_id,
                                activities::source_system,
                                activities::source_record_id,
                                activities::is_user_modified,
                            ))
                            .load::<(String, String, Option<String>, Option<String>, i32)>(tx.conn())
                            .map_err(StorageError::from)?
                    };

                // Build lookup maps for quick access.
                let mut existing_by_id: HashMap<String, i32> = HashMap::new();
                let mut existing_by_idemp: HashMap<String, (String, i32)> = HashMap::new();
                let mut existing_by_source: HashMap<(String, String, String), (String, i32)> =
                    HashMap::new();

                for (id, idemp_key, is_modified) in existing_activities {
                    existing_by_id.insert(id.clone(), is_modified);
                    if let Some(key) = idemp_key {
                        existing_by_idemp.insert(key, (id, is_modified));
                    }
                }

                for (id, account_id, source_system, source_record_id, is_modified) in
                    existing_source_activities
                {
                    if let (Some(source_system), Some(source_record_id)) =
                        (source_system, source_record_id)
                    {
                        existing_by_source.insert(
                            (source_system, account_id, source_record_id),
                            (id, is_modified),
                        );
                    }
                }

                let mut result = BulkUpsertResult::default();

                for mut activity_db in activity_rows {
                    let now_update = chrono::Utc::now().to_rfc3339();
                    let activity_id = activity_db.id.clone();
                    let idempotency_key = activity_db.idempotency_key.clone();

                    let source_identity = activity_db
                        .source_system
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .zip(
                            activity_db
                                .source_record_id
                                .as_deref()
                                .map(str::trim)
                                .filter(|value| !value.is_empty()),
                        )
                        .map(|(source_system, source_record_id)| {
                            (
                                source_system.to_string(),
                                activity_db.account_id.clone(),
                                source_record_id.to_string(),
                            )
                        });
                    let mut will_update = false;

                    // Check if this activity exists and is user-modified.
                    // First check by ID.
                    if let Some(&is_modified) = existing_by_id.get(&activity_id) {
                        will_update = true;
                        if is_modified != 0 {
                            log::debug!(
                                "Skipping user-modified activity {} (type={})",
                                activity_id,
                                activity_db.activity_type
                            );
                            result.skipped += 1;
                            continue;
                        }
                    }

                    // Match by provider identity before falling back to semantic idempotency.
                    if !will_update {
                        if let Some(ref source_key) = source_identity {
                            if let Some((existing_id, is_modified)) = existing_by_source.get(source_key)
                            {
                                if *is_modified != 0 {
                                    log::debug!(
                                        "Skipping update for user-modified activity (matched by source identity: {} -> {})",
                                        activity_id,
                                        existing_id
                                    );
                                    result.skipped += 1;
                                    continue;
                                }
                                log::debug!(
                                    "Activity {} matched existing {} by source identity, updating existing",
                                    activity_id,
                                    existing_id
                                );
                                activity_db.id = existing_id.clone();
                                will_update = true;
                            }
                        }
                    }

                    // If still unmatched, fall back to semantic idempotency.
                    if !will_update {
                        if let Some(ref key) = idempotency_key {
                            if let Some((existing_id, is_modified)) = existing_by_idemp.get(key) {
                                if *is_modified != 0 {
                                    log::debug!(
                                        "Skipping update for user-modified activity (matched by idempotency_key: {} -> {})",
                                        activity_id,
                                        existing_id
                                    );
                                    result.skipped += 1;
                                    continue;
                                }
                                // Found by idempotency_key - update the existing record instead
                                log::debug!(
                                    "Activity {} matched existing {} by idempotency_key, updating existing",
                                    activity_id,
                                    existing_id
                                );
                                activity_db.id = existing_id.clone();
                                will_update = true;
                            }
                        }
                    }

                    match diesel::insert_into(activities::table)
                        .values(&activity_db)
                        .on_conflict(activities::id)
                        .do_update()
                        .set((
                            activities::account_id.eq(excluded(activities::account_id)),
                            activities::asset_id.eq(excluded(activities::asset_id)),
                            activities::activity_type.eq(excluded(activities::activity_type)),
                            activities::subtype.eq(excluded(activities::subtype)),
                            activities::activity_date.eq(excluded(activities::activity_date)),
                            activities::quantity.eq(excluded(activities::quantity)),
                            activities::unit_price.eq(excluded(activities::unit_price)),
                            activities::currency.eq(excluded(activities::currency)),
                            activities::fee.eq(excluded(activities::fee)),
                            activities::amount.eq(excluded(activities::amount)),
                            activities::status.eq(excluded(activities::status)),
                            activities::notes.eq(excluded(activities::notes)),
                            activities::fx_rate.eq(excluded(activities::fx_rate)),
                            activities::metadata.eq(excluded(activities::metadata)),
                            activities::source_system.eq(excluded(activities::source_system)),
                            activities::source_record_id.eq(excluded(activities::source_record_id)),
                            activities::source_group_id.eq(excluded(activities::source_group_id)),
                            activities::needs_review.eq(excluded(activities::needs_review)),
                            activities::idempotency_key.eq(excluded(activities::idempotency_key)),
                            activities::import_run_id.eq(excluded(activities::import_run_id)),
                            activities::updated_at.eq(now_update),
                        ))
                        .execute(tx.conn())
                    {
                        Ok(count) => {
                            if count > 0 {
                                if will_update {
                                    tx.update(&activity_db)?;
                                } else {
                                    tx.insert(&activity_db)?;
                                }

                                existing_by_id.insert(activity_db.id.clone(), 0);
                                if let Some(key) = activity_db.idempotency_key.clone() {
                                    existing_by_idemp.insert(key, (activity_db.id.clone(), 0));
                                }
                                if let Some(source_key) = source_identity.clone() {
                                    existing_by_source.insert(source_key, (activity_db.id.clone(), 0));
                                }

                                result.upserted += count;
                                if will_update {
                                    result.updated += count;
                                } else {
                                    result.created += count;
                                }
                            }
                        }
                        Err(e) => {
                            log::error!(
                                "Failed to upsert activity {} (type={}): {:?}",
                                activity_db.id,
                                activity_db.activity_type,
                                e
                            );
                            return Err(StorageError::from(e).into());
                        }
                    }
                }

                if result.skipped > 0 {
                    log::info!(
                        "Skipped {} user-modified activities during bulk upsert",
                        result.skipped
                    );
                }

                log::debug!(
                    "Bulk upsert complete: {} upserted ({} created, {} updated), {} skipped",
                    result.upserted,
                    result.created,
                    result.updated,
                    result.skipped
                );

                Ok(result)
            })
            .await
    }

    async fn reassign_asset(&self, old_asset_id: &str, new_asset_id: &str) -> Result<u32> {
        let old_id = old_asset_id.to_string();
        let new_id = new_asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<u32> {
                let affected_ids = activities::table
                    .filter(activities::asset_id.eq(&old_id))
                    .select(activities::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                if affected_ids.is_empty() {
                    return Ok(0);
                }

                let now = chrono::Utc::now().to_rfc3339();
                let count =
                    diesel::update(activities::table.filter(activities::asset_id.eq(&old_id)))
                        .set((
                            activities::asset_id.eq(&new_id),
                            activities::updated_at.eq(&now),
                        ))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;

                let updated_rows = activities::table
                    .filter(activities::id.eq_any(&affected_ids))
                    .select(ActivityDB::as_select())
                    .load::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                for updated_row in updated_rows {
                    tx.update(&updated_row)?;
                }
                Ok(count as u32)
            })
            .await
    }

    async fn get_activity_accounts_and_currencies_by_asset_id(
        &self,
        asset_id: &str,
    ) -> Result<(Vec<String>, Vec<String>)> {
        let asset_id_owned = asset_id.to_string();
        self.writer
            .exec(
                move |conn: &mut SqliteConnection| -> Result<(Vec<String>, Vec<String>)> {
                    let rows: Vec<(String, String)> = activities::table
                        .filter(activities::asset_id.eq(&asset_id_owned))
                        .select((activities::account_id, activities::currency))
                        .distinct()
                        .load(conn)
                        .map_err(StorageError::from)?;

                    let mut account_ids: HashSet<String> = HashSet::new();
                    let mut currencies: HashSet<String> = HashSet::new();

                    for (account_id, currency) in rows {
                        if !account_id.is_empty() {
                            account_ids.insert(account_id);
                        }
                        if !currency.is_empty() {
                            currencies.insert(currency);
                        }
                    }

                    Ok((
                        account_ids.into_iter().collect(),
                        currencies.into_iter().collect(),
                    ))
                },
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use rust_decimal::Decimal;
    use tempfile::tempdir;
    use wealthfolio_core::activities::{import_type, ActivityUpsert};

    fn setup_db() -> (Arc<Pool<ConnectionManager<SqliteConnection>>>, WriteHandle) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer)
    }

    fn insert_account(conn: &mut SqliteConnection, account_id: &str) {
        insert_account_with_archived(conn, account_id, false);
    }

    fn insert_account_with_archived(conn: &mut SqliteConnection, account_id: &str, archived: bool) {
        diesel::sql_query(format!(
            "INSERT INTO accounts (id, name, account_type, `group`, currency, is_default, is_active, \
             created_at, updated_at, platform_id, account_number, meta, provider, provider_account_id, \
             is_archived, tracking_mode) VALUES ('{}', 'Test', 'cash', NULL, 'USD', 1, 1, \
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL, {}, 'portfolio')",
            account_id,
            if archived { 1 } else { 0 }
        ))
        .execute(conn)
        .expect("insert account");
    }

    fn insert_holdings_snapshot(
        conn: &mut SqliteConnection,
        account_id: &str,
        snapshot_date: &str,
        positions: &str,
    ) {
        let snapshot_id = format!("{}_{}", account_id, snapshot_date);
        sql_query(
            "INSERT INTO holdings_snapshots (
                id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis,
                net_contribution, calculated_at, net_contribution_base,
                cash_total_account_currency, cash_total_base_currency, source
             ) VALUES (?, ?, ?, 'USD', ?, '{}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'CALCULATED')",
        )
        .bind::<Text, _>(snapshot_id)
        .bind::<Text, _>(account_id)
        .bind::<Text, _>(snapshot_date)
        .bind::<Text, _>(positions)
        .execute(conn)
        .expect("insert holdings snapshot");
    }

    fn insert_template(conn: &mut SqliteConnection, template_id: &str) {
        diesel::sql_query(format!(
            "INSERT INTO import_templates (id, name, scope, config, created_at, updated_at) \
             VALUES ('{}', 'T', 'USER', '{{}}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            template_id
        ))
        .execute(conn)
        .expect("insert template");
    }

    fn insert_transfer_activity(
        conn: &mut SqliteConnection,
        id: &str,
        account_id: &str,
        activity_type: &str,
        source_group_id: Option<&str>,
        metadata: Option<&str>,
    ) {
        let activity = ActivityDB {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: "POSTED".to_string(),
            activity_date: "2024-01-15T00:00:00+00:00".to_string(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some("100".to_string()),
            fee: Some("0".to_string()),
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: metadata.map(str::to_string),
            source_system: Some("MANUAL".to_string()),
            source_record_id: None,
            source_group_id: source_group_id.map(str::to_string),
            idempotency_key: Some(format!("{id}-idempotency")),
            import_run_id: None,
            is_user_modified: 0,
            needs_review: 0,
            created_at: "2024-01-15T00:00:00+00:00".to_string(),
            updated_at: "2024-01-15T00:00:00+00:00".to_string(),
        };

        diesel::insert_into(activities::table)
            .values(&activity)
            .execute(conn)
            .expect("insert transfer activity");
    }

    fn insert_activity_with_subtype(
        conn: &mut SqliteConnection,
        id: &str,
        account_id: &str,
        activity_type: &str,
        asset_id: Option<&str>,
        subtype: Option<&str>,
    ) {
        let activity = ActivityDB {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.map(str::to_string),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: subtype.map(str::to_string),
            status: "POSTED".to_string(),
            activity_date: "2024-01-15T00:00:00+00:00".to_string(),
            settlement_date: None,
            quantity: Some("1".to_string()),
            unit_price: Some("100".to_string()),
            amount: Some("100".to_string()),
            fee: Some("0".to_string()),
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: Some("MANUAL".to_string()),
            source_record_id: None,
            source_group_id: None,
            idempotency_key: Some(format!("{id}-idempotency")),
            import_run_id: None,
            is_user_modified: 0,
            needs_review: 0,
            created_at: "2024-01-15T00:00:00+00:00".to_string(),
            updated_at: "2024-01-15T00:00:00+00:00".to_string(),
        };

        diesel::insert_into(activities::table)
            .values(&activity)
            .execute(conn)
            .expect("insert activity with subtype");
    }

    fn activity_metadata(conn: &mut SqliteConnection, id: &str) -> serde_json::Value {
        let metadata: Option<String> = activities::table
            .filter(activities::id.eq(id))
            .select(activities::metadata)
            .first(conn)
            .expect("activity metadata");
        serde_json::from_str(metadata.as_deref().expect("metadata should be set"))
            .expect("valid metadata")
    }

    fn activity_user_modified(conn: &mut SqliteConnection, id: &str) -> i32 {
        activities::table
            .filter(activities::id.eq(id))
            .select(activities::is_user_modified)
            .first(conn)
            .expect("activity is_user_modified")
    }

    #[tokio::test]
    async fn holdings_snapshot_bounds_ignore_zero_quantity_and_archived_accounts() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account(&mut conn, "acc-open");
        insert_account_with_archived(&mut conn, "acc-archived", true);

        insert_holdings_snapshot(
            &mut conn,
            "acc-open",
            "2026-01-01",
            r#"{"AAPL":{"quantity":"3"},"MSFT":{"quantity":"0"}}"#,
        );
        insert_holdings_snapshot(
            &mut conn,
            "acc-open",
            "2026-02-01",
            r#"{"AAPL":{"quantity":"0"},"MSFT":{"quantity":"4"}}"#,
        );
        insert_holdings_snapshot(
            &mut conn,
            "acc-open",
            "2026-03-01",
            r#"{"AAPL":{"quantity":"2"}}"#,
        );
        insert_holdings_snapshot(
            &mut conn,
            "acc-archived",
            "2026-01-01",
            r#"{"ARCH":{"quantity":"5"}}"#,
        );

        let asset_ids = vec![
            "AAPL".to_string(),
            "MSFT".to_string(),
            "ARCH".to_string(),
            "NONE".to_string(),
        ];
        let bounds = repo
            .get_holdings_snapshot_bounds_for_assets(&asset_ids)
            .expect("holdings bounds");

        assert_eq!(
            bounds.get("AAPL"),
            Some(&(
                Some(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()),
                Some(NaiveDate::from_ymd_opt(2026, 3, 1).unwrap())
            ))
        );
        assert_eq!(
            bounds.get("MSFT"),
            Some(&(
                Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap()),
                Some(NaiveDate::from_ymd_opt(2026, 2, 1).unwrap())
            ))
        );
        assert!(!bounds.contains_key("ARCH"));
        assert!(!bounds.contains_key("NONE"));
    }

    #[tokio::test]
    async fn update_activity_empty_subtype_clears_existing_subtype() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-subtype");
        insert_activity_with_subtype(
            &mut conn,
            "activity-subtype",
            "acc-subtype",
            "DIVIDEND",
            None,
            Some("DRIP"),
        );

        let updated = repo
            .update_activity(ActivityUpdate {
                id: "activity-subtype".to_string(),
                account_id: "acc-subtype".to_string(),
                asset: None,
                activity_type: "DIVIDEND".to_string(),
                subtype: Some(String::new()),
                activity_date: "2024-01-15".to_string(),
                quantity: None,
                unit_price: None,
                currency: "USD".to_string(),
                fee: None,
                amount: None,
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
            })
            .await
            .expect("update activity");

        assert_eq!(updated.subtype, None);
    }

    #[tokio::test]
    async fn income_report_derives_asset_backed_amount_only_for_valid_type_subtype_pair() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-income");
        insert_activity_with_subtype(
            &mut conn,
            "valid-staking",
            "acc-income",
            "INTEREST",
            None,
            Some("STAKING_REWARD"),
        );
        insert_activity_with_subtype(
            &mut conn,
            "metadata-only",
            "acc-income",
            "DIVIDEND",
            None,
            Some("STAKING_REWARD"),
        );

        diesel::sql_query(
            "UPDATE activities SET amount = '0', quantity = '2', unit_price = '50' \
             WHERE id IN ('valid-staking', 'metadata-only')",
        )
        .execute(&mut conn)
        .expect("zero income amounts");

        let rows = repo
            .get_income_activities_data(Some(&[String::from("acc-income")]))
            .expect("income data");
        let staking_amount = rows
            .iter()
            .find(|row| row.income_type == "INTEREST")
            .map(|row| row.amount);
        let metadata_amount = rows
            .iter()
            .find(|row| row.income_type == "DIVIDEND")
            .map(|row| row.amount);

        assert_eq!(staking_amount, Some(Decimal::new(100, 0)));
        assert_eq!(metadata_amount, Some(Decimal::ZERO));
    }

    /// Regression: re-linking the same (account_id, context_kind, source_system) must preserve the row `id`
    /// so that sync outbox events keep a stable entity_id across updates. Generating a new UUID
    /// on every upsert causes remote devices to receive a different entity_id and fail with a
    /// UNIQUE(account_id, context_kind, source_system) constraint error on replay.
    #[tokio::test]
    async fn relink_preserves_row_id() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-relink");
        insert_template(&mut conn, "tmpl-a");
        insert_template(&mut conn, "tmpl-b");

        // First link
        repo.link_account_template("acc-relink", "tmpl-a", import_type::ACTIVITY)
            .await
            .expect("first link");

        let id_after_first: String = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-relink"))
            .filter(import_account_templates::context_kind.eq(import_type::ACTIVITY))
            .select(import_account_templates::id)
            .first(&mut conn)
            .expect("row after first link");

        // Re-link to a different template for the same (account, context_kind)
        repo.link_account_template("acc-relink", "tmpl-b", import_type::ACTIVITY)
            .await
            .expect("relink");

        let id_after_relink: String = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-relink"))
            .filter(import_account_templates::context_kind.eq(import_type::ACTIVITY))
            .select(import_account_templates::id)
            .first(&mut conn)
            .expect("row after relink");

        // id must be stable — changing the linked template must not rotate the sync identity
        assert_eq!(
            id_after_first, id_after_relink,
            "row id changed on relink; sync entity_id would diverge from remote devices"
        );

        // template_id must have been updated
        let template_id_after: String = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-relink"))
            .select(import_account_templates::template_id)
            .first(&mut conn)
            .expect("template_id after relink");
        assert_eq!(template_id_after, "tmpl-b");
    }

    #[tokio::test]
    async fn link_transfer_activities_marks_user_modified_and_rejects_same_account() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-a");
        insert_account(&mut conn, "acc-b");
        insert_transfer_activity(
            &mut conn,
            "transfer-out",
            "acc-a",
            "TRANSFER_OUT",
            None,
            Some(r#"{"source":{"id":"manual"}}"#),
        );
        insert_transfer_activity(
            &mut conn,
            "transfer-in",
            "acc-b",
            "TRANSFER_IN",
            None,
            Some(r#"{"flow":{"is_external":true}}"#),
        );
        insert_transfer_activity(
            &mut conn,
            "same-account-in",
            "acc-a",
            "TRANSFER_IN",
            None,
            None,
        );

        let same_account = repo
            .link_transfer_activities("same-account-in".to_string(), "transfer-out".to_string())
            .await;
        assert!(same_account.is_err());
        let same_account_group: Option<String> = activities::table
            .filter(activities::id.eq("same-account-in"))
            .select(activities::source_group_id)
            .first(&mut conn)
            .expect("same-account-in group");
        assert_eq!(same_account_group, None);

        let (transfer_in, transfer_out) = repo
            .link_transfer_activities("transfer-in".to_string(), "transfer-out".to_string())
            .await
            .expect("link should succeed");

        assert!(transfer_in.is_user_modified);
        assert!(transfer_out.is_user_modified);
        assert!(transfer_in.source_group_id.is_some());
        assert_eq!(transfer_in.source_group_id, transfer_out.source_group_id);
        assert_eq!(
            transfer_in.metadata.as_ref().and_then(|m| {
                m.get("flow")
                    .and_then(|flow| flow.get("is_external"))
                    .and_then(|value| value.as_bool())
            }),
            Some(false)
        );
        assert_eq!(
            transfer_out
                .metadata
                .as_ref()
                .and_then(|m| m.get("source"))
                .and_then(|source| source.get("id"))
                .and_then(|value| value.as_str()),
            Some("manual"),
            "link should preserve unrelated metadata"
        );
        assert_eq!(activity_user_modified(&mut conn, "transfer-in"), 1);
        assert_eq!(activity_user_modified(&mut conn, "transfer-out"), 1);
    }

    #[tokio::test]
    async fn unlink_transfer_activities_clears_pair_and_marks_external() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-in");
        insert_account(&mut conn, "acc-out");
        insert_transfer_activity(
            &mut conn,
            "transfer-in",
            "acc-in",
            "TRANSFER_IN",
            Some("transfer-group"),
            Some(r#"{"flow":{"is_external":false},"source":{"id":"snaptrade"}}"#),
        );
        insert_transfer_activity(
            &mut conn,
            "transfer-out",
            "acc-out",
            "TRANSFER_OUT",
            Some("transfer-group"),
            Some(r#"{"flow":{"is_external":false}}"#),
        );

        let (transfer_in, transfer_out) = repo
            .unlink_transfer_activities("transfer-in".to_string(), "transfer-out".to_string())
            .await
            .expect("unlink should succeed");

        assert_eq!(transfer_in.id, "transfer-in");
        assert_eq!(transfer_out.id, "transfer-out");
        assert_eq!(transfer_in.source_group_id, None);
        assert_eq!(transfer_out.source_group_id, None);
        assert!(transfer_in.is_user_modified);
        assert!(transfer_out.is_user_modified);
        assert_eq!(
            transfer_in.metadata.as_ref().and_then(|m| {
                m.get("flow")
                    .and_then(|flow| flow.get("is_external"))
                    .and_then(|value| value.as_bool())
            }),
            Some(true)
        );
        assert_eq!(
            transfer_out.metadata.as_ref().and_then(|m| {
                m.get("flow")
                    .and_then(|flow| flow.get("is_external"))
                    .and_then(|value| value.as_bool())
            }),
            Some(true)
        );
        assert_eq!(
            transfer_in
                .metadata
                .as_ref()
                .and_then(|m| m.get("source"))
                .and_then(|source| source.get("id"))
                .and_then(|value| value.as_str()),
            Some("snaptrade"),
            "unlink should preserve unrelated metadata"
        );

        let source_group_ids: Vec<Option<String>> = activities::table
            .filter(activities::id.eq_any(["transfer-in", "transfer-out"]))
            .select(activities::source_group_id)
            .load(&mut conn)
            .expect("source group ids");
        assert_eq!(source_group_ids, vec![None, None]);

        assert_eq!(
            activity_metadata(&mut conn, "transfer-in")["flow"]["is_external"],
            true
        );
        assert_eq!(
            activity_metadata(&mut conn, "transfer-out")["flow"]["is_external"],
            true
        );
        assert_eq!(activity_user_modified(&mut conn, "transfer-in"), 1);
        assert_eq!(activity_user_modified(&mut conn, "transfer-out"), 1);
    }

    #[tokio::test]
    async fn unlink_transfer_activities_rejects_unlinked_or_mismatched_pairs() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-in");
        insert_account(&mut conn, "acc-out");
        insert_transfer_activity(
            &mut conn,
            "linked-in",
            "acc-in",
            "TRANSFER_IN",
            Some("group-a"),
            Some(r#"{"flow":{"is_external":false}}"#),
        );
        insert_transfer_activity(
            &mut conn,
            "linked-out",
            "acc-out",
            "TRANSFER_OUT",
            Some("group-b"),
            Some(r#"{"flow":{"is_external":false}}"#),
        );
        insert_transfer_activity(
            &mut conn,
            "unlinked-out",
            "acc-out",
            "TRANSFER_OUT",
            None,
            Some(r#"{"flow":{"is_external":true}}"#),
        );
        insert_transfer_activity(&mut conn, "buy-row", "acc-in", "BUY", Some("group-a"), None);

        let mismatched = repo
            .unlink_transfer_activities("linked-in".to_string(), "linked-out".to_string())
            .await;
        assert!(mismatched.is_err());

        let unlinked = repo
            .unlink_transfer_activities("linked-in".to_string(), "unlinked-out".to_string())
            .await;
        assert!(unlinked.is_err());

        let non_transfer = repo
            .unlink_transfer_activities("linked-in".to_string(), "buy-row".to_string())
            .await;
        assert!(non_transfer.is_err());

        let linked_in_group: Option<String> = activities::table
            .filter(activities::id.eq("linked-in"))
            .select(activities::source_group_id)
            .first(&mut conn)
            .expect("linked-in group");
        let linked_out_group: Option<String> = activities::table
            .filter(activities::id.eq("linked-out"))
            .select(activities::source_group_id)
            .first(&mut conn)
            .expect("linked-out group");
        let unlinked_out_group: Option<String> = activities::table
            .filter(activities::id.eq("unlinked-out"))
            .select(activities::source_group_id)
            .first(&mut conn)
            .expect("unlinked-out group");

        assert_eq!(linked_in_group.as_deref(), Some("group-a"));
        assert_eq!(linked_out_group.as_deref(), Some("group-b"));
        assert_eq!(unlinked_out_group, None);
        assert_eq!(
            activity_metadata(&mut conn, "linked-in")["flow"]["is_external"],
            false
        );
    }

    #[tokio::test]
    async fn bulk_upsert_prefers_source_identity_over_idempotency_fallback() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-sync");

        let first = ActivityUpsert {
            id: "provider-id-1".to_string(),
            account_id: "acc-sync".to_string(),
            asset_id: None,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Decimal::ONE),
            unit_price: Some(Decimal::from(100)),
            currency: "USD".to_string(),
            fee: Some(Decimal::ZERO),
            amount: Some(Decimal::from(100)),
            status: None,
            notes: Some("first import".to_string()),
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("SNAPTRADE".to_string()),
            source_record_id: Some("txn-1".to_string()),
            source_group_id: None,
            idempotency_key: Some("idemp-1".to_string()),
            import_run_id: None,
        };

        let second = ActivityUpsert {
            id: "provider-id-2".to_string(),
            account_id: "acc-sync".to_string(),
            asset_id: None,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Decimal::ONE),
            unit_price: Some(Decimal::from(101)),
            currency: "USD".to_string(),
            fee: Some(Decimal::ZERO),
            amount: Some(Decimal::from(101)),
            status: None,
            notes: Some("updated import".to_string()),
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("SNAPTRADE".to_string()),
            source_record_id: Some("txn-1".to_string()),
            source_group_id: None,
            idempotency_key: Some("idemp-2".to_string()),
            import_run_id: None,
        };

        let first_result = repo
            .bulk_upsert(vec![first])
            .await
            .expect("first upsert succeeds");
        assert_eq!(first_result.created, 1);
        assert_eq!(first_result.updated, 0);

        let second_result = repo
            .bulk_upsert(vec![second])
            .await
            .expect("second upsert succeeds");
        assert_eq!(second_result.created, 0);
        assert_eq!(second_result.updated, 1);

        #[allow(clippy::type_complexity)]
        let rows: Vec<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = activities::table
            .filter(activities::account_id.eq("acc-sync"))
            .select((
                activities::id,
                activities::amount,
                activities::source_system,
                activities::source_record_id,
                activities::idempotency_key,
            ))
            .load(&mut conn)
            .expect("load synced activities");

        assert_eq!(
            rows.len(),
            1,
            "source identity should collapse provider-id churn"
        );
        assert_eq!(
            rows[0].0, "provider-id-1",
            "existing row id should be preserved"
        );
        assert_eq!(
            rows[0].1,
            Some("101".to_string()),
            "latest economics should win"
        );
        assert_eq!(rows[0].2.as_deref(), Some("SNAPTRADE"));
        assert_eq!(rows[0].3.as_deref(), Some("txn-1"));
        assert_eq!(rows[0].4.as_deref(), Some("idemp-2"));
    }

    #[tokio::test]
    async fn bulk_upsert_collapses_duplicate_source_identity_within_same_batch() {
        let (pool, writer) = setup_db();
        let repo = ActivityRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account(&mut conn, "acc-sync");

        let first = ActivityUpsert {
            id: "provider-id-1".to_string(),
            account_id: "acc-sync".to_string(),
            asset_id: None,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Decimal::ONE),
            unit_price: Some(Decimal::from(100)),
            currency: "USD".to_string(),
            fee: Some(Decimal::ZERO),
            amount: Some(Decimal::from(100)),
            status: None,
            notes: Some("first import".to_string()),
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("SNAPTRADE".to_string()),
            source_record_id: Some("txn-1".to_string()),
            source_group_id: None,
            idempotency_key: Some("idemp-1".to_string()),
            import_run_id: None,
        };

        let second = ActivityUpsert {
            id: "provider-id-2".to_string(),
            account_id: "acc-sync".to_string(),
            asset_id: None,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Decimal::ONE),
            unit_price: Some(Decimal::from(101)),
            currency: "USD".to_string(),
            fee: Some(Decimal::ZERO),
            amount: Some(Decimal::from(101)),
            status: None,
            notes: Some("updated import".to_string()),
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("SNAPTRADE".to_string()),
            source_record_id: Some("txn-1".to_string()),
            source_group_id: None,
            idempotency_key: Some("idemp-2".to_string()),
            import_run_id: None,
        };

        let result = repo
            .bulk_upsert(vec![first, second])
            .await
            .expect("batched upsert succeeds");

        assert_eq!(result.created, 1);
        assert_eq!(result.updated, 1);

        #[allow(clippy::type_complexity)]
        let rows: Vec<(
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = activities::table
            .filter(activities::account_id.eq("acc-sync"))
            .select((
                activities::id,
                activities::amount,
                activities::source_system,
                activities::source_record_id,
                activities::idempotency_key,
            ))
            .load(&mut conn)
            .expect("load synced activities");

        assert_eq!(
            rows.len(),
            1,
            "batch should collapse to a single provider row"
        );
        assert_eq!(
            rows[0].0, "provider-id-1",
            "first inserted row id should remain authoritative"
        );
        assert_eq!(rows[0].1, Some("101".to_string()));
        assert_eq!(rows[0].2.as_deref(), Some("SNAPTRADE"));
        assert_eq!(rows[0].3.as_deref(), Some("txn-1"));
        assert_eq!(rows[0].4.as_deref(), Some("idemp-2"));
    }
}
