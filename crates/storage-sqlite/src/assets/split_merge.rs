//! Merges an instrument that is split across a legacy-MIC asset row and its
//! canonical twin.
//!
//! Everything runs inside one writer transaction: an error anywhere rolls back
//! every table and the projected sync outbox rows with it. The duplicate row is
//! deactivated, never deleted — a synced delete would cascade into broker
//! activities on other devices, and those activities do not sync.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::Text;
use diesel::sqlite::SqliteConnection;

use wealthfolio_core::assets::{AssetMergePreview, AssetMergeReport, SharedSourceSnapshot};
use wealthfolio_core::{Error, Result};

use super::model::AssetDB;
use crate::activities::ActivityDB;
use crate::assets::AssetLogoDB;
use crate::db::write_actor::DbWriteTx;
use crate::errors::StorageError;
use crate::market_data::QuoteDB;
use crate::portfolio::allocation_targets::AllocationTargetConstraintDB;
use crate::portfolio::snapshot::AccountStateSnapshotDB;
use crate::schema::{
    activities, allocation_target_constraints, asset_logos, asset_taxonomy_assignments, assets,
    holdings_snapshots, lot_disposals, lots, quote_sync_state, quotes, snapshot_positions,
};
use crate::taxonomies::AssetTaxonomyAssignmentDB;

const AUTO_SOURCE: &str = "AUTO";
const CALCULATED_SOURCE: &str = "CALCULATED";

#[derive(Debug, QueryableByName)]
struct SnapshotWithAccountRow {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    account_id: String,
    #[diesel(sql_type = Text)]
    account_name: String,
    #[diesel(sql_type = Text)]
    snapshot_date: String,
}

/// Read-only preview of [`merge`].
pub(crate) fn preview(
    conn: &mut SqliteConnection,
    survivor_id: &str,
    duplicate_id: &str,
) -> Result<AssetMergePreview> {
    load_pair(conn, survivor_id, duplicate_id)?;

    let survivor_quotes = load_quotes(conn, survivor_id)?;
    let duplicate_quotes = load_quotes(conn, duplicate_id)?;
    let mut preview = quote_preview(&survivor_quotes, &duplicate_quotes);
    preview.shared_source_snapshots = shared_source_snapshots(conn, survivor_id, duplicate_id)?;
    Ok(preview)
}

/// Moves every reference to `duplicate_id` onto `survivor_id` and deactivates
/// the duplicate. Refuses, writing nothing, when a user-entered snapshot lists
/// both rows.
pub(crate) fn merge(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
) -> Result<AssetMergeReport> {
    let (survivor, duplicate) = load_pair(tx.conn(), survivor_id, duplicate_id)?;

    let shared = shared_source_snapshots(tx.conn(), survivor_id, duplicate_id)?;
    if !shared.is_empty() {
        let listed = shared
            .iter()
            .map(|snapshot| format!("{} on {}", snapshot.account_name, snapshot.snapshot_date))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(Error::ConstraintViolation(format!(
            "Cannot merge {}: these holdings snapshots list both copies of the asset: {}. \
             Edit each snapshot so the holding appears once, then merge again.",
            display_symbol(&survivor),
            listed
        )));
    }

    let mut report = AssetMergeReport {
        survivor_id: survivor_id.to_string(),
        duplicate_id: duplicate_id.to_string(),
        ..AssetMergeReport::default()
    };
    let mut affected_accounts: BTreeSet<String> = BTreeSet::new();
    let mut currencies: BTreeSet<String> = BTreeSet::new();
    let now = chrono::Utc::now().to_rfc3339();

    // Accounts holding the survivor are rebuilt too: its price history grows.
    let referencing: Vec<(String, String)> = activities::table
        .filter(activities::asset_id.eq_any(vec![survivor_id, duplicate_id]))
        .select((activities::account_id, activities::currency))
        .load(tx.conn())
        .map_err(StorageError::from)?;
    for (account_id, currency) in referencing {
        affected_accounts.insert(account_id);
        currencies.insert(currency);
    }

    report.activities_moved = move_activities(tx, survivor_id, duplicate_id, &now)?;
    let (moved, dropped) = move_quotes(tx, survivor_id, duplicate_id)?;
    report.quotes_moved = moved;
    report.quotes_dropped = dropped;

    diesel::delete(quote_sync_state::table.filter(quote_sync_state::asset_id.eq(duplicate_id)))
        .execute(tx.conn())
        .map_err(StorageError::from)?;

    move_taxonomy_assignments(tx, survivor_id, duplicate_id, &now, &mut report)?;
    report.logo_moved = move_logo(tx, survivor_id, duplicate_id, &now)?;
    move_snapshots(
        tx,
        survivor_id,
        duplicate_id,
        &mut report,
        &mut affected_accounts,
    )?;

    // Lots and disposals are rebuilt from activities; re-pointing them keeps
    // them consistent until the rebuild replaces them.
    report.lots_moved = diesel::update(lots::table.filter(lots::asset_id.eq(duplicate_id)))
        .set(lots::asset_id.eq(survivor_id))
        .execute(tx.conn())
        .map_err(StorageError::from)? as u32;
    report.lot_disposals_moved =
        diesel::update(lot_disposals::table.filter(lot_disposals::asset_id.eq(duplicate_id)))
            .set(lot_disposals::asset_id.eq(survivor_id))
            .execute(tx.conn())
            .map_err(StorageError::from)? as u32;

    move_allocation_constraints(tx, survivor_id, duplicate_id, &now, &mut report)?;
    carry_asset_fields(tx, &survivor, &duplicate)?;

    if duplicate.is_active != 0 {
        let deactivated = diesel::update(assets::table.filter(assets::id.eq(duplicate_id)))
            .set(assets::is_active.eq(0))
            .get_result::<AssetDB>(tx.conn())
            .map_err(StorageError::from)?;
        tx.update(&deactivated)?;
    }

    report.affected_account_ids = affected_accounts.into_iter().collect();
    report.currencies = currencies.into_iter().collect();
    Ok(report)
}

