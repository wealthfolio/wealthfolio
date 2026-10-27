//! Stage 2: the single economics authority. Total over the 14-type ×
//! 12-subtype vocabulary: every posted activity maps to one or two events
//! (composites expand) or to a diagnostic. Cash resolution follows the
//! final-cash contract: the stored `amount` is authoritative, never derived.

use rust_decimal::Decimal;

use crate::arith;
use crate::diagnostics::{Diagnostic, DiagnosticCode};
use crate::model::*;

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledLedger {
    pub events: Vec<EconomicEvent>,
    pub diagnostics: Vec<Diagnostic>,
}

impl CompiledLedger {
    /// The activity an event derives from (`None` for an unknown event id):
    /// a composite leg (`{activity}:buy`) maps back to its stored row.
    pub fn source_of(&self, event: &EventId) -> Option<&ActivityId> {
        self.events
            .iter()
            .find(|e| &e.id == event)
            .map(|e| &e.source)
    }
}

pub fn compile(facts: &CanonicalFacts) -> CompiledLedger {
    let mut events = Vec::with_capacity(facts.activities.len());
    let mut diagnostics = Vec::new();
    let by_id: std::collections::HashMap<&ActivityId, &Activity> =
        if facts.conversions.iter().next().is_some() {
            facts.activities.iter().map(|a| (&a.id, a)).collect()
        } else {
            Default::default()
        };
    let mut converted: std::collections::HashSet<&str> = Default::default();
    for activity in &facts.activities {
        // `normalize` only admits activities of known accounts; facts built
        // any other way still compile without a panic.
        let Some(account) = facts.accounts.get(&activity.account) else {
            diagnostics.push(Diagnostic::error(
                DiagnosticCode::UnknownAccount,
                activity.id.as_str(),
                format!("activity references unknown account {}", activity.account),
            ));
            continue;
        };
        // A conversion row `normalize` could not pair changes nothing (rules
        // R7.5): its event only carries why, and the projection rejects it,
        // as it rejects any activity, so its account still folds.
        if let Some(reason) = facts.conversions.rejection(&activity.id) {
            let mut event = invalid_conversion_event(activity, reason);
            event.sequence = events.len() as u32;
            diagnostics.extend(event.diagnostics.iter().cloned());
            events.push(event);
            continue;
        }
        // A conversion's two rows fold as one event, at the first of them.
        if let Some(pair) = facts.conversions.pair_for(&activity.id) {
            if converted.insert(pair.group_id.as_str()) {
                if let (Some(out_leg), Some(in_leg)) =
                    (by_id.get(&pair.out_activity), by_id.get(&pair.in_activity))
                {
                    let mut event = conversion_event(out_leg, in_leg, activity);
                    event.sequence = events.len() as u32;
                    events.push(event);
                }
            }
            continue;
        }
        for leg in expand(activity) {
            let mut event = compile_leg(&leg, account, facts);
            event.sequence = events.len() as u32;
            diagnostics.extend(event.diagnostics.iter().cloned());
            events.push(event);
        }
    }
    CompiledLedger {
        events,
        diagnostics,
    }
}

/// A conversion's event (rules R7.5): the `CONVERSION_OUT` row's id and
/// data, at the place of its pair's first row. No cash, charges,
/// contribution, flow or attribution.
fn conversion_event(out_leg: &Activity, in_leg: &Activity, first: &Activity) -> EconomicEvent {
    let asset = |leg: &Activity| leg.asset.clone().unwrap_or_else(|| AssetId::new(""));
    EconomicEvent {
        id: EventId::new(out_leg.id.as_str()),
        source: out_leg.id.clone(),
        kind: ActivityKind::Adjustment,
        account: out_leg.account.clone(),
        date: out_leg.date,
        timestamp: first.timestamp,
        sequence: 0,
        currency: out_leg.currency.clone(),
        fx_rate: None,
        cash: None,
        charges: Charges::default(),
        action: Action::Conversion {
            from_asset: asset(out_leg),
            from_quantity: out_leg.quantity,
            to_asset: asset(in_leg),
            to_quantity: in_leg.quantity,
            arriving: in_leg.id.clone(),
        },
        contribution: Contribution::None,
        flow: Flow::NONE,
        attribution: Attributed::default(),
        diagnostics: Vec::new(),
    }
}

