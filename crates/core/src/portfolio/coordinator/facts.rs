//! Loads the kernel's `RawFacts` for a scope from the repositories. Activities,
//! FX rates and observed snapshots are loaded whole; quotes are loaded per
//! window (`window_quotes`), plus the few around split dates up front.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine as engine;
use wealthfolio_portfolio_engine::model::{
    Currency, Policy, RawAccount, RawActivity, RawAsset, RawFacts, RawFxConversion, RawFxRate,
    RawObservedPosition, RawObservedSnapshot, RawQuote,
};

use std::sync::Arc;

use crate::accounts::{AccountRepositoryTrait, TrackingMode};
use crate::activities::{Activity, ActivityRepositoryTrait};
use crate::assets::AssetRepositoryTrait;
use crate::errors::{Error, Result};
use crate::fx::FxRepositoryTrait;
use crate::portfolio::projection::ProjectionStoreTrait;
use crate::portfolio::snapshot::{
    snapshot_date_requires_remediation, SnapshotRepositoryTrait, SnapshotSource,
};
use crate::quotes::QuoteServiceTrait;

/// The repositories every kernel run reads its facts from.
#[derive(Clone)]
pub struct FactSources {
    pub accounts: Arc<dyn AccountRepositoryTrait>,
    pub activities: Arc<dyn ActivityRepositoryTrait>,
    pub assets: Arc<dyn AssetRepositoryTrait>,
    pub quotes: Arc<dyn QuoteServiceTrait>,
    pub fx_rates: Arc<dyn FxRepositoryTrait>,
    pub snapshots: Arc<dyn SnapshotRepositoryTrait>,
    /// Rejections of the last run, which the read path leaves out.
    pub projections: Arc<dyn ProjectionStoreTrait>,
}

impl FactSources {
    /// The scope's transfer closure and its activities, loaded by account
    /// and by transfer group rather than as the whole table (architecture §4.8):
    /// every account sharing a transfer group with the scope, transitively,
    /// archived counterparties included so pairs still resolve.
    fn closure_activities(
        &self,
        scope: &BTreeSet<String>,
    ) -> Result<(BTreeSet<String>, Vec<Activity>)> {
        let mut closure = scope.clone();
        let mut activities = self
            .activities
            .get_activities_by_account_ids_including_archived(
                &scope.iter().cloned().collect::<Vec<_>>(),
            )?;
        let mut seen_groups: BTreeSet<String> = BTreeSet::new();
        loop {
            let new_groups: Vec<String> = activities
                .iter()
                .filter_map(|a| a.source_group_id.clone())
                .filter(|g| seen_groups.insert(g.clone()))
                .collect();
            if new_groups.is_empty() {
                break;
            }
            let partners = self
                .activities
                .get_activities_by_source_group_ids(&new_groups)?;
            let new_accounts: Vec<String> = partners
                .iter()
                .map(|a| a.account_id.clone())
                .filter(|id| closure.insert(id.clone()))
                .collect();
            if new_accounts.is_empty() {
                break;
            }
            activities.extend(
                self.activities
                    .get_activities_by_account_ids_including_archived(&new_accounts)?,
            );
        }
        let mut ids = BTreeSet::new();
        activities.retain(|a| ids.insert(a.id.clone()));
        activities.sort_by(|a, b| a.activity_date.cmp(&b.activity_date).then(a.id.cmp(&b.id)));
        Ok((closure, activities))
    }

