//! Cash balances tool — per-account, per-currency cash positions.
//!
//! Uses the holdings service (which builds cash holdings from snapshots)
//! to return per-account cash balances. Amounts are in original currency;
//! totals use the captured holdings conversion and stay unknown when inputs are missing.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_cash_balances tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCashBalancesArgs {
    /// Account ID. Omit for all accounts.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// Per-currency cash balance within an account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashBalanceEntry {
    pub currency: String,
    pub amount: Decimal,
}

/// Per-account cash summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCashSummary {
    pub account_id: String,
    pub account_name: String,
    pub account_currency: String,
    /// Individual cash positions by currency.
    pub balances: Option<Vec<CashBalanceEntry>>,
    /// Accounting availability: ready, pending, or unavailable.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// Total cash converted to account currency.
    pub total_account_currency: Option<Decimal>,
    /// Total cash converted to base currency.
    pub total_base_currency: Option<Decimal>,
}

/// Output envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCashBalancesOutput {
    pub accounts: Vec<AccountCashSummary>,
    pub grand_total_base: Option<Decimal>,
    pub base_currency: String,
}

/// Tool to get cash balances.
pub struct GetCashBalances;

#[async_trait::async_trait]
impl AgentTool for GetCashBalances {
    fn name(&self) -> &'static str {
        "get_cash_balances"
    }

    fn description(&self) -> &'static str {
        "Get cash balances for investment accounts. Returns per-account, \
                per-currency cash positions with totals in both account currency and base \
                currency. Use this when the user asks about cash, available funds, \
                uninvested money, or account balances. Unavailable totals are null; per-currency balances and accounting status remain available."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "accountId": {
                    "type": "string",
                    "description": "Account ID. Omit for all accounts."
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetCashBalancesArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();

        let accounts = env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let mut account_map: HashMap<String, (String, String)> = accounts
            .iter()
            .map(|a| (a.id.clone(), (a.name.clone(), a.currency.clone())))
            .collect();

        let target_account_id = args.account_id.as_deref().filter(|id| !id.is_empty());
        let target_ids: Vec<String> = if let Some(target_account_id) = target_account_id {
            vec![target_account_id.to_string()]
        } else {
            accounts.iter().map(|a| a.id.clone()).collect()
        };
        if let Some(account_id) = target_account_id {
            if !account_map.contains_key(account_id) {
                let account = env
                    .account_service()
                    .get_account(account_id)
                    .map_err(|error| AgentToolError::ExecutionFailed(error.to_string()))?;
                account_map.insert(account.id, (account.name, account.currency));
            }
        }
        let scope = env
            .holdings_service()
            .get_holdings_by_account_scope(&target_ids, &base_currency)
            .await
            .map_err(|error| AgentToolError::ExecutionFailed(error.to_string()))?;
        let output = cash_balances_output(&target_ids, &account_map, scope, base_currency);
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

fn cash_balances_output(
    target_ids: &[String],
    account_map: &HashMap<String, (String, String)>,
    scope: wealthfolio_core::holdings::HoldingsScope,
    base_currency: String,
) -> GetCashBalancesOutput {
    let mut summaries = Vec::new();
    let mut grand_total_base = scope
        .incomplete_accounts
        .is_empty()
        .then_some(Decimal::ZERO);
    for account_id in target_ids {
        let (account_name, account_currency) = account_map
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| (account_id.clone(), base_currency.clone()));
        if let Some(issue) = scope
            .incomplete_accounts
            .iter()
            .find(|issue| issue.account_id == *account_id)
        {
            summaries.push(AccountCashSummary {
                account_id: account_id.clone(),
                account_name,
                account_currency,
                balances: None,
                status: issue.status.into(),
                reason_code: Some(issue.reason_code.into()),
                total_account_currency: None,
                total_base_currency: None,
            });
            continue;
        }
        let cash: Vec<_> = scope
            .holdings
            .iter()
            .filter(|holding| {
                holding.account_id == *account_id
                    && holding.holding_type == wealthfolio_core::holdings::HoldingType::Cash
            })
            .collect();
        if cash.is_empty() {
            continue;
        }
        let balances: Vec<_> = cash
            .iter()
            .map(|holding| CashBalanceEntry {
                currency: holding.local_currency.clone(),
                amount: holding.quantity,
            })
            .collect();
        let total_base_currency: Option<Decimal> =
            cash.iter().map(|holding| holding.market_value.base).sum();
        let total_account_currency = if balances
            .iter()
            .all(|balance| balance.currency == account_currency)
        {
            Some(balances.iter().map(|balance| balance.amount).sum())
        } else if account_currency == base_currency {
            total_base_currency
        } else {
            None
        };
        grand_total_base = grand_total_base
            .zip(total_base_currency)
            .map(|(total, value)| total + value);
        summaries.push(AccountCashSummary {
            account_id: account_id.clone(),
            account_name,
            account_currency,
            balances: Some(balances),
            status: "ready".into(),
            reason_code: None,
            total_account_currency,
            total_base_currency,
        });
    }
    GetCashBalancesOutput {
        accounts: summaries,
        grand_total_base,
        base_currency,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wealthfolio_core::holdings::{
        Holding, HoldingType, HoldingsScope, IncompleteHoldingsAccount, MonetaryValue,
    };

    fn cash(account: &str, currency: &str, amount: i64, base: Option<i64>) -> Holding {
        Holding {
            id: format!("{account}-{currency}"),
            account_id: account.into(),
            holding_type: HoldingType::Cash,
            is_closed: false,
            instrument: None,
            asset_kind: None,
            quantity: Decimal::from(amount),
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: currency.into(),
            base_currency: "CAD".into(),
            translate_observed_basis: false,
            fx_rate: None,
            market_value: MonetaryValue::new(Decimal::from(amount), base.map(Decimal::from)),
            cost_basis: None,
            price: None,
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: None,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 11, 6).unwrap(),
            metadata: None,
            source_account_ids: Vec::new(),
        }
    }

    fn output(scope: HoldingsScope) -> GetCashBalancesOutput {
        cash_balances_output(
            &["cad".into(), "usd".into()],
            &HashMap::from([
                ("cad".into(), ("CAD account".into(), "CAD".into())),
                ("usd".into(), ("USD account".into(), "USD".into())),
            ]),
            scope,
            "CAD".into(),
        )
    }

    #[test]
    fn missing_fx_keeps_native_cash_and_healthy_peers_without_a_partial_grand_total() {
        let result = output(HoldingsScope {
            holdings: vec![
                cash("cad", "CAD", 50, Some(50)),
                cash("usd", "USD", 100, None),
            ],
            incomplete_accounts: Vec::new(),
        });
        assert_eq!(result.accounts.len(), 2);
        assert_eq!(
            result.accounts[0].total_base_currency,
            Some(Decimal::from(50))
        );
        assert_eq!(
            result.accounts[1].balances.as_ref().unwrap()[0].amount,
            Decimal::from(100)
        );
        assert_eq!(
            result.accounts[1].total_account_currency,
            Some(Decimal::from(100))
        );
        assert_eq!(result.accounts[1].total_base_currency, None);
        assert_eq!(result.grand_total_base, None);
        let json = serde_json::to_value(result).unwrap();
        assert!(json["grandTotalBase"].is_null());
        assert!(json["accounts"][1]["totalBaseCurrency"].is_null());
    }

    #[test]
    fn pending_and_unavailable_accounts_do_not_hide_known_cash() {
        for status in ["pending", "unavailable"] {
            let result = output(HoldingsScope {
                holdings: vec![cash("cad", "CAD", 50, Some(50))],
                incomplete_accounts: vec![IncompleteHoldingsAccount {
                    account_id: "usd".into(),
                    status,
                    reason_code: "test",
                }],
            });
            assert_eq!(
                result.accounts[0].total_base_currency,
                Some(Decimal::from(50))
            );
            assert_eq!(result.accounts[1].status, status);
            assert!(result.accounts[1].balances.is_none());
            assert!(result.accounts[1].total_base_currency.is_none());
            assert!(result.grand_total_base.is_none());
        }
    }

    #[test]
    fn mixed_currencies_need_a_known_account_conversion_but_preserve_known_base_cash() {
        let result = output(HoldingsScope {
            holdings: vec![
                cash("usd", "CAD", 10, Some(10)),
                cash("usd", "USD", 20, Some(30)),
            ],
            incomplete_accounts: Vec::new(),
        });
        assert_eq!(result.accounts[0].total_account_currency, None);
        assert_eq!(
            result.accounts[0].total_base_currency,
            Some(Decimal::from(40))
        );
        assert_eq!(result.grand_total_base, Some(Decimal::from(40)));
        assert_eq!(
            output(HoldingsScope::default()).grand_total_base,
            Some(Decimal::ZERO)
        );
    }
}
