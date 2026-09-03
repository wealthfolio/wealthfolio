//! Loads the kernel's `RawFacts` for a scope from the repositories and
//! fingerprints each requested account from the same rows.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine::model::{
    Currency, Policy, RawAccount, RawActivity, RawAsset, RawFacts, RawFxRate, RawObservedPosition,
    RawObservedSnapshot, RawQuote,
};

use std::sync::Arc;

use super::fingerprint::{content_hash, AccountFingerprint};
use crate::accounts::{AccountRepositoryTrait, TrackingMode};
use crate::activities::{Activity, ActivityRepositoryTrait};
use crate::assets::AssetRepositoryTrait;
use crate::errors::{Error, Result};
use crate::fx::FxRepositoryTrait;
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
        let quote_rows = if requests.is_empty() {
            Vec::new()
        } else {
            self.quotes
                .get_sparse_asset_market_facts(&requests)?
                .quotes_by_request
                .into_values()
                .collect()
        };

        Ok(RawFacts {
            policy: policy(base_currency, timezone, as_of)?,
            accounts: all_accounts
                .iter()
                .filter(|a| closure.contains(&a.id))
                .map(raw_account)
                .collect(),
            assets: asset_rows.iter().map(raw_asset).collect(),
            activities: activities.into_iter().map(raw_activity).collect(),
            quotes: quote_rows.iter().map(raw_quote).collect(),
            fx_rates: self
                .fx_rates
                .get_historical_exchange_rates()?
                .iter()
                .map(raw_fx_rate)
                .collect(),
            observed_snapshots: Vec::new(),
        })
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

fn raw_account(a: &crate::accounts::Account) -> RawAccount {
    RawAccount {
        id: a.id.clone(),
        currency: a.currency.clone(),
        account_type: a.account_type.clone(),
        tracking_mode: tracking_label(a.tracking_mode).to_string(),
        is_archived: a.is_archived,
    }
}

fn raw_asset(a: &crate::assets::Asset) -> RawAsset {
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

fn raw_activity(a: &Activity) -> RawActivity {
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
        source_system: a.source_system.clone(),
        is_user_modified: a.is_user_modified,
        updated_at: a.updated_at,
    }
}

fn raw_quote(q: &crate::quotes::Quote) -> RawQuote {
    RawQuote {
        asset_id: q.asset_id.clone(),
        day: q.timestamp.date_naive(),
        close: q.close,
        currency: q.currency.clone(),
        source: q.data_source.clone(),
    }
}

fn raw_fx_rate(r: &crate::fx::ExchangeRate) -> RawFxRate {
    RawFxRate {
        from: r.from_currency.clone(),
        to: r.to_currency.clone(),
        day: r.timestamp.date_naive(),
        rate: r.rate,
    }
}

pub struct LoadedFacts {
    /// Accounts the job persists (requested, non-archived, sorted).
    pub scope: Vec<String>,
    /// Facts for the transfer closure of the scope.
    pub raw: RawFacts,
    pub fingerprints: BTreeMap<String, AccountFingerprint>,
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

    let accounts: Vec<RawAccount> = all_accounts
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
            // Positions and cash come out of hash maps: sort them so the
            // loaded facts (and the fingerprint computed over them) do not
            // depend on map iteration order, which differs per load.
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
            observed_snapshots.push(RawObservedSnapshot {
                account_id: snapshot.account_id.clone(),
                date: snapshot.snapshot_date,
                positions,
                cash,
                cost_basis: snapshot.cost_basis,
                net_contribution: snapshot.net_contribution,
                net_contribution_base: snapshot.net_contribution_base,
                cash_total_account_currency: snapshot.cash_total_account_currency,
                cash_total_base_currency: snapshot.cash_total_base_currency,
            });
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

    let earliest = activities
        .iter()
        .map(|a| a.activity_date.date_naive())
        .chain(observed_snapshots.iter().map(|s| s.date))
        .min()
        .unwrap_or(as_of);
    let quote_rows = if asset_ids.is_empty() {
        Vec::new()
    } else {
        let symbols: HashSet<String> = asset_ids.iter().cloned().collect();
        deps.quotes
            .get_sparse_quotes_in_range(&symbols, earliest, as_of)?
    };
    let quotes: Vec<RawQuote> = quote_rows
        .iter()
        .map(|q| RawQuote {
            asset_id: q.asset_id.clone(),
            day: q.timestamp.date_naive(),
            close: q.close,
            currency: q.currency.clone(),
            source: q.data_source.clone(),
        })
        .collect();