    /// Facts for the read path (`measure`): the scope's transfer closure,
    /// every FX observation, and quotes only where security-transfer legs
    /// are priced. No observed snapshots: holdings valuations are stored.
    pub fn load_for_measure(
        &self,
        account_ids: &[String],
        base_currency: &str,
        timezone: &str,
        as_of: NaiveDate,
    ) -> Result<RawFacts> {
        let all_accounts = self.accounts.list(None, None, None)?;
        let requested: BTreeSet<&str> = account_ids.iter().map(String::as_str).collect();
        let scope: BTreeSet<String> = all_accounts
            .iter()
            .filter(|a| requested.contains(a.id.as_str()))
            .map(|a| a.id.clone())
            .collect();
        let (closure, closure_activities) = self.closure_activities(&scope)?;
        let activities: Vec<&Activity> = closure_activities.iter().collect();

        let asset_ids: BTreeSet<String> = activities
            .iter()
            .filter_map(|a| a.asset_id.clone())
            .collect();
        let asset_id_vec: Vec<String> = asset_ids.iter().cloned().collect();
        let asset_rows = if asset_id_vec.is_empty() {
            Vec::new()
        } else {
            self.assets.list_by_asset_ids(&asset_id_vec)?
        };

        // Security-transfer legs are priced at their own dates.
        let timezone_tz = crate::utils::time_utils::parse_user_timezone_or_default(timezone);
        let mut requests: Vec<(String, NaiveDate)> = activities
            .iter()
            .filter(|a| {
                matches!(a.effective_type(), "TRANSFER_IN" | "TRANSFER_OUT")
                    && a.asset_id
                        .as_deref()
                        .is_some_and(|id| !id.starts_with("$CASH"))
            })
            .filter_map(|a| {
                a.asset_id.clone().map(|asset| {
                    (
                        asset,
                        crate::utils::time_utils::activity_date_in_tz(a.activity_date, timezone_tz),
                    )
                })
            })
            .collect();
        requests.sort();
        requests.dedup();
        // Real observations (the market-facts read stamps a carried close
        // with the requested day, which a split's detection would take for
        // a close of its own), one read per day.
        let mut days: BTreeMap<NaiveDate, Vec<String>> = BTreeMap::new();
        for (asset, day) in requests {
            days.entry(day).or_default().push(asset);
        }
        let mut quotes: Vec<RawQuote> = Vec::new();
        for (day, assets) in days {
            quotes.extend(window_quotes(self, &assets, day, day)?);
        }

        // Splits decide how every transfer price reads: those recorded
        // elsewhere too, with the closes that tell whether each was adjusted.
        let foreign = foreign_splits(self, &asset_ids, &closure_activities)?;
        quotes.extend(split_evidence(
            self,
            activities
                .iter()
                .copied()
                .filter(|a| a.effective_type() == "SPLIT")
                .chain(&foreign),
            timezone_tz,
            as_of,
        )?);
        let mut accounts: Vec<RawAccount> = all_accounts
            .iter()
            .filter(|a| closure.contains(&a.id))
            .map(raw_account)
            .collect();
        accounts.extend(split_accounts(&all_accounts, &closure, &foreign));

        Ok(RawFacts {
            policy: policy(base_currency, timezone, as_of)?,
            accounts,
            assets: asset_rows.iter().map(raw_asset).collect(),
            activities: activities
                .into_iter()
                .chain(&foreign)
                .map(raw_activity)
                .collect(),
            quotes,
            fx_rates: self
                .fx_rates
                .get_historical_exchange_rates()?
                .iter()
                .map(raw_fx_rate)
                .collect(),
            observed_snapshots: Vec::new(),
        })
    }

    /// The FX pairs whose two directions disagree in the stored rates.
    pub fn fx_conflicts(&self) -> Result<Vec<engine::FxConflict>> {
        let rates = self
            .fx_rates
            .get_historical_exchange_rates()?
            .iter()
            .map(raw_fx_rate)
            .collect();
        Ok(engine::fx_conflicts(&engine::normalize_fx_rates(
            rates,
            &mut Vec::new(),
        )))
    }
}

fn policy(base_currency: &str, timezone: &str, as_of: NaiveDate) -> Result<Policy> {
    Ok(Policy::new(
        Currency::parse(base_currency)
            .ok_or_else(|| Error::Unexpected("base currency is empty".to_string()))?,
        timezone.parse().unwrap_or(chrono_tz::Tz::UTC),
        as_of,
    ))
}

