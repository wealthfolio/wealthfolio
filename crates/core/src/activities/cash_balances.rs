//! Running cash balance per activity: an account's cash in one currency after
//! each row, so its activity list reads like a statement.
//!
//! Books cash the way the portfolio engine does (`compile` + `project`):
//! posted rows only, in application order (timestamp, created_at, then id),
//! each signed by the activity economics resolver in its own currency. An
//! account whose history holds securities gets no balances: their cash turns
//! on what only the engine resolves (contract multipliers, composite rows
//! booked in two currencies), so this ledger would drift from it.

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;

use super::{
    effective_activity_type, is_cash_symbol, is_securities_transfer, Activity, ActivityStatus,
    DefaultActivityCompiler, NewActivity, ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL, ACTIVITY_TYPE_BUY,
    ACTIVITY_TYPE_SELL,
};
use crate::accounts::{account_types, Account, TrackingMode};
use crate::portfolio::economic_events::{ActivityCashInputs, ActivityEconomicsResolver};

#[derive(Debug, Clone, PartialEq)]
pub struct ActivityCashBalance {
    /// The cash currency the row booked into.
    pub currency: String,
    /// The account's cash in that currency after the row.
    pub balance: Decimal,
}

/// The fields of an activity the ledger reads, so storage can load an
/// account's history without whole activities.
#[derive(Debug, Clone, PartialEq)]
pub struct CashLedgerActivity {
    pub id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub activity_type: String,
    pub activity_type_override: Option<String>,
    pub subtype: Option<String>,
    pub status: ActivityStatus,
    pub activity_date: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub amount: Option<Decimal>,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub currency: String,
}

impl CashLedgerActivity {
    fn effective_type(&self) -> &str {
        effective_activity_type(&self.activity_type, self.activity_type_override.as_deref())
    }

    /// The resolver's inputs, built from these fields alone: a new input
    /// fails to compile here until the ledger reads it too.
    fn cash_inputs(&self) -> ActivityCashInputs<'_> {
        ActivityCashInputs {
            activity_type: self.effective_type(),
            currency: &self.currency,
            is_security_transfer: is_securities_transfer(
                self.effective_type(),
                self.asset_id.as_deref(),
            ),
            quantity: self.quantity,
            unit_price: self.unit_price,
            amount: self.amount,
            fee: self.fee,
            tax: self.tax,
            unit_multiplier: Decimal::ONE,
        }
    }
}

impl From<&Activity> for CashLedgerActivity {
    fn from(activity: &Activity) -> Self {
        Self {
            id: activity.id.clone(),
            account_id: activity.account_id.clone(),
            asset_id: activity.asset_id.clone(),
            activity_type: activity.activity_type.clone(),
            activity_type_override: activity.activity_type_override.clone(),
            subtype: activity.subtype.clone(),
            status: activity.status.clone(),
            activity_date: activity.activity_date,
            created_at: activity.created_at,
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            amount: activity.amount,
            fee: activity.fee,
            tax: activity.tax,
            currency: activity.currency.clone(),
        }
    }
}

/// The order the engine applies an account's activities in: by timestamp,
/// then created_at (date-only imports share a timestamp), then id. A list
/// showing running balances must follow it, reversed for newest-first.
pub fn application_order(a: &Activity, b: &Activity) -> Ordering {
    a.activity_date
        .cmp(&b.activity_date)
        .then_with(|| a.created_at.cmp(&b.created_at))
        .then_with(|| a.id.cmp(&b.id))
}

/// Accounts whose cash comes from their activities: all but holdings-tracked
/// ones, whose holdings are entered rather than derived, and those that hold
/// no cash of their own (engine rules R1.6).
pub fn shows_cash_balance(account: &Account) -> bool {
    account.tracking_mode != TrackingMode::Holdings && !account.cash_not_tracked()
}

/// Cash and credit-card accounts whose cash comes from their activities.
pub fn shows_running_cash_balance(account: &Account) -> bool {
    matches!(
        account.account_type.as_str(),
        account_types::CASH | account_types::CREDIT_CARD
    ) && shows_cash_balance(account)
}

