//! `refresh_market_data`: start a price refresh, or replace an asset's
//! provider history, through the same paths as the app's buttons.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wealthfolio_core::assets::QuoteMode;
use wealthfolio_core::quotes::MarketSyncMode;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::asset_market_data::redact_urls;

/// Assets one refresh may name.
const MAX_REFRESH_ASSETS: usize = 50;
/// Assets one `replace` may name: each one is a provider fetch made during the call.
pub(crate) const MAX_REPLACE_ASSETS: usize = 10;
const DEFAULT_RECENT_DAYS: i64 = 30;
const MAX_RECENT_DAYS: i64 = 365;
/// Fallback history the app's "Refetch prices" uses when an asset has no activity.
const HISTORY_FALLBACK_DAYS: i64 = 365 * 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefreshMode {
    Latest,
    Recent,
    History,
    Replace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshMarketDataArgs {
    pub mode: RefreshMode,
    #[serde(default)]
    pub asset_ids: Option<Vec<String>>,
    #[serde(default)]
    pub days: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedHistoryDto {
    pub asset_id: String,
    pub source: String,
    pub from_date: String,
    pub to_date: String,
    pub deleted_count: usize,
    pub inserted_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshErrorDto {
    pub asset_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshMarketDataOutput {
    pub mode: RefreshMode,
    /// `queued`: a background job syncs prices and then recalculates.
    /// `done`: provider history was replaced during this call.
    pub status: &'static str,
    /// Assets the refresh covers; absent means every asset that syncs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub replaced: Vec<ReplacedHistoryDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<RefreshErrorDto>,
    /// `queued` when valuations will be recalculated, `none` otherwise.
    pub recalculation: &'static str,
}

/// Clean and de-duplicate the requested asset ids and check they exist.
fn checked_asset_ids(
    env: &dyn AgentEnvironment,
    ids: &[String],
    max: usize,
) -> Result<Vec<String>, AgentToolError> {
    let mut checked: Vec<String> = Vec::new();
    for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        if !checked.iter().any(|seen| seen == id) {
            checked.push(id.to_string());
        }
    }
    if checked.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "assetIds must name at least one asset".to_string(),
        ));
    }
    if checked.len() > max {
        return Err(AgentToolError::InvalidInput(format!(
            "assetIds may name at most {max} assets"
        )));
    }
    let asset_service = env.asset_service();
    for id in &checked {
        asset_service
            .get_asset_by_id(id)
            .map_err(|_| AgentToolError::InvalidInput(format!("Asset '{id}' was not found")))?;
    }
    Ok(checked)
}

/// Replace each asset's provider history in turn, keeping MANUAL and BROKER
/// quotes. Runs in its own task so a dropped call still commits, and the
/// quote service still emits its `PriceHistoryChanged`.
pub(crate) async fn replace_provider_history(
    env: Arc<dyn AgentEnvironment>,
    asset_ids: Vec<String>,
) -> Result<(Vec<ReplacedHistoryDto>, Vec<RefreshErrorDto>), AgentToolError> {
    tokio::spawn(async move {
        let quote_service = env.quote_service();
        let mut replaced = Vec::new();
        let mut errors = Vec::new();
        for asset_id in asset_ids {
            match quote_service.reset_provider_history(&asset_id).await {
                Ok(result) => replaced.push(ReplacedHistoryDto {
                    asset_id: result.asset_id,
                    source: result.source,
                    from_date: result.from_date,
                    to_date: result.to_date,
                    deleted_count: result.deleted_count,
                    inserted_count: result.inserted_count,
                }),
                Err(error) => errors.push(RefreshErrorDto {
                    asset_id,
                    error: redact_urls(&error.to_string()),
                }),
            }
        }
        (replaced, errors)
    })
    .await
    .map_err(|_| {
        AgentToolError::ExecutionFailed(
            "The history replacement could not be confirmed; check get_asset before retrying"
                .to_string(),
        )
    })
}

/// Tool to refresh prices or replace an asset's provider history.
pub struct RefreshMarketData;

