//! Calendar statements derived from the card's existing cash ledger. Nothing
//! is booked when a cycle closes: paying a card remains an ordinary transfer.

use std::collections::BTreeMap;

use chrono::{Datelike, Months, NaiveDate};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::{account_types, Account, TrackingMode};
use crate::activities::{running_cash_balances, ActivityStatus, CashLedgerActivity};
use crate::errors::ValidationError;
use crate::{Error, Result};

/// Stored in `Account.meta.creditCardBilling`, alongside other account settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditCardBillingSettings {
    pub closing_day: u32,
    pub due_day: u32,
}

/// Builds a validation error without exposing the account's metadata.
fn invalid(message: &str) -> Error {
    Error::Validation(ValidationError::InvalidInput(message.to_string()))
}

impl CreditCardBillingSettings {
    /// Requires calendar day numbers in 1..=31; due days may wrap to the next month.
    pub fn validate(&self) -> Result<()> {
        if !(1..=31).contains(&self.closing_day) || !(1..=31).contains(&self.due_day) {
            return Err(invalid(
                "Credit card billing days must be integers from 1 to 31",
            ));
        }
        Ok(())
    }

    /// Ignores unrelated legacy metadata but rejects a malformed recognized schedule.
    pub fn from_meta(meta: Option<&str>) -> Result<Option<Self>> {
        // Unrelated legacy metadata keeps its existing interpretation.
        let Some(value) = meta.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        else {
            return Ok(None);
        };
        let Some(settings) = value
            .get("creditCardBilling")
            .filter(|value| !value.is_null())
        else {
            return Ok(None);
        };
        let settings: Self = serde_json::from_value(settings.clone())
            .map_err(|_| invalid("Invalid credit card billing settings"))?;
        settings.validate()?;
        Ok(Some(settings))
    }

    /// Missing days (e.g. February 31) use the month's last day. The due date
    /// is the first occurrence of its configured day strictly after closing.
    fn period(&self, month: NaiveDate) -> Result<CreditCardStatement> {
        self.validate()?;
        let previous = month
            .checked_sub_months(Months::new(1))
            .ok_or_else(|| invalid("Billing period is outside the supported date range"))?;
        let closing_date = day_in_month(month, self.closing_day)?;
        let start_date = day_in_month(previous, self.closing_day)?
            .succ_opt()
            .ok_or_else(|| invalid("Billing period is outside the supported date range"))?;
        let mut due_date = day_in_month(month, self.due_day)?;
        if due_date <= closing_date {
            let next = month
                .checked_add_months(Months::new(1))
                .ok_or_else(|| invalid("Billing period is outside the supported date range"))?;
            due_date = day_in_month(next, self.due_day)?;
        }
        Ok(CreditCardStatement {
            start_date,
            closing_date,
            due_date,
            is_closed: false,
            balances: Vec::new(),
        })
    }
}

/// Clamps a configured day to the last valid day in the supplied month.
fn day_in_month(month: NaiveDate, day: u32) -> Result<NaiveDate> {
    (1..=day)
        .rev()
        .find_map(|day| month.with_day(day))
        .ok_or_else(|| invalid("Billing period is outside the supported date range"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditCardStatementBalance {
    pub currency: String,
    /// Positive means owed; negative means the card is in credit. Decimal
    /// strings preserve the ledger's precision across runtime transports.
    pub balance: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditCardStatement {
    pub start_date: NaiveDate,
    pub closing_date: NaiveDate,
    pub due_date: NaiveDate,
    pub is_closed: bool,
    pub balances: Vec<CreditCardStatementBalance>,
}

/// The open cycle and up to twelve preceding cycles, newest first. Older
/// cycles use the current schedule; balances include all prior posted rows.
/// An incomplete import therefore produces an incomplete statement too.
pub fn credit_card_statements(
    account: &Account,
    activities: &[CashLedgerActivity],
    today: NaiveDate,
    timezone: Tz,
) -> Result<Vec<CreditCardStatement>> {
    if account.account_type != account_types::CREDIT_CARD
        || account.tracking_mode != TrackingMode::Transactions
        || account.is_archived
    {
        return Err(invalid(
            "Billing statements require a non-archived, transaction-tracked credit card account",
        ));
    }
    let Some(settings) = CreditCardBillingSettings::from_meta(account.meta.as_deref())? else {
        return Ok(Vec::new());
    };
    let mut month = today.with_day(1).expect("first day of an existing month");
    if day_in_month(month, settings.closing_day)? < today {
        month = month
            .checked_add_months(Months::new(1))
            .ok_or_else(|| invalid("Billing period is outside the supported date range"))?;
    }
    let mut statements = Vec::with_capacity(13);
    for offset in (0..=12).rev() {
        let month = month
            .checked_sub_months(Months::new(offset))
            .ok_or_else(|| invalid("Billing period is outside the supported date range"))?;
        let mut statement = settings.period(month)?;
        statement.is_closed = statement.closing_date < today;
        statements.push(statement);
    }
    let mut ordered: Vec<_> = activities
        .iter()
        .filter(|row| {
            row.account_id == account.id
                && row.status == ActivityStatus::Posted
                && row.activity_date.with_timezone(&timezone).date_naive() <= today
        })
        .cloned()
        .collect();
    // Exclude future/draft rows before asking the existing ledger to validate
    // the history. A security-bearing history cannot produce a card statement.
    let running = running_cash_balances(account, &ordered).ok_or_else(|| {
        invalid("Card statement balances are unavailable for a history containing securities")
    })?;
    ordered.sort_by(|a, b| {
        a.activity_date
            .cmp(&b.activity_date)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let first_day = ordered
        .first()
        .map(|row| row.activity_date.with_timezone(&timezone).date_naive());
    let mut rows = ordered.iter().peekable();
    let mut cash: BTreeMap<String, Decimal> = BTreeMap::new();
    cash.insert(account.currency.trim().to_string(), Decimal::ZERO);
    for statement in &mut statements {
        while let Some(row) = rows.next_if(|row| {
            row.activity_date.with_timezone(&timezone).date_naive() <= statement.closing_date
        }) {
            if let Some(balance) = running.get(&row.id) {
                cash.insert(balance.currency.clone(), balance.balance);
            }
        }
        statement.balances = cash
            .iter()
            .map(|(currency, balance)| CreditCardStatementBalance {
                currency: currency.clone(),
                balance: (-*balance).to_string(),
            })
            .collect();
    }
    // Do not present zero statements from before the available ledger began.
    statements.retain(|statement| {
        !statement.is_closed || first_day.is_some_and(|day| day <= statement.closing_date)
    });
    statements.reverse();
    Ok(statements)
}

#[cfg(test)]
mod tests;
