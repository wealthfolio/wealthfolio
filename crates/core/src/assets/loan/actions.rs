//! Loan actions: a requested change is checked against the stored loan and
//! turned into writes that the repository applies in one transaction.
use chrono::{NaiveDate, NaiveTime, Utc};
use rust_decimal::{
    prelude::{FromPrimitive, ToPrimitive},
    Decimal,
};
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use super::model::decoded;
use super::{
    balance_notes, balance_user_note, calculate_loan, edited_balance_notes, event_entries, money,
    recalculate_loan, valid_amount, InterestMethod, LoanBalance, LoanBalanceKind, LoanCalculation,
    LoanCalculationRequest, LoanEvent, LoanFrequency, LoanRecalculationRequest, LoanTerms,
    LOAN_CLOSED_NOTE, LOAN_EVENTS_KEY, RENEWAL_MATURITY_KEY,
};
use crate::quotes::constants::DATA_SOURCE_MANUAL;
use crate::quotes::{quote_id, AssetId, Day, Quote, QuoteSource};

/// Why a loan action was refused. The codes are stable; the UI translates them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LoanError {
    #[error("LOAN_INVALID")]
    Invalid,
    #[error("LOAN_AMOUNT_EXCEEDS_BALANCE")]
    AmountExceedsBalance,
    #[error("LOAN_BALANCE_DATE_TAKEN")]
    BalanceDateTaken,
    #[error("LOAN_EVENT_CHANGED")]
    EventChanged,
    #[error("LOAN_EVENT_MISSING")]
    EventMissing,
    #[error("LOAN_PAYMENT_REQUIRED")]
    PaymentRequired,
    #[error("LOAN_CLOSURE_DATE_INVALID")]
    ClosureDateInvalid,
}

impl From<LoanError> for crate::errors::Error {
    fn from(error: LoanError) -> Self {
        Self::Validation(error.into())
    }
}

/// The outcome callers act on: refreshed balances need portfolio recalculation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoanActionResult {
    pub balances_changed: bool,
}

/// A loan's stored inputs, read inside the write transaction.
#[derive(Debug, Clone)]
pub struct LoanRecord {
    pub asset_id: String,
    pub currency: String,
    pub metadata: Value,
    /// Manual quotes, oldest first.
    pub balances: Vec<Quote>,
}

/// The writes for one action, applied together or not at all.
#[derive(Debug, Clone, Default)]
pub struct LoanUpdate {
    /// The complete new metadata, when it changes.
    pub metadata: Option<Value>,
    pub save_balances: Vec<Quote>,
    pub delete_balances: Vec<String>,
}