fn load_pair(
    conn: &mut SqliteConnection,
    survivor_id: &str,
    duplicate_id: &str,
) -> Result<(AssetDB, AssetDB)> {
    if survivor_id == duplicate_id {
        return Err(Error::Asset(
            "Cannot merge an asset into itself".to_string(),
        ));
    }
    let survivor = assets::table
        .find(survivor_id)
        .select(AssetDB::as_select())
        .first::<AssetDB>(conn)
        .map_err(StorageError::from)?;
    let duplicate = assets::table
        .find(duplicate_id)
        .select(AssetDB::as_select())
        .first::<AssetDB>(conn)
        .map_err(StorageError::from)?;
    Ok((survivor, duplicate))
}

fn display_symbol(asset: &AssetDB) -> String {
    asset
        .instrument_symbol
        .clone()
        .or_else(|| asset.display_code.clone())
        .unwrap_or_else(|| asset.id.clone())
}

fn load_quotes(conn: &mut SqliteConnection, asset_id: &str) -> Result<Vec<QuoteDB>> {
    Ok(quotes::table
        .filter(quotes::asset_id.eq(asset_id))
        .select(QuoteDB::as_select())
        .load::<QuoteDB>(conn)
        .map_err(StorageError::from)?)
}

/// Same order the quote readers use for one asset and day: MANUAL first, then
/// providers, then BROKER; the latest timestamp breaks ties.
fn source_priority(source: &str) -> u8 {
    match source {
        "MANUAL" => 1,
        "BROKER" => 3,
        _ => 2,
    }
}

fn quote_preview(survivor_quotes: &[QuoteDB], duplicate_quotes: &[QuoteDB]) -> AssetMergePreview {
    let mut preview = AssetMergePreview::default();
    let survivor_keys: HashSet<(&str, &str)> = survivor_quotes
        .iter()
        .map(|quote| (quote.day.as_str(), quote.source.as_str()))
        .collect();

    // Per day: (row, from_survivor) for every row that will exist after the merge.
    let mut days: BTreeMap<&str, Vec<(&QuoteDB, bool)>> = BTreeMap::new();
    let mut duplicate_days: HashSet<&str> = HashSet::new();
    for quote in survivor_quotes {
        days.entry(quote.day.as_str())
            .or_default()
            .push((quote, true));
    }
    for quote in duplicate_quotes {
        duplicate_days.insert(quote.day.as_str());
        if survivor_keys.contains(&(quote.day.as_str(), quote.source.as_str())) {
            preview.duplicate_quotes_dropped += 1;
        } else {
            preview.duplicate_quotes_moved += 1;
            days.entry(quote.day.as_str())
                .or_default()
                .push((quote, false));
        }
    }

    let survivor_days: HashSet<&str> = survivor_quotes.iter().map(|q| q.day.as_str()).collect();
    for (day, rows) in &days {
        if !(survivor_days.contains(day) && duplicate_days.contains(day)) {
            continue;
        }
        preview.overlapping_quote_days += 1;
        let winner = rows.iter().min_by(|(a, a_survivor), (b, b_survivor)| {
            source_priority(&a.source)
                .cmp(&source_priority(&b.source))
                .then_with(|| b.timestamp.cmp(&a.timestamp))
                .then_with(|| b_survivor.cmp(a_survivor))
        });
        match winner {
            Some((_, true)) => preview.overlap_days_kept_from_survivor += 1,
            Some((_, false)) => preview.overlap_days_kept_from_duplicate += 1,
            None => {}
        }
    }
    preview
}

/// User-entered snapshots (anything not CALCULATED) whose positions list both rows.
fn shared_source_snapshots(
    conn: &mut SqliteConnection,
    survivor_id: &str,
    duplicate_id: &str,
) -> Result<Vec<SharedSourceSnapshot>> {
    let rows: Vec<SnapshotWithAccountRow> = sql_query(
        "SELECT s.id AS id, s.account_id AS account_id, a.name AS account_name, \
                CAST(s.snapshot_date AS TEXT) AS snapshot_date \
         FROM holdings_snapshots s \
         JOIN accounts a ON a.id = s.account_id \
         WHERE s.source <> 'CALCULATED' \
           AND EXISTS (SELECT 1 FROM json_each(s.positions) p WHERE p.key = ?) \
           AND EXISTS (SELECT 1 FROM json_each(s.positions) p WHERE p.key = ?) \
         ORDER BY a.name, s.snapshot_date",
    )
    .bind::<Text, _>(survivor_id)
    .bind::<Text, _>(duplicate_id)
    .load(conn)
    .map_err(StorageError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| SharedSourceSnapshot {
            account_id: row.account_id,
            account_name: row.account_name,
            snapshot_date: row.snapshot_date,
        })
        .collect())
}

fn move_activities(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
    now: &str,
) -> Result<u32> {
    let ids: Vec<String> = activities::table
        .filter(activities::asset_id.eq(duplicate_id))
        .select(activities::id)
        .load(tx.conn())
        .map_err(StorageError::from)?;
    if ids.is_empty() {
        return Ok(0);
    }
    diesel::update(activities::table.filter(activities::asset_id.eq(duplicate_id)))
        .set((
            activities::asset_id.eq(survivor_id),
            activities::updated_at.eq(now),
        ))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    for chunk in crate::utils::chunk_for_sqlite(&ids) {
        let rows = activities::table
            .filter(activities::id.eq_any(chunk))
            .select(ActivityDB::as_select())
            .load::<ActivityDB>(tx.conn())
            .map_err(StorageError::from)?;
        for row in rows {
            tx.update(&row)?;
        }
    }
    Ok(ids.len() as u32)
}

