//! Removable one-shot compatibility code for legacy activity cash amounts.
//! Runtime economics must never call this module.
//!
//! Deliberate policy decisions:
//! - No automatic database backup: the rewrite touches only `amount` and
//!   `needs_review`, and every replaced amount is preserved on the row
//!   itself (activity metadata `final_cash_migration.legacy_amount`), so a
//!   full-database copy would block startup for no proportional benefit.
//! - The migration never changes lifecycle `status`. A Posted trade whose
//!   final cash cannot be verified keeps `amount = NULL` (zero runtime cash)
//!   and is flagged for review rather than demoted to Draft.
//! - A legacy trade whose stored amount is zero treats that zero like a
//!   missing value when complete, trustworthy inputs can derive final cash.
//!   If derivation is unavailable, the zero stays reviewable. This migration
//!   rule does not change the runtime contract for user-confirmed zero totals.
//! - Security-transfer rows are never touched, including legacy `amount`
//!   values that transfer pairing still reads.
//! - A crash between the row rewrite and the state write re-runs
//!   classification against migrated rows; already-final rows classify as
//!   matching, so the re-run never re-corrupts data.
//! - The migration runs per device and its rewrites deliberately emit no
//!   sync events (every device converges on its own deterministic pass).
//!   Rows synced in from a not-yet-upgraded device during a version-skew
//!   window keep old semantics on this device: accepted risk - devices
//!   sync near-immediately in practice, and fencing a one-shot migration
//!   is not worth the machinery.
//! - Charge-amount rewrites do not clear spending splits. Colliding rows
//!   would need a multi-category split on a disagreeing-column FEE/TAX row
//!   in a spending-opted account (zero-amount rows cannot be split at all);
//!   nobody splits a fee, and such rows are review-flagged anyway: accepted.
//! - Draft rows whose stored amount text is unparseable read as zero and can
//!   be rewritten to a derived value or "0". Reaching that state requires
//!   hand-corrupted DB text; such rows are review-flagged (legacy Drafts
//!   always are) and the original text survives in `legacy_amount`: accepted.

use std::collections::{HashMap, HashSet};

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::accounts::{account_types, AccountServiceTrait};
use crate::activities::{
    requires_final_cash_amount, Activity, ActivityFinalCashMigrationResult,
    ActivityFinalCashMigrationUpdate, ActivityRepositoryTrait, ActivityStatus, NewActivity,
    ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT,
    ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
    ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::assets::AssetServiceTrait;
use crate::errors::Result;
use crate::fx::currency::currency_minor_unit;
use crate::portfolio::coordinator::{PortfolioCoordinator, PortfolioJobRequest, SilentObserver};
use crate::portfolio::economic_events::{ActivityCashInputs, ActivityEconomicsResolver};
use crate::quotes::MarketSyncMode;
use crate::settings::SettingsServiceTrait;

const MIGRATION_STATE_KEY: &str = "migration.activity_final_cash.v1";
const PHASE_REWRITE_PENDING: &str = "rewrite_pending";
const PHASE_REBUILD_PENDING: &str = "rebuild_pending";
const PHASE_COMPLETE: &str = "complete";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMigrationState {
    phase: String,
    #[serde(default)]
    pending_account_ids: Vec<String>,
}

/// Private startup machinery: idempotency, crash recovery, and rebuild
/// retries. Deliberately not exposed through any activity API - the live
/// `activities.needs_review` column is the user-facing source of truth.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivityFinalCashMigrationStatus {
    /// Accounts still awaiting their post-rewrite rebuild; empty once the
    /// migration is complete. This is the only signal production consumes
    /// (it seeds the recalculation gate and the background rebuild).
    pub pending_account_ids: Vec<String>,
}

impl From<PersistedMigrationState> for ActivityFinalCashMigrationStatus {
    fn from(state: PersistedMigrationState) -> Self {
        Self {
            pending_account_ids: state.pending_account_ids,
        }
    }
}

pub fn get_final_cash_migration_status(
    settings_service: &dyn SettingsServiceTrait,
) -> Result<ActivityFinalCashMigrationStatus> {
    Ok(read_migration_state(settings_service)?
        .map(ActivityFinalCashMigrationStatus::from)
        .unwrap_or_default())
}

/// Runs the idempotent one-shot rewrite. Completion is withheld until every
/// affected account has rebuilt.
pub async fn run_final_cash_migration(
    settings_service: &dyn SettingsServiceTrait,
    activity_repository: &dyn ActivityRepositoryTrait,
    account_service: &dyn AccountServiceTrait,
    asset_service: &dyn AssetServiceTrait,
) -> Result<ActivityFinalCashMigrationStatus> {
    let mut state = match read_migration_state(settings_service)? {
        Some(state) => state,
        None => {
            let state = PersistedMigrationState {
                phase: PHASE_REWRITE_PENDING.to_string(),
                pending_account_ids: Vec::new(),
            };
            write_migration_state(settings_service, &state).await?;
            state
        }
    };

    if state.phase == PHASE_REWRITE_PENDING {
        let result =
            migrate_activities_to_final_cash(activity_repository, account_service, asset_service)
                .await?;
        state.phase = if result.affected_account_ids.is_empty() {
            PHASE_COMPLETE.to_string()
        } else {
            PHASE_REBUILD_PENDING.to_string()
        };
        state.pending_account_ids = result.affected_account_ids;
        if result.changed > 0 {
            log::info!("Final-cash migration rewrote {} activities", result.changed);
        }
        write_migration_state(settings_service, &state).await?;
    }

    Ok(state.into())
}