impl LoanUpdate {
    /// Balance quotes change valuations everywhere, so callers refresh portfolios.
    pub fn changes_balances(&self) -> bool {
        !self.save_balances.is_empty() || !self.delete_balances.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceEdit {
    pub date: NaiveDate,
    pub balance: f64,
    #[serde(default)]
    pub note: String,
}

/// What the user asked to do. Dates are calendar days.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LoanAction {
    #[serde(rename_all = "camelCase")]
    ConfirmBalance { date: NaiveDate, balance: f64 },
    #[serde(rename_all = "camelCase")]
    ExtraRepayment { date: NaiveDate, amount: f64 },
    #[serde(rename_all = "camelCase")]
    Close { date: NaiveDate },
    #[serde(rename_all = "camelCase")]
    Recalculate { date: NaiveDate, annual_rate: f64 },
    #[serde(rename_all = "camelCase")]
    Renew {
        date: NaiveDate,
        annual_rate: f64,
        /// Omitted: the current payment continues.
        #[serde(default)]
        payment_amount: Option<f64>,
        /// Stored only when it differs from the frequency in effect on the date.
        #[serde(default)]
        frequency: Option<LoanFrequency>,
        #[serde(default)]
        interest_method: Option<InterestMethod>,
        #[serde(default)]
        term_end_date: Option<NaiveDate>,
        /// The renewal letter's balance, recorded as a confirmation.
        #[serde(default)]
        balance: Option<f64>,
    },
    /// `index` counts readable events in date order; `original` must still match.
    #[serde(rename_all = "camelCase")]
    EditEvent {
        index: usize,
        original: LoanEvent,
        replacement: Option<LoanEvent>,
    },
    #[serde(rename_all = "camelCase")]
    EditBalance {
        quote_id: String,
        replacement: Option<BalanceEdit>,
    },
}

fn origination(metadata: &Value) -> Option<NaiveDate> {
    metadata
        .get("origination_date")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
}

/// Dated actions fall between origination and today.
fn check_date(metadata: &Value, date: NaiveDate, today: NaiveDate) -> Result<(), LoanError> {
    // `today` is in the settings timezone; the device that picked the date may be
    // a day ahead of it, and its date was always accepted.
    let latest = today.succ_opt().unwrap_or(today);
    if date > latest || origination(metadata).is_some_and(|start| date < start) {
        return Err(LoanError::Invalid);
    }
    Ok(())
}

fn checked(event: LoanEvent) -> Result<LoanEvent, LoanError> {
    event.valid().then_some(event).ok_or(LoanError::Invalid)
}

fn day_of(quote: &Quote) -> NaiveDate {
    quote.timestamp.date_naive()
}

fn renewable(metadata: &Value) -> bool {
    let kind = metadata
        .get("sub_type")
        .filter(|v| !v.is_null())
        .or_else(|| metadata.get("liability_type"))
        .and_then(Value::as_str);
    LoanTerms::active(metadata).is_some()
        && (kind == Some("mortgage")
            || metadata
                .get(RENEWAL_MATURITY_KEY)
                .is_some_and(Value::is_string))
}

impl LoanRecord {
    fn calculation(&self, metadata: &Value, as_of: NaiveDate) -> Option<LoanCalculation> {
        calculate_loan(&LoanCalculationRequest {
            metadata: metadata.clone(),
            balances: self.balances.iter().map(LoanBalance::from).collect(),
            as_of,
        })
    }

    fn balance_on(&self, date: NaiveDate) -> Option<&Quote> {
        self.balances.iter().find(|quote| day_of(quote) == date)
    }

    fn manual_quote(
        &self,
        date: NaiveDate,
        balance: f64,
        notes: Option<String>,
    ) -> Result<Quote, LoanError> {
        let value = Decimal::from_f64(money(balance)).ok_or(LoanError::Invalid)?;
        Ok(Quote {
            id: quote_id(
                &AssetId::new(&self.asset_id),
                Day::new(date),
                &QuoteSource::Manual,
            ),
            asset_id: self.asset_id.clone(),
            timestamp: date.and_time(NaiveTime::MIN).and_utc(),
            open: value,
            high: value,
            low: value,
            close: value,
            adjclose: value,
            volume: Decimal::ZERO,
            currency: self.currency.clone(),
            data_source: DATA_SOURCE_MANUAL.to_string(),
            created_at: Utc::now(),
            notes,
        })
    }
}

/// Frequency and interest method in effect on `date`, including that day's events.
fn settings_on(metadata: &Value, date: NaiveDate) -> Option<(LoanFrequency, InterestMethod)> {
    let terms = LoanTerms::read(metadata)?;
    let mut events: Vec<_> = event_entries(metadata)
        .iter()
        .filter_map(LoanEvent::parse)
        .filter(|event| event.date() <= date)
        .collect();
    events.sort_by_key(LoanEvent::date);
    let (mut frequency, mut method) = (terms.frequency, terms.interest_method);
    for event in events {
        match event {
            LoanEvent::PaymentFrequencyChange { frequency: f, .. } => frequency = f,
            LoanEvent::Renewal {
                frequency: f,
                interest_method: m,
                ..
            } => {
                frequency = f.unwrap_or(frequency);
                method = m.unwrap_or(method);
            }
            _ => {}
        }
    }
    Some((frequency, method))
}

fn with_entries(metadata: &Value, entries: Vec<Value>) -> Value {
    let mut next = metadata.clone();
    // Stored as JSON text, as the metadata API has always written it.
    next[LOAN_EVENTS_KEY] = Value::String(Value::Array(entries).to_string());
    next
}

/// Stored entries to add to; an unreadable list is refused rather than replaced.
fn stored_entries(metadata: &Value) -> Result<Vec<Value>, LoanError> {
    match metadata.get(LOAN_EVENTS_KEY) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(text)) if text.is_empty() => Ok(Vec::new()),
        stored => decoded(stored)
            .and_then(|v| v.as_array().cloned())
            .ok_or(LoanError::Invalid),
    }
}

