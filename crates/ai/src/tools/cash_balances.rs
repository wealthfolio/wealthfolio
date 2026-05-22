//! Cash balances tool — per-account, per-currency cash positions.
//!
//! Uses the holdings service (which builds cash holdings from snapshots)
//! to return per-account cash balances. Amounts are in original currency;
//! per-account totals use the snapshot's pre-computed base-currency conversion.

use rig::{completion::ToolDefinition, tool::Tool};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::env::AiEnvironment;
use crate::error::AiError;

// ============================================================================
// Tool Arguments and Output
// ============================================================================

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCashBalancesArgs {
    /// Account ID, or "TOTAL" for all accounts. Default: "TOTAL".
    #[serde(default = "default_account_id")]
    pub account_id: String,
}

fn default_account_id() -> String {
    "TOTAL".to_string()
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

// ============================================================================
// Tool Implementation
// ============================================================================

pub struct GetCashBalancesTool<E: AiEnvironment> {
    env: Arc<E>,
    base_currency: String,
}

impl<E: AiEnvironment> GetCashBalancesTool<E> {
    pub fn new(env: Arc<E>, base_currency: String) -> Self {
        Self { env, base_currency }
    }
}

impl<E: AiEnvironment> Clone for GetCashBalancesTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
            base_currency: self.base_currency.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetCashBalancesTool<E> {
    const NAME: &'static str = "get_cash_balances";

    type Error = AiError;
    type Args = GetCashBalancesArgs;
    type Output = GetCashBalancesOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get cash balances for investment accounts. Returns per-account, \
                per-currency cash positions with totals in both account currency and base \
                currency. Use this when the user asks about cash, available funds, \
                uninvested money, or account balances."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "accountId": {
                        "type": "string",
                        "description": "Account ID, or 'TOTAL' for all accounts. Default: 'TOTAL'."
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let accounts = self
            .env
            .account_service()
            .get_active_accounts()
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let account_map: HashMap<String, (String, String)> = accounts
            .iter()
            .map(|a| (a.id.clone(), (a.name.clone(), a.currency.clone())))
            .collect();

        let is_total = args.account_id == "TOTAL" || args.account_id.is_empty();
        let target_ids: Vec<String> = if is_total {
            accounts.iter().map(|a| a.id.clone()).collect()
        } else {
            vec![args.account_id.clone()]
        };
        let valuation_by_account: HashMap<_, _> = self
            .env
            .valuation_service()
            .get_latest_valuations(&target_ids)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
            .into_iter()
            .map(|valuation| (valuation.account_id.clone(), valuation))
            .collect();

        let mut summaries = Vec::new();
        let mut grand_total_base = Decimal::ZERO;

        for account_id in &target_ids {
            let holdings = self
                .env
                .holdings_service()
                .get_holdings(account_id, &self.base_currency)
                .await
                .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

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
                .unwrap_or_else(|| (account_id.clone(), self.base_currency.clone()));

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
            let all_in_base_currency = balances.iter().all(|b| b.currency == self.base_currency);
            let valuation = valuation_by_account.get(account_id);

            let total_base: Decimal = cash_holdings.iter().map(|h| h.market_value.base).sum();
            let effective_base = if total_base != Decimal::ZERO {
                total_base
            } else if let Some(valuation) = valuation {
                valuation.cash_balance * valuation.fx_rate_to_base
            } else if all_in_base_currency {
                raw_total
            } else {
                return Err(AiError::ToolExecutionFailed(format!(
                    "Cash balance for account '{}' includes currencies that cannot be converted to base currency.",
                    account_id
                )));
            };

            let total_account_currency = if let Some(valuation) = valuation {
                valuation.cash_balance
            } else if all_in_account_currency {
                raw_total
            } else if account_currency == self.base_currency {
                effective_base
            } else {
                return Err(AiError::ToolExecutionFailed(format!(
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

        Ok(GetCashBalancesOutput {
            accounts: summaries,
            grand_total_base,
            base_currency: self.base_currency.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::{
        MockAccountService, MockEnvironment, MockHoldingsService, MockValuationService,
    };
    use chrono::{NaiveDate, Utc};
    use rust_decimal::Decimal;
    use wealthfolio_core::{
        accounts::Account,
        holdings::{Holding, HoldingType, Instrument, MonetaryValue},
        valuation::DailyAccountValuation,
    };

    fn cash_holding(
        account_id: &str,
        currency: &str,
        amount: Decimal,
        base_value: Decimal,
    ) -> Holding {
        Holding {
            id: format!("CASH-{}-{}", account_id, currency),
            account_id: account_id.to_string(),
            holding_type: HoldingType::Cash,
            instrument: Some(Instrument {
                id: format!("cash:{}", currency),
                symbol: currency.to_string(),
                name: Some(format!("Cash ({})", currency)),
                currency: currency.to_string(),
                notes: None,
                pricing_mode: "MANUAL".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            }),
            asset_kind: None,
            quantity: amount,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: currency.to_string(),
            base_currency: "CAD".to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: amount,
                base: base_value,
            },
            cost_basis: None,
            price: Some(Decimal::ONE),
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
            source_account_ids: vec![],
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_get_cash_balances_basic() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetCashBalancesTool::new(env, "USD".to_string());
        let result = tool
            .call(GetCashBalancesArgs {
                account_id: "TOTAL".to_string(),
            })
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().base_currency, "USD");
    }

    #[tokio::test]
    async fn test_get_cash_balances_uses_valuation_for_account_currency_total() {
        let account = Account {
            id: "acct-1".to_string(),
            name: "CAD Account".to_string(),
            currency: "CAD".to_string(),
            is_active: true,
            ..Default::default()
        };
        let valuation_date = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        let env = Arc::new(MockEnvironment {
            base_currency: "CAD".to_string(),
            account_service: Arc::new(MockAccountService {
                accounts: vec![account],
            }),
            holdings_service: Arc::new(MockHoldingsService {
                holdings: vec![
                    cash_holding("acct-1", "CAD", Decimal::from(1000), Decimal::from(1000)),
                    cash_holding("acct-1", "USD", Decimal::from(1000), Decimal::from(1350)),
                ],
            }),
            valuation_service: Arc::new(MockValuationService {
                valuations: vec![DailyAccountValuation {
                    id: "valuation-1".to_string(),
                    account_id: "acct-1".to_string(),
                    valuation_date,
                    account_currency: "CAD".to_string(),
                    base_currency: "CAD".to_string(),
                    fx_rate_to_base: Decimal::ONE,
                    cash_balance: Decimal::from(2350),
                    investment_market_value: Decimal::ZERO,
                    total_value: Decimal::from(2350),
                    cost_basis: Decimal::ZERO,
                    net_contribution: Decimal::ZERO,
                    calculated_at: Utc::now(),
                }],
            }),
            ..MockEnvironment::new()
        });
        let tool = GetCashBalancesTool::new(env, "CAD".to_string());

        let result = tool
            .call(GetCashBalancesArgs {
                account_id: "TOTAL".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(result.accounts.len(), 1);
        assert_eq!(
            result.accounts[0].total_account_currency,
            Decimal::from(2350)
        );
        assert_eq!(result.accounts[0].total_base_currency, Decimal::from(2350));
        assert_eq!(result.grand_total_base, Decimal::from(2350));
    }
}