/// A conversion row that does not form a pair: no cash, action or flow, and
/// an `InvalidConversion` diagnostic the projection rejects it with.
fn invalid_conversion_event(activity: &Activity, reason: &str) -> EconomicEvent {
    EconomicEvent {
        id: EventId::new(activity.id.as_str()),
        source: activity.id.clone(),
        kind: activity.kind,
        account: activity.account.clone(),
        date: activity.date,
        timestamp: activity.timestamp,
        sequence: 0,
        currency: activity.currency.clone(),
        fx_rate: None,
        cash: None,
        charges: Charges::default(),
        action: Action::None,
        contribution: Contribution::None,
        flow: Flow::NONE,
        attribution: Attributed::default(),
        diagnostics: vec![Diagnostic::error(
            DiagnosticCode::InvalidConversion,
            activity.id.as_str(),
            format!("conversion row rejected: {reason}"),
        )],
    }
}

/// A leg of a possibly composite activity, with its own event id.
struct Leg {
    event_id: EventId,
    activity: Activity,
}

/// DRIP / STAKING_REWARD / DIVIDEND_IN_KIND become an income leg followed by
/// a BUY leg whose cash mirrors the income so the composite is cash-neutral
/// (legacy `DefaultActivityCompiler`).
fn expand(activity: &Activity) -> Vec<Leg> {
    let composite = match (activity.kind, activity.subtype) {
        (ActivityKind::Dividend, Some(Subtype::Drip | Subtype::DividendInKind)) => {
            Some((ActivityKind::Dividend, "dividend"))
        }
        (ActivityKind::Interest, Some(Subtype::StakingReward)) => {
            Some((ActivityKind::Interest, "interest"))
        }
        _ => None,
    };
    let Some((income_kind, income_suffix)) = composite else {
        return vec![Leg {
            event_id: EventId::new(activity.id.as_str()),
            activity: activity.clone(),
        }];
    };

    let income_amount = activity.amount;
    // A non-positive unit price only stands when no price derives from the
    // income amount (dust rewards where FMV and amount are both zero).
    let acquisition_price = Some(activity.unit_price)
        .filter(|price| *price > Decimal::ZERO)
        .or_else(|| {
            income_amount
                .filter(|amount| *amount > Decimal::ZERO)
                .and_then(|amount| arith::div(amount, activity.quantity))
        })
        .unwrap_or(activity.unit_price);

    let mut income = activity.clone();
    income.kind = income_kind;
    income.subtype = None;
    income.quantity = Decimal::ZERO;
    income.unit_price = Decimal::ZERO;

    let mut buy = activity.clone();
    buy.kind = ActivityKind::Buy;
    buy.subtype = None;
    buy.unit_price = acquisition_price;
    buy.amount = income_amount;
    buy.fee = Decimal::ZERO;
    buy.tax = Decimal::ZERO;

    vec![
        Leg {
            event_id: EventId::new(format!("{}:{income_suffix}", activity.id)),
            activity: income,
        },
        Leg {
            event_id: EventId::new(format!("{}:buy", activity.id)),
            activity: buy,
        },
    ]
}

