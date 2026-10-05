//! SQLite repository implementation for alternative assets.
//!
//! This module provides the database operations for alternative assets
//! (properties, vehicles, collectibles, precious metals, liabilities).
//!
//! Alternative assets use a simplified model - no accounts or activities,
//! just asset records + valuation quotes.

use async_trait::async_trait;
use diesel::dsl::sql;
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sql_types::{Nullable, Text};
use diesel::sqlite::SqliteConnection;
use std::collections::HashMap;
use std::sync::Arc;

use wealthfolio_core::activities::Activity;
use wealthfolio_core::assets::loan::{
    link_payment, LoanPayment, LoanPaymentTag, LoanRecord, LoanUpdate, PaymentLink,
};
use wealthfolio_core::assets::{AlternativeAssetRepositoryTrait, LoanChange, PaymentTagChange};
use wealthfolio_core::errors::DatabaseError;
use wealthfolio_core::quotes::Quote;
use wealthfolio_core::{Error, Result};

use crate::activities::ActivityDB;
use crate::db::{get_connection, write_actor::DbWriteTx, WriteHandle};
use crate::errors::StorageError;
use crate::market_data::QuoteDB;
use crate::schema::{accounts, activities, assets, quotes};

/// Tagged withdrawals counted as payments, by loan. The core rule decides
/// which tagged activities count; this only finds them.
fn read_loan_payments(
    conn: &mut SqliteConnection,
    loan_ids: &[String],
) -> Result<HashMap<String, Vec<LoanPayment>>> {
    let mut payments: HashMap<String, Vec<LoanPayment>> = HashMap::new();
    if loan_ids.is_empty() {
        return Ok(payments);
    }
    let currencies: HashMap<String, String> = assets::table
        .filter(assets::id.eq_any(loan_ids))
        .select((assets::id, assets::quote_ccy))
        .load::<(String, String)>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .collect();
    let tagged_loan =
        sql::<Nullable<Text>>("json_extract(activities.metadata, '$.loan_payment.loan_id')");
    let rows = activities::table
        .inner_join(accounts::table)
        .filter(tagged_loan.eq_any(loan_ids))
        .select((ActivityDB::as_select(), accounts::account_type))
        .load::<(ActivityDB, String)>(conn)
        .map_err(StorageError::from)?;
    for (row, account_type) in rows {
        let activity = Activity::from(row);
        let Some(currency) = LoanPaymentTag::read(activity.metadata.as_ref())
            .and_then(|tag| currencies.get(&tag.loan_id))
        else {
            continue;
        };
        if let Some((loan_id, payment)) =
            LoanPayment::from_activity(&activity, &account_type, currency)
        {
            payments.entry(loan_id).or_default().push(payment);
        }
    }
    Ok(payments)
}

