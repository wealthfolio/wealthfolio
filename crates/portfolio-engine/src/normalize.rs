//! Stage 1: strings → types, once. Bad data becomes diagnostics here; an
//! unusable request becomes an error. Applies the total order (local date,
//! timestamp, id), resolves transfer pairs by `source_group_id`, and keeps
//! only POSTED activities.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;

use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::error::EngineError;
use crate::model::*;

#[derive(Debug, Clone, PartialEq)]
pub struct Normalized {
    pub facts: CanonicalFacts,
    pub diagnostics: Vec<Diagnostic>,
}

/// Quantity tolerance for pairing the two legs of a security transfer.
const TRANSFER_PAIR_TOLERANCE: Decimal = Decimal::from_parts(1, 0, 0, false, 6);

pub fn normalize(raw: RawFacts) -> Result<Normalized, EngineError> {
    raw.policy.validate()?;
    let policy = raw.policy;
    let mut diagnostics = Vec::new();

    let mut accounts = BTreeMap::new();
    for account in raw.accounts {
        let id = AccountId::new(account.id.clone());
        let Some(currency) = Currency::parse(&account.currency) else {
            return Err(EngineError::InvalidPolicy(format!(
                "account {} has no currency",
                account.id
            )));
        };
        let facts = AccountFacts {
            id: id.clone(),
            currency,
            kind: account_kind(&account.account_type),
            tracking: tracking_mode(&account.tracking_mode),
            archived: account.is_archived,
        };
        if accounts.insert(id, facts).is_some() {
            return Err(EngineError::DuplicateAccountId(account.id));
        }
    }

    let mut assets = BTreeMap::new();
    for asset in raw.assets {
        let id = AssetId::new(asset.id.clone());
        let facts = asset_facts(&id, &asset, &mut diagnostics);
        if assets.insert(id, facts).is_some() {
            return Err(EngineError::DuplicateAssetId(asset.id));
        }
    }

    let mut seen_ids = HashSet::new();
    let mut activities = Vec::new();
    for activity in raw.activities {
        if !seen_ids.insert(activity.id.clone()) {
            return Err(EngineError::DuplicateActivityId(activity.id));
        }
        if !is_posted(&activity.status) {
            continue;
        }
        let account_id = AccountId::new(activity.account_id.clone());
        let Some(account) = accounts.get(&account_id) else {
            diagnostics.push(Diagnostic::error(
                DiagnosticCode::UnknownAccount,
                activity.id.clone(),
                format!(
                    "activity references unknown account {}",
                    activity.account_id
                ),
            ));
            continue;
        };
        activities.push(canonical_activity(
            activity,
            account,
            &policy,
            &mut diagnostics,
        ));
    }
    // Same-instant activities (date-only imports) fold in insertion order,
    // as the legacy pipeline's scan order did; the id is the last resort.
    activities.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.timestamp.cmp(&b.timestamp))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let transfer_pairs = resolve_transfer_pairs(&activities, &mut diagnostics);

    let mut quotes = Vec::with_capacity(raw.quotes.len());
    for quote in raw.quotes {
        let asset = AssetId::new(quote.asset_id.clone());
        let currency = Currency::parse(&quote.currency)
            .or_else(|| assets.get(&asset).and_then(|a| a.quote_currency.clone()));
        let Some(currency) = currency else {
            diagnostics.push(Diagnostic::warning(
                DiagnosticCode::MissingCurrency,
                format!("{}@{}", quote.asset_id, quote.day),
                "quote without a currency and no asset quote currency; ignored",
            ));
            continue;
        };
        // A zero or negative close is a broken row, not a price: using it
        // would value the position at nothing while reporting Complete.
        if quote.close <= Decimal::ZERO {
            diagnostics.push(Diagnostic::warning(
                DiagnosticCode::InvalidQuote,
                format!("{}@{}", quote.asset_id, quote.day),
                format!("quote close {} is not positive; ignored", quote.close),
            ));
            continue;
        }
        quotes.push(QuoteObservation {
            asset,
            day: quote.day,
            close: quote.close,
            currency,
            source: quote.source,
        });
    }
    // One observation per asset and day. Several sources may quote the same
    // day (the store is unique on asset, day and source); the winner is
    // decided by source rank, then source name, never by input order.
    quotes.sort_by(|a, b| {
        a.asset
            .cmp(&b.asset)
            .then_with(|| a.day.cmp(&b.day))
            .then_with(|| source_rank(&a.source).cmp(&source_rank(&b.source)))
            .then_with(|| a.source.cmp(&b.source))
    });
    quotes.dedup_by(|later, earlier| later.asset == earlier.asset && later.day == earlier.day);

    let mut fx_rates = Vec::with_capacity(raw.fx_rates.len());
    for rate in raw.fx_rates {
        match (Currency::parse(&rate.from), Currency::parse(&rate.to)) {
            // A zero or negative rate would convert every bucket to nothing
            // (or its inverse to infinity) while reporting Complete.
            (Some(from), Some(to)) if from != to && rate.rate <= Decimal::ZERO => {
                diagnostics.push(Diagnostic::warning(
                    DiagnosticCode::InvalidFxRate,
                    format!("fx {}/{}@{}", rate.from, rate.to, rate.day),
                    format!("FX rate {} is not positive; ignored", rate.rate),
                ));
            }
            (Some(from), Some(to)) if from != to => fx_rates.push(FxObservation {
                from,
                to,
                day: rate.day,
                rate: rate.rate,
            }),
            _ => diagnostics.push(Diagnostic::warning(
                DiagnosticCode::MissingCurrency,
                format!("fx {}/{}@{}", rate.from, rate.to, rate.day),
                "FX observation with an empty or identical currency pair; ignored",
            )),
        }
    }
    fx_rates.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then_with(|| a.to.cmp(&b.to))
            .then_with(|| a.day.cmp(&b.day))
    });

    let mut observed_snapshots = Vec::new();
    for snapshot in raw.observed_snapshots {
        let account = AccountId::new(snapshot.account_id.clone());
        if !accounts.contains_key(&account) {
            diagnostics.push(Diagnostic::error(
                DiagnosticCode::UnknownAccount,
                format!("observed@{}", snapshot.date),
                format!(
                    "observed snapshot references unknown account {}",
                    snapshot.account_id
                ),
            ));
            continue;
        }
        let positions = snapshot
            .positions
            .into_iter()
            .map(|position| {
                (
                    AssetId::new(position.asset_id),
                    ObservedPosition {
                        currency: Currency::parse(&position.currency),
                        quantity: position.quantity,
                        average_cost: position.average_cost,
                        total_cost_basis: position.total_cost_basis,
                        cost_basis_account: position.cost_basis_account,
                        cost_basis_base: position.cost_basis_base,
                    },
                )
            })
            .collect();
        let cash = snapshot
            .cash
            .into_iter()
            .filter_map(|(currency, amount)| Currency::parse(&currency).map(|c| (c, amount)))
            .collect();
        observed_snapshots.push(ObservedSnapshot {
            account,
            date: snapshot.date,
            positions,
            cash,
            cost_basis: snapshot.cost_basis,
            net_contribution: snapshot.net_contribution,
            net_contribution_base: snapshot.net_contribution_base,
            cash_total_account_currency: snapshot.cash_total_account_currency,
            cash_total_base_currency: snapshot.cash_total_base_currency,
        });
    }
    observed_snapshots.sort_by(|a, b| a.account.cmp(&b.account).then_with(|| a.date.cmp(&b.date)));

    Ok(Normalized {
        facts: CanonicalFacts {
            policy,
            accounts,
            assets,
            activities,
            transfer_pairs,
            quotes,
            fx_rates,
            observed_snapshots,
        },
        diagnostics,
    })
}