fn compile_leg(leg: &Leg, account: &AccountFacts, facts: &CanonicalFacts) -> EconomicEvent {
    let activity = &leg.activity;
    let multiplier = activity
        .asset
        .as_ref()
        .and_then(|asset| facts.assets.get(asset))
        .map(|asset| asset.contract_multiplier)
        .unwrap_or(Decimal::ONE);
    let mut diagnostics = Vec::new();

    let cash = resolve_cash(activity, account, multiplier, &mut diagnostics);
    let charges = Charges {
        fee: activity.fee,
        tax: activity.tax,
    };
    let action = action_for(activity, &mut diagnostics);
    let contribution = contribution_for(activity, facts);
    let flow = flow_for(activity, facts, multiplier, cash.as_ref(), &mut diagnostics);
    let attribution = attribution_for(activity, account, &action);

    EconomicEvent {
        id: leg.event_id.clone(),
        source: activity.id.clone(),
        kind: activity.kind,
        account: activity.account.clone(),
        date: activity.date,
        timestamp: activity.timestamp,
        sequence: 0,
        currency: activity.currency.clone(),
        fx_rate: activity.fx_rate,
        cash,
        charges,
        action,
        contribution,
        flow,
        attribution,
        diagnostics,
    }
}

/// Legacy `resolve_cash_inputs` + `resolve_cash_with_account_context`.
fn resolve_cash(
    activity: &Activity,
    account: &AccountFacts,
    multiplier: Decimal,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<CashEffect> {
    use ActivityKind::*;

    if activity.kind == Split || activity.kind == Adjustment || activity.kind == Unknown {
        return None;
    }

    if activity.is_security_transfer {
        // Security transfers book only their fee as cash.
        return (activity.fee > Decimal::ZERO).then_some(CashEffect {
            amount: -activity.fee,
            gross: Some(-activity.fee),
            booking: Booking::ActivityCurrency,
        });
    }

    let Some(final_amount) = activity.amount else {
        diagnostics.push(Diagnostic::warning(
            DiagnosticCode::MissingFinalCash,
            activity.id.as_str(),
            "posted activity stores no final cash amount; zero cash booked",
        ));
        return None;
    };

    let charges = activity.fee + activity.tax;
    let signed = if final_amount.is_zero() {
        Decimal::ZERO
    } else if activity.kind == Sell && sell_is_proven_negative(activity, multiplier, final_amount) {
        -final_amount
    } else {
        type_directed(activity.kind, final_amount)
    };

    let mut signed = signed;
    let mut gross = match activity.kind {
        Buy => Some(-signed - charges),
        Sell | Deposit | Dividend | Interest | Credit | TransferIn => Some(signed + charges),
        Withdrawal | TransferOut => Some(-signed - charges),
        Fee | Tax => Some(final_amount),
        _ => None,
    }
    .filter(|gross| *gross >= Decimal::ZERO)
    .map(|gross| type_directed(activity.kind, gross));

    // Investment-account interest is income; credit-card interest is a charge.
    if account.kind == AccountKind::CreditCard && activity.kind == Interest {
        signed = -final_amount.abs();
        gross = gross.map(|g| -g.abs());
    }

    let booking = match activity.kind {
        Buy | Sell => match activity.fx_rate {
            Some(rate) if activity.currency != account.currency => {
                Booking::AccountCurrency { rate }
            }
            _ => Booking::ActivityCurrency,
        },
        _ => Booking::ActivityCurrency,
    };

    Some(CashEffect {
        amount: signed,
        gross,
        booking,
    })
}

/// A SELL whose charges exceed proceeds books as an outflow, but only when
/// the quantity/price economics reproduce the stored magnitude within one
/// minor unit (or 1e-8 relative), mirroring the frontend `isProvenNegativeSell`.
fn sell_is_proven_negative(
    activity: &Activity,
    multiplier: Decimal,
    final_amount: Decimal,
) -> bool {
    // Economics that cannot be computed cannot prove anything: the stored
    // amount keeps its type-directed sign.
    let Some(gross) = arith::product(&[activity.quantity, activity.unit_price, multiplier]) else {
        return false;
    };
    if gross <= Decimal::ZERO {
        return false;
    }
    let expected = gross - activity.fee - activity.tax;
    if expected >= Decimal::ZERO {
        return false;
    }
    let tolerance = (final_amount * Decimal::new(1, 8)).max(minor_unit(activity.currency.as_str()));
    (expected.abs() - final_amount).abs() <= tolerance
}

fn type_directed(kind: ActivityKind, amount: Decimal) -> Decimal {
    use ActivityKind::*;
    match kind {
        Sell | Deposit | Dividend | Interest | Credit | TransferIn => amount.abs(),
        Buy | Withdrawal | Fee | Tax | TransferOut => -amount.abs(),
        _ => Decimal::ZERO,
    }
}

/// One minor unit of a currency (legacy `currency_minor_unit`), used only as
/// the SELL-reversal tolerance.
fn minor_unit(currency: &str) -> Decimal {
    let digits = match currency.to_ascii_uppercase().as_str() {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "CLF" | "UYW" => 4,
        "BTC" | "ETH" | "XRP" | "LTC" | "BCH" | "ADA" | "DOT" | "LINK" | "XLM" | "DOGE" | "UNI"
        | "SOL" | "AVAX" | "MATIC" | "ATOM" | "ALGO" | "VET" | "FIL" | "TRX" | "ETC" | "XMR"
        | "AAVE" | "MKR" | "COMP" | "SNX" | "YFI" | "SUSHI" | "CRV" => 8,
        _ => 2,
    };
    Decimal::new(1, digits)
}

fn action_for(activity: &Activity, diagnostics: &mut Vec<Diagnostic>) -> Action {
    use ActivityKind::*;
    let intent = match activity.subtype {
        Some(Subtype::PositionOpen) => Some(Intent::Open),
        Some(Subtype::PositionClose) => Some(Intent::Close),
        _ => None,
    };
    match (activity.kind, activity.asset.clone()) {
        (Buy, Some(asset)) => Action::Trade {
            asset,
            side: Side::Buy,
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            intent,
        },
        (Sell, Some(asset)) => Action::Trade {
            asset,
            side: Side::Sell,
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            intent,
        },
        (Buy | Sell, None) => {
            diagnostics.push(Diagnostic::error(
                DiagnosticCode::UnknownAsset,
                activity.id.as_str(),
                "trade without an asset; cash effect only",
            ));
            Action::None
        }
        (TransferIn | TransferOut, Some(asset)) => Action::SecurityTransfer {
            asset,
            direction: if activity.kind == TransferIn {
                Direction::In
            } else {
                Direction::Out
            },
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            legacy_amount: activity.amount.filter(|a| !a.is_zero()),
            group: activity.source_group_id.clone(),
        },
        (Split, Some(asset)) => {
            let ratio = if activity.amount.is_some_and(|a| a > Decimal::ZERO) {
                activity.amount.unwrap_or_default()
            } else {
                activity.quantity
            };
            if ratio <= Decimal::ZERO {
                diagnostics.push(Diagnostic::warning(
                    DiagnosticCode::InvalidSplitRatio,
                    activity.id.as_str(),
                    "SPLIT without a positive ratio; ignored",
                ));
                Action::None
            } else {
                Action::Split { asset, ratio }
            }
        }
        (Split, None) => {
            diagnostics.push(Diagnostic::warning(
                DiagnosticCode::UnknownAsset,
                activity.id.as_str(),
                "SPLIT without an asset; ignored",
            ));
            Action::None
        }
        (Adjustment, None)
            if matches!(
                activity.subtype,
                Some(Subtype::ReturnOfCapital | Subtype::NotionalDistribution)
            ) =>
        {
            diagnostics.push(Diagnostic::error(
                DiagnosticCode::UnknownAsset,
                activity.id.as_str(),
                "cost basis adjustment requires an asset",
            ));
            Action::None
        }
        (Adjustment, Some(asset)) if activity.subtype == Some(Subtype::OptionExpiry) => {
            Action::OptionExpiry {
                asset,
                quantity: activity.quantity,
            }
        }
        (Adjustment, Some(asset)) if activity.subtype == Some(Subtype::ReturnOfCapital) => {
            Action::ReturnOfCapital {
                asset,
                amount: activity.amount.unwrap_or_default().abs(),
            }
        }
        (Adjustment, Some(asset)) if activity.subtype == Some(Subtype::NotionalDistribution) => {
            Action::NotionalDistribution {
                asset,
                amount: activity.amount.unwrap_or_default().abs(),
            }
        }
        // A distribution of capital: its gross amount, the cash plus what was
        // withheld from it, is cost recovered.
        (Dividend, Some(asset)) if activity.subtype == Some(Subtype::ReturnOfCapital) => {
            Action::ReturnOfCapital {
                asset,
                amount: activity.amount.unwrap_or_default().abs() + activity.fee + activity.tax,
            }
        }
        _ => Action::None,
    }
}

/// Appendix A, cross-cutting rules: income is attributed gross; fees and
/// taxes are attributed for trades, income and standalone charge rows; fees
/// on deposits, withdrawals and transfers are booked but knowingly not
/// attributed. Credit-card interest is a charge on a liability (its cash is
/// negative), so its amount is attributed as a fee, never as income.
fn attribution_for(activity: &Activity, account: &AccountFacts, action: &Action) -> Attributed {
    use ActivityKind::*;
    let amount = activity.amount.unwrap_or(Decimal::ZERO);
    let (fee, tax) = (activity.fee, activity.tax);
    match activity.kind {
        Interest if account.kind == AccountKind::CreditCard => Attributed {
            fee: amount,
            ..Attributed::default()
        },
        // Capital paid back, not income; what was withheld is still a charge.
        Dividend if activity.subtype == Some(Subtype::ReturnOfCapital) => Attributed {
            fee,
            tax,
            ..Attributed::default()
        },
        Dividend | Interest => Attributed {
            income: activity
                .amount
                .map(|amount| amount + fee + tax)
                .unwrap_or(Decimal::ZERO),
            fee,
            tax,
        },
        Fee => Attributed {
            fee: amount,
            ..Attributed::default()
        },
        Tax => Attributed {
            tax: amount,
            ..Attributed::default()
        },
        Buy | Sell => Attributed {
            fee,
            tax,
            ..Attributed::default()
        },
        // Cash transfers book tax to cash; asset transfers book only the fee.
        Credit | Deposit | Withdrawal => Attributed {
            tax,
            ..Attributed::default()
        },
        TransferIn | TransferOut if !activity.is_security_transfer => Attributed {
            tax,
            ..Attributed::default()
        },
        // Each moves income by what it moves cost, so the unrealized P&L the
        // cost change causes is no gain (rules R7.4): a return of capital
        // takes capital back out of dividends already counted as income; a
        // notional distribution is income reinvested as cost.
        Adjustment if matches!(action, Action::ReturnOfCapital { .. }) => Attributed {
            income: -amount.abs(),
            ..Attributed::default()
        },
        Adjustment if matches!(action, Action::NotionalDistribution { .. }) => Attributed {
            income: amount.abs(),
            ..Attributed::default()
        },
        _ => Attributed::default(),
    }
}

/// A CREDIT crosses the portfolio boundary when its row says so
/// (`metadata.flow.is_external`); unmarked rows fall back to the subtype,
/// where only BONUS is new money. Matches 3.9.1's flow classifier.
fn credit_is_external(activity: &Activity) -> bool {
    activity
        .external_transfer
        .unwrap_or(activity.subtype == Some(Subtype::Bonus))
}

fn contribution_for(activity: &Activity, facts: &CanonicalFacts) -> Contribution {
    use ActivityKind::*;
    if facts
        .transfer_pairs
        .pair_for(&activity.id)
        .is_some_and(|pair| pair.contribution_neutral)
    {
        return Contribution::None;
    }
    match activity.kind {
        Deposit | Withdrawal => Contribution::CashGross,
        Credit if credit_is_external(activity) => Contribution::CashGross,
        TransferIn if activity.is_security_transfer => Contribution::SecurityIn,
        TransferOut if activity.is_security_transfer => Contribution::SecurityOut,
        TransferIn | TransferOut => Contribution::CashGross,
        _ => Contribution::None,
    }
}

fn flow_for(
    activity: &Activity,
    facts: &CanonicalFacts,
    multiplier: Decimal,
    cash: Option<&CashEffect>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Flow {
    use ActivityKind::*;
    let gross_abs = cash
        .and_then(|c| c.gross)
        .map(|value| value.abs())
        .unwrap_or(Decimal::ZERO);
    match activity.kind {
        Deposit | Withdrawal => Flow {
            boundary: Boundary::External,
            value: FlowValue::Cash(gross_abs),
        },
        Credit if credit_is_external(activity) => Flow {
            boundary: Boundary::External,
            value: FlowValue::Cash(gross_abs),
        },
        TransferIn | TransferOut => {
            let counterparty = facts
                .transfer_pairs
                .pair_for(&activity.id)
                .and_then(|pair| pair.counterparty(&activity.id));
            let boundary = match counterparty {
                Some(counterparty) => Boundary::Internal {
                    counterparty: counterparty.clone(),
                },
                None if activity.external_transfer == Some(true) => Boundary::External,
                None => {
                    diagnostics.push(Diagnostic::warning(
                        DiagnosticCode::UnknownTransferBoundary,
                        activity.id.as_str(),
                        "transfer has no valid pair and is not marked external; returns are gated",
                    ));
                    Boundary::Unknown
                }
            };
            let value = if activity.is_security_transfer {
                // The basis the projection books for the lot (contract
                // multiplier included), so a flow at cost matches it.
                let book_basis =
                    arith::product(&[activity.quantity, activity.unit_price, multiplier])
                        .filter(|basis| !basis.is_zero())
                        .or_else(|| {
                            (activity.kind == TransferIn && !activity.quantity.is_zero())
                                .then(|| activity.amount.unwrap_or_default().abs())
                                .filter(|basis| !basis.is_zero())
                        });
                FlowValue::SecurityAtMarket {
                    quantity: activity.quantity,
                    book_basis,
                    legacy_amount: activity.amount.filter(|a| !a.is_zero()),
                }
            } else {
                FlowValue::Cash(gross_abs)
            };
            Flow { boundary, value }
        }
        _ => Flow::NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use chrono::{DateTime, NaiveDate, TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn raw(id: &str, account: &str, kind: &str, ts: &str) -> RawActivity {
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
            amount: None,
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

    fn ledger(activities: Vec<RawActivity>, account_type: &str) -> CompiledLedger {
        let facts = RawFacts {
            policy: Policy::new(
                Currency::parse("USD").unwrap(),
                chrono_tz::UTC,
                NaiveDate::from_ymd_opt(2025, 3, 5).unwrap(),
            ),
            accounts: vec![RawAccount {
                id: "a1".into(),
                currency: "USD".into(),
                account_type: account_type.into(),
                tracking_mode: "TRANSACTIONS".into(),
                is_archived: false,
                cost_basis_method: None,
            }],
            assets: vec![RawAsset {
                id: "aapl".into(),
                quote_currency: "USD".into(),
                kind: "INVESTMENT".into(),
                instrument_type: Some("EQUITY".into()),
                contract_multiplier: None,
                alternative: false,
            }],
            activities,
            quotes: vec![],
            fx_rates: vec![],
            observed_snapshots: vec![],
        };
        compile(&normalize(facts).unwrap().facts)
    }

    #[test]
    fn buy_books_final_cash_and_reverse_derives_gross() {
        let mut buy = raw("b", "a1", "BUY", "2025-01-02T10:00:00Z");
        buy.asset_id = Some("aapl".into());
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        buy.fee = Some(dec!(1));
        buy.tax = Some(dec!(2));
        buy.amount = Some(dec!(23));
        let ledger = ledger(vec![buy], "SECURITIES");
        let cash = ledger.events[0].cash.as_ref().unwrap();
        assert_eq!(cash.amount, dec!(-23));
        assert_eq!(cash.gross, Some(dec!(-20)));
        assert!(matches!(
            ledger.events[0].action,
            Action::Trade {
                side: Side::Buy,
                ..
            }
        ));
    }

    #[test]
    fn sell_reverses_only_when_economics_prove_it() {
        let mut proven = raw("s1", "a1", "SELL", "2025-01-02T10:00:00Z");
        proven.asset_id = Some("aapl".into());
        proven.quantity = Some(dec!(1));
        proven.unit_price = Some(dec!(10));
        proven.fee = Some(dec!(12));
        proven.amount = Some(dec!(2));
        let mut inconsistent = proven.clone();
        inconsistent.id = "s2".into();
        inconsistent.timestamp = Utc.with_ymd_and_hms(2025, 1, 2, 11, 0, 0).unwrap();
        inconsistent.amount = Some(dec!(100));
        let ledger = ledger(vec![proven, inconsistent], "SECURITIES");
        assert_eq!(ledger.events[0].cash.as_ref().unwrap().amount, dec!(-2));
        assert_eq!(ledger.events[1].cash.as_ref().unwrap().amount, dec!(100));
        assert_eq!(
            ledger.events[1].cash.as_ref().unwrap().gross,
            Some(dec!(112))
        );
    }

    #[test]
    fn missing_final_cash_books_nothing_and_diagnoses() {
        let mut buy = raw("b", "a1", "BUY", "2025-01-02T10:00:00Z");
        buy.asset_id = Some("aapl".into());
        buy.quantity = Some(dec!(2));
        buy.unit_price = Some(dec!(10));
        let ledger = ledger(vec![buy], "SECURITIES");
        assert!(ledger.events[0].cash.is_none());
        assert_eq!(ledger.diagnostics[0].code, DiagnosticCode::MissingFinalCash);
    }

    #[test]
    fn credit_card_interest_is_a_charge() {
        let mut interest = raw("i", "a1", "INTEREST", "2025-01-02T10:00:00Z");
        interest.amount = Some(dec!(15));
        let ledger = ledger(vec![interest], "CREDIT_CARD");
        assert_eq!(ledger.events[0].cash.as_ref().unwrap().amount, dec!(-15));
    }

    #[test]
    fn drip_expands_into_income_and_cash_neutral_buy() {
        let mut drip = raw("d", "a1", "DIVIDEND", "2025-01-02T10:00:00Z");
        drip.asset_id = Some("aapl".into());
        drip.subtype = Some("DRIP".into());
        drip.amount = Some(dec!(50));
        drip.tax = Some(dec!(5));
        drip.quantity = Some(dec!(2));
        drip.unit_price = Some(dec!(0));
        let ledger = ledger(vec![drip], "SECURITIES");
        assert_eq!(ledger.events.len(), 2);
        assert_eq!(ledger.events[0].id.as_str(), "d:dividend");
        assert_eq!(ledger.events[0].cash.as_ref().unwrap().amount, dec!(50));
        assert_eq!(ledger.events[0].charges.tax, dec!(5));
        assert_eq!(ledger.events[1].id.as_str(), "d:buy");
        assert_eq!(ledger.events[1].cash.as_ref().unwrap().amount, dec!(-50));
        assert_eq!(ledger.events[1].charges, Charges::default());
        match &ledger.events[1].action {
            Action::Trade { unit_price, .. } => assert_eq!(*unit_price, dec!(25)),
            other => panic!("unexpected action {other:?}"),
        }
    }

    #[test]
    fn returns_of_capital_recover_cost_and_notional_distributions_add_it() {
        let mut dividend = raw("d", "a1", "DIVIDEND", "2025-01-02T10:00:00Z");
        dividend.asset_id = Some("aapl".into());
        dividend.subtype = Some("RETURN_OF_CAPITAL".into());
        dividend.amount = Some(dec!(45));
        dividend.tax = Some(dec!(5));
        let mut adjustment = raw("r", "a1", "ADJUSTMENT", "2025-01-02T11:00:00Z");
        adjustment.asset_id = Some("aapl".into());
        adjustment.subtype = Some("return_of_capital".into());
        adjustment.amount = Some(dec!(20));
        let mut notional = raw("n", "a1", "ADJUSTMENT", "2025-01-02T12:00:00Z");
        notional.asset_id = Some("aapl".into());
        notional.subtype = Some("NOTIONAL_DISTRIBUTION".into());
        notional.amount = Some(dec!(10));
        let ledger = ledger(vec![dividend, adjustment, notional], "SECURITIES");
        assert!(ledger.diagnostics.is_empty());

        // A dividend of capital books its cash, recovers its gross amount
        // and is no income; what was withheld is still a charge.
        assert_eq!(ledger.events[0].cash.as_ref().unwrap().amount, dec!(45));
        match &ledger.events[0].action {
            Action::ReturnOfCapital { amount, .. } => assert_eq!(*amount, dec!(50)),
            other => panic!("unexpected action {other:?}"),
        }
        assert_eq!(
            ledger.events[0].attribution,
            Attributed {
                income: dec!(0),
                fee: dec!(0),
                tax: dec!(5),
            }
        );
        // A return of capital adjustment books no cash and takes its amount
        // back out of income; a notional distribution adds it.
        assert!(ledger.events[1].cash.is_none());
        match &ledger.events[1].action {
            Action::ReturnOfCapital { amount, .. } => assert_eq!(*amount, dec!(20)),
            other => panic!("unexpected action {other:?}"),
        }
        assert_eq!(ledger.events[1].attribution.income, dec!(-20));
        assert!(ledger.events[2].cash.is_none());
        match &ledger.events[2].action {
            Action::NotionalDistribution { amount, .. } => assert_eq!(*amount, dec!(10)),
            other => panic!("unexpected action {other:?}"),
        }
        assert_eq!(ledger.events[2].attribution.income, dec!(10));
    }

    #[test]
    fn unpaired_transfer_without_marker_is_unknown_boundary() {
        let mut transfer = raw("t", "a1", "TRANSFER_IN", "2025-01-02T10:00:00Z");
        transfer.amount = Some(dec!(100));
        let ledger = ledger(vec![transfer], "SECURITIES");
        assert_eq!(ledger.events[0].flow.boundary, Boundary::Unknown);
        assert_eq!(ledger.events[0].contribution, Contribution::CashGross);
        assert_eq!(
            ledger.diagnostics[0].code,
            DiagnosticCode::UnknownTransferBoundary
        );
    }

    #[test]
    fn credit_honors_explicit_external_flag() {
        let cases = [
            ("CASH", None, Some(true), true),
            ("CASH", Some("REFUND"), Some(true), true),
            ("CASH", Some("REBATE"), Some(true), true),
            ("CASH", Some("REIMBURSEMENT"), Some(true), true),
            ("CASH", Some("BONUS"), None, true),
            ("CASH", Some("BONUS"), Some(false), false),
            ("CASH", Some("ADJUSTMENT"), None, false),
            ("SECURITIES", Some("REFUND"), None, false),
            ("SECURITIES", Some("REBATE"), None, false),
        ];
        for (account_type, subtype, external, expected) in cases {
            let mut credit = raw("credit", "a1", "CREDIT", "2025-03-01T10:00:00Z");
            credit.amount = Some(dec!(100));
            credit.subtype = subtype.map(str::to_owned);
            credit.external_transfer = external;
            let ledger = ledger(vec![credit], account_type);
            let event = &ledger.events[0];
            let case = format!("{account_type} {subtype:?} external={external:?}");
            if expected {
                assert_eq!(event.contribution, Contribution::CashGross, "{case}");
                assert_eq!(event.flow.boundary, Boundary::External, "{case}");
                assert_eq!(event.flow.value, FlowValue::Cash(dec!(100)), "{case}");
            } else {
                assert_eq!(event.contribution, Contribution::None, "{case}");
                assert_eq!(event.flow, Flow::NONE, "{case}");
            }
        }
    }
}