pub async fn record_final_cash_rebuild_attempt(
    settings_service: &dyn SettingsServiceTrait,
    succeeded_account_ids: &[String],
) -> Result<ActivityFinalCashMigrationStatus> {
    let Some(mut state) = read_migration_state(settings_service)? else {
        return Ok(ActivityFinalCashMigrationStatus::default());
    };
    if state.phase != PHASE_REBUILD_PENDING {
        return Ok(state.into());
    }

    let succeeded: HashSet<&str> = succeeded_account_ids.iter().map(String::as_str).collect();
    state
        .pending_account_ids
        .retain(|account_id| !succeeded.contains(account_id.as_str()));
    if state.pending_account_ids.is_empty() {
        state.phase = PHASE_COMPLETE.to_string();
    }
    write_migration_state(settings_service, &state).await?;
    Ok(state.into())
}

/// Attempts every pending account independently through the coordinator
/// (one forced rebuild each). Failed accounts remain durable and are retried
/// on the next launch; successful accounts leave the gate's pending set.
pub async fn rebuild_pending_final_cash_accounts(
    settings_service: &dyn SettingsServiceTrait,
    coordinator: &PortfolioCoordinator,
) -> Result<ActivityFinalCashMigrationStatus> {
    let status = get_final_cash_migration_status(settings_service)?;
    let mut succeeded = Vec::new();

    for account_id in &status.pending_account_ids {
        let request = PortfolioJobRequest {
            account_ids: Some(vec![account_id.clone()]),
            market_sync: MarketSyncMode::None,
            ..PortfolioJobRequest::default()
        };
        match coordinator.run_job(request, &SilentObserver).await {
            Ok(report) if report.failures.is_empty() => succeeded.push(account_id.clone()),
            Ok(report) => log::warn!(
                "Final-cash rebuild reported {} failure(s) for account {}",
                report.failures.len(),
                account_id
            ),
            Err(error) => log::warn!(
                "Final-cash rebuild failed for account {}: {}",
                account_id,
                error
            ),
        }
    }

    record_final_cash_rebuild_attempt(settings_service, &succeeded).await
}

fn read_migration_state(
    settings_service: &dyn SettingsServiceTrait,
) -> Result<Option<PersistedMigrationState>> {
    let Some(raw) = settings_service.get_setting_value(MIGRATION_STATE_KEY)? else {
        return Ok(None);
    };
    match serde_json::from_str(&raw) {
        Ok(state) => Ok(Some(state)),
        Err(error) => {
            // A corrupt state value must not brick startup. Treat it as
            // never-run: the rewrite is idempotent (already-final rows
            // classify as matching and are left alone) and rewrites its own
            // state on completion.
            log::warn!("Ignoring unreadable final-cash migration state: {error}");
            Ok(None)
        }
    }
}

async fn write_migration_state(
    settings_service: &dyn SettingsServiceTrait,
    state: &PersistedMigrationState,
) -> Result<()> {
    settings_service
        .set_setting_value(MIGRATION_STATE_KEY, &serde_json::to_string(state)?)
        .await
}

#[derive(Clone)]
struct AssetCashFacts {
    /// The asset's multiplier, which is the only owner of that convention on
    /// both sides of the cutover - so one value serves the legacy replay and
    /// the final contract. If an instrument default ever diverges again,
    /// resurrect a separate legacy replay multiplier here or the delta will
    /// be masked.
    unit_multiplier: Decimal,
    is_bond: bool,
    multiplier_is_reliable: bool,
}