/// Survivor quotes win on the same day and source. The duplicate's remaining
/// quotes move; deterministic ids (`{asset}_{day}_{source}`) are re-keyed to
/// the survivor, other ids (synced manual quotes) keep theirs.
fn move_quotes(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
) -> Result<(u32, u32)> {
    let survivor_keys: HashSet<(String, String)> = load_quotes(tx.conn(), survivor_id)?
        .into_iter()
        .map(|quote| (quote.day, quote.source))
        .collect();
    let mut moved = 0;
    let mut dropped = 0;
    for quote in load_quotes(tx.conn(), duplicate_id)? {
        if survivor_keys.contains(&(quote.day.clone(), quote.source.clone())) {
            diesel::delete(quotes::table.filter(quotes::id.eq(&quote.id)))
                .execute(tx.conn())
                .map_err(StorageError::from)?;
            tx.delete_model(&quote);
            dropped += 1;
            continue;
        }

        let deterministic_id = format!("{}_{}_{}", duplicate_id, quote.day, quote.source);
        let new_id = if quote.id == deterministic_id {
            format!("{}_{}_{}", survivor_id, quote.day, quote.source)
        } else {
            quote.id.clone()
        };
        let updated = diesel::update(quotes::table.filter(quotes::id.eq(&quote.id)))
            .set((quotes::id.eq(&new_id), quotes::asset_id.eq(survivor_id)))
            .get_result::<QuoteDB>(tx.conn())
            .map_err(StorageError::from)?;
        if new_id == quote.id {
            tx.update(&updated)?;
        } else {
            tx.delete_model(&quote);
            tx.insert(&updated)?;
        }
        moved += 1;
    }
    Ok((moved, dropped))
}

fn move_taxonomy_assignments(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
    now: &str,
    report: &mut AssetMergeReport,
) -> Result<()> {
    let load = |conn: &mut SqliteConnection, asset_id: &str| {
        asset_taxonomy_assignments::table
            .filter(asset_taxonomy_assignments::asset_id.eq(asset_id))
            .select(AssetTaxonomyAssignmentDB::as_select())
            .load::<AssetTaxonomyAssignmentDB>(conn)
            .map_err(StorageError::from)
    };
    let mut survivor_by_taxonomy: HashMap<String, Vec<AssetTaxonomyAssignmentDB>> = HashMap::new();
    for row in load(tx.conn(), survivor_id)? {
        survivor_by_taxonomy
            .entry(row.taxonomy_id.clone())
            .or_default()
            .push(row);
    }
    let mut duplicate_by_taxonomy: BTreeMap<String, Vec<AssetTaxonomyAssignmentDB>> =
        BTreeMap::new();
    for row in load(tx.conn(), duplicate_id)? {
        duplicate_by_taxonomy
            .entry(row.taxonomy_id.clone())
            .or_default()
            .push(row);
    }

    let is_auto = |row: &AssetTaxonomyAssignmentDB| row.source.eq_ignore_ascii_case(AUTO_SOURCE);
    let mut changed_taxonomies = Vec::new();
    for (taxonomy_id, duplicate_rows) in duplicate_by_taxonomy {
        let survivor_rows = survivor_by_taxonomy
            .remove(&taxonomy_id)
            .unwrap_or_default();
        let duplicate_user_set = duplicate_rows.iter().any(|row| !is_auto(row));
        let survivor_user_set = survivor_rows.iter().any(|row| !is_auto(row));
        // A user's classification beats an automatic one; between two of the
        // same kind the survivor's stands.
        let take_duplicate = if duplicate_user_set {
            !survivor_user_set
        } else {
            survivor_rows.is_empty()
        };

        if take_duplicate {
            for row in &survivor_rows {
                remove_assignment(tx, &row.id)?;
            }
            for row in duplicate_rows {
                let updated = diesel::update(
                    asset_taxonomy_assignments::table
                        .filter(asset_taxonomy_assignments::id.eq(&row.id)),
                )
                .set((
                    asset_taxonomy_assignments::asset_id.eq(survivor_id),
                    asset_taxonomy_assignments::updated_at.eq(now),
                ))
                .get_result::<AssetTaxonomyAssignmentDB>(tx.conn())
                .map_err(StorageError::from)?;
                tx.update(&updated)?;
                report.taxonomy_assignments_moved += 1;
            }
            changed_taxonomies.push(taxonomy_id);
        } else {
            for row in duplicate_rows {
                remove_assignment(tx, &row.id)?;
                report.taxonomy_assignments_dropped += 1;
            }
        }
    }
    report.changed_taxonomy_ids = changed_taxonomies;
    Ok(())
}

fn remove_assignment(tx: &mut DbWriteTx<'_>, id: &str) -> Result<()> {
    diesel::delete(asset_taxonomy_assignments::table.filter(asset_taxonomy_assignments::id.eq(id)))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    tx.delete::<AssetTaxonomyAssignmentDB>(id.to_string());
    Ok(())
}

fn move_logo(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
    now: &str,
) -> Result<bool> {
    let find = |conn: &mut SqliteConnection, asset_id: &str| {
        asset_logos::table
            .find(asset_id)
            .select(AssetLogoDB::as_select())
            .first::<AssetLogoDB>(conn)
            .optional()
            .map_err(StorageError::from)
    };
    let Some(duplicate_logo) = find(tx.conn(), duplicate_id)? else {
        return Ok(false);
    };
    let survivor_has_logo = find(tx.conn(), survivor_id)?.is_some();

    diesel::delete(asset_logos::table.find(duplicate_id))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    tx.delete_model(&duplicate_logo);
    if survivor_has_logo {
        return Ok(false);
    }

    let moved = AssetLogoDB {
        asset_id: survivor_id.to_string(),
        updated_at: now.to_string(),
        ..duplicate_logo
    };
    diesel::insert_into(asset_logos::table)
        .values(&moved)
        .execute(tx.conn())
        .map_err(StorageError::from)?;
    tx.insert(&moved)?;
    Ok(true)
}