/// The balance after each of `account`'s posted activities, by activity id, or
/// none when its posted history holds securities. Rows that are not posted
/// move no cash and get no balance.
pub fn running_cash_balances(
    account: &Account,
    activities: &[CashLedgerActivity],
) -> Option<HashMap<String, ActivityCashBalance>> {
    let mut ordered: Vec<&CashLedgerActivity> = activities
        .iter()
        .filter(|activity| {
            activity.account_id == account.id && activity.status == ActivityStatus::Posted
        })
        .collect();
    if ordered.iter().any(|activity| holds_security(activity)) {
        return None;
    }
    // Application order, as `application_order` sorts whole activities.
    ordered.sort_by(|a, b| {
        a.activity_date
            .cmp(&b.activity_date)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let is_credit_card = account.account_type == account_types::CREDIT_CARD;
    let mut cash: HashMap<String, Decimal> = HashMap::new();
    let mut balances = HashMap::with_capacity(ordered.len());
    for activity in ordered {
        // A row the engine books no cash for (a split, an adjustment, a
        // missing amount) adds zero; a row with no currency books in the
        // account's, as the engine assumes.
        let amount = ActivityEconomicsResolver::resolve_cash_inputs_with_account_context(
            activity.cash_inputs(),
            is_credit_card,
        )
        .signed_cash_effect
        .unwrap_or(Decimal::ZERO);
        let currency = match activity.currency.trim() {
            "" => account.currency.trim(),
            currency => currency,
        }
        .to_string();
        let balance = cash.entry(currency.clone()).or_insert(Decimal::ZERO);
        *balance += amount;
        balances.insert(
            activity.id.clone(),
            ActivityCashBalance {
                currency,
                balance: *balance,
            },
        );
    }
    Some(balances)
}

/// A trade, a row tied to an asset other than cash, a return of capital
/// (which reduces a holding: against a cash symbol the engine rejects it),
/// or a row the compiler expands into income and a purchase (DRIP, dividend
/// in kind, staking reward), with or without an asset.
fn holds_security(activity: &CashLedgerActivity) -> bool {
    let activity_type = activity.effective_type();
    let subtype =
        NewActivity::canonicalize_subtype_for_activity(activity_type, activity.subtype.as_deref());
    matches!(activity_type, ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL)
        || subtype.as_deref() == Some(ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL)
        || activity
            .asset_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|asset_id| !asset_id.is_empty() && !is_cash_symbol(asset_id))
        || DefaultActivityCompiler::expands(activity_type, activity.subtype.as_deref())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use chrono::{DateTime, NaiveDate, Utc};
    use rust_decimal_macros::dec;
    use wealthfolio_portfolio_engine::model::{
        AccountId, Currency, Policy, RawAccount, RawAsset, RawFacts,
    };
    use wealthfolio_portfolio_engine::Engine;

    use super::*;

    /// What storage hands the ledger: the ledger's fields of each activity.
    fn ledger(activities: &[Activity]) -> Vec<CashLedgerActivity> {
        activities.iter().map(CashLedgerActivity::from).collect()
    }
    use crate::activities::{
        ActivityStatus, ACTIVITY_SUBTYPE_BONUS, ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND,
        ACTIVITY_SUBTYPE_DRIP, ACTIVITY_SUBTYPE_NOTIONAL_DISTRIBUTION,
        ACTIVITY_SUBTYPE_OPTION_EXPIRY, ACTIVITY_SUBTYPE_POSITION_CLOSE,
        ACTIVITY_SUBTYPE_POSITION_OPEN, ACTIVITY_SUBTYPE_REBATE, ACTIVITY_SUBTYPE_REFUND,
        ACTIVITY_SUBTYPE_REIMBURSEMENT, ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL,
        ACTIVITY_SUBTYPE_STAKING_REWARD, ACTIVITY_TYPE_ADJUSTMENT, ACTIVITY_TYPE_CREDIT,
        ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST,
        ACTIVITY_TYPE_SPLIT, ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN,
        ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_UNKNOWN, ACTIVITY_TYPE_WITHDRAWAL,
    };
    use crate::portfolio::coordinator::raw_activity;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("test timestamp")
            .with_timezone(&Utc)
    }

    fn account(account_type: &str, currency: &str) -> Account {
        Account {
            id: "account".to_string(),
            name: "Account".to_string(),
            account_type: account_type.to_string(),
            currency: currency.to_string(),
            is_active: true,
            tracking_mode: TrackingMode::Transactions,
            ..Account::default()
        }
    }

    fn activity(id: &str, activity_type: &str, date: &str, amount: Decimal) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: "account".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: at(date),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(amount),
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
            created_at: at("2026-04-01T00:00:00Z"),
            updated_at: at("2026-04-01T00:00:00Z"),
        }
    }

    fn balance(currency: &str, balance: Decimal) -> ActivityCashBalance {
        ActivityCashBalance {
            currency: currency.to_string(),
            balance,
        }
    }

    /// The engine's cash for `account` after folding `activities`.
    fn engine_cash(account: &Account, activities: &[Activity]) -> BTreeMap<String, Decimal> {
        engine_cash_for(account, Vec::new(), activities)
    }

    fn engine_cash_for(
        account: &Account,
        assets: Vec<RawAsset>,
        activities: &[Activity],
    ) -> BTreeMap<String, Decimal> {
        let raw = RawFacts {
            policy: Policy::new(
                Currency::parse(&account.currency).expect("account currency"),
                chrono_tz::UTC,
                NaiveDate::from_ymd_opt(2026, 4, 30).expect("as-of date"),
            ),
            accounts: vec![RawAccount {
                id: account.id.clone(),
                currency: account.currency.clone(),
                account_type: account.account_type.clone(),
                tracking_mode: "TRANSACTIONS".to_string(),
                is_archived: false,
                cost_basis_method: None,
                cash_tracking: None,
            }],
            assets,
            activities: activities.iter().map(raw_activity).collect(),
            quotes: Vec::new(),
            fx_rates: Vec::new(),
            observed_snapshots: Vec::new(),
        };
        let bundle = Engine::new(raw)
            .expect("engine")
            .project()
            .expect("projection");
        bundle.final_state.accounts[&AccountId::new(account.id.clone())]
            .cash
            .iter()
            .filter(|(_, amount)| !amount.is_zero())
            .map(|(currency, amount)| (currency.to_string(), *amount))
            .collect()
    }

    /// Each currency's last running balance: what the account holds at the end.
    fn closing_cash(
        balances: &HashMap<String, ActivityCashBalance>,
        activities: &[Activity],
    ) -> BTreeMap<String, Decimal> {
        let mut ordered: Vec<&Activity> = activities
            .iter()
            .filter(|activity| balances.contains_key(&activity.id))
            .collect();
        ordered.sort_by(|a, b| application_order(a, b));
        let mut closing = BTreeMap::new();
        for activity in ordered {
            let row = &balances[&activity.id];
            closing.insert(row.currency.clone(), row.balance);
        }
        closing.retain(|_, amount: &mut Decimal| !amount.is_zero());
        closing
    }

    #[test]
    fn shows_only_for_cash_and_credit_card_accounts_tracking_transactions() {
        assert!(shows_running_cash_balance(&account(
            account_types::CASH,
            "USD"
        )));
        assert!(shows_running_cash_balance(&account(
            account_types::CREDIT_CARD,
            "USD"
        )));
        assert!(!shows_running_cash_balance(&account(
            account_types::SECURITIES,
            "USD"
        )));

        let mut holdings = account(account_types::CASH, "USD");
        holdings.tracking_mode = TrackingMode::Holdings;
        assert!(!shows_running_cash_balance(&holdings));
    }

    #[test]
    fn an_account_that_does_not_track_cash_shows_no_cash() {
        let mut brokerage = account(account_types::SECURITIES, "USD");
        assert!(shows_cash_balance(&brokerage));
        brokerage.meta = Some(r#"{"accounting":{"cashTracking":"NOT_TRACKED"}}"#.to_string());
        assert!(!shows_cash_balance(&brokerage));
    }

    #[test]
    fn same_instant_rows_apply_by_created_at_then_id() {
        let account = account(account_types::CASH, "USD");
        let mut opening = activity(
            "a",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-02T00:00:00Z",
            dec!(100),
        );
        opening.created_at = at("2026-04-01T00:00:01Z");
        // Same instant and created_at: the id breaks the tie, so "b" first.
        let mut rent = activity(
            "c",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(30),
        );
        rent.created_at = at("2026-04-01T00:00:02Z");
        let mut coffee = activity(
            "b",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(5),
        );
        coffee.created_at = at("2026-04-01T00:00:02Z");
        // Inserted first but dated later: date order wins over created_at.
        let mut salary = activity("d", ACTIVITY_TYPE_DEPOSIT, "2026-04-03T09:00:00Z", dec!(50));
        salary.created_at = at("2026-04-01T00:00:00Z");

        let balances = running_cash_balances(&account, &ledger(&[salary, rent, coffee, opening]))
            .expect("a cash-only history");

        assert_eq!(balances["a"], balance("USD", dec!(100)));
        assert_eq!(balances["b"], balance("USD", dec!(95)));
        assert_eq!(balances["c"], balance("USD", dec!(65)));
        assert_eq!(balances["d"], balance("USD", dec!(115)));
    }

    #[test]
    fn rows_that_are_not_posted_get_no_balance_and_move_nothing() {
        let account = account(account_types::CASH, "USD");
        let deposit = activity(
            "deposit",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-02T00:00:00Z",
            dec!(100),
        );
        let mut pending = activity(
            "pending",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-03T00:00:00Z",
            dec!(40),
        );
        pending.status = ActivityStatus::Pending;
        let mut draft = activity(
            "draft",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-03T00:00:00Z",
            dec!(7),
        );
        draft.status = ActivityStatus::Draft;
        let fee = activity("fee", ACTIVITY_TYPE_FEE, "2026-04-04T00:00:00Z", dec!(2));

        let balances = running_cash_balances(&account, &ledger(&[deposit, pending, draft, fee]))
            .expect("a cash-only history");

        assert!(!balances.contains_key("pending"));
        assert!(!balances.contains_key("draft"));
        assert_eq!(balances["fee"], balance("USD", dec!(98)));
    }

    #[test]
    fn credit_card_interest_is_a_charge_and_a_payment_pays_it_down() {
        let account = account(account_types::CREDIT_CARD, "USD");
        let charge = activity(
            "charge",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(120),
        );
        let interest = activity(
            "interest",
            ACTIVITY_TYPE_INTEREST,
            "2026-04-03T00:00:00Z",
            dec!(3),
        );
        let payment = activity(
            "payment",
            ACTIVITY_TYPE_TRANSFER_IN,
            "2026-04-04T00:00:00Z",
            dec!(100),
        );

        let balances = running_cash_balances(&account, &ledger(&[charge, interest, payment]))
            .expect("a cash-only history");

        assert_eq!(balances["charge"], balance("USD", dec!(-120)));
        assert_eq!(balances["interest"], balance("USD", dec!(-123)));
        assert_eq!(balances["payment"], balance("USD", dec!(-23)));
    }

    #[test]
    fn a_foreign_charge_keeps_its_own_currency_balance() {
        let account = account(account_types::CREDIT_CARD, "CAD");
        let mut home = activity(
            "home",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(40),
        );
        home.currency = "CAD".to_string();
        let abroad = activity(
            "abroad",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-03T00:00:00Z",
            dec!(9.59),
        );

        let balances =
            running_cash_balances(&account, &ledger(&[home, abroad])).expect("a cash-only history");

        assert_eq!(balances["home"], balance("CAD", dec!(-40)));
        assert_eq!(balances["abroad"], balance("USD", dec!(-9.59)));
    }

    #[test]
    fn other_accounts_rows_are_ignored() {
        let account = account(account_types::CASH, "USD");
        let own = activity(
            "own",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-02T00:00:00Z",
            dec!(10),
        );
        let mut other = activity(
            "other",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-01T00:00:00Z",
            dec!(99),
        );
        other.account_id = "someone-else".to_string();

        let balances =
            running_cash_balances(&account, &ledger(&[own, other])).expect("a cash-only history");

        assert_eq!(balances.len(), 1);
        assert_eq!(balances["own"], balance("USD", dec!(10)));
    }

    #[test]
    fn closing_balances_match_the_engine_for_a_cash_account() {
        let account = account(account_types::CASH, "USD");
        let deposit = activity(
            "deposit",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-02T00:00:00Z",
            dec!(1000),
        );
        let withdrawal = activity(
            "withdrawal",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(250.75),
        );
        let fee = activity("fee", ACTIVITY_TYPE_FEE, "2026-04-03T00:00:00Z", dec!(4.5));
        let interest = activity(
            "interest",
            ACTIVITY_TYPE_INTEREST,
            "2026-04-04T00:00:00Z",
            dec!(1.23),
        );
        let transfer_out = activity(
            "transfer-out",
            ACTIVITY_TYPE_TRANSFER_OUT,
            "2026-04-05T00:00:00Z",
            dec!(100),
        );
        let mut euros = activity(
            "euros",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-06T00:00:00Z",
            dec!(80),
        );
        euros.currency = "EUR".to_string();
        let mut split = activity(
            "split",
            ACTIVITY_TYPE_SPLIT,
            "2026-04-07T00:00:00Z",
            dec!(0),
        );
        split.amount = None;
        let mut draft = activity(
            "draft",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-08T00:00:00Z",
            dec!(60),
        );
        draft.status = ActivityStatus::Draft;
        let activities = vec![
            deposit,
            withdrawal,
            fee,
            interest,
            transfer_out,
            euros,
            split,
            draft,
        ];

        let balances =
            running_cash_balances(&account, &ledger(&activities)).expect("a cash-only history");

        assert_eq!(balances["transfer-out"], balance("USD", dec!(645.98)));
        assert_eq!(balances["euros"], balance("EUR", dec!(80)));
        assert_eq!(
            closing_cash(&balances, &activities),
            engine_cash(&account, &activities)
        );
    }

    #[test]
    fn closing_balances_match_the_engine_for_a_credit_card() {
        let account = account(account_types::CREDIT_CARD, "CAD");
        let mut groceries = activity(
            "groceries",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-02T00:00:00Z",
            dec!(84.12),
        );
        groceries.currency = "CAD".to_string();
        let mut refund = activity(
            "refund",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-03T00:00:00Z",
            dec!(20),
        );
        refund.currency = "CAD".to_string();
        refund.subtype = Some("REFUND".to_string());
        let mut interest = activity(
            "interest",
            ACTIVITY_TYPE_INTEREST,
            "2026-04-04T00:00:00Z",
            dec!(2.4),
        );
        interest.currency = "CAD".to_string();
        let abroad = activity(
            "abroad",
            ACTIVITY_TYPE_WITHDRAWAL,
            "2026-04-05T00:00:00Z",
            dec!(9.59),
        );
        let mut payment = activity(
            "payment",
            ACTIVITY_TYPE_TRANSFER_IN,
            "2026-04-06T00:00:00Z",
            dec!(50),
        );
        payment.currency = "CAD".to_string();
        let activities = vec![groceries, refund, interest, abroad, payment];

        let balances =
            running_cash_balances(&account, &ledger(&activities)).expect("a cash-only history");

        assert_eq!(
            closing_cash(&balances, &activities),
            engine_cash(&account, &activities)
        );
    }

    #[test]
    fn an_account_that_held_securities_gets_no_balances() {
        let account = account(account_types::CASH, "CAD");
        let mut deposit = activity(
            "deposit",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-01T00:00:00Z",
            dec!(100),
        );
        deposit.currency = "CAD".to_string();
        let security_row = |id: &str, activity_type: &str, asset_id: &str| {
            let mut row = activity(id, activity_type, "2026-04-02T00:00:00Z", dec!(10));
            row.asset_id = Some(asset_id.to_string());
            row.quantity = Some(dec!(1));
            row.unit_price = Some(dec!(10));
            row
        };

        // The engine books a foreign DRIP's income and purchase in two
        // currencies, and an option sale's sign turns on its multiplier.
        let mut drip = security_row("drip", ACTIVITY_TYPE_DIVIDEND, "AAPL");
        drip.subtype = Some("DRIP".to_string());
        drip.fx_rate = Some(dec!(1.35));
        let mut option_sale = security_row("sale", ACTIVITY_TYPE_SELL, "AAPL261218C00150000");
        option_sale.fee = Some(dec!(15));
        // A trade is a security row even when its asset is a cash symbol.
        let cash_symbol_trade = security_row("conversion", ACTIVITY_TYPE_BUY, "$CASH-EUR");
        for row in [drip, option_sale, cash_symbol_trade] {
            assert!(
                running_cash_balances(&account, &ledger(&[deposit.clone(), row])).is_none(),
                "a security row withholds the balances"
            );
        }

        // A draft trade moves no cash, so the account still has balances.
        let mut draft = security_row("draft", ACTIVITY_TYPE_BUY, "AAPL");
        draft.status = ActivityStatus::Draft;
        assert!(running_cash_balances(&account, &ledger(&[deposit, draft])).is_some());
    }

    #[test]
    fn holding_income_rows_get_no_balances_even_without_an_asset() {
        let account = account(account_types::CASH, "CAD");
        let mut deposit = activity(
            "deposit",
            ACTIVITY_TYPE_DEPOSIT,
            "2026-04-01T00:00:00Z",
            dec!(100),
        );
        deposit.currency = "CAD".to_string();
        let income = |activity_type: &str, subtype: &str| {
            let mut row = activity("income", activity_type, "2026-04-02T00:00:00Z", dec!(10));
            row.currency = "CAD".to_string();
            row.subtype = Some(subtype.to_string());
            row.quantity = Some(dec!(1));
            row.unit_price = Some(dec!(10));
            row
        };

        // The engine books a composite's income and the purchase it pays for,
        // which net to nothing here; the row's own amount counts only the
        // income. A return of capital reduces a holding the account may not
        // have, and then the engine rejects it.
        for (activity_type, subtype) in [
            (ACTIVITY_TYPE_DIVIDEND, "DRIP"),
            (ACTIVITY_TYPE_DIVIDEND, "DIVIDEND_IN_KIND"),
            (ACTIVITY_TYPE_INTEREST, "STAKING_REWARD"),
            (ACTIVITY_TYPE_DIVIDEND, "RETURN_OF_CAPITAL"),
        ] {
            assert!(
                running_cash_balances(
                    &account,
                    &ledger(&[deposit.clone(), income(activity_type, subtype)])
                )
                .is_none(),
                "{subtype} withholds the balances"
            );
        }

        // Plain income moves only cash, so the account keeps them.
        let mut dividend = income(ACTIVITY_TYPE_DIVIDEND, "");
        dividend.subtype = None;
        let activities = vec![deposit, dividend];
        let balances =
            running_cash_balances(&account, &ledger(&activities)).expect("a cash-only history");
        assert_eq!(
            closing_cash(&balances, &activities),
            engine_cash(&account, &activities)
        );
    }

    /// Every activity type, subtype, asset and currency the ledger can meet,
    /// one row after an opening deposit: the ledger either withholds the
    /// balances or ends where the engine does. Hand-picked cases missed rows
    /// the engine books differently; this covers the space instead.
    #[test]
    fn every_row_kind_is_withheld_or_matches_the_engine() {
        let types = [
            ACTIVITY_TYPE_BUY,
            ACTIVITY_TYPE_SELL,
            ACTIVITY_TYPE_DIVIDEND,
            ACTIVITY_TYPE_INTEREST,
            ACTIVITY_TYPE_DEPOSIT,
            ACTIVITY_TYPE_WITHDRAWAL,
            ACTIVITY_TYPE_TRANSFER_IN,
            ACTIVITY_TYPE_TRANSFER_OUT,
            ACTIVITY_TYPE_FEE,
            ACTIVITY_TYPE_TAX,
            ACTIVITY_TYPE_SPLIT,
            ACTIVITY_TYPE_CREDIT,
            ACTIVITY_TYPE_ADJUSTMENT,
            ACTIVITY_TYPE_UNKNOWN,
        ];
        let subtypes = [
            None,
            Some(ACTIVITY_SUBTYPE_DRIP),
            Some(ACTIVITY_SUBTYPE_STAKING_REWARD),
            Some(ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND),
            Some(ACTIVITY_SUBTYPE_BONUS),
            Some(ACTIVITY_SUBTYPE_REBATE),
            Some(ACTIVITY_SUBTYPE_REFUND),
            Some(ACTIVITY_SUBTYPE_REIMBURSEMENT),
            Some(ACTIVITY_SUBTYPE_OPTION_EXPIRY),
            Some(ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL),
            Some(ACTIVITY_SUBTYPE_NOTIONAL_DISTRIBUTION),
            Some(ACTIVITY_SUBTYPE_POSITION_OPEN),
            Some(ACTIVITY_SUBTYPE_POSITION_CLOSE),
        ];
        let assets = [None, Some("$CASH-USD"), Some("AAPL"), Some(OPTION)];
        // The account's own currency, a foreign one with no rate, and a
        // foreign one at a broker rate.
        let currencies = [("CAD", None), ("USD", None), ("USD", Some(dec!(1.35)))];

        let mut checked = 0;
        let mut compared = 0;
        let mut failures = Vec::new();
        for account_type in [account_types::CASH, account_types::CREDIT_CARD] {
            let account = account(account_type, "CAD");
            for activity_type in types {
                for subtype in subtypes {
                    for asset in assets {
                        for (currency, fx_rate) in currencies {
                            let mut deposit = activity(
                                "opening",
                                ACTIVITY_TYPE_DEPOSIT,
                                "2026-04-01T00:00:00Z",
                                dec!(1000),
                            );
                            deposit.currency = "CAD".to_string();
                            let mut row =
                                activity("row", activity_type, "2026-04-02T00:00:00Z", dec!(6));
                            row.subtype = subtype.map(str::to_string);
                            row.asset_id = asset.map(str::to_string);
                            row.quantity = Some(dec!(2));
                            row.unit_price = Some(dec!(3));
                            row.fee = Some(dec!(1));
                            row.currency = currency.to_string();
                            row.fx_rate = fx_rate;
                            let activities = vec![deposit, row];

                            checked += 1;
                            let Some(balances) =
                                running_cash_balances(&account, &ledger(&activities))
                            else {
                                continue;
                            };
                            compared += 1;
                            let ledger = closing_cash(&balances, &activities);
                            let engine = engine_cash_with_assets(&account, &activities);
                            if ledger != engine {
                                failures.push(format!(
                                    "{account_type} {activity_type} {subtype:?} asset={asset:?} \
                                     {currency} fx={fx_rate:?}: ledger {ledger:?}, engine {engine:?}"
                                ));
                            }
                        }
                    }
                }
            }
        }

        assert_eq!(checked, 2 * 14 * 13 * 4 * 3);
        // Cash rows must still reach the comparison, or the table proves nothing.
        assert!(
            compared >= 1_500,
            "only {compared} of {checked} cases reached the engine"
        );
        assert!(
            failures.is_empty(),
            "{} of {checked} cases diverge:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    const OPTION: &str = "AAPL261218C00150000";

    /// `engine_cash` with the table's equity and option known to the engine,
    /// as the facts loader would supply them for rows that name them.
    fn engine_cash_with_assets(
        account: &Account,
        activities: &[Activity],
    ) -> BTreeMap<String, Decimal> {
        let asset = |id: &str, instrument_type: &str| RawAsset {
            id: id.to_string(),
            quote_currency: "USD".to_string(),
            kind: "INVESTMENT".to_string(),
            instrument_type: Some(instrument_type.to_string()),
            contract_multiplier: None,
            alternative: false,
        };
        engine_cash_for(
            account,
            vec![asset("AAPL", "EQUITY"), asset(OPTION, "OPTION")],
            activities,
        )
    }
}
