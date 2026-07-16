//! Cash balances tool — per-account, per-currency cash positions.
//!
//! Uses the holdings service (which builds cash holdings from snapshots)
//! to return per-account cash balances. Amounts are in original currency;
//! per-account totals use the snapshot's pre-computed base-currency conversion.

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
    pub balances: Vec<CashBalanceEntry>,
    /// Total cash converted to account currency.
    pub total_account_currency: Decimal,
    /// Total cash converted to base currency.
    pub total_base_currency: Decimal,
}

/// Output envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCashBalancesOutput {
    pub accounts: Vec<AccountCashSummary>,
    pub grand_total_base: Decimal,
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
                uninvested money, or account balances."
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

        let account_map: HashMap<String, (String, String)> = accounts
            .iter()
            .map(|a| (a.id.clone(), (a.name.clone(), a.currency.clone())))
            .collect();

        let target_account_id = args.account_id.as_deref().filter(|id| !id.is_empty());
        let target_ids: Vec<String> = if let Some(target_account_id) = target_account_id {
            vec![target_account_id.to_string()]
        } else {
            accounts.iter().map(|a| a.id.clone()).collect()
        };
        let valuation_by_account: HashMap<_, _> = env
            .valuation_service()
            .get_latest_valuations(&target_ids)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            .into_iter()
            .map(|valuation| (valuation.account_id.clone(), valuation))
            .collect();

        let mut summaries = Vec::new();
        let mut grand_total_base = Decimal::ZERO;

        for account_id in &target_ids {
            let holdings = env
                .holdings_service()
                .get_holdings(account_id, &base_currency)
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

            let cash_holdings: Vec<_> = holdings
                .into_iter()
                .filter(|h| h.holding_type == wealthfolio_core::holdings::HoldingType::Cash)
                .collect();

            if cash_holdings.is_empty() {
                continue;
            }

            let (account_name, account_currency) = account_map
                .get(account_id)
                .cloned()
                .unwrap_or_else(|| (account_id.clone(), base_currency.clone()));

            let mut balances = Vec::new();

            for h in &cash_holdings {
                let currency = h
                    .instrument
                    .as_ref()
                    .map(|i| i.currency.clone())
                    .unwrap_or_else(|| h.local_currency.clone());
                balances.push(CashBalanceEntry {
                    currency,
                    amount: h.quantity,
                });
            }

            let raw_total: Decimal = balances.iter().map(|b| b.amount).sum();
            let all_in_account_currency = balances.iter().all(|b| b.currency == account_currency);
            let all_in_base_currency = balances.iter().all(|b| b.currency == base_currency);
            let valuation = valuation_by_account.get(account_id);

            let total_base: Decimal = cash_holdings.iter().map(|h| h.market_value.base).sum();
            let effective_base = if total_base != Decimal::ZERO {
                total_base
            } else if let Some(valuation) = valuation {
                valuation.cash_balance * valuation.fx_rate_to_base
            } else if all_in_base_currency {
                raw_total
            } else {
                return Err(AgentToolError::ExecutionFailed(format!(
                    "Cash balance for account '{}' includes currencies that cannot be converted to base currency.",
                    account_id
                )));
            };

            let total_account_currency = if let Some(valuation) = valuation {
                valuation.cash_balance
            } else if all_in_account_currency {
                raw_total
            } else if account_currency == base_currency {
                effective_base
            } else {
                return Err(AgentToolError::ExecutionFailed(format!(
                    "Cash balance for account '{}' includes mixed currencies without an account-currency total.",
                    account_id
                )));
            };

            grand_total_base += effective_base;
            summaries.push(AccountCashSummary {
                account_id: account_id.clone(),
                account_name,
                account_currency,
                balances,
                total_account_currency,
                total_base_currency: effective_base,
            });
        }

        let output = GetCashBalancesOutput {
            accounts: summaries,
            grand_total_base,
            base_currency,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
