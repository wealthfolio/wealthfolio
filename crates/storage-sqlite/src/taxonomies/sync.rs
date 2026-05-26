//! Custom taxonomy sync helpers: bundle payload construction and eligibility.

use diesel::prelude::*;
use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};
use wealthfolio_core::sync::{SyncEntity, SyncOperation};

use super::model::{CategoryDB, TaxonomyDB};
use crate::db::write_actor::WriteProjection;
use crate::schema::{taxonomies, taxonomy_categories};
use crate::sync::OutboxWriteRequest;

/// These system taxonomies allow user-created categories.
/// They're `is_system = 1` but their categories are user data that must sync.
const CUSTOM_GROUPS_ID: &str = "custom_groups";
const SPENDING_CATEGORIES_ID: &str = "spending_categories";
const INCOME_SOURCES_ID: &str = "income_sources";

fn is_syncable_system_taxonomy_id(taxonomy_id: &str) -> bool {
    matches!(
        taxonomy_id,
        CUSTOM_GROUPS_ID | SPENDING_CATEGORIES_ID | INCOME_SOURCES_ID
    )
}

/// Bundle payload for custom taxonomy sync events.
/// Sent as one atomic event containing the taxonomy row and all its categories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTaxonomyPayload {
    pub taxonomy: TaxonomyDB,
    pub categories: Vec<CategoryDB>,
}

/// Returns `true` if the taxonomy should participate in sync.
/// Eligible: any `is_system = 0` taxonomy, or a system taxonomy with user categories.
pub fn is_syncable_taxonomy(conn: &mut SqliteConnection, taxonomy_id: &str) -> bool {
    if is_syncable_system_taxonomy_id(taxonomy_id) {
        return true;
    }
    taxonomies::table
        .find(taxonomy_id)
        .select(taxonomies::is_system)
        .first::<i32>(conn)
        .map(|v| v == 0)
        .unwrap_or(false)
}

/// Build a `CustomTaxonomyPayload` from current DB state.
/// Returns `Ok(None)` for non-syncable taxonomies or if the taxonomy is not found.
/// Returns `Err` if the category query fails (prevents empty bundles from causing deletions).
pub fn build_custom_taxonomy_payload(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
) -> Result<Option<CustomTaxonomyPayload>, diesel::result::Error> {
    let taxonomy = match taxonomies::table
        .find(taxonomy_id)
        .first::<TaxonomyDB>(conn)
        .optional()?
    {
        Some(t) => t,
        None => return Ok(None),
    };

    if taxonomy.is_system != 0 && !is_syncable_system_taxonomy_id(&taxonomy.id) {
        return Ok(None);
    }

    let categories = taxonomy_categories::table
        .filter(taxonomy_categories::taxonomy_id.eq(taxonomy_id))
        .order(taxonomy_categories::sort_order.asc())
        .load::<CategoryDB>(conn)?;

    Ok(Some(CustomTaxonomyPayload {
        taxonomy,
        categories,
    }))
}

/// Queue a custom taxonomy outbox event on the projection.
pub fn queue_custom_taxonomy_event(
    projection: &mut WriteProjection,
    taxonomy_id: &str,
    op: SyncOperation,
    payload: serde_json::Value,
) {
    projection.queue_outbox(OutboxWriteRequest::new(
        SyncEntity::CustomTaxonomy,
        taxonomy_id,
        op,
        payload,
    ));
}

/// Build and queue a create/update bundle event for a custom taxonomy.
/// No-ops silently if the taxonomy is not syncable or not found.
/// Returns `Err` if the category query fails (prevents empty bundles from causing deletions).
pub fn queue_custom_taxonomy_bundle(
    conn: &mut SqliteConnection,
    projection: &mut WriteProjection,
    taxonomy_id: &str,
    op: SyncOperation,
) -> Result<(), diesel::result::Error> {
    if let Some(payload) = build_custom_taxonomy_payload(conn, taxonomy_id)? {
        let json = serde_json::to_value(&payload).unwrap_or_default();
        queue_custom_taxonomy_event(projection, taxonomy_id, op, json);
    }
    Ok(())
}

/// Queue a delete event for a custom taxonomy. The delete payload only needs the ID.
pub fn queue_custom_taxonomy_delete(projection: &mut WriteProjection, taxonomy_id: &str) {
    queue_custom_taxonomy_event(
        projection,
        taxonomy_id,
        SyncOperation::Delete,
        serde_json::json!({ "id": taxonomy_id }),
    );
}