fn is_posted(status: &str) -> bool {
    status.trim().eq_ignore_ascii_case("POSTED")
}

fn account_kind(raw: &str) -> AccountKind {
    match raw.trim().to_ascii_uppercase().as_str() {
        "SECURITIES" => AccountKind::Securities,
        "CASH" => AccountKind::Cash,
        "CREDIT_CARD" => AccountKind::CreditCard,
        "CRYPTOCURRENCY" => AccountKind::Cryptocurrency,
        _ => AccountKind::Other,
    }
}

fn tracking_mode(raw: &str) -> TrackingMode {
    match raw.trim().to_ascii_uppercase().as_str() {
        "HOLDINGS" => TrackingMode::Holdings,
        "TRANSACTIONS" => TrackingMode::Transactions,
        _ => TrackingMode::NotSet,
    }
}

/// Same-day quote precedence: a manual price is an explicit override, a
/// provider price is the reference, a broker trade price is the fallback.
fn source_rank(source: &str) -> u8 {
    match source.trim().to_ascii_uppercase().as_str() {
        "MANUAL" => 0,
        "BROKER" => 2,
        _ => 1,
    }
}

fn asset_facts(id: &AssetId, asset: &RawAsset, diagnostics: &mut Vec<Diagnostic>) -> AssetFacts {
    let kind = asset.kind.trim().to_ascii_uppercase();
    let instrument = asset
        .instrument_type
        .as_deref()
        .map(|s| s.trim().to_ascii_uppercase());
    let alternative = matches!(
        kind.as_str(),
        "PROPERTY" | "VEHICLE" | "COLLECTIBLE" | "PRECIOUS_METAL"
    );
    let is_option = instrument.as_deref() == Some("OPTION");
    let equity_like =
        kind == "INVESTMENT" && matches!(instrument.as_deref(), None | Some("EQUITY"));
    let contract_multiplier = asset
        .contract_multiplier
        .filter(|m| *m > Decimal::ZERO)
        .unwrap_or(if is_option {
            Decimal::from(100)
        } else {
            Decimal::ONE
        });
    let quote_currency = Currency::parse(&asset.quote_currency);
    if quote_currency.is_none() {
        diagnostics.push(Diagnostic::warning(
            DiagnosticCode::MissingCurrency,
            id.as_str().to_string(),
            "asset has no quote currency; its positions take the currency of the activity that opens them and its quotes need an explicit currency",
        ));
    }
    AssetFacts {
        id: id.clone(),
        quote_currency,
        alternative,
        contract_multiplier,
        allows_negative_lots: is_option || equity_like,
        requires_explicit_short_intent: equity_like,
    }
}