/// A loan's metadata and its manual balance quotes, oldest first.
fn read_loan(conn: &mut SqliteConnection, asset_id: &str) -> Result<LoanRecord> {
    let asset = assets::table
        .filter(assets::id.eq(asset_id))
        .first::<crate::assets::AssetDB>(conn)
        .optional()
        .map_err(StorageError::from)?
        .ok_or_else(|| {
            Error::Database(DatabaseError::NotFound(format!(
                "Asset not found: {asset_id}"
            )))
        })?;
    let metadata = asset
        .metadata
        .as_deref()
        .and_then(|m| serde_json::from_str(m).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let balances = quotes::table
        .filter(quotes::asset_id.eq(asset_id))
        .filter(quotes::source.eq("MANUAL"))
        .order(quotes::day.asc())
        .select(QuoteDB::as_select())
        .load::<QuoteDB>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .map(Quote::from)
        .collect();
    let payments = read_loan_payments(conn, std::slice::from_ref(&asset.id))?
        .remove(&asset.id)
        .unwrap_or_default();
    let payment_accounts = accounts::table
        .filter(accounts::account_type.eq("CASH"))
        .filter(accounts::currency.eq(&asset.quote_ccy))
        .filter(accounts::is_active.eq(true))
        .filter(accounts::is_archived.eq(false))
        .select(accounts::id)
        .load::<String>(conn)
        .map_err(StorageError::from)?;
    Ok(LoanRecord {
        asset_id: asset.id,
        currency: asset.quote_ccy,
        metadata,
        balances,
        payments,
        payment_accounts,
    })
}

/// Replaces a loan's metadata and records the change for sync.
fn write_asset_metadata(
    tx: &mut DbWriteTx<'_>,
    asset_id: &str,
    metadata: &serde_json::Value,
) -> Result<()> {
    diesel::update(assets::table.filter(assets::id.eq(asset_id)))
        .set(assets::metadata.eq(Some(metadata.to_string())))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    let row = assets::table
        .filter(assets::id.eq(asset_id))
        .first::<crate::assets::AssetDB>(tx.conn())
        .map_err(StorageError::from)?;
    tx.update(&row)?;
    Ok(())
}

/// Writes an activity's metadata and records the change for sync.
fn write_activity_metadata(
    tx: &mut DbWriteTx<'_>,
    activity_id: &str,
    metadata: Option<&serde_json::Value>,
) -> Result<()> {
    diesel::update(activities::table.filter(activities::id.eq(activity_id)))
        .set((
            activities::metadata.eq(metadata.map(|m| m.to_string())),
            activities::updated_at.eq(chrono::Utc::now().to_rfc3339()),
        ))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    let row = activities::table
        .filter(activities::id.eq(activity_id))
        .select(ActivityDB::as_select())
        .first::<ActivityDB>(tx.conn())
        .map_err(StorageError::from)?;
    tx.update(&row)?;
    Ok(())
}

/// Repository for managing alternative asset data in the database.
///
/// This repository handles transactional operations for alternative assets,
/// including metadata updates and cascading deletions.
pub struct AlternativeAssetRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AlternativeAssetRepository {
    /// Creates a new AlternativeAssetRepository instance.
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl AlternativeAssetRepositoryTrait for AlternativeAssetRepository {
    /// Deletes an alternative asset and associated data transactionally.
    ///
    /// This operation performs the following steps in a transaction:
    /// 1. Unlinks any liabilities that reference this asset (removes linked_asset_id from metadata)
    /// 2. Deletes all quotes for this asset WHERE data_source = 'MANUAL'
    /// 3. Deletes the asset record
    ///
    /// Note: No account or activity deletion needed - alternative assets don't create them.
    async fn delete_alternative_asset(&self, asset_id: &str) -> Result<()> {
        let asset_id_owned = asset_id.to_string();

        self.writer
            .exec_tx(move |tx| -> Result<()> {
                // Step 1: Find and unlink any liabilities that reference this asset
                let linked_pattern = format!("%\"linked_asset_id\":\"{}\"%", asset_id_owned);

                let linked_liabilities: Vec<(String, Option<String>)> = assets::table
                    .filter(assets::metadata.like(&linked_pattern))
                    .select((assets::id, assets::metadata))
                    .load(tx.conn())
                    .map_err(StorageError::from)?;

                for (liability_id, metadata_opt) in linked_liabilities {
                    if let Some(metadata_str) = metadata_opt {
                        if let Ok(mut metadata_json) =
                            serde_json::from_str::<serde_json::Value>(&metadata_str)
                        {
                            if let Some(obj) = metadata_json.as_object_mut() {
                                obj.remove("linked_asset_id");
                            }

                            let updated_metadata = serde_json::to_string(&metadata_json).ok();

                            diesel::update(assets::table.filter(assets::id.eq(&liability_id)))
                                .set(assets::metadata.eq(updated_metadata))
                                .execute(tx.conn())
                                .map_err(StorageError::from)?;

                            let liability_row = assets::table
                                .filter(assets::id.eq(&liability_id))
                                .first::<crate::assets::AssetDB>(tx.conn())
                                .map_err(StorageError::from)?;

                            tx.update(&liability_row)?;
                        }
                    }
                }

                // Step 1b: Untag withdrawals paid toward this loan; they stay in their accounts.
                let tagged = activities::table
                    .filter(
                        sql::<Nullable<Text>>(
                            "json_extract(activities.metadata, '$.loan_payment.loan_id')",
                        )
                        .eq(&asset_id_owned),
                    )
                    .select(ActivityDB::as_select())
                    .load::<ActivityDB>(tx.conn())
                    .map_err(StorageError::from)?;
                for row in tagged {
                    let activity = Activity::from(row);
                    let untagged = link_payment(&activity, "", None, &PaymentLink::Unlink)?;
                    write_activity_metadata(tx, &activity.id, untagged.activity.as_ref())?;
                }

                // Step 2: Delete all quotes for this asset with source = 'MANUAL'
                diesel::delete(
                    quotes::table
                        .filter(quotes::asset_id.eq(&asset_id_owned))
                        .filter(quotes::source.eq("MANUAL")),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                // Step 3: Delete the asset record
                let assets_deleted =
                    diesel::delete(assets::table.filter(assets::id.eq(&asset_id_owned)))
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;

                if assets_deleted == 0 {
                    return Err(Error::Database(DatabaseError::NotFound(format!(
                        "Alternative asset not found: {}",
                        asset_id_owned
                    ))));
                }

                tx.delete::<crate::assets::AssetDB>(asset_id_owned);

                Ok(())
            })
            .await
    }

    /// Updates an asset's metadata.
    ///
    /// This is used for linking/unlinking liabilities to assets.
    /// The metadata is stored as a JSON string in the database.
    async fn update_asset_metadata(
        &self,
        asset_id: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<()> {
        self.update_asset_details(asset_id, None, None, metadata, None)
            .await
    }

    /// Finds all liabilities linked to the given asset.
    ///
    /// This queries assets where the metadata contains linked_asset_id = asset_id.
    /// Returns a list of liability asset IDs.
    fn find_liabilities_linked_to(&self, linked_asset_id: &str) -> Result<Vec<String>> {
        let mut conn = get_connection(&self.pool)?;

        // Build a pattern to match the linked_asset_id in the metadata JSON
        // Metadata is stored as JSON string, so we look for: "linked_asset_id":"PROP-xxxxx"
        let linked_pattern = format!("%\"linked_asset_id\":\"{}\"%", linked_asset_id);

        let liability_ids: Vec<String> = assets::table
            .filter(assets::metadata.like(&linked_pattern))
            .select(assets::id)
            .load(&mut conn)
            .map_err(StorageError::from)?;

        Ok(liability_ids)
    }

    /// Updates an asset's details (name, display_code, metadata, and/or notes).
    async fn update_asset_details(
        &self,
        asset_id: &str,
        name: Option<&str>,
        display_code: Option<&str>,
        metadata: Option<serde_json::Value>,
        notes: Option<&str>,
    ) -> Result<()> {
        let asset_id_owned = asset_id.to_string();
        let name_owned = name.map(|n| n.to_string());
        let display_code_owned = display_code.map(|s| s.to_string());
        let metadata_str = metadata.and_then(|v| serde_json::to_string(&v).ok());
        let notes_owned = notes.map(|n| n.to_string());

        self.writer
            .exec_tx(move |tx| -> Result<()> {
                // Build dynamic update based on which fields are provided
                let has_updates = name_owned.is_some()
                    || display_code_owned.is_some()
                    || metadata_str.is_some()
                    || notes_owned.is_some();

                if !has_updates {
                    return Ok(()); // Nothing to update
                }

                // Use a single query with all provided fields
                let updated = diesel::update(assets::table.filter(assets::id.eq(&asset_id_owned)))
                    .set((
                        name_owned.as_ref().map(|n| assets::name.eq(n)),
                        display_code_owned
                            .as_ref()
                            .map(|s| assets::display_code.eq(s)),
                        metadata_str.as_ref().map(|m| assets::metadata.eq(Some(m))),
                        notes_owned.as_ref().map(|n| assets::notes.eq(Some(n))),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;

                if updated == 0 {
                    return Err(Error::Database(DatabaseError::NotFound(format!(
                        "Asset not found: {}",
                        asset_id_owned
                    ))));
                }

                let updated_row = assets::table
                    .filter(assets::id.eq(&asset_id_owned))
                    .first::<crate::assets::AssetDB>(tx.conn())
                    .map_err(StorageError::from)?;
                tx.update(&updated_row)?;

                Ok(())
            })
            .await
    }

    async fn update_payment_tag(
        &self,
        activity_id: &str,
        loan_id: Option<&str>,
        change: PaymentTagChange,
    ) -> Result<Option<Activity>> {
        let activity_id = activity_id.to_string();
        let loan_id = loan_id.map(str::to_string);
        self.writer
            .exec_tx(move |tx| -> Result<Option<Activity>> {
                let (row, account_type) = activities::table
                    .inner_join(accounts::table)
                    .filter(activities::id.eq(&activity_id))
                    .select((ActivityDB::as_select(), accounts::account_type))
                    .first::<(ActivityDB, String)>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?
                    .ok_or_else(|| {
                        Error::Database(DatabaseError::NotFound(format!(
                            "Activity not found: {activity_id}"
                        )))
                    })?;
                let loan = match &loan_id {
                    Some(id) => match read_loan(tx.conn(), id) {
                        Ok(record) => Some(record),
                        Err(Error::Database(DatabaseError::NotFound(_))) => None,
                        Err(error) => return Err(error),
                    },
                    None => None,
                };
                let activity = Activity::from(row);
                let update = change(&activity, &account_type, loan.as_ref())?;
                if let (Some(metadata), Some(loan)) = (&update.loan, &loan) {
                    write_asset_metadata(tx, &loan.asset_id, metadata)?;
                }
                if update.activity == activity.metadata {
                    return Ok(None);
                }
                write_activity_metadata(tx, &activity_id, update.activity.as_ref())?;
                Ok(Some(activity))
            })
            .await
    }

    fn loan_payments(&self, loan_ids: &[String]) -> Result<HashMap<String, Vec<LoanPayment>>> {
        let mut conn = get_connection(&self.pool)?;
        read_loan_payments(&mut conn, loan_ids)
    }

    async fn update_loan(&self, asset_id: &str, change: LoanChange) -> Result<LoanUpdate> {
        let asset_id = asset_id.to_string();
        self.writer
            .exec_tx(move |tx| -> Result<LoanUpdate> {
                // Decide from what is stored now, inside the same transaction as the writes.
                // The decision runs on the shared writer, so a panic becomes an error
                // instead of stopping every later write.
                let record = read_loan(tx.conn(), &asset_id)?;
                let update =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| change(&record)))
                        .map_err(|_| Error::Unexpected("Loan action failed unexpectedly".into()))??;
                if let Some(metadata) = &update.metadata {
                    write_asset_metadata(tx, &asset_id, metadata)?;
                }
                for id in &update.delete_balances {
                    let existing = quotes::table
                        .filter(quotes::id.eq(id))
                        .filter(quotes::asset_id.eq(&asset_id))
                        .select(QuoteDB::as_select())
                        .first::<QuoteDB>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;
                    if let Some(row) = existing {
                        diesel::delete(quotes::table.filter(quotes::id.eq(id)))
                            .execute(tx.conn())
                            .map_err(StorageError::from)?;
                        tx.delete_model(&row);
                    }
                }
                // Manual quotes are one per day, as when saved one at a time.
                for quote in &update.save_balances {
                    let mut row = QuoteDB::from(quote);
                    let existing = quotes::table
                        .filter(quotes::asset_id.eq(&row.asset_id))
                        .filter(quotes::day.eq(&row.day))
                        .filter(quotes::source.eq(&row.source))
                        .select(QuoteDB::as_select())
                        .first::<QuoteDB>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;
                    let is_update = existing.is_some();
                    if let Some(existing) = existing {
                        row.id = existing.id;
                    }
                    diesel::replace_into(quotes::table)
                        .values(&row)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    if is_update {
                        tx.update(&row)?;
                    } else {
                        tx.insert(&row)?;
                    }
                }
                Ok(update)
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_linked_pattern_construction() {
        let asset_id = "PROP-a1b2c3d4";
        let pattern = format!("%\"linked_asset_id\":\"{}\"%", asset_id);
        assert_eq!(pattern, "%\"linked_asset_id\":\"PROP-a1b2c3d4\"%");

        // This pattern would match JSON like:
        // {"linked_asset_id":"PROP-a1b2c3d4","sub_type":"mortgage"}
    }
}