#[async_trait::async_trait]
impl AgentTool for RefreshMarketData {
    fn name(&self) -> &'static str {
        "refresh_market_data"
    }

    fn description(&self) -> &'static str {
        "Refresh prices from the enabled market data providers, as the app's price buttons do. \
         `mode`: `latest` syncs new prices since the last sync; `recent` refetches the last \
         `days` (default 30, max 365) and overwrites them; `history` refetches each asset's full \
         history from its first activity (the app's \"Refetch prices\"). These three queue a \
         background job and return `status: \"queued\"`; valuations are recalculated when it \
         finishes, so check a few seconds later with get_asset or get_health_status. Without \
         `assetIds` they cover every asset that syncs (at most 50 ids). `replace` deletes the \
         provider quotes of the named `assetIds` (required, at most 10, MARKET quote mode only) \
         and fetches them again from the asset's current provider during this call, so rows in \
         an old currency or from an old provider go away; MANUAL and BROKER quotes are kept, \
         and nothing is deleted when the fetch fails. Use it after an asset's listing, currency \
         or provider was fixed. Transactions, quantities and cost are never changed."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["latest", "recent", "history", "replace"],
                    "description": "latest, recent or history (queued jobs), or replace (replace provider history now)."
                },
                "assetIds": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": MAX_REFRESH_ASSETS,
                    "description": "Assets to refresh. Required for replace (at most 10). Omit to refresh every asset."
                },
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_RECENT_DAYS,
                    "description": "For recent: how many days back to refetch. Default 30."
                }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::MarketDataWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: RefreshMarketDataArgs = serde_json::from_value(args)?;
        if args.days.is_some() && args.mode != RefreshMode::Recent {
            return Err(AgentToolError::InvalidInput(
                "days applies only to mode recent".to_string(),
            ));
        }

        let (sync_mode, asset_ids, days) = match args.mode {
            RefreshMode::Replace => {
                let ids = args.asset_ids.as_deref().ok_or_else(|| {
                    AgentToolError::InvalidInput("replace needs assetIds".to_string())
                })?;
                let asset_ids = checked_asset_ids(env.as_ref(), ids, MAX_REPLACE_ASSETS)?;
                let asset_service = env.asset_service();
                for id in &asset_ids {
                    let asset = asset_service
                        .get_asset_by_id(id)
                        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
                    if asset.quote_mode != QuoteMode::Market {
                        return Err(AgentToolError::InvalidInput(format!(
                            "Asset '{id}' uses manual quotes; it has no provider history to replace"
                        )));
                    }
                }
                let (replaced, errors) =
                    replace_provider_history(env.clone(), asset_ids.clone()).await?;
                let output = RefreshMarketDataOutput {
                    mode: args.mode,
                    status: "done",
                    asset_ids: Some(asset_ids),
                    days: None,
                    recalculation: if replaced.is_empty() {
                        "none"
                    } else {
                        "queued"
                    },
                    replaced,
                    errors,
                };
                return Ok(AgentToolResult {
                    content: serde_json::to_value(output)?,
                });
            }
            RefreshMode::Latest | RefreshMode::Recent | RefreshMode::History => {
                let asset_ids = args
                    .asset_ids
                    .as_deref()
                    .map(|ids| checked_asset_ids(env.as_ref(), ids, MAX_REFRESH_ASSETS))
                    .transpose()?;
                match args.mode {
                    RefreshMode::Recent => {
                        let days = args.days.unwrap_or(DEFAULT_RECENT_DAYS);
                        if !(1..=MAX_RECENT_DAYS).contains(&days) {
                            return Err(AgentToolError::InvalidInput(format!(
                                "days must be between 1 and {MAX_RECENT_DAYS}"
                            )));
                        }
                        (
                            MarketSyncMode::RefetchRecent {
                                asset_ids: asset_ids.clone(),
                                days,
                            },
                            asset_ids,
                            Some(days),
                        )
                    }
                    RefreshMode::History => (
                        MarketSyncMode::BackfillHistory {
                            asset_ids: asset_ids.clone(),
                            days: HISTORY_FALLBACK_DAYS,
                        },
                        asset_ids,
                        None,
                    ),
                    _ => (
                        MarketSyncMode::Incremental {
                            asset_ids: asset_ids.clone(),
                        },
                        asset_ids,
                        None,
                    ),
                }
            }
        };

        env.request_portfolio_job(sync_mode)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        let output = RefreshMarketDataOutput {
            mode: args.mode,
            status: "queued",
            asset_ids,
            days,
            replaced: Vec::new(),
            errors: Vec::new(),
            recalculation: "queued",
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records requested jobs; every service access fails the test.
    #[derive(Default)]
    struct JobEnv {
        jobs: Mutex<Vec<MarketSyncMode>>,
    }

    #[async_trait::async_trait]
    impl AgentEnvironment for JobEnv {
        crate::tools::test_support::unreachable_services!();

        async fn request_portfolio_job(
            &self,
            mode: MarketSyncMode,
        ) -> wealthfolio_core::Result<()> {
            self.jobs.lock().expect("jobs lock").push(mode);
            Ok(())
        }
    }

    /// Default environment: cannot start jobs.
    struct NoJobs;

    #[async_trait::async_trait]
    impl AgentEnvironment for NoJobs {
        crate::tools::test_support::unreachable_services!();
    }

    async fn run(
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, AgentToolError> {
        RefreshMarketData
            .call(env, args)
            .await
            .map(|result| result.content)
    }

    #[tokio::test]
    async fn each_mode_queues_the_matching_market_sync() {
        let env = Arc::new(JobEnv::default());
        for args in [
            serde_json::json!({ "mode": "latest" }),
            serde_json::json!({ "mode": "recent" }),
            serde_json::json!({ "mode": "recent", "days": 7 }),
            serde_json::json!({ "mode": "history" }),
        ] {
            let output = run(env.clone(), args).await.expect("queued");
            assert_eq!(output["status"], "queued", "{output}");
            assert_eq!(output["recalculation"], "queued", "{output}");
        }
        assert_eq!(
            *env.jobs.lock().expect("jobs lock"),
            vec![
                MarketSyncMode::Incremental { asset_ids: None },
                MarketSyncMode::RefetchRecent {
                    asset_ids: None,
                    days: 30
                },
                MarketSyncMode::RefetchRecent {
                    asset_ids: None,
                    days: 7
                },
                MarketSyncMode::BackfillHistory {
                    asset_ids: None,
                    days: 365 * 5
                },
            ]
        );
    }

    #[tokio::test]
    async fn bad_requests_queue_nothing_and_touch_no_service() {
        let env = Arc::new(JobEnv::default());
        for args in [
            serde_json::json!({ "mode": "latest", "days": 7 }),
            serde_json::json!({ "mode": "recent", "days": 0 }),
            serde_json::json!({ "mode": "recent", "days": 366 }),
            serde_json::json!({ "mode": "replace" }),
            serde_json::json!({ "mode": "replace", "assetIds": [" ", ""] }),
            serde_json::json!({ "mode": "latest", "assetIds": [] }),
            serde_json::json!({
                "mode": "replace",
                "assetIds": (0..=MAX_REPLACE_ASSETS).map(|i| format!("a{i}")).collect::<Vec<_>>()
            }),
        ] {
            let error = run(env.clone(), args.clone()).await.unwrap_err();
            assert!(
                matches!(error, AgentToolError::InvalidInput(_)),
                "{args}: {error}"
            );
        }
        assert!(env.jobs.lock().expect("jobs lock").is_empty());
    }

    #[tokio::test]
    async fn environments_without_jobs_report_it() {
        let error = run(Arc::new(NoJobs), serde_json::json!({ "mode": "latest" }))
            .await
            .unwrap_err();
        assert!(
            matches!(error, AgentToolError::ExecutionFailed(ref m) if m.contains("not available")),
            "{error}"
        );
    }

    #[test]
    fn modes_and_arguments_parse_strictly() {
        let args: RefreshMarketDataArgs = serde_json::from_value(serde_json::json!({
            "mode": "recent", "assetIds": ["a"], "days": 7
        }))
        .expect("valid args");
        assert_eq!(args.mode, RefreshMode::Recent);
        for bad in [
            serde_json::json!({ "mode": "everything" }),
            serde_json::json!({ "mode": "latest", "force": true }),
            serde_json::json!({}),
        ] {
            assert!(serde_json::from_value::<RefreshMarketDataArgs>(bad).is_err());
        }
    }
}
