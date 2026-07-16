//! Commit Activity tools (MCP-only).
//!
//! `commit_activity_draft` and `commit_activity_drafts` take the
//! [`ActivityDraft`] shape that `record_activity` / `record_activities`
//! produce and persist them as real activities. These are the write step the
//! in-app assistant performs through its confirmation widget (the frontend
//! calls the activity form mutation). MCP callers have no widget, so these
//! tools let a scoped token commit a previously-reviewed draft directly.
//!
//! Mapping mirrors the frontend draft → create payload (record-activity-tool-ui):
//! the draft's `assetId`/`symbol`/`assetKind` become the nested
//! [`AssetResolutionInput`]; numeric fields are converted f64 → Decimal.

use std::sync::Arc;

use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use wealthfolio_core::activities::{AssetResolutionInput, NewActivity};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::record_activity::ActivityDraft;

/// Max drafts per `commit_activity_drafts` call. Mirrors the `record_activities`
/// batch cap (these drafts come from there), so a buggy or hostile client with
/// write scope can't trigger an unbounded one-by-one write.
const MAX_COMMIT_DRAFTS: usize = 100;

/// Drop the draft payload(s) from audit args — never persist amounts, account
/// ids, symbols, or notes in `mcp_audit_log`. Built as an allowlist (fresh
/// object) so an extra top-level field an agent attaches can't slip through
/// unredacted.
fn redact_drafts(args: &serde_json::Value) -> serde_json::Value {
    let mut redacted = serde_json::Map::new();
    if let Some(obj) = args.as_object() {
        if obj.contains_key("draft") {
            redacted.insert("draft".to_string(), serde_json::json!("[redacted]"));
        }
        if let Some(drafts) = obj.get("drafts").and_then(|d| d.as_array()) {
            redacted.insert(
                "drafts".to_string(),
                serde_json::json!(format!("[{} drafts]", drafts.len())),
            );
        }
    }
    serde_json::Value::Object(redacted)
}

/// Arguments for `commit_activity_drafts`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityDraftsArgs {
    pub drafts: Vec<ActivityDraft>,
}

/// Summary of a committed activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedActivity {
    pub id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub activity_type: String,
    pub activity_date: String,
    pub currency: String,
}

/// Output for `commit_activity_draft`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityDraftOutput {
    pub created: CommittedActivity,
}

/// A row-level error in a batch commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitError {
    pub index: usize,
    pub message: String,
}

/// Output for `commit_activity_drafts` (partial success).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityDraftsOutput {
    pub created: Vec<CommittedActivity>,
    pub errors: Vec<CommitError>,
}

/// Convert an [`ActivityDraft`] into the core [`NewActivity`] create payload.
///
/// Mirrors the frontend draft → create payload mapping: asset identity is
/// nested into [`AssetResolutionInput`] (existing `id`, `symbol`, `kind`),
/// and numeric fields are converted from f64 to `Decimal`.
fn draft_to_new_activity(draft: &ActivityDraft) -> Result<NewActivity, AgentToolError> {
    let account_id = draft
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AgentToolError::InvalidInput("Draft is missing an account_id".to_string()))?
        .to_string();

    // Build the nested asset resolution input. Pure cash activities (no asset
    // id and no symbol) carry no asset.
    let has_asset = draft.asset_id.as_deref().is_some_and(|id| !id.is_empty())
        || draft.symbol.as_deref().is_some_and(|s| !s.is_empty());
    let asset = if has_asset {
        Some(AssetResolutionInput {
            id: draft
                .asset_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            symbol: draft
                .symbol
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            exchange_mic: None,
            kind: draft.asset_kind.clone(),
            name: draft.asset_name.clone(),
            quote_mode: Some(draft.pricing_mode.clone()),
            quote_ccy: None,
            instrument_type: None,
            provider_id: None,
            provider_symbol: None,
        })
    } else {
        None
    };

    let to_decimal = |value: Option<f64>, field: &str| -> Result<Option<Decimal>, AgentToolError> {
        match value {
            None => Ok(None),
            Some(v) => Decimal::from_f64(v).map(Some).ok_or_else(|| {
                AgentToolError::InvalidInput(format!("Invalid numeric value for {field}: {v}"))
            }),
        }
    };

    Ok(NewActivity {
        id: None,
        account_id,
        asset,
        activity_type: draft.activity_type.clone(),
        subtype: draft.subtype.clone(),
        activity_date: draft.activity_date.clone(),
        quantity: to_decimal(draft.quantity, "quantity")?,
        unit_price: to_decimal(draft.unit_price, "unitPrice")?,
        currency: draft.currency.clone(),
        fee: to_decimal(draft.fee, "fee")?,
        tax: to_decimal(draft.tax, "tax")?,
        amount: to_decimal(draft.amount, "amount")?,
        status: None,
        notes: draft.notes.clone(),
        fx_rate: None,
        metadata: None,
        needs_review: None,
        source_system: None,
        source_record_id: None,
        source_group_id: None,
        idempotency_key: None,
        import_run_id: None,
    })
}