pub(super) fn raw_account(a: &crate::accounts::Account) -> RawAccount {
    RawAccount {
        id: a.id.clone(),
        currency: a.currency.clone(),
        account_type: a.account_type.clone(),
        tracking_mode: tracking_label(a.tracking_mode).to_string(),
        is_archived: a.is_archived,
    }
}

pub(super) fn raw_asset(a: &crate::assets::Asset) -> RawAsset {
    RawAsset {
        id: a.id.clone(),
        quote_currency: a.quote_ccy.clone(),
        kind: a.kind.as_db_str().to_string(),
        instrument_type: a
            .instrument_type
            .as_ref()
            .map(|t| t.as_db_str().to_string()),
        contract_multiplier: Some(a.contract_multiplier()),
    }
}

pub(crate) fn raw_activity(a: &Activity) -> RawActivity {
    RawActivity {
        id: a.id.clone(),
        account_id: a.account_id.clone(),
        asset_id: a.asset_id.clone(),
        activity_type: a.activity_type.clone(),
        activity_type_override: a.activity_type_override.clone(),
        subtype: a.subtype.clone(),
        status: format!("{:?}", a.status).to_ascii_uppercase(),
        timestamp: a.activity_date,
        created_at: a.created_at,
        quantity: a.quantity,
        unit_price: a.unit_price,
        amount: a.amount,
        fee: a.fee,
        tax: a.tax,
        currency: a.currency.clone(),
        fx_rate: a.fx_rate,
        source_group_id: a.source_group_id.clone(),
        external_transfer: a.explicit_external_transfer(),
        fx_conversion: raw_fx_conversion(a),
        source_system: a.source_system.clone(),
        is_user_modified: a.is_user_modified,
        updated_at: a.updated_at,
    }
}

/// `metadata.fx`: the import linker's record of a same-account cash FX
/// conversion. The kernel decides whether it makes the pair neutral.
fn raw_fx_conversion(a: &Activity) -> Option<RawFxConversion> {
    let fx = a.metadata.as_ref()?.get("fx")?;
    let text = |key: &str| {
        fx.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let amount = |key: &str| {
        fx.get(key)
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<Decimal>().ok())
    };
    Some(RawFxConversion {
        rate_source: text("rateSource"),
        source_currency: text("sourceCurrency"),
        destination_currency: text("destinationCurrency"),
        source_amount: amount("sourceAmount"),
        destination_amount: amount("destinationAmount"),
    })
}

pub(super) fn raw_quote(q: &crate::quotes::Quote) -> RawQuote {
    RawQuote {
        asset_id: q.asset_id.clone(),
        day: q.timestamp.date_naive(),
        close: q.close,
        currency: q.currency.clone(),
        source: q.data_source.clone(),
    }
}

pub(super) fn raw_fx_rate(r: &crate::fx::ExchangeRate) -> RawFxRate {
    RawFxRate {
        from: r.from_currency.clone(),
        to: r.to_currency.clone(),
        day: r.timestamp.date_naive(),
        rate: r.rate,
        source: r.source.clone(),
    }
}

/// An observed (holdings) snapshot as the kernel reads it. Positions and cash
/// come out of hash maps: they are sorted so the loaded facts (and the
/// fingerprint computed over them) do not depend on map iteration order,
/// which differs per load.
pub(super) fn raw_observed_snapshot(
    snapshot: &crate::portfolio::snapshot::AccountStateSnapshot,
) -> RawObservedSnapshot {
    let mut positions: Vec<RawObservedPosition> = snapshot
        .positions
        .values()
        .map(|p| RawObservedPosition {
            asset_id: p.asset_id.clone(),
            currency: p.currency.clone(),
            quantity: p.quantity,
            average_cost: p.average_cost,
            total_cost_basis: p.total_cost_basis,
            cost_basis_account: p.cost_basis_account,
            cost_basis_base: p.cost_basis_base,
        })
        .collect();
    positions.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
    let mut cash: Vec<(String, Decimal)> = snapshot
        .cash_balances
        .iter()
        .map(|(c, a)| (c.clone(), *a))
        .collect();
    cash.sort_by(|a, b| a.0.cmp(&b.0));
    RawObservedSnapshot {
        account_id: snapshot.account_id.clone(),
        date: snapshot.snapshot_date,
        positions,
        cash,
        cost_basis: snapshot.cost_basis,
        net_contribution: snapshot.net_contribution,
        net_contribution_base: snapshot.net_contribution_base,
        cash_total_account_currency: snapshot.cash_total_account_currency,
        cash_total_base_currency: snapshot.cash_total_base_currency,
    }
}

