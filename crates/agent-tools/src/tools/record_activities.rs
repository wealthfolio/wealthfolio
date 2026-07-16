//! Record Activities tool - create multiple activity drafts in one call.
//!
//! This batch tool reuses `record_activity` normalization/validation logic and
//! returns row-level drafts with a validation summary for a single confirm flow.

use log::debug;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::record_activity::{
    record_activity_schema, AccountOption, ActivityDraft, RecordActivity, RecordActivityArgs,
    ResolvedAsset, SubtypeOption, ValidationError, ValidationResult,
};

/// Arguments for the record_activities tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivitiesArgs {
    /// List of activity intents to normalize into drafts.
    pub activities: Vec<RecordActivityArgs>,
}

/// Batch validation summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchValidationSummary {
    pub total_rows: usize,
    pub valid_rows: usize,
    pub error_rows: usize,
}

/// Row-level draft output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDraftRow {
    pub row_index: usize,
    pub draft: ActivityDraft,
    pub validation: ValidationResult,
    pub errors: Vec<String>,
    pub resolved_asset: Option<ResolvedAsset>,
    pub available_subtypes: Vec<SubtypeOption>,
}

/// Output envelope for record_activities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivitiesOutput {
    pub drafts: Vec<ActivityDraftRow>,
    pub validation: BatchValidationSummary,
    pub available_accounts: Vec<AccountOption>,
    pub resolved_assets: Vec<ResolvedAsset>,
}

const RECORD_ACTIVITIES_DESCRIPTION: &str = "Record multiple investment transactions from natural \
    language. Returns a read-only batch draft preview for single confirmation. If the user has \
    multiple accounts and did not specify which account to use, ask which account before calling \
    this tool.";

/// Tool to record multiple investment activities from natural language.
pub struct RecordActivities;

impl RecordActivities {
    pub(crate) async fn build_output(
        env: &dyn AgentEnvironment,
        args: RecordActivitiesArgs,
    ) -> Result<RecordActivitiesOutput, AgentToolError> {
        const MAX_BATCH_SIZE: usize = 100;

        debug!(
            "record_activities called with {} rows",
            args.activities.len()
        );

        if args.activities.is_empty() {
            return Ok(RecordActivitiesOutput {
                drafts: Vec::new(),
                validation: BatchValidationSummary {
                    total_rows: 0,
                    valid_rows: 0,
                    error_rows: 0,
                },
                available_accounts: Vec::new(),
                resolved_assets: Vec::new(),
            });
        }

        if args.activities.len() > MAX_BATCH_SIZE {
            return Err(AgentToolError::ExecutionFailed(format!(
                "Batch limited to {} activities, got {}",
                MAX_BATCH_SIZE,
                args.activities.len()
            )));
        }

        // Pre-fetch accounts once for the entire batch.
        let accounts = env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let available_accounts: Vec<AccountOption> = accounts
            .iter()
            .map(|a| AccountOption {
                id: a.id.clone(),
                name: a.name.clone(),
                currency: a.currency.clone(),
                account_type: Some(a.account_type.clone()),
            })
            .collect();

        let mut drafts = Vec::with_capacity(args.activities.len());

        for (row_index, activity) in args.activities.into_iter().enumerate() {
            match RecordActivity::build_output_with_accounts(env, activity, &accounts).await {
                Ok(output) => {
                    let mut row_errors = Vec::new();
                    for field in &output.validation.missing_fields {
                        row_errors.push(format!("Missing required field: {}", field));
                    }
                    for error in &output.validation.errors {
                        row_errors.push(format!("{}: {}", error.field, error.message));
                    }

                    drafts.push(ActivityDraftRow {
                        row_index,
                        draft: output.draft,
                        validation: output.validation,
                        errors: row_errors,
                        resolved_asset: output.resolved_asset,
                        available_subtypes: output.available_subtypes,
                    });
                }
                Err(e) => {
                    drafts.push(ActivityDraftRow {
                        row_index,
                        draft: ActivityDraft {
                            activity_type: "UNKNOWN".to_string(),
                            activity_date: String::new(),
                            symbol: None,
                            asset_id: None,
                            asset_name: None,
                            quantity: None,
                            unit_price: None,
                            amount: None,
                            fee: None,
                            tax: None,
                            currency: env.base_currency(),
                            account_id: None,
                            account_name: None,
                            subtype: None,
                            notes: None,
                            price_source: "none".to_string(),
                            pricing_mode: "MARKET".to_string(),
                            is_custom_asset: false,
                            asset_kind: None,
                        },
                        validation: ValidationResult {
                            is_valid: false,
                            missing_fields: Vec::new(),
                            errors: vec![ValidationError {
                                field: "row".to_string(),
                                message: e.to_string(),
                            }],
                        },
                        errors: vec![e.to_string()],
                        resolved_asset: None,
                        available_subtypes: Vec::new(),
                    });
                }
            }
        }

        let valid_rows = drafts.iter().filter(|d| d.validation.is_valid).count();
        let total_rows = drafts.len();
        let error_rows = total_rows.saturating_sub(valid_rows);

        let mut seen_asset_ids = HashSet::new();
        let resolved_assets: Vec<ResolvedAsset> = drafts
            .iter()
            .filter_map(|row| row.resolved_asset.as_ref())
            .filter_map(|asset| {
                if seen_asset_ids.insert(asset.asset_id.clone()) {
                    Some(asset.clone())
                } else {
                    None
                }
            })
            .collect();

        Ok(RecordActivitiesOutput {
            drafts,
            validation: BatchValidationSummary {
                total_rows,
                valid_rows,
                error_rows,
            },
            available_accounts,
            resolved_assets,
        })
    }
}

#[async_trait::async_trait]
impl AgentTool for RecordActivities {
    fn name(&self) -> &'static str {
        "record_activities"
    }

    fn description(&self) -> &'static str {
        RECORD_ACTIVITIES_DESCRIPTION
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "activities": {
                    "type": "array",
                    "description": "List of activities to record together",
                    "items": record_activity_schema()
                }
            },
            "required": ["activities"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Prefetches the account list for resolution, so it needs
        // accounts:read in addition to activities:draft.
        &[AgentScope::AccountsRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        // Never persist the draft rows' financial details in the audit log.
        let count = args
            .get("activities")
            .and_then(|a| a.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        serde_json::json!(format!("[{count} activities]"))
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: RecordActivitiesArgs = serde_json::from_value(args)?;
        let output = RecordActivities::build_output(env.as_ref(), args).await?;
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_redaction_counts_drafts() {
        let args = serde_json::json!({
            "activities": [ { "activityType": "BUY" }, { "activityType": "SELL" } ]
        });
        assert_eq!(
            RecordActivities.sanitize_args_for_audit(&args),
            serde_json::json!("[2 activities]")
        );
    }
}
