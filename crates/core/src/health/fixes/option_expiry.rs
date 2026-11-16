//! Option expiries recorded against the contract's underlying stock (#2655).
//!
//! Some brokers send an expiry with only the underlying ticker and no units.
//! The engine books an expiry only against an option contract, so such a row
//! changes nothing and the contract stays open with its gain or loss unrealized. This
//! module finds the contract the expiry refers to, for the Health Center, and
//! moves the expiry onto it when the user applies the fix.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use log::warn;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::accounts::{Account, AccountServiceTrait, TrackingMode};
use crate::activities::{
    Activity, ActivityError, ActivityServiceTrait, ActivityStatus, ActivityUpdate,
    AssetResolutionInput, ACTIVITY_SUBTYPE_OPTION_EXPIRY, ACTIVITY_TYPE_ADJUSTMENT,
};
use crate::assets::{Asset, AssetServiceTrait};
use crate::errors::Result;
use crate::portfolio::coordinator::blocking;
use crate::portfolio::snapshot::SnapshotServiceTrait;
use crate::utils::occ_symbol::parse_occ_symbol;
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default};

/// Fix action id for moving expiries onto the contracts they refer to.
pub const MATCH_OPTION_EXPIRY_CONTRACTS_FIX: &str = "match_option_expiry_contracts";

/// Payload of the [`MATCH_OPTION_EXPIRY_CONTRACTS_FIX`] action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchOptionExpiryContractsPayload {
    pub activity_ids: Vec<String>,
    /// The timezone the check matched in; without it, the configured one.
    #[serde(default)]
    pub timezone: Option<String>,
}

/// The option contract an expiry refers to, and the units it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiryContract {
    pub asset_id: String,
    pub symbol: String,
    /// Contracts held at the end of the expiry's day, as a positive count;
    /// the engine relieves a short position for a written option.
    pub quantity: Decimal,
}

/// An expiry that names a stock instead of an option contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionExpiryWithoutContractInfo {
    pub activity_id: String,
    pub account_id: String,
    pub account_name: String,
    /// The expiry's day in the user's timezone.
    pub date: NaiveDate,
    /// The symbol of the stock the expiry names.
    pub stock_symbol: String,
    /// The one contract it refers to, when exactly one fits.
    pub contract: Option<ExpiryContract>,
    /// Why there is no contract to move it to; the user chooses one.
    pub no_contract: Option<NoContractReason>,
}

/// Why an expiry gets no contract to move to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoContractReason {
    /// No contract on the stock expiring that day was still held.
    NoneHeld,
    /// Several contracts fit.
    Several,
    /// The one contract that fits is also claimed by another expiry.
    Shared,
    /// The contract was traded later that day than the expiry's timestamp.
    /// Moved as is, the expiry would be applied before that trade and could
    /// close nothing.
    TradedAfterExpiry,
}

/// A posted option expiry whose asset is typed as something other than an
/// option. The engine rejects these (an untyped asset may be a legacy option
/// and still books), so the check mirrors that rule.
fn names_a_non_option(activity: &Activity, asset: &Asset) -> bool {
    activity.status == ActivityStatus::Posted
        && activity.effective_type() == ACTIVITY_TYPE_ADJUSTMENT
        && activity
            .subtype
            .as_deref()
            .is_some_and(|subtype| subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY))
        && asset.instrument_type.is_some()
        && !asset.is_option()
}