/// Add an event after everything recorded on or before its date.
fn with_event(metadata: &Value, event: &LoanEvent) -> Result<Value, LoanError> {
    let mut entries = stored_entries(metadata)?;
    let position = entries
        .iter()
        .rposition(|entry| LoanEvent::parse(entry).is_some_and(|e| e.date() <= event.date()))
        .map_or(0, |i| i + 1);
    entries.insert(position, serde_json::to_value(event).unwrap_or(Value::Null));
    Ok(with_entries(metadata, entries))
}

/// The latest renewal's term end, in date order with recorded same-day order.
fn latest_term_end(entries: &[Value]) -> Option<NaiveDate> {
    let mut renewals: Vec<_> = entries
        .iter()
        .filter_map(LoanEvent::parse)
        .filter_map(|event| match event {
            LoanEvent::Renewal {
                effective_date,
                term_end_date: Some(end),
                ..
            } => Some((effective_date, end)),
            _ => None,
        })
        .collect();
    renewals.sort_by_key(|(date, _)| *date);
    renewals.last().map(|(_, end)| *end)
}

/// Replace or remove exactly one recorded event, keeping same-day siblings and
/// unreadable entries. A renewal that owned the maturity passes it on.
fn change_event(
    metadata: &Value,
    index: usize,
    original: &LoanEvent,
    replacement: Option<&LoanEvent>,
) -> Result<Value, LoanError> {
    let entries = decoded(metadata.get(LOAN_EVENTS_KEY))
        .and_then(|v| v.as_array().cloned())
        .ok_or(LoanError::EventMissing)?;
    let mut ordered: Vec<(usize, LoanEvent)> = entries
        .iter()
        .enumerate()
        .filter_map(|(position, entry)| LoanEvent::parse(entry).map(|event| (position, event)))
        .collect();
    ordered.sort_by_key(|(_, event)| event.date());
    // The event is found by its stored value; the index only chooses between
    // identical events, so entries another reader skips cannot shift the target.
    let position = ordered
        .iter()
        .enumerate()
        .filter(|(_, (_, event))| event == original)
        .min_by_key(|(order, _)| order.abs_diff(index))
        .map(|(_, (position, _))| *position)
        .ok_or(LoanError::EventChanged)?;
    let mut next_entries = entries.clone();
    match replacement {
        Some(event) => next_entries[position] = serde_json::to_value(event).unwrap_or(Value::Null),
        None => {
            next_entries.remove(position);
        }
    }
    let mut next = with_entries(metadata, next_entries.clone());
    if let LoanEvent::Renewal { term_end_date, .. } = original {
        let maturity = metadata
            .get(RENEWAL_MATURITY_KEY)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let latest_renewal = ordered
            .iter()
            .rfind(|(_, event)| matches!(event, LoanEvent::Renewal { .. }))
            .map(|(position, _)| *position);
        let owned = match term_end_date {
            Some(end) => maturity == Some(end.to_string().as_str()),
            None => maturity.is_none() && latest_renewal == Some(position),
        };
        if owned {
            match latest_term_end(&next_entries) {
                Some(end) => next[RENEWAL_MATURITY_KEY] = Value::String(end.to_string()),
                None => {
                    if let Some(object) = next.as_object_mut() {
                        object.remove(RENEWAL_MATURITY_KEY);
                    }
                }
            }
        }
    }
    Ok(next)
}