/// Whether the kernel can use a close: one it would drop at normalize (not
/// positive, outside its range, without a currency) leaves a window that
/// starts from it without the price a run over the whole range carries.
fn usable(quote: &RawQuote) -> bool {
    !engine::normalize_quotes(vec![quote.clone()], &BTreeMap::new(), &mut Vec::new()).is_empty()
}

/// Quotes of one window: every observation from `start` through `end`, plus
/// each asset's last usable observation before `start` (the sparse read's
/// seed, stepping back past any close the kernel would drop), so a price
/// carries into the window exactly as it would through the whole range.
pub fn window_quotes(
    deps: &FactSources,
    asset_ids: &[String],
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<RawQuote>> {
    if asset_ids.is_empty() || start > end {
        return Ok(Vec::new());
    }
    let symbols: HashSet<String> = asset_ids.iter().cloned().collect();
    let mut quotes: Vec<RawQuote> = deps
        .quotes
        .get_sparse_quotes_in_range(&symbols, start, end)?
        .iter()
        .map(raw_quote)
        .collect();
    for asset in asset_ids {
        let mut seed = quotes
            .iter()
            .filter(|q| q.asset_id == *asset && q.day < start)
            .max_by_key(|q| q.day)
            .cloned();
        while let Some(unusable) = seed.filter(|q| !usable(q)) {
            let earlier: Vec<RawQuote> = deps
                .quotes
                .get_sparse_quotes_in_range(
                    &HashSet::from([asset.clone()]),
                    unusable.day,
                    unusable.day,
                )?
                .iter()
                .map(raw_quote)
                .filter(|q| q.day < unusable.day)
                .collect();
            seed = earlier.iter().max_by_key(|q| q.day).cloned();
            quotes.extend(earlier);
        }
    }
    Ok(quotes)
}

/// SPLIT rows of `assets` recorded outside `activities` (any account,
/// archived included): a split belongs to the asset, so it decides how every
/// holder's quotes read, whichever account recorded it (3.9.1 read them by
/// asset too).
fn foreign_splits(
    deps: &FactSources,
    assets: &BTreeSet<String>,
    activities: &[Activity],
) -> Result<Vec<Activity>> {
    let known: HashSet<&str> = activities.iter().map(|a| a.id.as_str()).collect();
    let assets: Vec<String> = assets.iter().cloned().collect();
    Ok(deps
        .activities
        .get_split_activities_by_asset_ids(&assets)?
        .into_iter()
        .filter(|a| !known.contains(a.id.as_str()))
        .collect())
}

/// The accounts that recorded `splits` outside the run, as archived: only
/// their split rows are loaded, so the kernel must not project them.
fn split_accounts(
    all_accounts: &[crate::accounts::Account],
    known: &BTreeSet<String>,
    splits: &[Activity],
) -> Vec<RawAccount> {
    let recorders: BTreeSet<&str> = splits.iter().map(|a| a.account_id.as_str()).collect();
    all_accounts
        .iter()
        .filter(|a| recorders.contains(a.id.as_str()) && !known.contains(&a.id))
        .map(|a| RawAccount {
            is_archived: true,
            ..raw_account(a)
        })
        .collect()
}

/// The closes that tell whether the provider already adjusted each split:
/// its asset's last usable close before the split day and its first usable
/// close on or after it, however far away either is (sparse, manually
/// entered history included).
fn split_evidence<'a>(
    deps: &FactSources,
    splits: impl IntoIterator<Item = &'a Activity>,
    timezone: chrono_tz::Tz,
    as_of: NaiveDate,
) -> Result<Vec<RawQuote>> {
    let days: BTreeSet<(String, NaiveDate)> = splits
        .into_iter()
        .filter_map(|a| {
            a.asset_id.clone().map(|asset| {
                (
                    asset,
                    crate::utils::time_utils::activity_date_in_tz(a.activity_date, timezone),
                )
            })
        })
        .filter(|(_, day)| *day <= as_of)
        .collect();
    let mut quotes = Vec::new();
    for (asset, day) in days {
        let asset = std::slice::from_ref(&asset);
        quotes.extend(window_quotes(deps, asset, day, day)?);
        let mut from = day;
        let mut span = 31;
        while from <= as_of {
            let to = (from + chrono::Duration::days(span)).min(as_of);
            let found = window_quotes(deps, asset, from, to)?;
            let after = found.iter().any(|q| q.day >= day && usable(q));
            quotes.extend(found);
            if after {
                break;
            }
            from = to + chrono::Duration::days(1);
            span *= 4;
        }
    }
    Ok(quotes)
}