/// Underlying symbol and expiration of an option contract, from its option
/// metadata or, failing that, its OCC symbol.
fn contract_terms(asset: &Asset) -> Option<(String, NaiveDate)> {
    if !asset.is_option() {
        return None;
    }
    if let Some(spec) = asset.option_spec() {
        return Some((spec.underlying_asset_id.to_uppercase(), spec.expiration));
    }
    [
        asset.instrument_symbol.as_deref(),
        asset.display_code.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(|symbol| parse_occ_symbol(symbol).ok())
    .map(|parsed| (parsed.underlying.to_uppercase(), parsed.expiration))
}

fn stock_symbol(asset: &Asset) -> Option<String> {
    asset
        .instrument_symbol
        .as_deref()
        .or(asset.display_code.as_deref())
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
        .map(str::to_uppercase)
}

fn contract_symbol(asset: &Asset) -> String {
    asset
        .display_code
        .clone()
        .or_else(|| asset.instrument_symbol.clone())
        .unwrap_or_else(|| asset.id.clone())
}

/// Finds every expiry that names a stock instead of an option contract, in
/// accounts whose holdings come from their transactions, and the contract
/// each refers to.
///
/// A contract fits an expiry when it is an option on the expiry's stock, it
/// expires on the expiry's day (in the user's timezone or in UTC, as brokers
/// stamp expiries at different times of day), it has no expiry of its own in
/// the account, and the account still held it at the end of that day. An
/// expiry gets a contract only when exactly one fits, no other expiry claims
/// it, and it has no trade later that day than the expiry.
pub fn find_option_expiries_without_contract(
    activities: &[Activity],
    accounts: &[Account],
    assets: &[Asset],
    snapshot_service: &dyn SnapshotServiceTrait,
    timezone: Option<&str>,
) -> Vec<OptionExpiryWithoutContractInfo> {
    let tz = parse_user_timezone_or_default(timezone.unwrap_or_default());
    let accounts: HashMap<&str, &Account> = accounts
        .iter()
        .filter(|account| account.tracking_mode != TrackingMode::Holdings)
        .map(|account| (account.id.as_str(), account))
        .collect();
    let assets_by_id: HashMap<&str, &Asset> = assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();

    let expiries: Vec<(&Activity, &Account, &Asset)> = activities
        .iter()
        .filter_map(|activity| {
            let account = accounts.get(activity.account_id.as_str())?;
            let asset = assets_by_id.get(activity.asset_id.as_deref()?)?;
            names_a_non_option(activity, asset).then_some((activity, *account, *asset))
        })
        .collect();
    if expiries.is_empty() {
        return Vec::new();
    }

    // Contracts that already expire through a row of their own.
    let expired: HashSet<(&str, &str)> = activities
        .iter()
        .filter(|activity| {
            activity.status == ActivityStatus::Posted
                && activity
                    .subtype
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY))
        })
        .filter_map(|activity| {
            let asset_id = activity.asset_id.as_deref()?;
            assets_by_id
                .get(asset_id)
                .is_some_and(|asset| asset.is_option())
                .then_some((activity.account_id.as_str(), asset_id))
        })
        .collect();
    // When each contract was otherwise traded, by account.
    let mut traded: HashMap<(&str, &str), Vec<DateTime<Utc>>> = HashMap::new();
    for activity in activities {
        let Some(asset_id) = activity.asset_id.as_deref() else {
            continue;
        };
        let is_contract = assets_by_id
            .get(asset_id)
            .is_some_and(|asset| asset.is_option());
        let is_expiry = activity
            .subtype
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY));
        if is_contract && !is_expiry && activity.status == ActivityStatus::Posted {
            traded
                .entry((activity.account_id.as_str(), asset_id))
                .or_default()
                .push(activity.activity_date);
        }
    }
    let contracts: Vec<(&Asset, String, NaiveDate)> = assets
        .iter()
        .filter_map(|asset| {
            let (underlying, expiration) = contract_terms(asset)?;
            Some((asset, underlying, expiration))
        })
        .collect();

    let mut held_on: HashMap<(String, NaiveDate), HashMap<String, Decimal>> = HashMap::new();
    let mut infos: Vec<OptionExpiryWithoutContractInfo> = expiries
        .into_iter()
        .map(|(activity, account, stock)| {
            // A stock without a symbol matches no contract, but is still listed.
            let symbol = stock_symbol(stock);
            let date = activity_date_in_tz(activity.activity_date, tz);
            let utc_date = activity.activity_date.date_naive();
            let held = held_on
                .entry((account.id.clone(), date))
                .or_insert_with(|| held_at_end_of(snapshot_service, &account.id, date));
            let candidates: Vec<ExpiryContract> = contracts
                .iter()
                .filter(|(_, underlying, expiration)| {
                    symbol.as_deref() == Some(underlying.as_str())
                        && (*expiration == date || *expiration == utc_date)
                })
                .filter(|(asset, _, _)| {
                    !expired.contains(&(account.id.as_str(), asset.id.as_str()))
                })
                .filter_map(|(asset, _, _)| {
                    let quantity = held.get(&asset.id).copied()?.abs();
                    (!quantity.is_zero()).then(|| ExpiryContract {
                        asset_id: asset.id.clone(),
                        symbol: contract_symbol(asset),
                        quantity,
                    })
                })
                .collect();
            let traded_after = candidates.iter().any(|contract| {
                traded
                    .get(&(account.id.as_str(), contract.asset_id.as_str()))
                    .is_some_and(|times| {
                        times.iter().any(|at| {
                            *at > activity.activity_date && activity_date_in_tz(*at, tz) == date
                        })
                    })
            });
            let no_contract = match candidates.len() {
                0 => Some(NoContractReason::NoneHeld),
                1 if traded_after => Some(NoContractReason::TradedAfterExpiry),
                1 => None,
                _ => Some(NoContractReason::Several),
            };
            OptionExpiryWithoutContractInfo {
                activity_id: activity.id.clone(),
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                date,
                stock_symbol: symbol.unwrap_or_else(|| contract_symbol(stock)),
                contract: no_contract
                    .is_none()
                    .then(|| candidates.into_iter().next())
                    .flatten(),
                no_contract,
            }
        })
        .collect();

    // A contract expires once: when two expiries claim it, neither gets it.
    let mut claims: HashMap<(String, String), usize> = HashMap::new();
    for info in &infos {
        if let Some(contract) = &info.contract {
            *claims
                .entry((info.account_id.clone(), contract.asset_id.clone()))
                .or_default() += 1;
        }
    }
    for info in &mut infos {
        let shared = info.contract.as_ref().is_some_and(|contract| {
            claims[&(info.account_id.clone(), contract.asset_id.clone())] > 1
        });
        if shared {
            info.contract = None;
            info.no_contract = Some(NoContractReason::Shared);
        }
    }
    infos
}

