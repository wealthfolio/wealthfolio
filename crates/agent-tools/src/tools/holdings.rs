//! Holdings tool - fetch portfolio holdings.

use rust_decimal::{prelude::ToPrimitive, Decimal};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::accounts::{account_supports_purpose, AccountPurpose};
use wealthfolio_core::holdings::Holding;

use crate::constants::MAX_HOLDINGS;
use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Arguments for the get_holdings tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHoldingsArgs {
    /// Account ID. Omit for all accounts.
    #[serde(default)]
    pub account_id: Option<String>,

    /// View mode: "table", "treemap", or "both". Default is "treemap".
    /// - "table": Show holdings as a detailed list with values and gains
    /// - "treemap": Show portfolio composition chart with daily performance colors
    /// - "both": Show treemap first, then table below
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
}

fn default_view_mode() -> String {
    "treemap".to_string()
}

/// DTO for holding data in tool output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingDto {
    pub account: String,
    pub symbol: String,
    pub name: Option<String>,
    pub holding_type: String,
    pub quantity: f64,
    pub market_value_base: f64,
    pub cost_basis_base: Option<f64>,
    /// Base-currency unrealized return, including FX effects.
    pub unrealized_gain_pct: Option<f64>,
    pub total_gain_base: Option<f64>,
    /// Base-currency total gain return, including FX effects.
    pub total_gain_pct: Option<f64>,
    pub income_base: Option<f64>,
    pub total_return_base: Option<f64>,
    /// Base-currency total return, including FX effects.
    pub total_return_pct: Option<f64>,
    pub return_basis_base: Option<f64>,
    pub day_change_pct: Option<f64>,
    pub weight: f64,
    /// Portfolio base currency used by the monetary fields above.
    pub currency: String,
}

/// Output envelope for holdings tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHoldingsOutput {
    pub holdings: Vec<HoldingDto>,
    pub total_value: f64,
    pub currency: String,
    pub account_scope: String,
    /// View mode requested: "table", "treemap", or "both"
    pub view_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

/// Tool to get portfolio holdings.
pub struct GetHoldings;

fn base_percentage(amount: Option<Decimal>, basis: Option<Decimal>) -> Option<f64> {
    let amount = amount?;
    let basis = basis?;
    let exposure = basis.abs();
    if exposure > Decimal::ZERO {
        (amount / exposure).to_f64()
    } else if amount.is_zero() {
        Some(0.0)
    } else {
        None
    }
}

fn holding_to_dto(h: Holding, account: String) -> HoldingDto {
    let (symbol, name) = h
        .instrument
        .as_ref()
        .map(|i| (i.symbol.clone(), i.name.clone()))
        .unwrap_or_else(|| ("CASH".to_string(), None));

    let holding_type = match h.holding_type {
        wealthfolio_core::holdings::HoldingType::Cash => "Cash",
        wealthfolio_core::holdings::HoldingType::Security => "Security",
        wealthfolio_core::holdings::HoldingType::AlternativeAsset => "AlternativeAsset",
    };

    let cost_basis_base = h.cost_basis.as_ref().map(|value| value.base);
    let return_basis_base = h.return_basis.as_ref().map(|value| value.base);
    let unrealized_gain_base = h.unrealized_gain.as_ref().map(|value| value.base);
    let total_gain_base = h.total_gain.as_ref().map(|value| value.base);
    let total_return_base = h.total_return.as_ref().map(|value| value.base);

    HoldingDto {
        account,
        symbol,
        name,
        holding_type: holding_type.to_string(),
        quantity: h.quantity.to_f64().unwrap_or(0.0),
        market_value_base: h.market_value.base.to_f64().unwrap_or(0.0),
        cost_basis_base: cost_basis_base.and_then(|value| value.to_f64()),
        unrealized_gain_pct: base_percentage(unrealized_gain_base, cost_basis_base),
        total_gain_base: total_gain_base.and_then(|value| value.to_f64()),
        total_gain_pct: base_percentage(total_gain_base, return_basis_base),
        income_base: h.income.as_ref().and_then(|v| v.base.to_f64()),
        total_return_base: total_return_base.and_then(|value| value.to_f64()),
        total_return_pct: base_percentage(total_return_base, return_basis_base),
        return_basis_base: return_basis_base.and_then(|value| value.to_f64()),
        day_change_pct: h.day_change_pct.and_then(|d| d.to_f64()),
        weight: h.weight.to_f64().unwrap_or(0.0),
        currency: h.base_currency,
    }
}