fn canonical_activity(
    raw: RawActivity,
    account: &AccountFacts,
    policy: &Policy,
    diagnostics: &mut Vec<Diagnostic>,
) -> Activity {
    let id = ActivityId::new(raw.id.clone());
    let effective_type = raw
        .activity_type_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(raw.activity_type.as_str());
    let kind = ActivityKind::parse(effective_type).unwrap_or_else(|| {
        diagnostics.push(Diagnostic::error(
            DiagnosticCode::UnknownActivityType,
            raw.id.clone(),
            format!("unknown activity type {effective_type:?}; treated as UNKNOWN"),
        ));
        ActivityKind::Unknown
    });
    let subtype = canonical_subtype(kind, raw.subtype.as_deref(), &raw.id, diagnostics);
    let currency = Currency::parse(&raw.currency).unwrap_or_else(|| {
        diagnostics.push(Diagnostic::warning(
            DiagnosticCode::MissingCurrency,
            raw.id.clone(),
            format!(
                "activity has no currency; the account currency {} is assumed",
                account.currency
            ),
        ));
        account.currency.clone()
    });
    let asset = raw
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| !(kind.is_transfer() && is_cash_symbol(s)))
        .map(AssetId::new);
    let is_security_transfer = kind.is_transfer() && asset.is_some();
    let fx_rate = raw.fx_rate.filter(|rate| *rate > Decimal::ZERO);
    let abs = |value: Option<Decimal>| value.map(|value| value.abs()).unwrap_or(Decimal::ZERO);

    Activity {
        id,
        account: account.id.clone(),
        asset,
        kind,
        subtype,
        date: local_date(raw.timestamp, policy),
        timestamp: raw.timestamp,
        created_at: raw.created_at,
        quantity: abs(raw.quantity),
        unit_price: abs(raw.unit_price),
        amount: raw.amount.map(|value| value.abs()),
        fee: abs(raw.fee),
        tax: abs(raw.tax),
        currency,
        fx_rate,
        source_group_id: raw
            .source_group_id
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty()),
        external_transfer: raw.external_transfer,
        is_security_transfer,
        source_system: raw
            .source_system
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        is_user_modified: raw.is_user_modified,
        updated_at: raw.updated_at,
    }
}

/// UTC instant → user-local business date, exactly once (architecture §4.7).
pub fn local_date(instant: DateTime<Utc>, policy: &Policy) -> NaiveDate {
    instant.with_timezone(&policy.timezone).date_naive()
}

/// `$CASH-USD`, `CASH_USD`, `CASH:USD` placeholders (case-insensitive).
pub fn is_cash_symbol(symbol: &str) -> bool {
    let upper = symbol.trim().to_ascii_uppercase();
    let stripped = upper.strip_prefix('$').unwrap_or(&upper);
    let Some(rest) = stripped.strip_prefix("CASH") else {
        return false;
    };
    rest.strip_prefix('-')
        .or_else(|| rest.strip_prefix('_'))
        .or_else(|| rest.strip_prefix(':'))
        .is_some_and(|currency| {
            currency.len() == 3 && currency.chars().all(|c| c.is_ascii_alphabetic())
        })
}

