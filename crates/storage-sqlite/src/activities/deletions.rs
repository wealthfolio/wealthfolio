//! Tombstones for broker-sourced activities the user deleted.
//!
//! A broker re-sync walks the same window and upserts on the same keys, so a
//! hard delete is undone by the next sync. Recording the delete lets
//! [`super::repository::ActivityRepository::bulk_upsert`] suppress the row
//! instead of resurrecting it, and lets the user put it back deliberately.
//!
//! Only a *user* delete tombstones. A provider that stops returning a record
//! deletes nothing locally, so it never reaches this module — which is the
//! distinction the two events need.

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use std::collections::HashSet;
use uuid::Uuid;
use wealthfolio_core::activities::ActivityError;
use wealthfolio_core::{Error, Result};

use super::model::ActivityDB;
use crate::errors::StorageError;
use crate::schema::{activities, activity_deletions};

/// A recorded deletion, carrying the row that was removed so the suppression
/// list can describe it and a restore can put it back unchanged.
#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = crate::schema::activity_deletions)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct ActivityDeletionDB {
    pub id: String,
    pub account_id: String,
    pub source_system: String,
    pub source_record_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub activity_snapshot: String,
    pub deleted_at: String,
}

/// The keys a re-sync is matched against, mirroring the order `bulk_upsert`
/// itself matches in: provider identity first, semantic idempotency key as the
/// fallback for feeds that carry no record id.
#[derive(Debug, Default, Clone)]
pub(crate) struct SuppressedActivityKeys {
    source_identities: HashSet<(String, String, String)>,
    idempotency_keys: HashSet<String>,
}

impl SuppressedActivityKeys {
    pub(crate) fn is_empty(&self) -> bool {
        self.source_identities.is_empty() && self.idempotency_keys.is_empty()
    }

    pub(crate) fn suppresses(&self, activity: &ActivityDB) -> bool {
        if let Some(source_record_id) = normalized(activity.source_record_id.as_deref()) {
            if let Some(source_system) = normalized_source_system(activity.source_system.as_deref())
            {
                if self.source_identities.contains(&(
                    source_system,
                    activity.account_id.clone(),
                    source_record_id,
                )) {
                    return true;
                }
            }
        }

        normalized(activity.idempotency_key.as_deref())
            .is_some_and(|key| self.idempotency_keys.contains(&key))
    }
}

/// Broker-sourced rows are the only ones a re-sync can bring back. A manual or
/// CSV row is deleted once and stays deleted, so tombstoning it would only add
/// a row nothing ever reads.
fn suppression_keys(activity: &ActivityDB) -> Option<(String, Option<String>, Option<String>)> {
    let source_system = normalized_source_system(activity.source_system.as_deref())?;
    if matches!(source_system.as_str(), "MANUAL" | "CSV") {
        return None;
    }

    let source_record_id = normalized(activity.source_record_id.as_deref());
    let idempotency_key =
        normalized(activity.idempotency_key.as_deref()).filter(|key| !key.starts_with("manual:"));

    if source_record_id.is_none() && idempotency_key.is_none() {
        return None;
    }

    Some((source_system, source_record_id, idempotency_key))
}

/// Records a user deletion. Returns `false` when the row is not one a re-sync
/// could return.
pub(crate) fn record_activity_deletion_tx(
    conn: &mut SqliteConnection,
    activity: &ActivityDB,
) -> Result<bool> {
    let Some((source_system, source_record_id, idempotency_key)) = suppression_keys(activity)
    else {
        return Ok(false);
    };

    // A second local row can share the identity of one already tombstoned (the
    // same record imported twice). Keep the newer tombstone rather than failing
    // the delete on the unique index.
    if let Some(ref source_record_id) = source_record_id {
        diesel::delete(
            activity_deletions::table
                .filter(activity_deletions::account_id.eq(&activity.account_id))
                .filter(activity_deletions::source_system.eq(&source_system))
                .filter(activity_deletions::source_record_id.eq(source_record_id)),
        )
        .execute(conn)
        .map_err(StorageError::from)?;
    }
    if let Some(ref idempotency_key) = idempotency_key {
        diesel::delete(
            activity_deletions::table
                .filter(activity_deletions::idempotency_key.eq(idempotency_key)),
        )
        .execute(conn)
        .map_err(StorageError::from)?;
    }

    let row = ActivityDeletionDB {
        id: Uuid::new_v4().to_string(),
        account_id: activity.account_id.clone(),
        source_system,
        source_record_id,
        idempotency_key,
        activity_snapshot: serde_json::to_string(activity)?,
        deleted_at: chrono::Utc::now().to_rfc3339(),
    };

    diesel::insert_into(activity_deletions::table)
        .values(&row)
        .execute(conn)
        .map_err(StorageError::from)?;

    Ok(true)
}