#[async_trait::async_trait]
impl AgentTool for GetHoldings {
    fn name(&self) -> &'static str {
        "get_holdings"
    }

    fn description(&self) -> &'static str {
        "Get portfolio holdings for an account or all accounts. Returns symbol, quantity, market value, cost basis, and gain/loss for each holding. Gain/loss amounts and percentages are expressed in the portfolio base currency and include FX effects. Omit accountId for aggregate holdings across all accounts. Use viewMode to control display: 'treemap' for visual composition chart with daily performance, 'table' for detailed list, or 'both' to show both views."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "accountId": {
                    "type": "string",
                    "description": "Account ID to get holdings for. Omit for all accounts."
                },
                "viewMode": {
                    "type": "string",
                    "enum": ["table", "treemap", "both"],
                    "description": "Display mode: 'treemap' for composition chart with daily gains (best for 'how is my portfolio today?'), 'table' for detailed list, 'both' for treemap + table",
                    "default": "treemap"
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        use std::collections::HashMap;

        let args: GetHoldingsArgs = serde_json::from_value(args)?;
        let base_currency = env.base_currency();
        let account_id = args.account_id.as_deref().filter(|id| !id.is_empty());

        let holdings = if let Some(account_id) = account_id {
            let account = env
                .account_service()
                .get_account(account_id)
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            if !account_supports_purpose(&account.account_type, AccountPurpose::Holdings) {
                Vec::new()
            } else {
                env.holdings_service()
                    .get_holdings(account_id, &base_currency)
                    .await
                    .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            }
        } else {
            let accounts = env
                .account_service()
                .get_active_non_archived_accounts()
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
            let account_ids: Vec<String> = accounts
                .into_iter()
                .filter(|account| {
                    account_supports_purpose(&account.account_type, AccountPurpose::Holdings)
                })
                .map(|account| account.id)
                .collect();
            env.holdings_service()
                .get_holdings_for_accounts(&account_ids, &base_currency, "all")
                .await
                .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        };

        // Build account_id → name lookup
        let accounts = env
            .account_service()
            .list_accounts(None, None, None)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        let account_names: HashMap<String, String> =
            accounts.into_iter().map(|a| (a.id, a.name)).collect();

        let original_count = holdings.len();

        // Convert to DTOs, filtering out cash positions, and apply limit
        let holdings_dto: Vec<HoldingDto> = holdings
            .into_iter()
            .filter(|h| h.holding_type != wealthfolio_core::holdings::HoldingType::Cash)
            .take(MAX_HOLDINGS)
            .map(|h| {
                let account = account_names
                    .get(&h.account_id)
                    .cloned()
                    .unwrap_or_else(|| h.account_id.clone());
                holding_to_dto(h, account)
            })
            .collect();

        let returned_count = holdings_dto.len();
        let total_value: f64 = holdings_dto.iter().map(|h| h.market_value_base).sum();
        let truncated = original_count > returned_count;

        let output = GetHoldingsOutput {
            holdings: holdings_dto,
            total_value,
            currency: base_currency,
            account_scope: account_id.unwrap_or("all").to_string(),
            view_mode: args.view_mode.clone(),
            truncated: if truncated { Some(true) } else { None },
            original_count: if truncated {
                Some(original_count)
            } else {
                None
            },
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{base_percentage, holding_to_dto};
    use chrono::NaiveDate;
    use rust_decimal::Decimal;
    use wealthfolio_core::holdings::{Holding, HoldingType, MonetaryValue};

    #[test]
    fn base_percentage_uses_signed_amount_and_absolute_basis() {
        assert_eq!(
            base_percentage(Some(Decimal::from(-20)), Some(Decimal::from(50))),
            Some(-0.4)
        );
        assert_eq!(
            base_percentage(Some(Decimal::from(20)), Some(Decimal::from(-50))),
            Some(0.4)
        );
    }

    #[test]
    fn base_percentage_handles_zero_and_missing_basis() {
        assert_eq!(
            base_percentage(Some(Decimal::ZERO), Some(Decimal::ZERO)),
            Some(0.0)
        );
        assert_eq!(
            base_percentage(Some(Decimal::ONE), Some(Decimal::ZERO)),
            None
        );
        assert_eq!(base_percentage(Some(Decimal::ONE), None), None);
    }

    #[test]
    fn holding_dto_labels_base_currency_amounts_with_base_currency() {
        let holding = Holding {
            id: "holding-1".to_string(),
            account_id: "account-1".to_string(),
            holding_type: HoldingType::Security,
            instrument: None,
            asset_kind: None,
            quantity: Decimal::ONE,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "USD".to_string(),
            base_currency: "CAD".to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: Decimal::from(80),
                base: Decimal::from(100),
            },
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
            weight: Decimal::ZERO,
            as_of_date: NaiveDate::from_ymd_opt(2026, 7, 13).unwrap(),
            metadata: None,
            source_account_ids: Vec::new(),
        };

        let dto = holding_to_dto(holding, "Account".to_string());

        assert_eq!(dto.market_value_base, 100.0);
        assert_eq!(dto.currency, "CAD");
    }
}