/// Legacy `canonicalize_subtype_for_activity`: trade intent aliases first,
/// then the shared vocabulary; anything else is reported and dropped.
fn canonical_subtype(
    kind: ActivityKind,
    raw: Option<&str>,
    activity_id: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Subtype> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let normalized: String = raw
        .chars()
        .map(|c| match c {
            ' ' | '-' => '_',
            _ => c.to_ascii_uppercase(),
        })
        .collect();
    let intent = match kind {
        ActivityKind::Buy => match normalized.as_str() {
            "BTO" | "BUY_TO_OPEN" | "BUY_OPEN" | "OPEN_BUY" => Some(Subtype::PositionOpen),
            "BTC" | "BUY_TO_CLOSE" | "BUY_CLOSE" | "CLOSE_BUY" | "BUY_TO_COVER" | "BUY_COVER"
            | "COVER_SHORT" => Some(Subtype::PositionClose),
            _ => None,
        },
        ActivityKind::Sell => match normalized.as_str() {
            "STO" | "SELL_TO_OPEN" | "SELL_OPEN" | "OPEN_SELL" | "SELL_SHORT" | "SHORT_SELL"
            | "SELL_SHORT_TO_OPEN" => Some(Subtype::PositionOpen),
            "STC" | "SELL_TO_CLOSE" | "SELL_CLOSE" | "CLOSE_SELL" => Some(Subtype::PositionClose),
            _ => None,
        },
        _ => None,
    };
    if intent.is_some() {
        return intent;
    }
    let shared = match normalized.as_str() {
        "DRIP" => Some(Subtype::Drip),
        "DIVIDEND_IN_KIND" => Some(Subtype::DividendInKind),
        "STAKING_REWARD" => Some(Subtype::StakingReward),
        "BONUS" => Some(Subtype::Bonus),
        "REBATE" => Some(Subtype::Rebate),
        "REFUND" => Some(Subtype::Refund),
        "REIMBURSEMENT" => Some(Subtype::Reimbursement),
        "OPTION_EXPIRY" => Some(Subtype::OptionExpiry),
        "POSITION_OPEN" => Some(Subtype::PositionOpen),
        "POSITION_CLOSE" => Some(Subtype::PositionClose),
        _ => None,
    };
    if shared.is_none() {
        diagnostics.push(Diagnostic::info(
            DiagnosticCode::UnknownSubtype,
            activity_id,
            format!("subtype {raw:?} is not canonical; treated as none"),
        ));
    }
    shared
}

/// Pairs transfer legs by `source_group_id` (legacy `TransferPairResolution`):
/// exactly two legs, one in and one out; same-account legs only as a cash FX
/// conversion between two currencies; security legs on the same asset with
/// quantities within tolerance.
fn resolve_transfer_pairs(
    activities: &[Activity],
    diagnostics: &mut Vec<Diagnostic>,
) -> TransferPairs {
    let mut groups: BTreeMap<&str, Vec<&Activity>> = BTreeMap::new();
    for activity in activities.iter().filter(|a| a.kind.is_transfer()) {
        if let Some(group) = activity.source_group_id.as_deref() {
            groups.entry(group).or_default().push(activity);
        }
    }

    let mut pairs = TransferPairs::default();
    for (group, legs) in groups {
        match build_pair(group, &legs) {
            Ok(pair) => pairs.insert(pair),
            Err(reason) => {
                for leg in legs {
                    diagnostics.push(Diagnostic::warning(
                        DiagnosticCode::InvalidTransferGroup,
                        leg.id.as_str(),
                        format!("transfer group {group:?} is invalid ({reason}); leg treated as unpaired"),
                    ));
                }
            }
        }
    }
    pairs
}