/// Re-keys the duplicate's position in every snapshot that holds it, in both
/// the JSON column and the relational `snapshot_positions` rows.
///
/// Source snapshots never hold both rows here (the caller refused). Calculated
/// snapshots are rebuilt from activities after the merge; until then a
/// duplicate position beside a survivor one is dropped so the portfolio job's
/// quote-sync reconciliation, which reads the latest snapshots before the
/// rebuild, does not reactivate the duplicate.
fn move_snapshots(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
    report: &mut AssetMergeReport,
    affected_accounts: &mut BTreeSet<String>,
) -> Result<()> {
    let snapshot_ids: Vec<String> = sql_query(
        "SELECT s.id AS id, s.account_id AS account_id, '' AS account_name, \
                CAST(s.snapshot_date AS TEXT) AS snapshot_date \
         FROM holdings_snapshots s \
         WHERE EXISTS (SELECT 1 FROM json_each(s.positions) p WHERE p.key = ?)",
    )
    .bind::<Text, _>(duplicate_id)
    .load::<SnapshotWithAccountRow>(tx.conn())
    .map_err(StorageError::from)?
    .into_iter()
    .map(|row| row.id)
    .collect();

    for snapshot_id in snapshot_ids {
        let snapshot = holdings_snapshots::table
            .find(&snapshot_id)
            .first::<AccountStateSnapshotDB>(tx.conn())
            .map_err(StorageError::from)?;
        let mut positions: serde_json::Value = serde_json::from_str(&snapshot.positions)?;
        let Some(map) = positions.as_object_mut() else {
            continue;
        };
        let Some(position) = map.remove(duplicate_id) else {
            continue;
        };
        if !map.contains_key(survivor_id) {
            map.insert(
                survivor_id.to_string(),
                rekey_position(position, duplicate_id, survivor_id),
            );
        } else if snapshot.source != CALCULATED_SOURCE {
            // Unreachable after the shared-snapshot check; never merge two
            // user-entered positions silently.
            return Err(Error::ConstraintViolation(format!(
                "Snapshot {} lists both copies of the asset",
                snapshot_id
            )));
        }
        let positions_json = serde_json::to_string(&positions)?;
        diesel::update(holdings_snapshots::table.find(&snapshot_id))
            .set(holdings_snapshots::positions.eq(&positions_json))
            .execute(tx.conn())
            .map_err(StorageError::from)?;
        let updated = AccountStateSnapshotDB {
            positions: positions_json,
            ..snapshot
        };
        tx.update(&updated)?;
        report.snapshots_rewritten += 1;
        affected_accounts.insert(updated.account_id.clone());

        let survivor_row_exists = snapshot_positions::table
            .filter(snapshot_positions::snapshot_id.eq(&snapshot_id))
            .filter(snapshot_positions::asset_id.eq(survivor_id))
            .count()
            .get_result::<i64>(tx.conn())
            .map_err(StorageError::from)?
            > 0;
        let duplicate_rows = snapshot_positions::table
            .filter(snapshot_positions::snapshot_id.eq(&snapshot_id))
            .filter(snapshot_positions::asset_id.eq(duplicate_id));
        if survivor_row_exists {
            report.snapshot_positions_dropped += diesel::delete(duplicate_rows)
                .execute(tx.conn())
                .map_err(StorageError::from)?
                as u32;
        } else {
            report.snapshot_positions_moved += diesel::update(duplicate_rows)
                .set(snapshot_positions::asset_id.eq(survivor_id))
                .execute(tx.conn())
                .map_err(StorageError::from)? as u32;
        }
    }
    Ok(())
}

/// Rewrites a position's asset references without going through the typed
/// `Position`, whose `lots` field is not serialized: a typed round-trip would
/// drop the lots that older snapshots embed.
fn rekey_position(
    mut position: serde_json::Value,
    duplicate_id: &str,
    survivor_id: &str,
) -> serde_json::Value {
    let Some(object) = position.as_object_mut() else {
        return position;
    };
    object.insert(
        "assetId".to_string(),
        serde_json::Value::String(survivor_id.to_string()),
    );
    let old_position_id = object
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let new_position_id = old_position_id.as_deref().and_then(|id| {
        id.strip_prefix(&format!("POS-{}-", duplicate_id))
            .map(|account| format!("POS-{}-{}", survivor_id, account))
    });
    if let (Some(old_id), Some(new_id)) = (old_position_id, new_position_id) {
        object.insert("id".to_string(), serde_json::Value::String(new_id.clone()));
        if let Some(lots) = object.get_mut("lots").and_then(|lots| lots.as_array_mut()) {
            for lot in lots {
                if lot.get("positionId").and_then(|value| value.as_str()) == Some(old_id.as_str()) {
                    lot["positionId"] = serde_json::Value::String(new_id.clone());
                }
            }
        }
    }
    position
}

fn move_allocation_constraints(
    tx: &mut DbWriteTx<'_>,
    survivor_id: &str,
    duplicate_id: &str,
    now: &str,
    report: &mut AssetMergeReport,
) -> Result<()> {
    let load = |conn: &mut SqliteConnection, asset_id: &str| {
        allocation_target_constraints::table
            .filter(allocation_target_constraints::subject_type.eq("asset"))
            .filter(allocation_target_constraints::subject_id.eq(asset_id))
            .load::<AllocationTargetConstraintDB>(conn)
            .map_err(StorageError::from)
    };
    let survivor_keys: HashSet<(String, String, String)> = load(tx.conn(), survivor_id)?
        .into_iter()
        .map(|row| (row.target_id, row.action, row.effect))
        .collect();
    for row in load(tx.conn(), duplicate_id)? {
        let key = (
            row.target_id.clone(),
            row.action.clone(),
            row.effect.clone(),
        );
        if survivor_keys.contains(&key) {
            diesel::delete(
                allocation_target_constraints::table
                    .filter(allocation_target_constraints::id.eq(&row.id)),
            )
            .execute(tx.conn())
            .map_err(StorageError::from)?;
            tx.delete::<AllocationTargetConstraintDB>(row.id);
            report.allocation_constraints_dropped += 1;
            continue;
        }
        diesel::update(
            allocation_target_constraints::table
                .filter(allocation_target_constraints::id.eq(&row.id)),
        )
        .set((
            allocation_target_constraints::subject_id.eq(survivor_id),
            allocation_target_constraints::updated_at.eq(now),
        ))
        .execute(tx.conn())
        .map_err(StorageError::from)?;
        let updated = AllocationTargetConstraintDB {
            subject_id: survivor_id.to_string(),
            updated_at: now.to_string(),
            ..row
        };
        tx.update(&updated)?;
        report.allocation_constraints_moved += 1;
    }
    Ok(())
}