/// Loads the suppression keys covering the accounts an upsert batch touches.
pub(crate) fn load_suppressed_activity_keys_tx(
    conn: &mut SqliteConnection,
    account_ids: &[String],
) -> Result<SuppressedActivityKeys> {
    let mut keys = SuppressedActivityKeys::default();
    if account_ids.is_empty() {
        return Ok(keys);
    }

    for chunk in crate::utils::chunk_for_sqlite(account_ids) {
        let rows: Vec<(String, String, Option<String>, Option<String>)> = activity_deletions::table
            .filter(activity_deletions::account_id.eq_any(chunk))
            .select((
                activity_deletions::account_id,
                activity_deletions::source_system,
                activity_deletions::source_record_id,
                activity_deletions::idempotency_key,
            ))
            .load(conn)
            .map_err(StorageError::from)?;

        for (account_id, source_system, source_record_id, idempotency_key) in rows {
            if let Some(source_record_id) = source_record_id {
                keys.source_identities
                    .insert((source_system, account_id, source_record_id));
            }
            if let Some(idempotency_key) = idempotency_key {
                keys.idempotency_keys.insert(idempotency_key);
            }
        }
    }

    Ok(keys)
}

pub(crate) fn list_activity_deletions_tx(
    conn: &mut SqliteConnection,
    account_ids: Option<&[String]>,
) -> Result<Vec<(ActivityDeletionDB, ActivityDB)>> {
    let rows: Vec<ActivityDeletionDB> = match account_ids {
        Some(account_ids) => {
            if account_ids.is_empty() {
                return Ok(Vec::new());
            }
            let mut rows = Vec::new();
            for chunk in crate::utils::chunk_for_sqlite(account_ids) {
                rows.extend(
                    activity_deletions::table
                        .filter(activity_deletions::account_id.eq_any(chunk))
                        .select(ActivityDeletionDB::as_select())
                        .load::<ActivityDeletionDB>(conn)
                        .map_err(StorageError::from)?,
                );
            }
            rows
        }
        None => activity_deletions::table
            .select(ActivityDeletionDB::as_select())
            .load::<ActivityDeletionDB>(conn)
            .map_err(StorageError::from)?,
    };

    let mut deletions: Vec<(ActivityDeletionDB, ActivityDB)> = rows
        .into_iter()
        .map(|row| {
            let snapshot = parse_activity_snapshot(&row.activity_snapshot)?;
            Ok((row, snapshot))
        })
        .collect::<Result<Vec<_>>>()?;

    deletions.sort_by(|(left, _), (right, _)| right.deleted_at.cmp(&left.deleted_at));
    Ok(deletions)
}

/// Drops the tombstone and puts the recorded row back, so the next sync updates
/// it in place instead of inserting a duplicate.
pub(crate) fn restore_activity_deletion_tx(
    conn: &mut SqliteConnection,
    deletion_id: &str,
) -> Result<ActivityDB> {
    let row = activity_deletions::table
        .find(deletion_id)
        .select(ActivityDeletionDB::as_select())
        .first::<ActivityDeletionDB>(conn)
        .optional()
        .map_err(StorageError::from)?
        .ok_or_else(|| {
            Error::from(ActivityError::NotFound(format!(
                "No suppressed activity with id {deletion_id}"
            )))
        })?;

    let snapshot = parse_activity_snapshot(&row.activity_snapshot)?;

    diesel::delete(activity_deletions::table.find(&row.id))
        .execute(conn)
        .map_err(StorageError::from)?;

    diesel::insert_or_ignore_into(activities::table)
        .values(&snapshot)
        .execute(conn)
        .map_err(StorageError::from)?;

    activities::table
        .find(&snapshot.id)
        .select(ActivityDB::as_select())
        .first::<ActivityDB>(conn)
        .map_err(StorageError::from)
        .map_err(Error::from)
}

/// A snapshot is read back long after it was written, so a column added to
/// `activities` in the meantime must not make the deletion unreadable — and an
/// unreadable deletion is one that suppresses a row nothing can restore.
fn parse_activity_snapshot(snapshot: &str) -> Result<ActivityDB> {
    let mut value = serde_json::from_str::<serde_json::Value>(snapshot)?;
    let defaults = serde_json::to_value(ActivityDB::default())?;
    if let (Some(fields), Some(defaults)) = (value.as_object_mut(), defaults.as_object()) {
        for (field, default) in defaults {
            fields
                .entry(field.clone())
                .or_insert_with(|| default.clone());
        }
    }
    Ok(serde_json::from_value::<ActivityDB>(value)?)
}

fn normalized(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_source_system(value: Option<&str>) -> Option<String> {
    normalized(value).map(|value| value.to_ascii_uppercase())
}
