use diesel::prelude::*;
use wealthfolio_core::Result;
use wealthfolio_spending::settings::SETTING_KEY_ACCOUNT_IDS;

use crate::errors::StorageError;
use crate::schema::{
    allocation_target_constraints, allocation_targets, app_settings, contribution_limits,
    daily_account_valuation, holdings_snapshots, import_account_templates,
};

/// Clean portfolio data and configuration for a logical account deletion in the caller's transaction.
/// Do not call during snapshot replacement: absent snapshot tables retain local configuration.
/// These changes follow the account-delete event without generating additional sync events.
pub(crate) fn delete_account_references(
    conn: &mut SqliteConnection,
    account_id: &str,
) -> Result<()> {
    diesel::delete(holdings_snapshots::table.filter(holdings_snapshots::account_id.eq(account_id)))
        .execute(conn)
        .map_err(StorageError::from)?;
    diesel::delete(
        daily_account_valuation::table.filter(daily_account_valuation::account_id.eq(account_id)),
    )
    .execute(conn)
    .map_err(StorageError::from)?;

    diesel::delete(
        import_account_templates::table.filter(import_account_templates::account_id.eq(account_id)),
    )
    .execute(conn)
    .map_err(StorageError::from)?;
    diesel::delete(
        allocation_targets::table.filter(
            allocation_targets::scope_type
                .eq("account")
                .and(allocation_targets::scope_id.eq(account_id)),
        ),
    )
    .execute(conn)
    .map_err(StorageError::from)?;
    diesel::delete(
        allocation_target_constraints::table.filter(
            allocation_target_constraints::subject_type
                .eq("account")
                .and(allocation_target_constraints::subject_id.eq(account_id)),
        ),
    )
    .execute(conn)
    .map_err(StorageError::from)?;

    let limits = contribution_limits::table
        .select((contribution_limits::id, contribution_limits::account_ids))
        .load::<(String, Option<String>)>(conn)
        .map_err(StorageError::from)?;
    for (id, csv) in limits {
        let Some(csv) = csv else { continue };
        if csv.split(',').any(|value| value.trim() == account_id) {
            let remaining = csv
                .split(',')
                .filter(|value| value.trim() != account_id)
                .collect::<Vec<_>>()
                .join(",");
            diesel::update(contribution_limits::table.find(id))
                .set(contribution_limits::account_ids.eq(remaining))
                .execute(conn)
                .map_err(StorageError::from)?;
        }
    }

    let value = app_settings::table
        .find(SETTING_KEY_ACCOUNT_IDS)
        .select(app_settings::setting_value)
        .first::<String>(conn)
        .optional()
        .map_err(StorageError::from)?;
    if let Some(mut ids) = value.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
    {
        let previous_len = ids.len();
        ids.retain(|id| id != account_id);
        if ids.len() != previous_len {
            diesel::update(app_settings::table.find(SETTING_KEY_ACCOUNT_IDS))
                .set(app_settings::setting_value.eq(serde_json::to_string(&ids)?))
                .execute(conn)
                .map_err(StorageError::from)?;
        }
    }
    Ok(())
}