fn build_pair(group: &str, legs: &[&Activity]) -> Result<TransferPair, String> {
    if legs.len() != 2 {
        return Err(format!("expected exactly two legs, found {}", legs.len()));
    }
    let ins: Vec<&Activity> = legs
        .iter()
        .copied()
        .filter(|a| a.kind == ActivityKind::TransferIn)
        .collect();
    let outs: Vec<&Activity> = legs
        .iter()
        .copied()
        .filter(|a| a.kind == ActivityKind::TransferOut)
        .collect();
    let (&transfer_in, &transfer_out) = match (ins.as_slice(), outs.as_slice()) {
        ([i], [o]) => (i, o),
        _ => {
            return Err(format!(
                "expected one TRANSFER_IN and one TRANSFER_OUT, found {} in and {} out",
                ins.len(),
                outs.len()
            ))
        }
    };

    let is_cash = |a: &Activity| !a.is_security_transfer;
    if transfer_in.account == transfer_out.account {
        let cash_fx_conversion = is_cash(transfer_in)
            && is_cash(transfer_out)
            && transfer_in.amount.is_some_and(|a| !a.is_zero())
            && transfer_out.amount.is_some_and(|a| !a.is_zero())
            && !transfer_in
                .currency
                .as_str()
                .eq_ignore_ascii_case(transfer_out.currency.as_str());
        if !cash_fx_conversion {
            return Err(
                "same-account legs must be a cash FX conversion between two currencies".into(),
            );
        }
    }

    let asset_key = |a: &Activity| a.asset.as_ref().map(|id| id.as_str().to_ascii_uppercase());
    let (in_asset, out_asset) = (asset_key(transfer_in), asset_key(transfer_out));
    let security = in_asset.is_some() || out_asset.is_some();
    if security {
        if in_asset != out_asset {
            return Err("security transfer legs use different assets".into());
        }
        let (in_qty, out_qty) = (transfer_in.quantity, transfer_out.quantity);
        if in_qty.is_zero() || out_qty.is_zero() {
            return Err("security transfer legs must both include a quantity".into());
        }
        if (in_qty - out_qty).abs() > TRANSFER_PAIR_TOLERANCE {
            return Err("security transfer legs use different quantities".into());
        }
    }

    Ok(TransferPair {
        group_id: group.to_string(),
        transfer_out: transfer_out.id.clone(),
        transfer_in: transfer_in.id.clone(),
        out_account: transfer_out.account.clone(),
        in_account: transfer_in.account.clone(),
        security,
    })
}