#[derive(Clone)]
struct AccountCashFacts {
    is_credit_card: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LegacyCashDecision {
    final_amount: Option<Decimal>,
    needs_review: bool,
    previous_cash_effect: Decimal,
    final_cash_effect: Decimal,
}

pub(crate) async fn migrate_activities_to_final_cash(
    activity_repository: &dyn ActivityRepositoryTrait,
    account_service: &dyn AccountServiceTrait,
    asset_service: &dyn AssetServiceTrait,
) -> Result<ActivityFinalCashMigrationResult> {
    let activities = activity_repository.get_activities_including_archived_accounts()?;
    let mut asset_cache: HashMap<String, Option<AssetCashFacts>> = HashMap::new();
    let mut account_cache: HashMap<String, AccountCashFacts> = HashMap::new();
    let mut affected_account_ids = HashSet::new();
    let mut posted_account_by_activity_id = HashMap::new();
    let mut updates = Vec::new();

    for activity in activities {
        let asset_facts = activity
            .asset_id
            .as_deref()
            .and_then(|asset_id| cached_asset_facts(asset_id, asset_service, &mut asset_cache));
        let account_facts = account_cache
            .entry(activity.account_id.clone())
            .or_insert_with(|| {
                account_service
                    .get_account(&activity.account_id)
                    .map(|account| AccountCashFacts {
                        is_credit_card: account.account_type == account_types::CREDIT_CARD,
                    })
                    .unwrap_or(AccountCashFacts {
                        is_credit_card: false,
                    })
            })
            .clone();
        let Some(decision) = classify_legacy_activity_cash(
            &activity,
            asset_facts.unwrap_or(AssetCashFacts {
                unit_multiplier: Decimal::ONE,
                is_bond: false,
                multiplier_is_reliable: false,
            }),
            &account_facts,
        ) else {
            if let Some(update) = unclassified_draft_backfill(&activity) {
                updates.push(update);
            }
            continue;
        };

        if activity.status == ActivityStatus::Posted
            && decision.previous_cash_effect != decision.final_cash_effect
        {
            affected_account_ids.insert(activity.account_id.clone());
        }

        let normalized_existing = activity.amount.map(|amount| amount.abs());
        if normalized_existing != decision.final_amount
            || activity.needs_review != decision.needs_review
        {
            if activity.status == ActivityStatus::Posted {
                posted_account_by_activity_id
                    .insert(activity.id.clone(), activity.account_id.clone());
            }
            updates.push(ActivityFinalCashMigrationUpdate {
                id: activity.id,
                amount: decision.final_amount,
                needs_review: decision.needs_review,
            });
        }
    }

    let write_result = activity_repository
        .update_activities_for_final_cash_migration(updates)
        .await?;
    // Storage can intentionally preserve an amount when its undo breadcrumb
    // cannot be recorded. The new runtime then books that preserved value,
    // not the classifier's proposed value, so the account must rebuild even
    // when the legacy and proposed cash effects happened to match.
    for activity_id in write_result.unapplied_amount_update_ids {
        if let Some(account_id) = posted_account_by_activity_id.get(&activity_id) {
            affected_account_ids.insert(account_id.clone());
        }
    }
    let mut affected_account_ids: Vec<String> = affected_account_ids.into_iter().collect();
    affected_account_ids.sort();

    Ok(ActivityFinalCashMigrationResult {
        changed: write_result.changed,
        affected_account_ids,
    })
}

fn cached_asset_facts(
    asset_id: &str,
    asset_service: &dyn AssetServiceTrait,
    cache: &mut HashMap<String, Option<AssetCashFacts>>,
) -> Option<AssetCashFacts> {
    if let Some(cached) = cache.get(asset_id) {
        return cached.clone();
    }
    let facts = asset_service
        .get_asset_by_id(asset_id)
        .ok()
        .map(asset_cash_facts_from_asset);
    cache.insert(asset_id.to_string(), facts.clone());
    facts
}

/// The one constructor turning a real [`Asset`] into migration facts. Tests
/// must build facts through this function, never as struct literals - a
/// hand-built `AssetCashFacts` can encode states no real asset produces.
fn asset_cash_facts_from_asset(asset: crate::assets::Asset) -> AssetCashFacts {
    AssetCashFacts {
        unit_multiplier: asset.contract_multiplier(),
        is_bond: asset.is_bond(),
        multiplier_is_reliable: true,
    }
}

fn classify_legacy_activity_cash(
    activity: &Activity,
    asset_facts: AssetCashFacts,
    account_facts: &AccountCashFacts,
) -> Option<LegacyCashDecision> {
    let activity_type = activity.effective_type();
    let is_security_transfer = ActivityEconomicsResolver::is_security_transfer(activity);
    if activity_type == ACTIVITY_TYPE_SPLIT
        || !requires_final_cash_amount(activity_type, is_security_transfer)
    {
        return None;
    }

    // The asset owns the multiplier, so derivation and the legacy replay read
    // the same value (see AssetCashFacts).
    let unit_multiplier = asset_facts.unit_multiplier;
    let inputs = ActivityCashInputs {
        activity_type,
        currency: &activity.currency,
        is_security_transfer: false,
        quantity: activity.quantity,
        unit_price: activity.unit_price,
        amount: None,
        fee: activity.fee,
        tax: activity.tax,
        unit_multiplier,
    };
    let is_trade = matches!(activity_type, ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL);
    let is_charge = matches!(activity_type, ACTIVITY_TYPE_FEE | ACTIVITY_TYPE_TAX);
    let is_composite =
        NewActivity::is_asset_backed_income_subtype(activity_type, activity.subtype.as_deref());
    // Every monetary activity input is denominated in activity currency, so
    // the asset quote currency does not participate in transaction arithmetic.
    // The account currency is also deliberately absent: booking converts the
    // derived activity-currency final later, with or without an explicit FX
    // rate. Only the asset-owned multiplier needs an independent reliability
    // check here.
    let priced_inputs_are_reliable = asset_facts.multiplier_is_reliable;
    let derived_final = if is_trade {
        priced_inputs_are_reliable
            .then(|| ActivityEconomicsResolver::calculate_trade_final_cash(inputs))
            .flatten()
    } else if is_charge {
        ActivityEconomicsResolver::calculate_standalone_charge_amount(inputs)
    } else if is_composite {
        priced_inputs_are_reliable
            .then(|| {
                ActivityEconomicsResolver::calculate_composite_final_cash(
                    activity_type,
                    activity.subtype.as_deref(),
                    activity.quantity,
                    activity.unit_price,
                    unit_multiplier,
                )
            })
            .flatten()
    } else {
        None
    };
    let derived_gross = priced_inputs_are_reliable
        .then(|| ActivityEconomicsResolver::derived_positive_gross(inputs))
        .flatten();
    let supplied = activity.amount.map(|amount| amount.abs());
    let charges = activity.fee_amt() + activity.tax_amt();
    let tolerance = currency_minor_unit(&activity.currency) / Decimal::TWO;

    let (final_amount, needs_review) = if is_trade {
        match supplied {
            None => (derived_final, derived_final.is_none()),
            Some(amount) if amount.is_zero() => match derived_final {
                Some(final_amount) => (Some(final_amount), false),
                None => (Some(Decimal::ZERO), true),
            },
            Some(amount) => {
                let matches_gross =
                    derived_gross.is_some_and(|gross| close(amount, gross, tolerance));
                let matches_final = derived_final
                    .is_some_and(|final_amount| close(amount, final_amount, tolerance));
                if matches_final || (matches_gross && derived_final.is_some()) {
                    (derived_final, false)
                } else {
                    (Some(amount), true)
                }
            }
        }
    } else if is_charge {
        // The legacy runtime charged the tax/fee column first and read the
        // stored amount only as a fallback (old `charge_amt_for`), so that
        // effective value - not the raw amount column - is the cash to
        // preserve. Old imports routinely wrote charges as amount=0 with the
        // value in fee/tax.
        let charge_derived = derived_final.filter(|value| !value.is_zero());
        match charge_derived.or_else(|| supplied.filter(|value| !value.is_zero())) {
            Some(effective) => {
                // Replacing a different nonzero stored amount deserves eyes.
                let replaced_disagreeing_amount = supplied
                    .filter(|amount| !amount.is_zero())
                    .is_some_and(|amount| !close(amount, effective, tolerance));
                (Some(effective), replaced_disagreeing_amount)
            }
            None => match supplied {
                Some(zero) => (Some(zero), false),
                None => (derived_final, derived_final.is_none()),
            },
        }
    } else if is_composite {
        match supplied {
            // A charged composite (e.g. DRIP with withholding) changes its
            // compiled cash effect under the final contract; surface it.
            Some(amount) => (Some(amount), !charges.is_zero()),
            None => (derived_final, derived_final.is_none()),
        }
    } else {
        match supplied {
            Some(amount) => (Some(amount), !charges.is_zero()),
            None => (None, true),
        }
    };

    let previous_cash_effect =
        legacy_compiled_cash_effect(activity, &asset_facts, account_facts.is_credit_card);
    let mut migrated = activity.clone();
    migrated.amount = final_amount;
    let final_cash_effect = ActivityEconomicsResolver::resolve_compiled_cash(
        &migrated,
        asset_facts.unit_multiplier,
        account_facts.is_credit_card,
    )
    .ok()
    .and_then(|resolved| resolved.signed_cash_effect)
    .unwrap_or(Decimal::ZERO);

    // Before the cutover the review queue was `status = DRAFT`; after it,
    // `needs_review` is the only queue. Flag legacy drafts so they stay
    // reachable instead of silently sitting excluded from calculations.
    let is_legacy_draft = activity.status == ActivityStatus::Draft;

    Some(LegacyCashDecision {
        final_amount,
        needs_review: needs_review || activity.needs_review || is_legacy_draft,
        previous_cash_effect,
        final_cash_effect,
    })
}

/// Rows outside the cash classification (splits, security transfers,
/// non-cash types) still need the legacy-Draft review backfill: the
/// pre-cutover review queue was `status = DRAFT`, and `needs_review` is the
/// only queue after the cutover. The amount passes through untouched.
fn unclassified_draft_backfill(activity: &Activity) -> Option<ActivityFinalCashMigrationUpdate> {
    (activity.status == ActivityStatus::Draft && !activity.needs_review).then(|| {
        ActivityFinalCashMigrationUpdate {
            id: activity.id.clone(),
            amount: activity.amount,
            needs_review: true,
        }
    })
}

fn close(left: Decimal, right: Decimal, tolerance: Decimal) -> bool {
    (left - right).abs() <= tolerance
}

fn legacy_compiled_cash_effect(
    activity: &Activity,
    asset_facts: &AssetCashFacts,
    is_credit_card: bool,
) -> Decimal {
    legacy_cash_postings(activity)
        .iter()
        .map(|posting| legacy_runtime_cash_effect(posting, asset_facts, is_credit_card))
        .sum()
}

/// Reproduces only the pre-cutover asset-income expansion needed to compare
/// user-visible cash before and after migration. Calling the current compiler
/// here would evaluate the legacy row under the new final-cash contract and
/// produce a false rebuild delta for missing DRIP/staking amounts.
fn legacy_cash_postings(activity: &Activity) -> Vec<Activity> {
    if !activity.is_posted() {
        return Vec::new();
    }
    if !NewActivity::is_asset_backed_income_subtype(
        activity.effective_type(),
        activity.subtype.as_deref(),
    ) {
        return vec![activity.clone()];
    }

    let quantity = activity.quantity.unwrap_or(Decimal::ZERO);
    let derived_amount = activity.unit_price.map(|unit_price| quantity * unit_price);
    let income_amount = activity
        .amount
        .filter(|amount| !amount.is_zero())
        .or(derived_amount)
        .or(activity.amount);
    let acquisition_unit_price = activity
        .unit_price
        .filter(|price| price.is_sign_positive() && !price.is_zero())
        .or_else(|| {
            income_amount.and_then(|amount| {
                let reinvested_amount = amount - activity.fee_amt() - activity.tax_amt();
                if quantity.is_zero() || reinvested_amount <= Decimal::ZERO {
                    None
                } else {
                    Some(reinvested_amount / quantity)
                }
            })
        })
        .or(activity.unit_price);

    let mut income_leg = activity.clone();
    income_leg.activity_type = activity.effective_type().to_string();
    income_leg.activity_type_override = None;
    income_leg.subtype = None;
    income_leg.quantity = None;
    income_leg.unit_price = None;
    income_leg.amount = income_amount;

    let mut buy_leg = activity.clone();
    buy_leg.activity_type = ACTIVITY_TYPE_BUY.to_string();
    buy_leg.activity_type_override = None;
    buy_leg.subtype = None;
    buy_leg.unit_price = acquisition_unit_price;
    buy_leg.amount = None;
    buy_leg.fee = Some(Decimal::ZERO);
    buy_leg.tax = Some(Decimal::ZERO);

    vec![income_leg, buy_leg]
}

fn legacy_runtime_cash_effect(
    activity: &Activity,
    asset_facts: &AssetCashFacts,
    is_credit_card: bool,
) -> Decimal {
    let activity_type = activity.effective_type();
    let fee = activity.fee_amt();
    let tax = activity.tax_amt();
    let amount = activity.amt();

    if is_credit_card && activity_type == ACTIVITY_TYPE_INTEREST {
        let charge = if !fee.is_zero() { fee } else { amount };
        return -charge;
    }

    match activity_type {
        ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL => {
            let has_quantity = activity
                .quantity
                .is_some_and(|quantity| !quantity.is_zero());
            let has_unit_price = activity
                .unit_price
                .is_some_and(|unit_price| !unit_price.is_zero());
            let use_amount = activity.amount.is_some_and(|amount| !amount.is_zero())
                && (asset_facts.is_bond || !has_quantity || !has_unit_price);
            let gross = if use_amount {
                amount
            } else {
                activity.qty() * activity.price() * asset_facts.unit_multiplier
            };
            if activity_type == ACTIVITY_TYPE_BUY {
                -(gross + fee + tax)
            } else {
                gross - fee - tax
            }
        }
        ACTIVITY_TYPE_DEPOSIT
        | ACTIVITY_TYPE_DIVIDEND
        | ACTIVITY_TYPE_INTEREST
        | ACTIVITY_TYPE_CREDIT
        | ACTIVITY_TYPE_TRANSFER_IN => amount - fee - tax,
        ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => -amount - fee - tax,
        ACTIVITY_TYPE_FEE => {
            let charge = if !fee.is_zero() { fee } else { amount };
            -charge
        }
        ACTIVITY_TYPE_TAX => {
            let charge = if !tax.is_zero() {
                tax
            } else if !fee.is_zero() {
                fee
            } else {
                amount
            };
            -charge
        }
        _ => Decimal::ZERO,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::Utc;
    use rust_decimal_macros::dec;
    use std::sync::Mutex;

    #[derive(Default)]
    struct InMemorySettings {
        values: Mutex<HashMap<String, String>>,
    }

    #[async_trait]
    impl SettingsServiceTrait for InMemorySettings {
        fn get_settings(&self) -> Result<crate::settings::Settings> {
            Ok(crate::settings::Settings::default())
        }

        async fn update_settings(
            &self,
            _new_settings: &crate::settings::SettingsUpdate,
        ) -> Result<()> {
            Ok(())
        }

        fn get_base_currency(&self) -> Result<Option<String>> {
            Ok(None)
        }

        async fn update_base_currency(&self, _new_base_currency: &str) -> Result<()> {
            Ok(())
        }

        fn is_auto_update_check_enabled(&self) -> Result<bool> {
            Ok(true)
        }

        fn is_sync_enabled(&self) -> Result<bool> {
            Ok(false)
        }

        fn get_setting_value(&self, key: &str) -> Result<Option<String>> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }

        async fn set_setting_value(&self, key: &str, value: &str) -> Result<()> {
            self.values
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
    }

    fn activity(activity_type: &str) -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn facts() -> AssetCashFacts {
        AssetCashFacts {
            unit_multiplier: Decimal::ONE,
            is_bond: false,
            multiplier_is_reliable: true,
        }
    }

    fn account_facts() -> AccountCashFacts {
        AccountCashFacts {
            is_credit_card: false,
        }
    }

    #[test]
    fn corrupt_migration_state_is_treated_as_never_run() {
        // A hand-edited or truncated state value must not brick startup; the
        // idempotent rewrite simply re-runs (already-final rows classify as
        // matching and are left alone).
        let settings = InMemorySettings::default();
        settings
            .values
            .lock()
            .unwrap()
            .insert(MIGRATION_STATE_KEY.to_string(), "{not json".to_string());

        let status = get_final_cash_migration_status(&settings)
            .expect("corrupt state must not surface as an error");
        assert_eq!(status, ActivityFinalCashMigrationStatus::default());
    }

    #[test]
    fn legacy_rows_disagreeing_with_their_asset_multiplier_are_flagged() {
        // A row stored at a 10x scale against a 100x asset. The asset owns
        // the multiplier, so derivation gives 100 and cannot confirm the
        // stored 10: keep the user's number and route it to review rather
        // than rescale it. Such a row already priced at 100 before the
        // cutover - the disagreement is a misconfigured asset, not a
        // per-row convention.
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(1));
        buy.unit_price = Some(dec!(1));
        buy.amount = Some(dec!(10));
        buy.metadata = Some(serde_json::json!({ "contract_multiplier": 10 }));
        let mut asset_facts = facts();
        asset_facts.unit_multiplier = dec!(100);

        let decision = classify_legacy_activity_cash(&buy, asset_facts, &account_facts())
            .expect("trade rows are classified");

        assert_eq!(decision.final_amount, Some(dec!(10)));
        assert!(decision.needs_review);
    }

    #[test]
    fn composite_income_derives_in_activity_currency() {
        // The activity declares CAD, so its quantity and price produce a CAD
        // final even when the asset itself is quoted in another currency.
        let mut drip = activity(ACTIVITY_TYPE_DIVIDEND);
        drip.subtype = Some("DRIP".to_string());
        drip.quantity = Some(dec!(10));
        drip.unit_price = Some(dec!(5));
        drip.currency = "CAD".to_string();

        let decision = classify_legacy_activity_cash(&drip, facts(), &account_facts())
            .expect("dividend rows are classified");
        assert_eq!(decision.final_amount, Some(dec!(50)));
        assert!(!decision.needs_review);
    }

    #[tokio::test]
    async fn pending_rebuild_state_is_durable_and_completes_incrementally() {
        let settings = InMemorySettings::default();
        write_migration_state(
            &settings,
            &PersistedMigrationState {
                phase: PHASE_REBUILD_PENDING.to_string(),
                pending_account_ids: vec!["account-1".to_string(), "account-2".to_string()],
            },
        )
        .await
        .unwrap();

        let first = record_final_cash_rebuild_attempt(&settings, &["account-1".to_string()])
            .await
            .unwrap();
        assert_eq!(first.pending_account_ids, vec!["account-2"]);

        let after_restart = get_final_cash_migration_status(&settings).unwrap();
        assert_eq!(after_restart, first);

        let complete = record_final_cash_rebuild_attempt(&settings, &["account-2".to_string()])
            .await
            .unwrap();
        assert!(complete.pending_account_ids.is_empty());
    }

    #[test]
    fn ambiguous_charged_dividend_preserves_amount_and_reports_delta() {
        let mut dividend = activity(ACTIVITY_TYPE_DIVIDEND);
        dividend.amount = Some(dec!(100));
        dividend.tax = Some(dec!(15));

        let decision = classify_legacy_activity_cash(&dividend, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert!(decision.needs_review);
        assert_eq!(decision.previous_cash_effect, dec!(85));
        assert_eq!(decision.final_cash_effect, dec!(100));
    }

    #[test]
    fn dividend_quantity_price_match_does_not_reclassify_final_amount_as_gross() {
        let mut dividend = activity(ACTIVITY_TYPE_DIVIDEND);
        dividend.quantity = Some(dec!(10));
        dividend.unit_price = Some(dec!(10));
        dividend.amount = Some(dec!(100));
        dividend.tax = Some(dec!(15));

        let decision = classify_legacy_activity_cash(&dividend, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert!(decision.needs_review);
        assert_eq!(decision.final_cash_effect, dec!(100));
    }

    #[test]
    fn provable_gross_trade_is_converted_to_final() {
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.amount = Some(dec!(20));
        buy.fee = Some(dec!(1));
        buy.tax = Some(dec!(2));

        let decision = classify_legacy_activity_cash(&buy, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(23)));
        assert!(!decision.needs_review);
        assert_eq!(decision.previous_cash_effect, dec!(-23));
        assert_eq!(decision.final_cash_effect, dec!(-23));
    }

    #[test]
    fn missing_derivable_amount_is_filled_but_runtime_never_derives_it() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(2));
        sell.unit_price = Some(dec!(10));
        sell.fee = Some(dec!(1));
        sell.tax = Some(dec!(2));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(17)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn already_final_trade_is_normalized_without_review() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(2));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(17));
        sell.fee = Some(dec!(1));
        sell.tax = Some(dec!(2));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(17)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn custom_trade_total_is_preserved_for_review() {
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.amount = Some(dec!(30));
        buy.fee = Some(dec!(1));

        let decision = classify_legacy_activity_cash(&buy, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(30)));
        assert!(decision.needs_review);
    }

    #[test]
    fn sell_charges_exceeding_proceeds_becomes_an_outflow() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(10));
        sell.fee = Some(dec!(12));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(2)));
        assert_eq!(decision.final_cash_effect, dec!(-2));
        assert!(!decision.needs_review);
    }

    #[test]
    fn trade_within_currency_tolerance_is_normalized_exactly() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(2));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(16.995));
        sell.fee = Some(dec!(3));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(17)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn trade_one_minor_unit_from_calculation_preserves_supplied_amount_for_review() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(2));
        sell.unit_price = Some(dec!(10));
        sell.amount = Some(dec!(16.99));
        sell.fee = Some(dec!(3));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(16.99)));
        assert!(decision.needs_review);
    }

    #[test]
    fn incomplete_charged_trade_preserves_amount_for_review() {
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.amount = Some(dec!(100));
        sell.fee = Some(dec!(5));

        let decision = classify_legacy_activity_cash(&sell, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert!(decision.needs_review);
    }

    #[test]
    fn cross_currency_trade_derives_final_in_activity_currency() {
        // The derived final lives in activity currency; the account currency
        // only affects booking, so a USD trade in a CAD account still
        // reclassifies its gross amount to final.
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.amount = Some(dec!(20));
        buy.fee = Some(dec!(1));
        let account = AccountCashFacts {
            is_credit_card: false,
        };

        let decision = classify_legacy_activity_cash(&buy, facts(), &account).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(21)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn trade_with_unknown_multiplier_is_not_reclassified() {
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.amount = Some(dec!(20));
        buy.fee = Some(dec!(1));
        let unknown_facts = AssetCashFacts {
            unit_multiplier: Decimal::ONE,
            is_bond: false,
            multiplier_is_reliable: false,
        };

        let decision =
            classify_legacy_activity_cash(&buy, unknown_facts, &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(20)));
        assert!(decision.needs_review);
    }

    #[test]
    fn zero_trade_with_unknown_multiplier_stays_reviewable() {
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.amount = Some(Decimal::ZERO);
        let unknown_facts = AssetCashFacts {
            unit_multiplier: Decimal::ONE,
            is_bond: false,
            multiplier_is_reliable: false,
        };

        let decision =
            classify_legacy_activity_cash(&buy, unknown_facts, &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(Decimal::ZERO));
        assert!(decision.needs_review);
    }

    #[test]
    fn ordinary_cash_never_derives_missing_amount() {
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.quantity = Some(dec!(2));
        deposit.unit_price = Some(dec!(10));

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, None);
        assert!(decision.needs_review);
    }

    #[test]
    fn explicit_zero_ordinary_cash_is_preserved() {
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.amount = Some(Decimal::ZERO);

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(Decimal::ZERO));
        assert!(!decision.needs_review);
    }

    #[test]
    fn charged_deposit_preserves_final_amount_and_reports_delta() {
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.amount = Some(dec!(100));
        deposit.fee = Some(dec!(5));

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert!(decision.needs_review);
        assert_eq!(decision.previous_cash_effect, dec!(95));
        assert_eq!(decision.final_cash_effect, dec!(100));
    }

    #[test]
    fn missing_standalone_charges_copy_their_explicit_component() {
        let mut fee = activity(ACTIVITY_TYPE_FEE);
        fee.fee = Some(dec!(4));
        let fee_decision = classify_legacy_activity_cash(&fee, facts(), &account_facts()).unwrap();

        let mut tax = activity(ACTIVITY_TYPE_TAX);
        tax.tax = Some(Decimal::ZERO);
        tax.fee = Some(dec!(7));
        let tax_decision = classify_legacy_activity_cash(&tax, facts(), &account_facts()).unwrap();

        assert_eq!(fee_decision.final_amount, Some(dec!(4)));
        assert_eq!(tax_decision.final_amount, Some(dec!(7)));
        assert!(!fee_decision.needs_review);
        assert!(!tax_decision.needs_review);
    }

    #[test]
    fn legacy_bond_trade_derives_under_the_shared_default_multiplier() {
        // Bonds default to multiplier 1 pre- and post-cutover (percent-of-par
        // is per-asset opt-in), so a legacy dollar-priced bond derives
        // qty x price - never qty x price x 0.01 - and needs no review.
        let mut buy = activity(ACTIVITY_TYPE_BUY);
        buy.quantity = Some(dec!(10));
        buy.unit_price = Some(dec!(985));
        buy.amount = None;
        let bond_facts = AssetCashFacts {
            unit_multiplier: Decimal::ONE,
            is_bond: true,
            multiplier_is_reliable: true,
        };

        let decision = classify_legacy_activity_cash(&buy, bond_facts, &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(9850)));
        assert!(!decision.needs_review);
        assert_eq!(decision.previous_cash_effect, dec!(-9850));
        assert_eq!(decision.final_cash_effect, dec!(-9850));
    }

    #[test]
    fn zero_amount_charge_derives_from_its_charge_column() {
        // Old imports wrote charges as amount=0 with the value in fee/tax,
        // and the legacy runtime charged the fee/tax column first.
        let mut fee = activity(ACTIVITY_TYPE_FEE);
        fee.amount = Some(Decimal::ZERO);
        fee.fee = Some(dec!(15));
        let decision = classify_legacy_activity_cash(&fee, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(15)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn charge_amount_disagreeing_with_charge_column_is_replaced_and_flagged() {
        // The legacy runtime booked the fee, not the amount column; migrating
        // to the fee preserves the old cash effect, and replacing a different
        // nonzero stored amount surfaces for review.
        let mut fee = activity(ACTIVITY_TYPE_FEE);
        fee.amount = Some(dec!(100));
        fee.fee = Some(dec!(2));
        let decision = classify_legacy_activity_cash(&fee, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(2)));
        assert!(decision.needs_review);
    }

    #[test]
    fn genuinely_zero_charge_stays_zero_without_review() {
        let mut fee = activity(ACTIVITY_TYPE_FEE);
        fee.amount = Some(Decimal::ZERO);
        fee.fee = Some(Decimal::ZERO);
        let decision = classify_legacy_activity_cash(&fee, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(Decimal::ZERO));
        assert!(!decision.needs_review);
    }

    #[test]
    fn missing_drip_amount_uses_only_the_composite_contract() {
        let mut drip = activity(ACTIVITY_TYPE_DIVIDEND);
        drip.subtype = Some("DRIP".to_string());
        drip.quantity = Some(dec!(2));
        drip.unit_price = Some(dec!(50));

        let decision = classify_legacy_activity_cash(&drip, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert_eq!(decision.previous_cash_effect, Decimal::ZERO);
        assert_eq!(decision.final_cash_effect, Decimal::ZERO);
        assert!(!decision.needs_review);
    }

    #[test]
    fn draft_review_row_stays_draft_and_in_review() {
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.amount = Some(dec!(100));
        deposit.status = ActivityStatus::Draft;
        deposit.needs_review = true;

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        // ActivityFinalCashMigrationUpdate carries no status field, so the
        // lifecycle is untouchable by construction.
        assert!(decision.needs_review);
    }

    #[test]
    fn legacy_draft_is_backfilled_into_the_review_queue() {
        // The pre-cutover review queue was `status = DRAFT`. Without the
        // backfill this row would be excluded from calculations yet invisible
        // to the needs-review filter.
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.amount = Some(dec!(100));
        deposit.status = ActivityStatus::Draft;

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        assert!(decision.needs_review);
    }

    #[test]
    fn posted_lifecycle_does_not_create_review_state() {
        let mut deposit = activity(ACTIVITY_TYPE_DEPOSIT);
        deposit.amount = Some(dec!(100));

        let decision = classify_legacy_activity_cash(&deposit, facts(), &account_facts()).unwrap();

        assert!(!decision.needs_review);
    }

    #[test]
    fn charged_composite_is_flagged_for_review() {
        let mut drip = activity(ACTIVITY_TYPE_DIVIDEND);
        drip.subtype = Some("DRIP".to_string());
        drip.asset_id = Some("asset-1".to_string());
        drip.quantity = Some(dec!(10));
        drip.unit_price = Some(dec!(10));
        drip.amount = Some(dec!(100));
        drip.tax = Some(dec!(15));

        let decision = classify_legacy_activity_cash(&drip, facts(), &account_facts()).unwrap();

        assert_eq!(decision.final_amount, Some(dec!(100)));
        assert!(decision.needs_review);
        assert_ne!(decision.previous_cash_effect, decision.final_cash_effect);
    }

    #[test]
    fn unclassified_legacy_draft_is_backfilled_verbatim() {
        let mut split = activity(ACTIVITY_TYPE_SPLIT);
        split.status = ActivityStatus::Draft;
        split.amount = Some(dec!(2));

        let update = unclassified_draft_backfill(&split).expect("draft split joins the queue");
        assert_eq!(update.amount, Some(dec!(2)));
        assert!(update.needs_review);

        split.needs_review = true;
        assert!(unclassified_draft_backfill(&split).is_none());
        split.needs_review = false;
        split.status = ActivityStatus::Posted;
        assert!(unclassified_draft_backfill(&split).is_none());
    }

    #[test]
    fn security_transfer_is_outside_the_migration() {
        let mut transfer = activity(ACTIVITY_TYPE_TRANSFER_IN);
        transfer.asset_id = Some("SEC:AAPL:XNAS".to_string());
        transfer.quantity = Some(dec!(10));
        transfer.amount = Some(dec!(250));

        assert_eq!(
            classify_legacy_activity_cash(&transfer, facts(), &account_facts()),
            None
        );
    }
    #[test]
    fn real_asset_facts_flow_through_classification() {
        use crate::assets::{Asset, InstrumentType};

        // Bare bond: multiplier 1 end to end (never 0.01) - a legacy
        // dollar-priced bond derives qty x price and is not flagged.
        let bond = Asset {
            instrument_type: Some(InstrumentType::Bond),
            quote_ccy: "USD".to_string(),
            ..Default::default()
        };
        let mut bond_buy = activity(ACTIVITY_TYPE_BUY);
        bond_buy.quantity = Some(dec!(10));
        bond_buy.unit_price = Some(dec!(985));
        let decision = classify_legacy_activity_cash(
            &bond_buy,
            asset_cash_facts_from_asset(bond),
            &account_facts(),
        )
        .unwrap();
        assert_eq!(decision.final_amount, Some(dec!(9850)));
        assert!(!decision.needs_review);

        // Standard option: 100 from the instrument default.
        let option = Asset {
            instrument_type: Some(InstrumentType::Option),
            quote_ccy: "USD".to_string(),
            ..Default::default()
        };
        let mut option_buy = activity(ACTIVITY_TYPE_BUY);
        option_buy.quantity = Some(dec!(2));
        option_buy.unit_price = Some(dec!(5.5));
        let decision = classify_legacy_activity_cash(
            &option_buy,
            asset_cash_facts_from_asset(option),
            &account_facts(),
        )
        .unwrap();
        assert_eq!(decision.final_amount, Some(dec!(1100.0)));
        assert!(!decision.needs_review);

        // The real asset's quote currency is for valuation only. The activity
        // declares CAD, so its price and derived final are CAD.
        let usd_equity = Asset {
            instrument_type: Some(InstrumentType::Equity),
            quote_ccy: "USD".to_string(),
            ..Default::default()
        };
        let mut cad_buy = activity(ACTIVITY_TYPE_BUY);
        cad_buy.quantity = Some(dec!(10));
        cad_buy.unit_price = Some(dec!(50));
        cad_buy.currency = "CAD".to_string();
        let decision = classify_legacy_activity_cash(
            &cad_buy,
            asset_cash_facts_from_asset(usd_equity),
            &account_facts(),
        )
        .unwrap();
        assert_eq!(decision.final_amount, Some(dec!(500)));
        assert!(!decision.needs_review);
    }

    #[test]
    fn quote_currency_does_not_change_legacy_trade_classification() {
        use crate::assets::{Asset, InstrumentType};

        let usd_asset_facts = || {
            asset_cash_facts_from_asset(Asset {
                instrument_type: Some(InstrumentType::Equity),
                quote_ccy: "USD".to_string(),
                ..Default::default()
            })
        };
        let mut sell = activity(ACTIVITY_TYPE_SELL);
        sell.quantity = Some(dec!(2));
        sell.unit_price = Some(dec!(10));
        sell.fee = Some(dec!(1));
        sell.currency = "CAD".to_string();

        let missing =
            classify_legacy_activity_cash(&sell, usd_asset_facts(), &account_facts()).unwrap();
        assert_eq!(missing.final_amount, Some(dec!(19)));
        assert!(!missing.needs_review);

        sell.amount = Some(Decimal::ZERO);
        let zero =
            classify_legacy_activity_cash(&sell, usd_asset_facts(), &account_facts()).unwrap();
        assert_eq!(zero.final_amount, Some(dec!(19)));
        assert!(!zero.needs_review);

        sell.amount = Some(dec!(20));
        let gross =
            classify_legacy_activity_cash(&sell, usd_asset_facts(), &account_facts()).unwrap();
        assert_eq!(gross.final_amount, Some(dec!(19)));
        assert!(!gross.needs_review);

        sell.amount = Some(dec!(19));
        let final_total =
            classify_legacy_activity_cash(&sell, usd_asset_facts(), &account_facts()).unwrap();
        assert_eq!(final_total.final_amount, Some(dec!(19)));
        assert!(!final_total.needs_review);

        sell.amount = Some(dec!(25));
        let contradictory =
            classify_legacy_activity_cash(&sell, usd_asset_facts(), &account_facts()).unwrap();
        assert_eq!(contradictory.final_amount, Some(dec!(25)));
        assert!(contradictory.needs_review);
    }
}