pub struct LoadedFacts {
    /// Accounts the job persists (requested, non-archived, sorted).
    pub scope: Vec<String>,
    /// Facts for the transfer closure of the scope; `raw.quotes` holds only
    /// the closes around split dates.
    pub raw: RawFacts,
    /// The currency pair of each FX asset with rates, so a marked FX asset
    /// names the rate that changed.
    pub fx_pairs: BTreeMap<String, (String, String)>,
    /// Holdings accounts with an observed snapshot outside the supported
    /// date range (account id, date): they fail instead of projecting.
    pub invalid_snapshot_dates: Vec<(String, NaiveDate)>,
    /// Accounts whose accounting settings the kernel cannot honour
    /// (account id, reason).
    pub unsupported_accounts: Vec<(String, String)>,
    pub base_currency: String,
    pub timezone: String,
    pub as_of: NaiveDate,
}

fn tracking_label(mode: TrackingMode) -> &'static str {
    match mode {
        TrackingMode::Holdings => "HOLDINGS",
        TrackingMode::Transactions | TrackingMode::NotSet => "TRANSACTIONS",
    }
}

pub fn load(
    deps: &FactSources,
    account_ids: &[String],
    base_currency: &str,
    timezone: &str,
    as_of: NaiveDate,
) -> Result<LoadedFacts> {
    let all_accounts = deps.accounts.list(None, None, None)?;
    let requested: BTreeSet<&str> = account_ids.iter().map(String::as_str).collect();
    let scope: Vec<String> = all_accounts
        .iter()
        .filter(|a| requested.contains(a.id.as_str()))
        .map(|a| a.id.clone())
        .collect();
    // Legacy refused LIFO / non-generic / pooled accounts with a validation
    // error; the kernel computes FIFO only, so such accounts fail loudly
    // instead of being relabelled FIFO.
    let accounting = deps
        .accounts
        .get_accounting_settings_by_account_ids(&scope)?;
    let unsupported_accounts: Vec<(String, String)> = scope
        .iter()
        .filter_map(|id| {
            accounting
                .get(id)
                .and_then(|settings| settings.ensure_supported_for_calculation().err())
                .map(|error| (id.clone(), error.to_string()))
        })
        .collect();

    // Transfer closure: every account sharing a transfer group with the scope.
    let (closure, closure_activities) =
        deps.closure_activities(&scope.iter().cloned().collect::<BTreeSet<String>>())?;

    let mut accounts: Vec<RawAccount> = all_accounts
        .iter()
        .filter(|a| closure.contains(&a.id))
        .map(|a| RawAccount {
            id: a.id.clone(),
            currency: a.currency.clone(),
            account_type: a.account_type.clone(),
            tracking_mode: tracking_label(a.tracking_mode).to_string(),
            is_archived: a.is_archived,
        })
        .collect();
    let activities: Vec<&Activity> = closure_activities.iter().collect();

    let mut observed_snapshots = Vec::new();
    let mut invalid_snapshot_dates = Vec::new();
    for account in all_accounts
        .iter()
        .filter(|a| closure.contains(&a.id) && a.tracking_mode == TrackingMode::Holdings)
    {
        for snapshot in deps
            .snapshots
            .get_snapshots_by_account(&account.id, None, None)?
            .into_iter()
            .filter(|s| s.source != SnapshotSource::Calculated)
        {
            // An out-of-policy date (year 224, or far in the future) would
            // stretch the projection over centuries; the account fails
            // instead and the health center points at the row.
            if snapshot_date_requires_remediation(snapshot.snapshot_date, as_of) {
                invalid_snapshot_dates.push((account.id.clone(), snapshot.snapshot_date));
                continue;
            }
            observed_snapshots.push(raw_observed_snapshot(&snapshot));
        }
    }

    let mut asset_ids: BTreeSet<String> = activities
        .iter()
        .filter_map(|a| a.asset_id.clone())
        .collect();
    asset_ids.extend(
        observed_snapshots
            .iter()
            .flat_map(|s| s.positions.iter().map(|p| p.asset_id.clone())),
    );
    let asset_id_vec: Vec<String> = asset_ids.iter().cloned().collect();
    let asset_rows = if asset_id_vec.is_empty() {
        Vec::new()
    } else {
        deps.assets.list_by_asset_ids(&asset_id_vec)?
    };
    let assets: Vec<RawAsset> = asset_rows
        .iter()
        .map(|a| RawAsset {
            id: a.id.clone(),
            quote_currency: a.quote_ccy.clone(),
            kind: a.kind.as_db_str().to_string(),
            instrument_type: a
                .instrument_type
                .as_ref()
                .map(|t| t.as_db_str().to_string()),
            contract_multiplier: Some(a.contract_multiplier()),
        })
        .collect();

    // Splits of these assets recorded elsewhere, and the closes around every
    // split, over the whole range; every other quote is read per window.
    let foreign = foreign_splits(deps, &asset_ids, &closure_activities)?;
    accounts.extend(split_accounts(&all_accounts, &closure, &foreign));
    let tz: chrono_tz::Tz = timezone.parse().unwrap_or(chrono_tz::Tz::UTC);
    let quotes = split_evidence(
        deps,
        activities
            .iter()
            .copied()
            .filter(|a| a.effective_type() == "SPLIT")
            .chain(&foreign),
        tz,
        as_of,
    )?;

    let fx_rows = deps.fx_rates.get_historical_exchange_rates()?;
    let fx_pairs: BTreeMap<String, (String, String)> = fx_rows
        .iter()
        .map(|r| {
            (
                r.id.clone(),
                (r.from_currency.clone(), r.to_currency.clone()),
            )
        })
        .collect();
    let fx_rates: Vec<RawFxRate> = fx_rows
        .iter()
        .map(|r| RawFxRate {
            from: r.from_currency.clone(),
            to: r.to_currency.clone(),
            day: r.timestamp.date_naive(),
            rate: r.rate,
            source: r.source.clone(),
        })
        .collect();

    let policy = Policy::new(
        Currency::parse(base_currency)
            .ok_or_else(|| Error::Unexpected("base currency is empty".to_string()))?,
        timezone.parse().unwrap_or(chrono_tz::Tz::UTC),
        as_of,
    );

    let raw_activities: Vec<RawActivity> = activities
        .iter()
        .copied()
        .chain(&foreign)
        .map(raw_activity)
        .collect();

    Ok(LoadedFacts {
        scope,
        fx_pairs,
        raw: RawFacts {
            policy,
            accounts,
            assets,
            activities: raw_activities,
            quotes,
            fx_rates,
            observed_snapshots,
        },
        invalid_snapshot_dates,
        unsupported_accounts,
        base_currency: base_currency.to_string(),
        timezone: timezone.to_string(),
        as_of,
    })
}