#[allow(dead_code)]
fn _lookup_helpers(_: &HashMap<String, String>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;

    fn policy(tz: chrono_tz::Tz) -> Policy {
        Policy::new(
            Currency::parse("USD").unwrap(),
            tz,
            NaiveDate::from_ymd_opt(2025, 3, 5).unwrap(),
        )
    }

    fn account(id: &str, currency: &str) -> RawAccount {
        RawAccount {
            id: id.into(),
            currency: currency.into(),
            account_type: "SECURITIES".into(),
            tracking_mode: "TRANSACTIONS".into(),
            is_archived: false,
        }
    }

    #[test]
    fn same_instant_activities_fold_by_created_at_then_id() {
        let mut later_id_created_first =
            activity("z-first", "a1", "DEPOSIT", "2025-01-03T00:00:00Z");
        later_id_created_first.created_at = "2025-01-03T15:00:00Z".parse().unwrap();
        let mut earlier_id_created_second =
            activity("a-second", "a1", "WITHDRAWAL", "2025-01-03T00:00:00Z");
        earlier_id_created_second.created_at = "2025-01-03T15:00:01Z".parse().unwrap();
        let raw = facts(
            vec![earlier_id_created_second, later_id_created_first],
            chrono_tz::UTC,
        );
        let ids: Vec<String> = normalize(raw)
            .unwrap()
            .facts
            .activities
            .iter()
            .map(|a| a.id.as_str().to_string())
            .collect();
        assert_eq!(ids, vec!["z-first", "a-second"]);
    }

    fn activity(id: &str, account: &str, kind: &str, ts: &str) -> RawActivity {
        RawActivity {
            id: id.into(),
            account_id: account.into(),
            asset_id: None,
            activity_type: kind.into(),
            activity_type_override: None,
            subtype: None,
            status: "POSTED".into(),
            timestamp: DateTime::parse_from_rfc3339(ts)
                .unwrap()
                .with_timezone(&Utc),
            quantity: None,
            unit_price: None,
            amount: Some(dec!(100)),
            fee: None,
            tax: None,
            currency: "USD".into(),
            fx_rate: None,
            source_group_id: None,
            external_transfer: None,
            source_system: None,
            is_user_modified: false,
            created_at: Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap(),
        }
    }

    fn facts(activities: Vec<RawActivity>, tz: chrono_tz::Tz) -> RawFacts {
        RawFacts {
            policy: policy(tz),
            accounts: vec![account("a1", "USD"), account("a2", "CAD")],
            assets: vec![],
            activities,
            quotes: vec![],
            fx_rates: vec![],
            observed_snapshots: vec![],
        }
    }

    #[test]
    fn orders_by_local_date_then_timestamp_then_id() {
        let mut late = activity("b", "a1", "DEPOSIT", "2025-01-02T03:30:00Z");
        late.id = "b".into();
        let early = activity("a", "a1", "DEPOSIT", "2025-01-02T23:30:00Z");
        let facts = facts(vec![early, late], chrono_tz::America::Toronto);
        let normalized = normalize(facts).unwrap();
        let dates: Vec<_> = normalized
            .facts
            .activities
            .iter()
            .map(|a| (a.id.as_str().to_string(), a.date))
            .collect();
        assert_eq!(dates[0].1, NaiveDate::from_ymd_opt(2025, 1, 1).unwrap());
        assert_eq!(dates[0].0, "b");
        assert_eq!(dates[1].1, NaiveDate::from_ymd_opt(2025, 1, 2).unwrap());
    }

    #[test]
    fn rejects_duplicate_ids_and_drops_non_posted() {
        let mut draft = activity("d", "a1", "DEPOSIT", "2025-01-03T10:00:00Z");
        draft.status = "DRAFT".into();
        let normalized = normalize(facts(
            vec![
                activity("x", "a1", "DEPOSIT", "2025-01-02T10:00:00Z"),
                draft,
            ],
            chrono_tz::UTC,
        ))
        .unwrap();
        assert_eq!(normalized.facts.activities.len(), 1);

        let dup = normalize(facts(
            vec![
                activity("x", "a1", "DEPOSIT", "2025-01-02T10:00:00Z"),
                activity("x", "a1", "DEPOSIT", "2025-01-03T10:00:00Z"),
            ],
            chrono_tz::UTC,
        ));
        assert_eq!(
            dup.unwrap_err(),
            EngineError::DuplicateActivityId("x".into())
        );
    }

    #[test]
    fn empty_currency_falls_back_to_account_currency_with_diagnostic() {
        let mut raw = activity("x", "a2", "DEPOSIT", "2025-01-02T10:00:00Z");
        raw.currency = "".into();
        let normalized = normalize(facts(vec![raw], chrono_tz::UTC)).unwrap();
        assert_eq!(normalized.facts.activities[0].currency.as_str(), "CAD");
        assert_eq!(
            normalized.diagnostics[0].code,
            DiagnosticCode::MissingCurrency
        );
    }

    #[test]
    fn pairs_transfers_by_group_and_reports_invalid_groups() {
        let mut out = activity("out", "a1", "TRANSFER_OUT", "2025-01-02T10:00:00Z");
        out.source_group_id = Some("g1".into());
        let mut into = activity("in", "a2", "TRANSFER_IN", "2025-01-02T11:00:00Z");
        into.source_group_id = Some("g1".into());
        let mut lonely = activity("lonely", "a1", "TRANSFER_OUT", "2025-01-03T10:00:00Z");
        lonely.source_group_id = Some("g2".into());
        let normalized = normalize(facts(vec![out, into, lonely], chrono_tz::UTC)).unwrap();
        let pair = normalized
            .facts
            .transfer_pairs
            .pair_for(&ActivityId::from("in"))
            .unwrap();
        assert_eq!(
            pair.counterparty(&ActivityId::from("in")).unwrap().as_str(),
            "a1"
        );
        assert!(normalized
            .facts
            .transfer_pairs
            .pair_for(&ActivityId::from("lonely"))
            .is_none());
        assert!(normalized
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::InvalidTransferGroup));
    }

    #[test]
    fn trade_intent_aliases_canonicalize() {
        let mut sell = activity("s", "a1", "SELL", "2025-01-02T10:00:00Z");
        sell.subtype = Some("sell short".into());
        let mut buy = activity("b", "a1", "BUY", "2025-01-02T11:00:00Z");
        buy.subtype = Some("BTC".into());
        let normalized = normalize(facts(vec![sell, buy], chrono_tz::UTC)).unwrap();
        assert_eq!(
            normalized.facts.activities[0].subtype,
            Some(Subtype::PositionOpen)
        );
        assert_eq!(
            normalized.facts.activities[1].subtype,
            Some(Subtype::PositionClose)
        );
    }

    #[test]
    fn cash_placeholder_transfers_are_cash() {
        let mut out = activity("out", "a1", "TRANSFER_OUT", "2025-01-02T10:00:00Z");
        out.asset_id = Some("$CASH-USD".into());
        let normalized = normalize(facts(vec![out], chrono_tz::UTC)).unwrap();
        assert!(normalized.facts.activities[0].asset.is_none());
        assert!(!normalized.facts.activities[0].is_security_transfer);
    }
}
