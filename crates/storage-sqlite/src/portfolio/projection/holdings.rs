//! One SQLite read snapshot for the live holdings accounting view.
use super::*;
use crate::accounts::AccountDB;
use crate::activities::ActivityDB;
use crate::assets::AssetDB;
use crate::fx::FxRepository;
use crate::schema::{
    accounts, activities, app_settings, assets, holdings_snapshots, lot_disposals, lots,
    projection_state,
};
use wealthfolio_core::accounts::Account;
use wealthfolio_core::activities::Activity;
use wealthfolio_core::portfolio::holdings::HoldingsRead;
use wealthfolio_core::portfolio::snapshot::AccountStateSnapshot;

pub(super) fn read(
    conn: &mut SqliteConnection,
    requested: &[String],
    day: NaiveDate,
    detail_asset: Option<&str>,
) -> Result<HoldingsRead> {
    conn.transaction::<_, StorageError, _>(|conn| {
        let account_rows: Vec<AccountDB> =
            accounts::table.load(conn).map_err(StorageError::from)?;
        let accounts: Vec<Account> = account_rows.into_iter().map(Into::into).collect();
        let settings: HashMap<String, String> = app_settings::table
            .load::<(String, String)>(conn)
            .map_err(StorageError::from)?
            .into_iter()
            .collect();
        let timezone = settings
            .get(wealthfolio_core::settings::SETTING_TIMEZONE)
            .cloned()
            .unwrap_or_default();
        let day = if timezone.is_empty() {
            day
        } else {
            wealthfolio_core::utils::time_utils::user_today(
                wealthfolio_core::utils::time_utils::parse_user_timezone_or_default(&timezone),
            )
        };
        let mut closure: HashSet<String> = requested.iter().cloned().collect();
        let activity_rows = loop {
            let rows: Vec<ActivityDB> = activities::table
                .filter(activities::account_id.eq_any(&closure))
                .load(conn)
                .map_err(StorageError::from)?;
            let groups: Vec<String> = rows
                .iter()
                .filter_map(|a| a.source_group_id.clone())
                .collect();
            let partners: Vec<String> = activities::table
                .filter(activities::source_group_id.eq_any(groups))
                .select(activities::account_id)
                .distinct()
                .load(conn)
                .map_err(StorageError::from)?;
            let before = closure.len();
            closure.extend(partners);
            if closure.len() == before {
                break rows;
            }
        };
        let mut activity_rows: Vec<Activity> = activity_rows.into_iter().map(Into::into).collect();
        let mut snapshots = HashMap::new();
        let mut unavailable_accounts = HashSet::new();
        for account in accounts.iter().filter(|a| requested.contains(&a.id)) {
            let calculated =
                account.tracking_mode != wealthfolio_core::accounts::TrackingMode::Holdings;
            let row: Option<AccountStateSnapshotDB> = holdings_snapshots::table
                .filter(holdings_snapshots::account_id.eq(&account.id))
                .filter(holdings_snapshots::snapshot_date.le(day.to_string()))
                .filter(
                    holdings_snapshots::source
                        .eq(SOURCE_CALCULATED)
                        .eq(calculated),
                )
                .order(holdings_snapshots::snapshot_date.desc())
                .first(conn)
                .optional()
                .map_err(StorageError::from)?;
            if let Some(row) = row {
                // Older repository readers tolerate invalid JSON. A financial
                // current view must never certify that as an empty account.
                if serde_json::from_str::<
                    HashMap<String, wealthfolio_core::portfolio::snapshot::Position>,
                >(&row.positions)
                .is_err()
                    || serde_json::from_str::<HashMap<String, rust_decimal::Decimal>>(
                        &row.cash_balances,
                    )
                    .is_err()
                {
                    unavailable_accounts.insert(account.id.clone());
                } else {
                    match AccountStateSnapshot::try_from(row) {
                        Ok(snapshot) if !wealthfolio_core::portfolio::snapshot::snapshot_date_requires_remediation(snapshot.snapshot_date, day) => {
                            snapshots.insert(account.id.clone(), snapshot);
                        }
                        Ok(_) | Err(_) => {
                            unavailable_accounts.insert(account.id.clone());
                        }
                    }
                }
            }
        }
        let asset_ids: HashSet<String> = activity_rows
            .iter()
            .filter_map(|a| a.asset_id.clone())
            .chain(snapshots.values().flat_map(|s| s.positions.keys().cloned()))
            .collect();
        let split_rows: Vec<ActivityDB> = activities::table
            .filter(activities::asset_id.eq_any(&asset_ids))
            .filter(
                activities::activity_type
                    .eq("SPLIT")
                    .or(activities::activity_type_override.eq("SPLIT")),
            )
            .load(conn)
            .map_err(StorageError::from)?;
        let mut seen: HashSet<String> = activity_rows.iter().map(|a| a.id.clone()).collect();
        activity_rows.extend(
            split_rows
                .into_iter()
                .filter(|a| seen.insert(a.id.clone()))
                .map(Into::into),
        );
        let asset_rows: Vec<AssetDB> = assets::table
            .filter(assets::id.eq_any(&asset_ids))
            .load(conn)
            .map_err(StorageError::from)?;
        // Current summary costs never load or sum lots. Only requested detail
        // loads the open records; an indexed existence read distinguishes a
        // missing calculated snapshot from a genuinely empty account.
        let accounts_with_open_lots: HashSet<String> = lots::table
            .filter(lots::account_id.eq_any(requested))
            .filter(lots::is_closed.eq(0))
            .select(lots::account_id)
            .distinct()
            .load::<String>(conn)
            .map_err(StorageError::from)?
            .into_iter()
            .collect();
        let lot_rows: Vec<LotRecordDB> = if let Some(asset_id) = detail_asset {
            lots::table
                .filter(lots::account_id.eq_any(requested))
                .filter(lots::is_closed.eq(0))
                .filter(lots::asset_id.eq(asset_id))
                .select(LotRecordDB::as_select())
                .load(conn)
                .map_err(StorageError::from)?
        } else {
            Vec::new()
        };
        let disposal_rows: Vec<LotDisposalDB> = lot_disposals::table
            .filter(lot_disposals::account_id.eq_any(requested))
            .select(LotDisposalDB::as_select())
            .load(conn)
            .map_err(StorageError::from)?;
        let issue_rows: Vec<(String, String)> = projection_state::table
            .filter(projection_state::scope.eq_any(&closure))
            .select((projection_state::scope, projection_state::activity_issues))
            .load(conn)
            .map_err(StorageError::from)?;
        let mut issues = Vec::new();
        for (account_id, row) in issue_rows {
            match serde_json::from_str::<Vec<ActivityIssue>>(&row) {
                Ok(account_issues) => issues.extend(account_issues),
                Err(_) => {
                    unavailable_accounts.insert(account_id);
                }
            }
        }
        let markers = load_markers(conn)?;
        let last_valued = load_last_valued(conn)?;
        let failed_accounts = projection_state::table
            .filter(projection_state::scope.eq_any(&closure))
            .filter(projection_state::dirty_from.is_not_null())
            .filter(projection_state::failed_version.eq(projection_state::version.nullable()))
            .select(projection_state::scope).load::<String>(conn).map_err(StorageError::from)?
            .into_iter().collect();
        Ok(HoldingsRead {
            day,
            accounts,
            snapshots,
            unavailable_accounts,
            failed_accounts,
            assets: asset_rows
                .into_iter()
                .map(|a| (a.id.clone(), a.into()))
                .collect(),
            activities: activity_rows,
            fx_rates: FxRepository::historical_rates_on_connection(conn)?,
            lots: lot_rows.into_iter().map(Into::into).collect(),
            accounts_with_open_lots,
            disposals: disposal_rows.into_iter().map(Into::into).collect(),
            issues,
            markers,
            last_valued,
            base_currency: settings
                .get(wealthfolio_core::settings::SETTING_BASE_CURRENCY)
                .cloned()
                .unwrap_or_default(),
            timezone,
        })
    })
    .map_err(Into::into)
}
