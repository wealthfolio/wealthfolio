//! Private-assets tools - read-only access to the private-assets projection layer.

use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::private_assets::{
    PrivateAssetCurrentTotals, PrivateAssetDetail, PrivateAssetHistoricalPoint, PrivateAssetListRow,
};

use crate::env::AiEnvironment;
use crate::error::AiError;

use super::constants::MAX_HOLDINGS;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPrivateAssetRowsArgs {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPrivateAssetRowsOutput {
    pub rows: Vec<PrivateAssetListRow>,
    pub count: usize,
    pub include_archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_count: Option<usize>,
}

pub struct ListPrivateAssetRowsTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> ListPrivateAssetRowsTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for ListPrivateAssetRowsTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for ListPrivateAssetRowsTool<E> {
    const NAME: &'static str = "list_private_asset_rows";

    type Error = AiError;
    type Args = ListPrivateAssetRowsArgs;
    type Output = ListPrivateAssetRowsOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List private assets from the private-assets ledger with latest snapshot, freshness state, strategy, and manager/direct context.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "includeArchived": {
                        "type": "boolean",
                        "description": "Whether to include archived private assets",
                        "default": false
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let rows = self
            .env
            .private_asset_projection_service()
            .list_private_asset_rows(args.include_archived)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let original_count = rows.len();
        let rows: Vec<PrivateAssetListRow> = rows.into_iter().take(MAX_HOLDINGS).collect();
        let returned_count = rows.len();
        let truncated = original_count > returned_count;

        Ok(ListPrivateAssetRowsOutput {
            rows,
            count: returned_count,
            include_archived: args.include_archived,
            truncated: if truncated { Some(true) } else { None },
            original_count: if truncated {
                Some(original_count)
            } else {
                None
            },
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetDetailArgs {
    pub private_asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetDetailOutput {
    pub private_asset_id: String,
    pub detail: Option<PrivateAssetDetail>,
}

pub struct GetPrivateAssetDetailTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> GetPrivateAssetDetailTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for GetPrivateAssetDetailTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetPrivateAssetDetailTool<E> {
    const NAME: &'static str = "get_private_asset_detail";

    type Error = AiError;
    type Args = GetPrivateAssetDetailArgs;
    type Output = GetPrivateAssetDetailOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get detail for one private asset, including fund manager, snapshots, sub-assets, and freshness.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "privateAssetId": {
                        "type": "string",
                        "description": "Private asset ID from list_private_asset_rows"
                    }
                },
                "required": ["privateAssetId"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let detail = self
            .env
            .private_asset_projection_service()
            .get_private_asset_detail(&args.private_asset_id)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        Ok(GetPrivateAssetDetailOutput {
            private_asset_id: args.private_asset_id,
            detail,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetCurrentTotalsArgs {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetCurrentTotalsOutput {
    pub include_archived: bool,
    pub totals: PrivateAssetCurrentTotals,
}

pub struct GetPrivateAssetCurrentTotalsTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> GetPrivateAssetCurrentTotalsTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for GetPrivateAssetCurrentTotalsTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetPrivateAssetCurrentTotalsTool<E> {
    const NAME: &'static str = "get_private_asset_current_totals";

    type Error = AiError;
    type Args = GetPrivateAssetCurrentTotalsArgs;
    type Output = GetPrivateAssetCurrentTotalsOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get current aggregated private-assets totals from latest snapshots, including current value, contributed, distributed, and latest as-of date.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "includeArchived": {
                        "type": "boolean",
                        "description": "Whether to include archived private assets",
                        "default": false
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let totals = self
            .env
            .private_asset_projection_service()
            .get_private_asset_current_totals(args.include_archived)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        Ok(GetPrivateAssetCurrentTotalsOutput {
            include_archived: args.include_archived,
            totals,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetHistoricalSeriesArgs {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPrivateAssetHistoricalSeriesOutput {
    pub series: Vec<PrivateAssetHistoricalPoint>,
    pub count: usize,
    pub include_archived: bool,
}

pub struct GetPrivateAssetHistoricalSeriesTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> GetPrivateAssetHistoricalSeriesTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for GetPrivateAssetHistoricalSeriesTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for GetPrivateAssetHistoricalSeriesTool<E> {
    const NAME: &'static str = "get_private_asset_historical_series";

    type Error = AiError;
    type Args = GetPrivateAssetHistoricalSeriesArgs;
    type Output = GetPrivateAssetHistoricalSeriesOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description:
                "Get historical carry-forward private-assets series from reported snapshots."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "includeArchived": {
                        "type": "boolean",
                        "description": "Whether to include archived private assets",
                        "default": false
                    }
                },
                "required": []
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let series = self
            .env
            .private_asset_projection_service()
            .get_private_asset_historical_series(args.include_archived)
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let count = series.len();

        Ok(GetPrivateAssetHistoricalSeriesOutput {
            series,
            count,
            include_archived: args.include_archived,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::MockEnvironment;

    #[tokio::test]
    async fn test_list_private_asset_rows_tool() {
        let env = Arc::new(MockEnvironment::new());
        let tool = ListPrivateAssetRowsTool::new(env);

        let result = tool.call(ListPrivateAssetRowsArgs::default()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().count, 0);
    }

    #[tokio::test]
    async fn test_get_private_asset_detail_tool() {
        let env = Arc::new(MockEnvironment::new());
        let tool = GetPrivateAssetDetailTool::new(env);

        let result = tool
            .call(GetPrivateAssetDetailArgs {
                private_asset_id: "asset-1".to_string(),
            })
            .await;
        assert!(result.is_ok());
        assert!(result.unwrap().detail.is_none());
    }
}
