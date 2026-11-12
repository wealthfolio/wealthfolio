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
const SAVINGS_CATEGORIES_ID: &str = "savings_categories";

fn is_syncable_system_taxonomy_id(taxonomy_id: &str) -> bool {
    matches!(
        taxonomy_id,
        CUSTOM_GROUPS_ID | SPENDING_CATEGORIES_ID | INCOME_SOURCES_ID | SAVINGS_CATEGORIES_ID
    )
}

/// Bundle payload for custom taxonomy sync events.
/// Sent as one atomic event containing the taxonomy row and all its categories.
#[derive(Debug, Clone, Deserialize)]
pub struct CustomTaxonomyPayload {
    pub taxonomy: TaxonomyDB,
    #[serde(alias = "categories_after_atomic_merge")]
    pub categories: Vec<CategoryDB>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub category_merges: Vec<CategoryMergeRedirect>,
    #[serde(default)]
    pub merge_operation: bool,
}

impl Serialize for CustomTaxonomyPayload {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("taxonomy", &self.taxonomy)?;
        // Keep atomic receipts distinct from ordinary category snapshots. The
        // engine's authenticated payload header is the legacy replay barrier;
        // this required-field change also prevents legacy direct decoders from
        // applying destructive category snapshots without their receipts.
        let key = if self.category_merges.is_empty() {
            "categories"
        } else {
            "categories_after_atomic_merge"
        };
        map.serialize_entry(key, &self.categories)?;
        if !self.category_merges.is_empty() {
            map.serialize_entry("category_merges", &self.category_merges)?;
        }
        if self.merge_operation {
            map.serialize_entry("merge_operation", &true)?;
        }
        map.end()
    }
}

impl crate::sync::SyncOutboxModel for CustomTaxonomyPayload {
    const ENTITY: SyncEntity = SyncEntity::CustomTaxonomy;
    fn sync_entity_id(&self) -> &str {
        &self.taxonomy.id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMergeRedirect {
    pub taxonomy_id: String,
    pub source_id: String,
    pub destination_id: String,
    pub budget_origins: Vec<wealthfolio_spending::category_merge::MergeBudgetOrigin>,
}

pub(crate) fn category_merge_redirects(
    conn: &mut SqliteConnection,
) -> wealthfolio_core::Result<Vec<CategoryMergeRedirect>> {
    use crate::{errors::StorageError, schema::app_settings};
    let value = app_settings::table
        .find(wealthfolio_spending::category_merge::SETTING_KEY_CATEGORY_MERGES)
        .select(app_settings::setting_value)
        .first::<String>(conn)
        .optional()
        .map_err(StorageError::from)?;
    value
        .map(|v| {
            serde_json::from_str(&v).map_err(|e| {
                wealthfolio_core::errors::ValidationError::InvalidInput(e.to_string()).into()
            })
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub(crate) fn save_category_merge_redirects(
    conn: &mut SqliteConnection,
    redirects: &[CategoryMergeRedirect],
) -> wealthfolio_core::Result<()> {
    use crate::{errors::StorageError, schema::app_settings};
    let value = serde_json::to_string(redirects)
        .map_err(|e| wealthfolio_core::errors::ValidationError::InvalidInput(e.to_string()))?;
    diesel::replace_into(app_settings::table)
        .values((
            app_settings::setting_key
                .eq(wealthfolio_spending::category_merge::SETTING_KEY_CATEGORY_MERGES),
            app_settings::setting_value.eq(value),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
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
        merge_operation: false,
        category_merges: if wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS
            .contains(&taxonomy_id)
        {
            category_merge_redirects(conn)
                .map_err(|e| diesel::result::Error::QueryBuilderError(Box::new(e)))?
                .into_iter()
                .filter(|r| r.taxonomy_id == taxonomy_id)
                .collect()
        } else {
            Vec::new()
        },
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