fn committed_summary(activity: wealthfolio_core::activities::Activity) -> CommittedActivity {
    CommittedActivity {
        id: activity.id,
        account_id: activity.account_id,
        asset_id: activity.asset_id,
        activity_type: activity.activity_type,
        activity_date: activity.activity_date.to_rfc3339(),
        currency: activity.currency,
    }
}

/// Commit a single activity draft.
pub struct CommitActivityDraft;

#[async_trait::async_trait]
impl AgentTool for CommitActivityDraft {
    fn name(&self) -> &'static str {
        "commit_activity_draft"
    }

    fn description(&self) -> &'static str {
        "Persist a single reviewed activity draft (the shape returned by \
         record_activity) as a real activity. This MUTATES data — only call it \
         after the draft has been reviewed and confirmed."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "draft": activity_draft_schema()
            },
            "required": ["draft"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesDraft, AgentScope::ActivitiesWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_drafts(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        #[derive(Deserialize)]
        struct Args {
            draft: ActivityDraft,
        }
        let args: Args = serde_json::from_value(args)?;

        let new_activity = draft_to_new_activity(&args.draft)?;
        let created = env
            .activity_service()
            .create_activity(new_activity)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        env.health_service().clear_cache().await;

        let output = CommitActivityDraftOutput {
            created: committed_summary(created),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// Commit multiple activity drafts. Partial success: each row is created
/// independently and row-level failures are reported without aborting the rest.
pub struct CommitActivityDrafts;

#[async_trait::async_trait]
impl AgentTool for CommitActivityDrafts {
    fn name(&self) -> &'static str {
        "commit_activity_drafts"
    }

    fn description(&self) -> &'static str {
        "Persist multiple reviewed activity drafts (the shape returned by \
         record_activities) as real activities. This MUTATES data — only call it \
         after the drafts have been reviewed and confirmed. Each draft is created \
         independently; row-level failures are reported in `errors` without \
         aborting the others."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "drafts": {
                    "type": "array",
                    "description": "Activity drafts to persist.",
                    "maxItems": MAX_COMMIT_DRAFTS,
                    "items": activity_draft_schema()
                }
            },
            "required": ["drafts"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesDraft, AgentScope::ActivitiesWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_drafts(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        // Reject oversized batches from the raw array length before
        // deserializing the whole payload — a buggy or hostile client with
        // write scope must not be able to force unbounded work.
        if let Some(len) = args.get("drafts").and_then(|d| d.as_array()).map(Vec::len) {
            if len > MAX_COMMIT_DRAFTS {
                return Err(AgentToolError::InvalidInput(format!(
                    "Batch limited to {MAX_COMMIT_DRAFTS} drafts, got {len}"
                )));
            }
        }

        let args: CommitActivityDraftsArgs = serde_json::from_value(args)?;

        let activity_service = env.activity_service();
        let mut created = Vec::new();
        let mut errors = Vec::new();
        let mut any_created = false;

        for (index, draft) in args.drafts.iter().enumerate() {
            let new_activity = match draft_to_new_activity(draft) {
                Ok(new) => new,
                Err(e) => {
                    errors.push(CommitError {
                        index,
                        message: e.to_string(),
                    });
                    continue;
                }
            };
            match activity_service.create_activity(new_activity).await {
                Ok(activity) => {
                    any_created = true;
                    created.push(committed_summary(activity));
                }
                Err(e) => errors.push(CommitError {
                    index,
                    message: e.to_string(),
                }),
            }
        }

        if any_created {
            env.health_service().clear_cache().await;
        }

        let output = CommitActivityDraftsOutput { created, errors };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// JSON schema for an [`ActivityDraft`] commit input — the shape
/// `record_activity` returns under `draft`.
fn activity_draft_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "activityType": { "type": "string" },
            "activityDate": { "type": "string", "description": "ISO 8601 date." },
            "symbol": { "type": "string" },
            "assetId": { "type": "string" },
            "assetName": { "type": "string" },
            "quantity": { "type": "number" },
            "unitPrice": { "type": "number" },
            "amount": { "type": "number" },
            "fee": { "type": "number" },
            "tax": { "type": "number" },
            "currency": { "type": "string" },
            "accountId": { "type": "string" },
            "accountName": { "type": "string" },
            "subtype": { "type": "string" },
            "notes": { "type": "string" },
            "priceSource": { "type": "string" },
            "pricingMode": { "type": "string" },
            "isCustomAsset": { "type": "boolean" },
            "assetKind": { "type": "string" }
        },
        "required": ["activityType", "activityDate", "currency", "accountId"]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fully-populated security buy draft; tweak fields per test.
    fn security_draft() -> ActivityDraft {
        ActivityDraft {
            activity_type: "BUY".to_string(),
            activity_date: "2024-01-15T00:00:00Z".to_string(),
            symbol: Some("AAPL".to_string()),
            asset_id: Some("SEC:AAPL:XNAS".to_string()),
            asset_name: Some("Apple Inc.".to_string()),
            quantity: Some(10.0),
            unit_price: Some(150.25),
            amount: Some(1502.5),
            fee: Some(1.0),
            tax: None,
            currency: "USD".to_string(),
            account_id: Some("acct-1".to_string()),
            account_name: Some("Brokerage".to_string()),
            subtype: None,
            notes: Some("from agent".to_string()),
            price_source: "user".to_string(),
            pricing_mode: "MARKET".to_string(),
            is_custom_asset: false,
            asset_kind: None,
        }
    }

    #[test]
    fn maps_security_draft_to_new_activity() {
        let new = draft_to_new_activity(&security_draft()).unwrap();
        assert_eq!(new.account_id, "acct-1");
        assert_eq!(new.activity_type, "BUY");
        assert_eq!(new.currency, "USD");
        assert_eq!(new.quantity, Some(Decimal::from_f64(10.0).unwrap()));
        assert_eq!(new.unit_price, Some(Decimal::from_f64(150.25).unwrap()));
        assert_eq!(new.fee, Some(Decimal::from_f64(1.0).unwrap()));
        assert_eq!(new.tax, None);
        let asset = new.asset.expect("security draft should carry an asset");
        assert_eq!(asset.id.as_deref(), Some("SEC:AAPL:XNAS"));
        assert_eq!(asset.symbol.as_deref(), Some("AAPL"));
        // Never minted on commit — the service assigns it.
        assert!(new.id.is_none());
    }

    #[test]
    fn missing_account_id_is_rejected() {
        let mut draft = security_draft();
        draft.account_id = None;
        assert!(matches!(
            draft_to_new_activity(&draft),
            Err(AgentToolError::InvalidInput(_))
        ));

        // Whitespace-only is treated as missing too.
        draft.account_id = Some("   ".to_string());
        assert!(matches!(
            draft_to_new_activity(&draft),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn cash_draft_carries_no_asset() {
        let mut draft = security_draft();
        draft.activity_type = "DEPOSIT".to_string();
        draft.symbol = None;
        draft.asset_id = None;
        draft.quantity = None;
        draft.unit_price = None;
        let new = draft_to_new_activity(&draft).unwrap();
        assert!(
            new.asset.is_none(),
            "pure cash activity must carry no asset"
        );
        assert_eq!(new.amount, Some(Decimal::from_f64(1502.5).unwrap()));
    }

    #[test]
    fn non_finite_numeric_is_rejected() {
        let mut draft = security_draft();
        draft.quantity = Some(f64::NAN);
        assert!(matches!(
            draft_to_new_activity(&draft),
            Err(AgentToolError::InvalidInput(_))
        ));

        let mut draft = security_draft();
        draft.amount = Some(f64::INFINITY);
        assert!(matches!(
            draft_to_new_activity(&draft),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn audit_redaction_drops_draft_payloads() {
        let single = serde_json::json!({ "draft": { "amount": 1502.5, "notes": "secret" } });
        assert_eq!(
            redact_drafts(&single)["draft"],
            serde_json::json!("[redacted]")
        );

        let batch = serde_json::json!({ "drafts": [ { "amount": 1.0 }, { "amount": 2.0 } ] });
        assert_eq!(
            redact_drafts(&batch)["drafts"],
            serde_json::json!("[2 drafts]")
        );
    }

    #[test]
    fn audit_redaction_drops_unknown_keys() {
        // An extra top-level field must not survive into the audit log.
        let args = serde_json::json!({
            "draft": { "amount": 1.0 },
            "note": "SSN 123-45-6789",
        });
        let redacted = redact_drafts(&args);
        assert!(redacted.get("note").is_none());
        assert_eq!(redacted.as_object().unwrap().len(), 1);
    }

    #[test]
    fn commit_drafts_schema_caps_batch_size() {
        let schema = CommitActivityDrafts.input_schema();
        assert_eq!(
            schema["properties"]["drafts"]["maxItems"],
            serde_json::json!(MAX_COMMIT_DRAFTS)
        );
    }
}