/// Check an action against the stored loan and return the writes it needs.
pub fn apply_loan_action(
    record: &LoanRecord,
    action: &LoanAction,
    today: NaiveDate,
) -> Result<LoanUpdate, LoanError> {
    let metadata = &record.metadata;
    let mut update = LoanUpdate::default();
    match action {
        LoanAction::ConfirmBalance { date, balance } => {
            check_date(metadata, *date, today)?;
            if !valid_amount(*balance) {
                return Err(LoanError::Invalid);
            }
            let notes = balance_notes(LoanBalanceKind::BalanceCorrection, "");
            update
                .save_balances
                .push(record.manual_quote(*date, *balance, notes)?);
        }
        LoanAction::ExtraRepayment { date, amount } => {
            check_date(metadata, *date, today)?;
            if !valid_amount(*amount) {
                return Err(LoanError::Invalid);
            }
            let calculated = record.calculation(metadata, *date);
            let recorded = record
                .balances
                .iter()
                .filter(|quote| day_of(quote) <= *date)
                .max_by_key(|quote| quote.timestamp);
            // Tracked terms the engine cannot use must not fall back to a manual balance.
            if calculated.is_none()
                && (LoanTerms::tracked(metadata).is_some() || recorded.is_none())
            {
                return Err(LoanError::Invalid);
            }
            let at_date = calculated.as_ref().map_or_else(
                || recorded.and_then(|q| q.close.abs().to_f64()).unwrap_or(0.0),
                |c| c.current_balance,
            );
            if *amount <= 0.0 || *amount > at_date {
                return Err(LoanError::AmountExceedsBalance);
            }
            // Calculated loans record the repayment; manual ones record the new balance.
            if calculated.is_some() {
                let event = checked(LoanEvent::ExtraRepayment {
                    effective_date: *date,
                    amount: *amount,
                    note: None,
                })?;
                update.metadata = Some(with_event(metadata, &event)?);
            } else {
                let notes = balance_notes(LoanBalanceKind::ExtraRepayment, "");
                let balance = (at_date - amount).max(0.0);
                update
                    .save_balances
                    .push(record.manual_quote(*date, balance, notes)?);
            }
        }
        LoanAction::Close { date } => {
            check_date(metadata, *date, today).map_err(|_| LoanError::ClosureDateInvalid)?;
            update.save_balances.push(record.manual_quote(
                *date,
                0.0,
                Some(LOAN_CLOSED_NOTE.to_string()),
            )?);
        }
        LoanAction::Recalculate { date, annual_rate } => {
            check_date(metadata, *date, today)?;
            if LoanTerms::active(metadata).is_none() {
                return Err(LoanError::Invalid);
            }
            let solved = recalculate_loan(&LoanRecalculationRequest {
                loan: LoanCalculationRequest {
                    metadata: metadata.clone(),
                    balances: record.balances.iter().map(LoanBalance::from).collect(),
                    as_of: *date,
                },
                annual_rate: *annual_rate,
            })
            .ok_or(LoanError::Invalid)?;
            let rate = checked(LoanEvent::RateChange {
                effective_date: *date,
                annual_rate: *annual_rate,
                note: None,
            })?;
            let payment = checked(LoanEvent::PaymentChange {
                effective_date: *date,
                payment_amount: solved.payment_amount,
                note: None,
            })?;
            update.metadata = Some(with_event(&with_event(metadata, &rate)?, &payment)?);
        }
        LoanAction::Renew {
            date,
            annual_rate,
            payment_amount,
            frequency,
            interest_method,
            term_end_date,
            balance,
        } => {
            if !renewable(metadata) {
                return Err(LoanError::Invalid);
            }
            check_date(metadata, *date, today)?;
            if term_end_date.is_some_and(|end| end <= *date)
                || balance.is_some_and(|b| !valid_amount(b))
            {
                return Err(LoanError::Invalid);
            }
            let (current_frequency, current_method) =
                settings_on(metadata, *date).ok_or(LoanError::Invalid)?;
            let frequency = frequency.filter(|f| *f != current_frequency);
            // A payment is an amount per period, so a new frequency needs its own payment.
            if frequency.is_some() && payment_amount.is_none() {
                return Err(LoanError::PaymentRequired);
            }
            let event = checked(LoanEvent::Renewal {
                effective_date: *date,
                annual_rate: *annual_rate,
                payment_amount: *payment_amount,
                frequency,
                interest_method: interest_method.filter(|m| *m != current_method),
                term_end_date: *term_end_date,
                note: None,
            })?;
            if let Some(balance) = balance {
                // Keep any note already recorded on that day's balance.
                let note = balance_user_note(
                    record
                        .balance_on(*date)
                        .and_then(|quote| quote.notes.as_deref()),
                );
                let notes = balance_notes(LoanBalanceKind::BalanceCorrection, &note);
                update
                    .save_balances
                    .push(record.manual_quote(*date, *balance, notes)?);
            }
            let mut next = with_event(metadata, &event)?;
            // Only the latest dated renewal sets the current term's maturity.
            if let Some(end) = term_end_date {
                let latest = event_entries(&next)
                    .iter()
                    .filter_map(LoanEvent::parse)
                    .filter(|event| matches!(event, LoanEvent::Renewal { .. }))
                    .map(|event| event.date())
                    .max();
                if latest == Some(*date) {
                    next[RENEWAL_MATURITY_KEY] = Value::String(end.to_string());
                }
            }
            update.metadata = Some(next);
        }
        LoanAction::EditEvent {
            index,
            original,
            replacement,
        } => {
            if let Some(event) = replacement {
                checked(event.clone())?;
                check_date(metadata, event.date(), today)?;
                if let LoanEvent::Renewal {
                    term_end_date: Some(end),
                    effective_date,
                    ..
                } = event
                {
                    if end <= effective_date {
                        return Err(LoanError::Invalid);
                    }
                }
            }
            let next = change_event(metadata, *index, original, replacement.as_ref())?;
            if let Some(LoanEvent::ExtraRepayment {
                effective_date,
                amount,
                ..
            }) = replacement
            {
                if LoanTerms::tracked(metadata).is_some() {
                    let without = change_event(metadata, *index, original, None)?;
                    let available = record.calculation(&without, *effective_date);
                    if available.is_none_or(|c| *amount > c.current_balance) {
                        return Err(LoanError::AmountExceedsBalance);
                    }
                }
            }
            update.metadata = Some(next);
        }
        LoanAction::EditBalance {
            quote_id,
            replacement,
        } => {
            let original = record
                .balances
                .iter()
                .find(|quote| &quote.id == quote_id)
                .ok_or(LoanError::EventMissing)?;
            if let Some(edit) = replacement {
                check_date(metadata, edit.date, today)?;
                if !valid_amount(edit.balance) {
                    return Err(LoanError::Invalid);
                }
                let moved = edit.date != day_of(original);
                if moved
                    && record
                        .balances
                        .iter()
                        .any(|quote| quote.id != original.id && day_of(quote) == edit.date)
                {
                    return Err(LoanError::BalanceDateTaken);
                }
                let notes =
                    edited_balance_notes(original.notes.as_deref(), edit.balance, &edit.note);
                update
                    .save_balances
                    .push(record.manual_quote(edit.date, edit.balance, notes)?);
                if moved {
                    update.delete_balances.push(original.id.clone());
                }
            } else {
                update.delete_balances.push(original.id.clone());
            }
        }
    }
    Ok(update)
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