/// Quantities the account held at the end of `day`, by asset.
fn held_at_end_of(
    snapshot_service: &dyn SnapshotServiceTrait,
    account_id: &str,
    day: NaiveDate,
) -> HashMap<String, Decimal> {
    match snapshot_service.get_latest_snapshots_as_of(&[account_id.to_string()], day) {
        Ok(mut snapshots) => snapshots
            .remove(account_id)
            .map(|snapshot| {
                snapshot
                    .positions
                    .into_iter()
                    .map(|(asset_id, position)| (asset_id, position.quantity))
                    .collect()
            })
            .unwrap_or_default(),
        Err(error) => {
            warn!(
                "Failed to read holdings for an option expiry check: {}",
                error
            );
            HashMap::new()
        }
    }
}

/// Moves each listed expiry onto the contract it refers to, with the units
/// held, and clears its review flag. The match is derived again from the
/// stored data, so a stale or edited payload cannot point an expiry at
/// another asset. Returns how many expiries were moved.
pub async fn match_option_expiry_contracts(
    activity_service: Arc<dyn ActivityServiceTrait>,
    account_service: Arc<dyn AccountServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    payload: MatchOptionExpiryContractsPayload,
    timezone: Option<String>,
) -> Result<usize> {
    let timezone = payload
        .timezone
        .filter(|tz| !tz.trim().is_empty())
        .or(timezone);
    let requested: HashSet<String> = payload.activity_ids.into_iter().collect();
    if requested.is_empty() {
        return Err(ActivityError::InvalidData("No option expiries were selected".into()).into());
    }
    let reader = Arc::clone(&activity_service);
    let (matches, activities) = blocking(move || {
        let activities = reader.get_activities()?;
        let accounts = account_service.get_non_archived_accounts()?;
        let assets = asset_service.get_assets()?;
        let matches = find_option_expiries_without_contract(
            &activities,
            &accounts,
            &assets,
            snapshot_service.as_ref(),
            timezone.as_deref(),
        );
        let activities: HashMap<String, Activity> = activities
            .into_iter()
            .filter(|activity| requested.contains(&activity.id))
            .map(|activity| (activity.id.clone(), activity))
            .collect();
        Ok((matches, activities))
    })
    .await?;

    let mut moved = 0;
    for info in matches {
        let (Some(contract), Some(activity)) = (info.contract, activities.get(&info.activity_id))
        else {
            continue;
        };
        activity_service
            .update_activity(ActivityUpdate {
                unlink_transfer_pair_id: None,
                split_review: None,
                id: activity.id.clone(),
                account_id: activity.account_id.clone(),
                asset: Some(AssetResolutionInput {
                    id: Some(contract.asset_id),
                    ..Default::default()
                }),
                activity_type: activity.effective_type().to_string(),
                subtype: None,
                activity_date: activity.activity_date.to_rfc3339(),
                quantity: Some(Some(contract.quantity)),
                unit_price: None,
                currency: activity.currency.clone(),
                fee: None,
                tax: None,
                amount: None,
                status: None,
                needs_review: Some(false),
                notes: activity.notes.clone(),
                fx_rate: None,
                metadata: None,
            })
            .await?;
        moved += 1;
    }
    if moved == 0 {
        return Err(ActivityError::InvalidData(
            "None of the selected option expiries has a single matching contract".into(),
        )
        .into());
    }
    Ok(moved)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::assets::InstrumentType;
    use crate::lots::AssetLotView;
    use crate::portfolio::snapshot::{AccountStateSnapshot, HoldingsTimeline, Position};
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};

    const DAY: &str = "2026-07-17";

    /// Positions held at the end of each (account, day).
    #[derive(Default)]
    pub(crate) struct Held(HashMap<(String, NaiveDate), Vec<(&'static str, i64)>>);

    /// Asset ids and quantities an account held at the end of a day.
    pub(crate) type HeldOn<'a> = (&'a str, &'a str, &'a [(&'static str, i64)]);

    #[async_trait]
    impl SnapshotServiceTrait for Held {
        fn get_holdings_keyframes(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!()
        }

        fn get_holdings_timeline(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<HoldingsTimeline> {
            unimplemented!()
        }

        fn get_latest_holdings_snapshot(
            &self,
            _account_id: &str,
        ) -> Result<Option<AccountStateSnapshot>> {
            unimplemented!()
        }

        fn get_latest_snapshots_as_of(
            &self,
            account_ids: &[String],
            day: NaiveDate,
        ) -> Result<HashMap<String, AccountStateSnapshot>> {
            Ok(account_ids
                .iter()
                .filter_map(|account_id| {
                    let held = self.0.get(&(account_id.clone(), day))?;
                    let mut snapshot = AccountStateSnapshot {
                        account_id: account_id.clone(),
                        snapshot_date: day,
                        ..AccountStateSnapshot::default()
                    };
                    for (asset_id, quantity) in held {
                        snapshot.positions.insert(
                            (*asset_id).to_string(),
                            Position {
                                account_id: account_id.clone(),
                                asset_id: (*asset_id).to_string(),
                                quantity: Decimal::from(*quantity),
                                ..Position::default()
                            },
                        );
                    }
                    Some((account_id.clone(), snapshot))
                })
                .collect())
        }

        fn carry_lot_view_rows(&self, _rows: &mut [AssetLotView], _day: NaiveDate) -> Result<()> {
            Ok(())
        }

        async fn save_manual_snapshot(
            &self,
            _account_id: &str,
            _snapshot: AccountStateSnapshot,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn delete_snapshot_for_account(
            &self,
            _account_id: &str,
            _dates: &[NaiveDate],
        ) -> Result<()> {
            unimplemented!()
        }
    }

    fn day(date: &str) -> NaiveDate {
        NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("valid test date")
    }

    pub(crate) fn held(entries: &[HeldOn<'_>]) -> Held {
        Held(
            entries
                .iter()
                .map(|(account, date, positions)| {
                    ((account.to_string(), day(date)), positions.to_vec())
                })
                .collect(),
        )
    }

    fn account(id: &str, tracking_mode: TrackingMode) -> Account {
        Account {
            id: id.to_string(),
            name: format!("{id} name"),
            tracking_mode,
            ..Account::default()
        }
    }

    fn stock(id: &str, instrument_type: Option<InstrumentType>) -> Asset {
        Asset {
            id: id.to_string(),
            instrument_type,
            instrument_symbol: Some(id.to_uppercase()),
            ..Asset::default()
        }
    }

    fn contract(id: &str, occ: &str) -> Asset {
        Asset {
            id: id.to_string(),
            instrument_type: Some(InstrumentType::Option),
            instrument_symbol: Some(occ.to_string()),
            ..Asset::default()
        }
    }

    fn expiry(id: &str, account_id: &str, asset_id: &str, at: &str) -> Activity {
        let at: DateTime<Utc> = at.parse().expect("valid test instant");
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: Some(asset_id.to_string()),
            activity_type: ACTIVITY_TYPE_ADJUSTMENT.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: Some(ACTIVITY_SUBTYPE_OPTION_EXPIRY.to_string()),
            status: ActivityStatus::Posted,
            activity_date: at,
            settlement_date: None,
            quantity: Some(Decimal::ZERO),
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
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
            created_at: at,
            updated_at: at,
        }
    }

    fn assets() -> Vec<Asset> {
        vec![
            stock("rgld", Some(InstrumentType::Equity)),
            stock("btg", Some(InstrumentType::Equity)),
            contract("rgld-c195", "RGLD260717C00195000"),
            contract("rgld-c200", "RGLD260717C00200000"),
            contract("btg-c4", "BTG260717C00004000"),
        ]
    }

    fn find(
        activities: &[Activity],
        accounts: &[Account],
        held: &Held,
        timezone: &str,
    ) -> Vec<OptionExpiryWithoutContractInfo> {
        find_option_expiries_without_contract(activities, accounts, &assets(), held, Some(timezone))
    }

    #[test]
    fn matches_the_one_contract_held_on_the_expiry_day() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [
            expiry("exp-rgld", "fhsa", "rgld", "2026-07-17T21:30:00Z"),
            expiry("exp-btg", "fhsa", "btg", "2026-07-17T21:30:00Z"),
        ];
        // A written BTG call is a short position; the expiry ends 3 contracts.
        let held = held(&[(
            "fhsa",
            DAY,
            &[("rgld-c195", 2), ("btg-c4", -3), ("rgld", 10)],
        )]);

        let found = find(&activities, &accounts, &held, "America/Toronto");

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].date, day(DAY));
        assert_eq!(found[0].stock_symbol, "RGLD");
        assert_eq!(
            found[0].contract,
            Some(ExpiryContract {
                asset_id: "rgld-c195".into(),
                symbol: "RGLD260717C00195000".into(),
                quantity: Decimal::from(2),
            })
        );
        assert_eq!(
            found[1].contract.as_ref().map(|c| c.quantity),
            Some(Decimal::from(3))
        );
    }

    #[test]
    fn leaves_the_choice_to_the_user_when_several_contracts_fit() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [expiry("exp", "fhsa", "rgld", "2026-07-17T21:30:00Z")];
        let held = held(&[("fhsa", DAY, &[("rgld-c195", 2), ("rgld-c200", 1)])]);

        let found = find(&activities, &accounts, &held, "UTC");

        assert_eq!(found[0].contract, None);
        assert_eq!(found[0].no_contract, Some(NoContractReason::Several));
    }

    #[test]
    fn skips_contracts_no_longer_held_or_expired_by_their_own_row() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [
            expiry("exp", "fhsa", "rgld", "2026-07-17T21:30:00Z"),
            expiry("own", "fhsa", "rgld-c200", "2026-07-17T21:30:00Z"),
        ];
        // c195 was sold before expiry (0 held); c200 has its own expiry row.
        let held = held(&[("fhsa", DAY, &[("rgld-c195", 0), ("rgld-c200", 1)])]);

        let found = find(&activities, &accounts, &held, "UTC");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].contract, None);
        assert_eq!(found[0].no_contract, Some(NoContractReason::NoneHeld));
    }

    #[test]
    fn a_contract_claimed_by_two_expiries_goes_to_neither() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [
            expiry("exp-1", "fhsa", "rgld", "2026-07-17T21:30:00Z"),
            expiry("exp-2", "fhsa", "rgld", "2026-07-17T21:31:00Z"),
        ];
        let held = held(&[("fhsa", DAY, &[("rgld-c195", 2)])]);

        let found = find(&activities, &accounts, &held, "UTC");

        assert!(found.iter().all(|info| info.contract.is_none()));
        assert!(found
            .iter()
            .all(|info| info.no_contract == Some(NoContractReason::Shared)));
    }

    #[test]
    fn matches_on_the_utc_day_when_the_local_day_has_moved_on() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [expiry("exp", "fhsa", "rgld", "2026-07-17T21:30:00Z")];
        // In Tokyo the expiry falls on Jul 18; holdings are read for that day.
        let held = held(&[("fhsa", "2026-07-18", &[("rgld-c195", 2)])]);

        let found = find(&activities, &accounts, &held, "Asia/Tokyo");

        assert_eq!(found[0].date, day("2026-07-18"));
        assert_eq!(
            found[0].contract.as_ref().map(|c| c.asset_id.as_str()),
            Some("rgld-c195")
        );
    }

    #[test]
    fn leaves_a_contract_traded_after_the_expiry_that_day_to_the_user() {
        // A date-only expiry at midnight, then a same-day (0DTE) purchase:
        // moved as is, the expiry would apply before the purchase and close
        // nothing, so it is not offered.
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let mut buy = expiry("buy", "fhsa", "rgld-c195", "2026-07-17T15:00:00Z");
        buy.activity_type = "BUY".to_string();
        buy.subtype = None;
        let activities = [expiry("exp", "fhsa", "rgld", "2026-07-17T00:00:00Z"), buy];
        let held = held(&[("fhsa", DAY, &[("rgld-c195", 1)])]);

        let found = find(&activities, &accounts, &held, "UTC");

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].contract, None);
        assert_eq!(
            found[0].no_contract,
            Some(NoContractReason::TradedAfterExpiry)
        );

        // Bought the day before, the same contract is matched.
        let mut earlier = activities.clone();
        earlier[1].activity_date = "2026-07-16T15:00:00Z".parse().expect("valid instant");
        let found = find(&earlier, &accounts, &held, "UTC");
        assert_eq!(
            found[0].contract.as_ref().map(|c| c.asset_id.as_str()),
            Some("rgld-c195")
        );
    }

    #[test]
    fn lists_a_stock_without_a_symbol_with_no_contract() {
        let accounts = [account("fhsa", TrackingMode::Transactions)];
        let activities = [expiry("exp", "fhsa", "nameless", "2026-07-17T21:30:00Z")];
        let mut all_assets = assets();
        all_assets.push(Asset {
            id: "nameless".into(),
            instrument_type: Some(InstrumentType::Equity),
            ..Asset::default()
        });
        let held = held(&[("fhsa", DAY, &[("rgld-c195", 2)])]);

        let found = find_option_expiries_without_contract(
            &activities,
            &accounts,
            &all_assets,
            &held,
            Some("UTC"),
        );

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].stock_symbol, "nameless");
        assert_eq!(found[0].contract, None);
        assert_eq!(found[0].no_contract, Some(NoContractReason::NoneHeld));
    }

    #[test]
    fn ignores_holdings_accounts_untyped_assets_and_contract_expiries() {
        let accounts = [
            account("fhsa", TrackingMode::Transactions),
            account("broker", TrackingMode::Holdings),
        ];
        let mut untyped = expiry("untyped", "fhsa", "legacy", "2026-07-17T21:30:00Z");
        untyped.asset_id = Some("legacy".into());
        let activities = [
            expiry("holdings", "broker", "rgld", "2026-07-17T21:30:00Z"),
            expiry("contract", "fhsa", "rgld-c195", "2026-07-17T21:30:00Z"),
            untyped,
        ];
        let mut all_assets = assets();
        all_assets.push(stock("legacy", None));
        let held = held(&[]);

        let found = find_option_expiries_without_contract(
            &activities,
            &accounts,
            &all_assets,
            &held,
            Some("UTC"),
        );

        assert!(found.is_empty());
    }
}