/// Carries what the survivor lacks: notes, provider configuration, and
/// top-level metadata keys (except the provider `profile`, which enrichment
/// refreshes). Reactivates the survivor if needed.
fn carry_asset_fields(
    tx: &mut DbWriteTx<'_>,
    survivor: &AssetDB,
    duplicate: &AssetDB,
) -> Result<()> {
    let is_blank = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());

    let notes = if is_blank(&survivor.notes) && !is_blank(&duplicate.notes) {
        duplicate.notes.clone()
    } else {
        survivor.notes.clone()
    };
    let provider_config = if survivor.provider_config.is_none() {
        duplicate.provider_config.clone()
    } else {
        survivor.provider_config.clone()
    };

    let parse = |raw: &Option<String>| {
        raw.as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
    };
    let mut metadata = survivor.metadata.clone();
    if let Some(serde_json::Value::Object(extra)) = parse(&duplicate.metadata) {
        let merged = match parse(&survivor.metadata) {
            Some(serde_json::Value::Object(map)) => Some(map),
            None => Some(serde_json::Map::new()),
            Some(_) => None,
        };
        if let Some(mut merged) = merged {
            let before = merged.len();
            for (key, value) in extra {
                if key != "profile" && !merged.contains_key(&key) {
                    merged.insert(key, value);
                }
            }
            if merged.len() != before {
                metadata = Some(serde_json::to_string(&merged)?);
            }
        }
    }

    if notes == survivor.notes
        && provider_config == survivor.provider_config
        && metadata == survivor.metadata
        && survivor.is_active != 0
    {
        return Ok(());
    }
    let updated = diesel::update(assets::table.filter(assets::id.eq(&survivor.id)))
        .set((
            assets::notes.eq(notes),
            assets::provider_config.eq(provider_config),
            assets::metadata.eq(metadata),
            assets::is_active.eq(1),
        ))
        .get_result::<AssetDB>(tx.conn())
        .map_err(StorageError::from)?;
    tx.update(&updated)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(asset: &str, day: &str, source: &str, timestamp: &str) -> QuoteDB {
        QuoteDB {
            id: format!("{asset}_{day}_{source}"),
            asset_id: asset.to_string(),
            day: day.to_string(),
            source: source.to_string(),
            open: None,
            high: None,
            low: None,
            close: "1".to_string(),
            adjclose: None,
            volume: None,
            currency: "CAD".to_string(),
            notes: None,
            created_at: timestamp.to_string(),
            timestamp: timestamp.to_string(),
        }
    }

    #[test]
    fn quote_preview_counts_the_effective_price_per_overlapping_day() {
        let t = "2026-01-01T00:00:00Z";
        let survivor = vec![
            quote("S", "2026-01-02", "YAHOO", t),
            quote("S", "2026-01-03", "YAHOO", t),
            quote("S", "2026-01-04", "YAHOO", t),
        ];
        let duplicate = vec![
            // Same day and source: the survivor's quote stands.
            quote("L", "2026-01-02", "YAHOO", t),
            // A hand-entered price beats the survivor's downloaded one.
            quote("L", "2026-01-03", "MANUAL", t),
            // A broker trade price never shadows a provider quote.
            quote("L", "2026-01-04", "BROKER", t),
            // No overlap: just moves.
            quote("L", "2025-12-31", "YAHOO", t),
        ];

        let preview = quote_preview(&survivor, &duplicate);
        assert_eq!(preview.overlapping_quote_days, 3);
        assert_eq!(preview.overlap_days_kept_from_survivor, 2);
        assert_eq!(preview.overlap_days_kept_from_duplicate, 1);
        assert_eq!(preview.duplicate_quotes_dropped, 1);
        assert_eq!(preview.duplicate_quotes_moved, 3);
    }

    use crate::assets::AssetRepository;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::schema::sync_outbox;
    use std::sync::Arc;
    use wealthfolio_core::assets::AssetRepositoryTrait;

    type Pool = Arc<diesel::r2d2::Pool<diesel::r2d2::ConnectionManager<SqliteConnection>>>;

    const MANUAL_QUOTE_MOVES: &str = "0190f0a0-0000-7000-8000-000000000001";
    const MANUAL_QUOTE_CLASHES: &str = "0190f0a0-0000-7000-8000-000000000002";
    const SOURCE_SNAPSHOT: &str = "0190f0a0-0000-7000-8000-0000000000aa";

    fn setup() -> (Pool, AssetRepository) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let app_data = tempfile::tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool.clone(), AssetRepository::new(pool, writer))
    }

    fn exec(conn: &mut SqliteConnection, sql: &str) {
        sql_query(sql)
            .execute(conn)
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    /// The FEQT/VBG shape: the XNEO row holds the buys, price history and the
    /// user's classification; the NEOE twin holds a sell and the live quotes.
    fn seed_split_pair(conn: &mut SqliteConnection) {
        for (id, mode) in [("acc1", "TRANSACTIONS"), ("acc2", "HOLDINGS")] {
            exec(
                conn,
                &format!(
                    "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
                     created_at, updated_at, is_archived, tracking_mode) VALUES ('{id}', '{id} name', \
                     'SECURITIES', 'CAD', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, '{mode}')"
                ),
            );
        }
        exec(
            conn,
            r#"INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active,
               quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic,
               provider_config, created_at, updated_at) VALUES
               ('L', 'INVESTMENT', 'Vanguard Global', 'VBG', 'my note',
                '{"identifiers":{"isin":"CA1"},"profile":{"old":1}}', 1, 'MARKET', 'CAD',
                'EQUITY', 'VBG', 'XNEO', '{"preferredProvider":"YAHOO"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ('S', 'INVESTMENT', 'First Equities Corp', 'VBG', NULL, '{"profile":{"new":1}}', 0,
                'MARKET', 'CAD', 'EQUITY', 'VBG', 'NEOE', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"#,
        );
        let activity = |id: &str, asset: &str, kind: &str, source: &str| {
            let record = if source == "MANUAL" {
                "NULL".to_string()
            } else {
                format!("'{id}-ext'")
            };
            format!(
                "INSERT INTO activities (id, account_id, asset_id, activity_type, status, activity_date, \
                 quantity, unit_price, amount, fee, currency, source_system, source_record_id, \
                 is_user_modified, needs_review, created_at, updated_at) VALUES ('{id}', 'acc1', \
                 '{asset}', '{kind}', 'POSTED', '2026-01-02T15:00:00Z', '10', '31.5', '315', '0', \
                 'CAD', '{source}', {record}, 0, 0, '2026-01-02T15:00:00Z', '2026-01-02T15:00:00Z')"
            )
        };
        exec(conn, &activity("buy-manual", "L", "BUY", "MANUAL"));
        exec(conn, &activity("buy-broker", "L", "BUY", "SNAPTRADE"));
        exec(conn, &activity("sell-broker", "S", "SELL", "SNAPTRADE"));

        let quote = |id: &str, asset: &str, day: &str, source: &str| {
            format!(
                "INSERT INTO quotes (id, asset_id, day, source, close, currency, created_at, timestamp) \
                 VALUES ('{id}', '{asset}', '{day}', '{source}', '30', 'CAD', \
                 '{day}T20:00:00Z', '{day}T20:00:00Z')"
            )
        };
        exec(
            conn,
            &quote("S_2026-01-02_YAHOO", "S", "2026-01-02", "YAHOO"),
        );
        exec(
            conn,
            &quote("S_2026-01-05_MANUAL", "S", "2026-01-05", "MANUAL"),
        );
        exec(
            conn,
            &quote("L_2026-01-02_YAHOO", "L", "2026-01-02", "YAHOO"),
        );
        exec(
            conn,
            &quote("L_2025-12-30_YAHOO", "L", "2025-12-30", "YAHOO"),
        );
        exec(
            conn,
            &quote(MANUAL_QUOTE_MOVES, "L", "2026-01-02", "MANUAL"),
        );
        exec(
            conn,
            &quote(MANUAL_QUOTE_CLASHES, "L", "2026-01-05", "MANUAL"),
        );
        exec(
            conn,
            "INSERT INTO quote_sync_state (asset_id) VALUES ('L'), ('S')",
        );

        let assignment = |id: &str, asset: &str, taxonomy: &str, category: &str, source: &str| {
            format!(
                "INSERT INTO asset_taxonomy_assignments (id, asset_id, taxonomy_id, category_id, \
                 weight, source, created_at, updated_at) VALUES ('{id}', '{asset}', '{taxonomy}', \
                 '{category}', 10000, '{source}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        };
        // instrument_type: the user's choice on L replaces S's automatic one.
        exec(
            conn,
            &assignment("l-type", "L", "instrument_type", "STOCK_COMMON", "MANUAL"),
        );
        exec(
            conn,
            &assignment("s-type", "S", "instrument_type", "STOCK_PREFERRED", "AUTO"),
        );
        // regions: S's user choice stands over L's automatic one.
        exec(conn, &assignment("l-region", "L", "regions", "R10", "AUTO"));
        exec(
            conn,
            &assignment("s-region", "S", "regions", "R20", "MANUAL"),
        );

        exec(
            conn,
            "INSERT INTO asset_logos (asset_id, mime_type, data, sha256, width, height, created_at, \
             updated_at) VALUES ('L', 'image/png', 'AAAA', 'abc', 64, 64, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        );

        // A user-entered snapshot holding only L, with legacy embedded lots.
        let source_positions = r#"{"L":{"id":"POS-L-acc2","accountId":"acc2","assetId":"L","quantity":"5","lots":[{"id":"lot-a","positionId":"POS-L-acc2","quantity":"5"}]}}"#;
        insert_snapshot(
            conn,
            SOURCE_SNAPSHOT,
            "acc2",
            "2026-01-31",
            source_positions,
            "MANUAL_ENTRY",
        );
        insert_position_row(conn, SOURCE_SNAPSHOT, "L");
        // A calculated snapshot holding both rows.
        let calculated = r#"{"L":{"id":"POS-L-acc1","assetId":"L","quantity":"20"},"S":{"id":"POS-S-acc1","assetId":"S","quantity":"-10"}}"#;
        insert_snapshot(
            conn,
            "acc1_2026-01-02",
            "acc1",
            "2026-01-02",
            calculated,
            "CALCULATED",
        );
        insert_position_row(conn, "acc1_2026-01-02", "L");
        insert_position_row(conn, "acc1_2026-01-02", "S");

        exec(
            conn,
            "INSERT INTO lots (id, account_id, asset_id, open_date, open_activity_id, original_quantity, \
             cost_per_unit, original_cost_basis, remaining_cost_basis, remaining_quantity) VALUES \
             ('buy-manual', 'acc1', 'L', '2026-01-02', 'buy-manual', '10', '31.5', '315', '315', '10')",
        );
        exec(
            conn,
            "INSERT INTO lot_disposals (id, lot_id, account_id, asset_id, disposal_activity_id, \
             disposal_date, quantity, proceeds, cost_basis, realized_pnl, proceeds_base, \
             cost_basis_base, realized_pnl_base, currency, base_currency, fx_rate_to_base) VALUES \
             ('d1', 'buy-manual', 'acc1', 'L', 'sell-broker', '2026-01-02', '10', '315', '315', \
              '0', '315', '315', '0', 'CAD', 'CAD', '1')",
        );
    }

    fn insert_snapshot(
        conn: &mut SqliteConnection,
        id: &str,
        account: &str,
        date: &str,
        positions: &str,
        source: &str,
    ) {
        sql_query(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, \
             cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, \
             cash_total_account_currency, cash_total_base_currency, source) VALUES \
             (?, ?, ?, 'CAD', ?, '{}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', ?)",
        )
        .bind::<Text, _>(id)
        .bind::<Text, _>(account)
        .bind::<Text, _>(date)
        .bind::<Text, _>(positions)
        .bind::<Text, _>(source)
        .execute(conn)
        .expect("insert snapshot");
    }

    fn insert_position_row(conn: &mut SqliteConnection, snapshot: &str, asset: &str) {
        exec(
            conn,
            &format!(
                "INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, average_cost, \
                 total_cost_basis, currency, inception_date, created_at, last_updated) VALUES \
                 ('{snapshot}', '{asset}', '1', '1', '1', 'CAD', '2026-01-02', CURRENT_TIMESTAMP, \
                 CURRENT_TIMESTAMP)"
            ),
        );
    }

    fn outbox(pool: &Pool) -> Vec<(String, String, String)> {
        let conn = &mut get_connection(pool).expect("conn");
        let mut rows = sync_outbox::table
            .select((sync_outbox::entity, sync_outbox::entity_id, sync_outbox::op))
            .load::<(String, String, String)>(conn)
            .expect("outbox");
        rows.sort();
        rows
    }

    fn clear_outbox(pool: &Pool) {
        let conn = &mut get_connection(pool).expect("conn");
        diesel::delete(sync_outbox::table)
            .execute(conn)
            .expect("clear outbox");
    }

    fn snapshot_positions_json(pool: &Pool, id: &str) -> serde_json::Value {
        let conn = &mut get_connection(pool).expect("conn");
        let raw: String = holdings_snapshots::table
            .find(id)
            .select(holdings_snapshots::positions)
            .first(conn)
            .expect("snapshot");
        serde_json::from_str(&raw).expect("json")
    }

    fn count_on(pool: &Pool, table: &str, asset: &str) -> i64 {
        #[derive(QueryableByName)]
        struct Count {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            n: i64,
        }
        let conn = &mut get_connection(pool).expect("conn");
        sql_query(format!(
            "SELECT COUNT(*) AS n FROM {table} WHERE asset_id = ?"
        ))
        .bind::<Text, _>(asset)
        .get_result::<Count>(conn)
        .expect("count")
        .n
    }

    #[tokio::test]
    async fn merge_moves_everything_onto_the_survivor() {
        let (pool, repo) = setup();
        seed_split_pair(&mut get_connection(&pool).expect("conn"));
        clear_outbox(&pool);

        let preview = repo.preview_merge("S", "L").expect("preview");
        assert_eq!(preview.overlapping_quote_days, 2);
        // 2026-01-02: L's hand-entered price beats S's download.
        // 2026-01-05: both MANUAL, so S's stands.
        assert_eq!(preview.overlap_days_kept_from_duplicate, 1);
        assert_eq!(preview.overlap_days_kept_from_survivor, 1);
        assert_eq!(preview.duplicate_quotes_dropped, 2);
        assert_eq!(preview.duplicate_quotes_moved, 2);
        assert!(preview.shared_source_snapshots.is_empty());

        let report = repo.merge_into("S", "L").await.expect("merge");
        assert_eq!(report.activities_moved, 2);
        assert_eq!(report.quotes_moved, 2);
        assert_eq!(report.quotes_dropped, 2);
        assert_eq!(report.taxonomy_assignments_moved, 1);
        assert_eq!(report.taxonomy_assignments_dropped, 1);
        assert!(report.logo_moved);
        assert_eq!(report.snapshots_rewritten, 2);
        assert_eq!(report.snapshot_positions_moved, 1);
        assert_eq!(report.snapshot_positions_dropped, 1);
        assert_eq!(report.lots_moved, 1);
        assert_eq!(report.lot_disposals_moved, 1);
        assert_eq!(report.affected_account_ids, vec!["acc1", "acc2"]);
        assert_eq!(report.currencies, vec!["CAD"]);
        assert_eq!(report.changed_taxonomy_ids, vec!["instrument_type"]);

        for table in [
            "activities",
            "quotes",
            "quote_sync_state",
            "asset_taxonomy_assignments",
            "asset_logos",
            "snapshot_positions",
            "lots",
            "lot_disposals",
        ] {
            assert_eq!(count_on(&pool, table, "L"), 0, "{table} still references L");
        }

        let conn = &mut get_connection(&pool).expect("conn");
        let mut quote_ids: Vec<String> = quotes::table.select(quotes::id).load(conn).unwrap();
        quote_ids.sort();
        assert_eq!(
            quote_ids,
            vec![
                MANUAL_QUOTE_MOVES.to_string(),
                "S_2025-12-30_YAHOO".to_string(),
                "S_2026-01-02_YAHOO".to_string(),
                "S_2026-01-05_MANUAL".to_string(),
            ]
        );

        let mut assignments: Vec<(String, String)> = asset_taxonomy_assignments::table
            .select((
                asset_taxonomy_assignments::id,
                asset_taxonomy_assignments::category_id,
            ))
            .load(conn)
            .unwrap();
        assignments.sort();
        assert_eq!(
            assignments,
            vec![
                ("l-type".to_string(), "STOCK_COMMON".to_string()),
                ("s-region".to_string(), "R20".to_string()),
            ]
        );

        let survivor = assets::table
            .find("S")
            .select(AssetDB::as_select())
            .first::<AssetDB>(conn)
            .unwrap();
        let duplicate = assets::table
            .find("L")
            .select(AssetDB::as_select())
            .first::<AssetDB>(conn)
            .unwrap();
        assert_eq!(survivor.is_active, 1);
        assert_eq!(survivor.notes.as_deref(), Some("my note"));
        assert_eq!(
            survivor.provider_config.as_deref(),
            Some(r#"{"preferredProvider":"YAHOO"}"#)
        );
        let metadata: serde_json::Value =
            serde_json::from_str(survivor.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(metadata["identifiers"]["isin"], "CA1");
        assert_eq!(metadata["profile"], serde_json::json!({ "new": 1 }));
        assert_eq!(
            duplicate.is_active, 0,
            "the duplicate is retired, never deleted"
        );
        assert_eq!(duplicate.instrument_exchange_mic.as_deref(), Some("XNEO"));

        let source = snapshot_positions_json(&pool, SOURCE_SNAPSHOT);
        assert!(source.get("L").is_none());
        assert_eq!(source["S"]["assetId"], "S");
        assert_eq!(source["S"]["id"], "POS-S-acc2");
        assert_eq!(source["S"]["lots"][0]["positionId"], "POS-S-acc2");
        assert_eq!(source["S"]["lots"][0]["id"], "lot-a");
        let calculated = snapshot_positions_json(&pool, "acc1_2026-01-02");
        assert!(calculated.get("L").is_none());
        assert_eq!(calculated["S"]["quantity"], "-10");

        // Only syncable models reach the outbox: the manual activity (not the
        // broker ones), the UUID manual quotes (not provider or deterministic
        // ids), assignments, the logo, the user snapshot and both asset rows.
        let s = |v: &str| v.to_string();
        assert_eq!(
            outbox(&pool),
            vec![
                (s("activity"), s("buy-manual"), s("update")),
                (s("asset"), s("L"), s("update")),
                (s("asset"), s("S"), s("update")),
                (s("asset_logo"), s("L"), s("delete")),
                (s("asset_logo"), s("S"), s("create")),
                (s("asset_taxonomy_assignment"), s("l-region"), s("delete")),
                (s("asset_taxonomy_assignment"), s("l-type"), s("update")),
                (s("asset_taxonomy_assignment"), s("s-type"), s("delete")),
                (s("quote"), s(MANUAL_QUOTE_MOVES), s("update")),
                (s("quote"), s(MANUAL_QUOTE_CLASHES), s("delete")),
                (s("snapshot"), s(SOURCE_SNAPSHOT), s("update")),
            ]
        );

        // A second run finds nothing left to move and writes nothing.
        clear_outbox(&pool);
        let again = repo.merge_into("S", "L").await.expect("second merge");
        assert_eq!(again.activities_moved, 0);
        assert_eq!(again.quotes_moved + again.quotes_dropped, 0);
        assert_eq!(again.snapshots_rewritten, 0);
        assert!(outbox(&pool).is_empty());
    }

    #[tokio::test]
    async fn merge_refuses_and_rolls_back_when_a_source_snapshot_lists_both() {
        let (pool, repo) = setup();
        {
            let conn = &mut get_connection(&pool).expect("conn");
            seed_split_pair(conn);
            let both = r#"{"L":{"assetId":"L","quantity":"5"},"S":{"assetId":"S","quantity":"1"}}"#;
            insert_snapshot(
                conn,
                "acc2_2026-02-28",
                "acc2",
                "2026-02-28",
                both,
                "MANUAL_ENTRY",
            );
        }
        clear_outbox(&pool);

        let preview = repo.preview_merge("S", "L").expect("preview");
        assert_eq!(preview.shared_source_snapshots.len(), 1);
        assert_eq!(preview.shared_source_snapshots[0].account_name, "acc2 name");
        assert_eq!(
            preview.shared_source_snapshots[0].snapshot_date,
            "2026-02-28"
        );

        let error = repo.merge_into("S", "L").await.expect_err("refused");
        let message = error.to_string();
        assert!(message.contains("acc2 name on 2026-02-28"), "{message}");

        assert_eq!(count_on(&pool, "activities", "L"), 2);
        assert_eq!(count_on(&pool, "quotes", "L"), 4);
        assert_eq!(count_on(&pool, "asset_logos", "L"), 1);
        let conn = &mut get_connection(&pool).expect("conn");
        let l_active: i32 = assets::table
            .find("L")
            .select(assets::is_active)
            .first(conn)
            .unwrap();
        assert_eq!(l_active, 1);
        assert!(outbox(&pool).is_empty());
    }

    #[tokio::test]
    async fn merge_rejects_an_asset_into_itself_or_a_missing_one() {
        let (pool, repo) = setup();
        seed_split_pair(&mut get_connection(&pool).expect("conn"));
        assert!(repo.merge_into("S", "S").await.is_err());
        assert!(repo.merge_into("S", "missing").await.is_err());
    }

    #[test]
    fn rekey_position_keeps_legacy_embedded_lots() {
        let position = serde_json::json!({
            "id": "POS-L-acc",
            "accountId": "acc",
            "assetId": "L",
            "quantity": "10",
            "lots": [{ "id": "buy-1", "positionId": "POS-L-acc", "quantity": "10" }]
        });
        let rekeyed = rekey_position(position, "L", "S");
        assert_eq!(rekeyed["assetId"], "S");
        assert_eq!(rekeyed["id"], "POS-S-acc");
        assert_eq!(rekeyed["lots"][0]["positionId"], "POS-S-acc");
        assert_eq!(rekeyed["lots"][0]["quantity"], "10");
    }
}