    let fx_rows = deps.fx_rates.get_historical_exchange_rates()?;
    let fx_rates: Vec<RawFxRate> = fx_rows
        .iter()
        .map(|r| RawFxRate {
            from: r.from_currency.clone(),
            to: r.to_currency.clone(),
            day: r.timestamp.date_naive(),
            rate: r.rate,
        })
        .collect();

    let policy = Policy::new(
        Currency::parse(base_currency)
            .ok_or_else(|| Error::Unexpected("base currency is empty".to_string()))?,
        timezone.parse().unwrap_or(chrono_tz::Tz::UTC),
        as_of,
    );

    let raw_activities: Vec<RawActivity> = activities.iter().map(|a| raw_activity(a)).collect();

    // Fingerprints for the requested accounts.
    let policy_key = format!("{base_currency}|{timezone}");
    let fx_count = fx_rows.len();
    let fx_keys: Vec<String> = fx_rows
        .iter()
        .map(|r| {
            format!(
                "{}|{}|{}|{}",
                r.from_currency,
                r.to_currency,
                r.timestamp.date_naive(),
                r.rate
            )
        })
        .collect();
    let fx_hash = content_hash(fx_keys.iter().map(String::as_str));
    let mut fingerprints = BTreeMap::new();
    for account in all_accounts.iter().filter(|a| scope.contains(&a.id)) {
        let own: Vec<&Activity> = activities
            .iter()
            .copied()
            .filter(|a| a.account_id == account.id)
            .collect();
        let own_groups: HashSet<&str> = own
            .iter()
            .filter_map(|a| a.source_group_id.as_deref())
            .collect();
        let partners: Vec<&Activity> = activities
            .iter()
            .copied()
            .filter(|a| {
                a.account_id != account.id
                    && a.source_group_id
                        .as_deref()
                        .is_some_and(|g| own_groups.contains(g))
            })
            .collect();
        let settings = accounting.get(&account.id);
        let mut own_assets: BTreeSet<&str> =
            own.iter().filter_map(|a| a.asset_id.as_deref()).collect();
        let observed: Vec<&RawObservedSnapshot> = observed_snapshots
            .iter()
            .filter(|s| s.account_id == account.id)
            .collect();
        own_assets.extend(
            observed
                .iter()
                .flat_map(|s| s.positions.iter().map(|p| p.asset_id.as_str())),
        );
        let asset_keys: Vec<String> = asset_rows
            .iter()
            .filter(|a| own_assets.contains(a.id.as_str()))
            .map(|a| {
                format!(
                    "{}|{}|{}|{}|{}",
                    a.id,
                    a.kind.as_db_str(),
                    a.instrument_type
                        .as_ref()
                        .map(|t| t.as_db_str())
                        .unwrap_or(""),
                    a.quote_ccy,
                    a.contract_multiplier()
                )
            })
            .collect();
        let quote_keys: Vec<String> = quote_rows
            .iter()
            .filter(|q| own_assets.contains(q.asset_id.as_str()))
            .map(|q| format!("{}|{}|{}", q.asset_id, q.timestamp.date_naive(), q.close))
            .collect();
        let observed_keys: Vec<String> = observed
            .iter()
            .map(|s| serde_json::to_string(s).unwrap_or_default())
            .collect();
        fingerprints.insert(
            account.id.clone(),
            AccountFingerprint {
                activity_count: own.len(),
                activities_updated_at: own.iter().map(|a| a.updated_at).max(),
                partner_activity_count: partners.len(),
                partner_activities_updated_at: partners.iter().map(|a| a.updated_at).max(),
                account: format!(
                    "{}|{}|{}|{}|{}|{}|{:?}",
                    account.currency,
                    account.account_type,
                    tracking_label(account.tracking_mode),
                    account.is_archived,
                    settings
                        .map(|s| s.cost_basis_method.as_str())
                        .unwrap_or("FIFO"),
                    settings
                        .map(|s| s.cost_basis_profile.as_str())
                        .unwrap_or("GENERIC"),
                    settings.map(|s| s.pooling_scope),
                ),
                assets: asset_keys,
                observed_snapshot_count: observed.len(),
                observed_snapshots_hash: content_hash(observed_keys.iter().map(String::as_str)),
                policy: policy_key.clone(),
                quote_count: quote_keys.len(),
                quotes_hash: content_hash(quote_keys.iter().map(String::as_str)),
                fx_count,
                fx_hash,
            },
        );
    }

    Ok(LoadedFacts {
        scope,
        raw: RawFacts {
            policy,
            accounts,
            assets,
            activities: raw_activities,
            quotes,
            fx_rates,
            observed_snapshots,
        },
        fingerprints,
        invalid_snapshot_dates,
        unsupported_accounts,
        base_currency: base_currency.to_string(),
        timezone: timezone.to_string(),
        as_of,
    })
}
