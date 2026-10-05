//! Transfer linking tools (MCP-only).
//!
//! A TRANSFER_OUT and a TRANSFER_IN that are two sides of one movement between
//! owned accounts count as spending and income until they are linked. These
//! tools let an agent find unlinked transfers with the candidates the Link
//! Transfer dialog suggests, then link or unlink pairs through the same core
//! methods as the dialog: its validation, the recalculation it triggers, and
//! the user-edit flag that keeps broker syncs from undoing a link.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::activities::{
    Activity, ActivityServiceTrait, TransferLinkState, TransferMatchCandidate, UnlinkedTransfer,
    UnlinkedTransfersRequest,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Max pairs per link or unlink call, so one call cannot force unbounded writes.
const MAX_PAIRS: usize = 100;

/// Arguments for `find_transfer_matches`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTransferMatchesArgs {
    #[serde(default)]
    pub activity_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub window_days: Option<i64>,
    #[serde(default)]
    pub candidate_limit: Option<usize>,
    #[serde(default)]
    pub link_states: Option<Vec<TransferLinkState>>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// A transfer activity as the tools show it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDto {
    pub id: String,
    pub date: String,
    pub activity_type: String,
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<f64>,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCandidateDto {
    pub activity: TransferDto,
    pub match_kind: String,
    pub confidence: String,
    pub score: i32,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedTransferDto {
    pub activity: TransferDto,
    pub link_state: TransferLinkState,
    pub candidates: Vec<TransferCandidateDto>,
}

/// Output for `find_transfer_matches`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTransferMatchesOutput {
    pub transfers: Vec<UnlinkedTransferDto>,
    /// Matching unlinked transfers before `offset` and `limit`.
    pub total: usize,
    /// For an `activityId` lookup of a linked transfer: its other side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_to: Option<String>,
    /// For an `activityId` lookup of a linked transfer: linked, or
    /// linked_but_marked_external when a leg is still marked external.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_state: Option<TransferLinkState>,
}

fn parse_date(value: Option<&str>, field: &str) -> Result<Option<NaiveDate>, AgentToolError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
                AgentToolError::InvalidInput(format!("{field} must be YYYY-MM-DD, got '{value}'"))
            })
        })
        .transpose()
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn transfer_dto(activity: &Activity, account_names: &HashMap<String, String>) -> TransferDto {
    TransferDto {
        id: activity.id.clone(),
        date: activity.activity_date.to_rfc3339(),
        activity_type: activity.effective_type().to_string(),
        account_id: activity.account_id.clone(),
        account_name: account_names.get(&activity.account_id).cloned(),
        amount: activity.amount.and_then(|amount| amount.to_f64()),
        quantity: activity.quantity.and_then(|quantity| quantity.to_f64()),
        currency: activity.currency.clone(),
        asset_id: activity.asset_id.clone(),
        notes: activity.notes.clone(),
    }
}

fn candidate_dto(
    candidate: &TransferMatchCandidate,
    account_names: &HashMap<String, String>,
) -> TransferCandidateDto {
    TransferCandidateDto {
        activity: transfer_dto(&candidate.activity, account_names),
        match_kind: candidate.match_kind.clone(),
        confidence: candidate.confidence.clone(),
        score: candidate.score,
        reasons: candidate.reasons.clone(),
        warnings: candidate.warnings.clone(),
    }
}

fn unlinked_dto(
    transfer: &UnlinkedTransfer,
    account_names: &HashMap<String, String>,
) -> UnlinkedTransferDto {
    UnlinkedTransferDto {
        activity: transfer_dto(&transfer.activity, account_names),
        link_state: transfer.link_state,
        candidates: transfer
            .candidates
            .iter()
            .map(|candidate| candidate_dto(candidate, account_names))
            .collect(),
    }
}

/// Find unlinked transfers and the counterparts they could be linked with.
pub struct FindTransferMatches;

#[async_trait::async_trait]
impl AgentTool for FindTransferMatches {
    fn name(&self) -> &'static str {
        "find_transfer_matches"
    }

    fn description(&self) -> &'static str {
        "Find posted transfers (TRANSFER_IN / TRANSFER_OUT) in active accounts that are not linked to their other side. Each comes with its linkState and up to candidateLimit (default 3) candidates the app's Link Transfer dialog suggests: the opposite direction with the same amount and currency (or the same asset and quantity for securities) within windowDays, best first with confidence, reasons and warnings. An unlinked transfer between two owned accounts counts as income and spending; after the user confirms a pair, link it with link_transfer_activities. linkState: needs_counterpart and broken_link are unlinked transfers the Health Center reports; external is marked as money from or to outside the portfolio, which imports set unless the source says internal, so an external transfer with a clear candidate may still be one side of an internal move. A transfer without candidates may still have another side the matcher cannot see, such as a different currency or amount, or a date outside windowDays; ask the user. Filter by linkStates, accountId and dateFrom/dateTo (UTC calendar days); results are newest first, paged with offset and limit, and total counts every match. Pass activityId to check one transfer: when it is linked, linkedTo names its other side and linkedState is linked, or linked_but_marked_external when a leg is still marked external (which the Health Center also reports; linking the pair again clears it)."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "activityId": { "type": "string", "description": "Check this one transfer instead of scanning." },
                "accountId": { "type": "string", "description": "Only transfers in this account." },
                "dateFrom": { "type": "string", "description": "YYYY-MM-DD UTC calendar day, inclusive." },
                "dateTo": { "type": "string", "description": "YYYY-MM-DD UTC calendar day, inclusive." },
                "linkStates": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["needs_counterpart", "broken_link", "external"] },
                    "description": "Only these states (default all three)."
                },
                "windowDays": { "type": "integer", "minimum": 0, "maximum": 90, "description": "Days a candidate may be from the transfer (default 7)." },
                "candidateLimit": { "type": "integer", "minimum": 1, "maximum": 25, "description": "Candidates per transfer (default 3)." },
                "offset": { "type": "integer", "minimum": 0, "description": "Transfers to skip, for paging (default 0)." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Transfers returned (default 25)." }
            }
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: FindTransferMatchesArgs = serde_json::from_value(args)?;
        let request = UnlinkedTransfersRequest {
            activity_id: non_empty(args.activity_id),
            account_id: non_empty(args.account_id),
            start_date: parse_date(args.date_from.as_deref(), "dateFrom")?,
            end_date: parse_date(args.date_to.as_deref(), "dateTo")?,
            window_days: args.window_days,
            candidate_limit: args.candidate_limit,
            limit: args.limit,
            offset: args.offset,
            link_states: args.link_states,
        };
        let unlinked = env
            .activity_service()
            .find_unlinked_transfers(request)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        let account_names: HashMap<String, String> = env
            .account_service()
            .get_all_accounts()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            .into_iter()
            .map(|account| (account.id, account.name))
            .collect();
        let output = FindTransferMatchesOutput {
            transfers: unlinked
                .transfers
                .iter()
                .map(|transfer| unlinked_dto(transfer, &account_names))
                .collect(),
            total: unlinked.total,
            linked_to: unlinked
                .linked
                .as_ref()
                .map(|linked| linked.counterpart_id.clone()),
            linked_state: unlinked.linked.map(|linked| linked.link_state),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// One pair to link or unlink; the two sides may come in either order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPairInput {
    pub activity_a_id: String,
    pub activity_b_id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPairsArgs {
    pub pairs: Vec<TransferPairInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPairDto {
    pub transfer_in_id: String,
    pub transfer_out_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPairError {
    pub index: usize,
    pub message: String,
}

/// Output for `link_transfer_activities`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTransfersOutput {
    pub linked: Vec<TransferPairDto>,
    pub errors: Vec<TransferPairError>,
}

/// Output for `unlink_transfer_activities`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkTransfersOutput {
    pub unlinked: Vec<TransferPairDto>,
    pub errors: Vec<TransferPairError>,
}

fn pairs_schema(action: &str) -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "pairs": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_PAIRS,
                "description": format!("Pairs to {action}: one TRANSFER_OUT and one TRANSFER_IN id each, in either order."),
                "items": {
                    "type": "object",
                    "properties": {
                        "activityAId": { "type": "string" },
                        "activityBId": { "type": "string" }
                    },
                    "required": ["activityAId", "activityBId"]
                }
            }
        },
        "required": ["pairs"]
    })
}

/// Keep only the pair ids, at most `MAX_PAIRS` of them, and the pair count in
/// the audit log, so an extra field an agent attaches cannot reach it.
fn pairs_for_audit(args: &serde_json::Value) -> serde_json::Value {
    let pairs: Vec<serde_json::Value> = args
        .get("pairs")
        .and_then(|pairs| pairs.as_array())
        .map(|pairs| {
            pairs
                .iter()
                .take(MAX_PAIRS)
                .map(|pair| {
                    json!({
                        "activityAId": pair.get("activityAId"),
                        "activityBId": pair.get("activityBId"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let count = args
        .get("pairs")
        .and_then(|pairs| pairs.as_array())
        .map_or(0, Vec::len);
    json!({ "pairs": pairs, "pairCount": count })
}

fn parse_pairs(args: serde_json::Value) -> Result<Vec<TransferPairInput>, AgentToolError> {
    // Reject oversized batches from the raw array before deserializing it.
    let count = args
        .get("pairs")
        .and_then(|pairs| pairs.as_array())
        .map(Vec::len);
    if let Some(count) = count.filter(|count| *count > MAX_PAIRS) {
        return Err(AgentToolError::InvalidInput(format!(
            "Batch limited to {MAX_PAIRS} pairs, got {count}"
        )));
    }
    let args: TransferPairsArgs = serde_json::from_value(args)?;
    if args.pairs.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "pairs must contain at least one pair".to_string(),
        ));
    }
    Ok(args.pairs)
}

/// Only posted transfers count in calculations, and the scan offers only
/// those: a pending, draft or void side would hide its posted counterpart as
/// an internal transfer.
fn ensure_posted(
    activity_service: &dyn ActivityServiceTrait,
    ids: [&str; 2],
) -> Result<(), String> {
    for id in ids {
        let activity = activity_service
            .get_activity(id)
            .map_err(|error| error.to_string())?;
        if !activity.is_posted() {
            return Err(format!(
                "Activity {id} is not posted; only posted transfers can be linked"
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum PairAction {
    Link,
    Unlink,
}

/// Apply `action` to each pair independently: a failing pair is reported and
/// the others still go through.
async fn apply_pairs(
    env: Arc<dyn AgentEnvironment>,
    args: serde_json::Value,
    action: PairAction,
) -> Result<(Vec<TransferPairDto>, Vec<TransferPairError>), AgentToolError> {
    let pairs = parse_pairs(args)?;
    let activity_service = env.activity_service();
    let mut done = Vec::new();
    let mut errors = Vec::new();
    for (index, pair) in pairs.into_iter().enumerate() {
        let a = pair.activity_a_id.trim().to_string();
        let b = pair.activity_b_id.trim().to_string();
        let result = match action {
            PairAction::Link => match ensure_posted(activity_service.as_ref(), [&a, &b]) {
                Ok(()) => activity_service
                    .link_transfer_activities(a, b)
                    .await
                    .map_err(|error| error.to_string()),
                Err(message) => Err(message),
            },
            PairAction::Unlink => activity_service
                .unlink_transfer_activities(a, b)
                .await
                .map_err(|error| error.to_string()),
        };
        match result {
            Ok((transfer_in, transfer_out)) => done.push(TransferPairDto {
                transfer_in_id: transfer_in.id,
                transfer_out_id: transfer_out.id,
            }),
            Err(message) => errors.push(TransferPairError { index, message }),
        }
    }
    if !done.is_empty() {
        env.health_service().clear_cache().await;
    }
    Ok((done, errors))
}

/// Link transfer pairs.
pub struct LinkTransferActivities;

#[async_trait::async_trait]
impl AgentTool for LinkTransferActivities {
    fn name(&self) -> &'static str {
        "link_transfer_activities"
    }

    fn description(&self) -> &'static str {
        "Link transfer pairs. Each pair is a TRANSFER_OUT and a TRANSFER_IN (in either order) that are the two sides of one movement between owned accounts; linked, they count as an internal transfer instead of spending and income, and broker syncs keep the link. This MUTATES data: only call it after the user confirmed the pairs, for example from find_transfer_matches. Linking applies the app's rules: neither side may already be linked to another transfer, a same-account pair must be a cash currency conversion, security legs must match in asset and quantity, and both sides must be posted. Linking a pair that is already linked to each other repairs it, clearing an external marker left on either side. Up to 100 pairs; each is linked on its own, with linked pairs listed in linked and failures in errors."
    }

    fn input_schema(&self) -> serde_json::Value {
        pairs_schema("link")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Linking reads both stored activities and reports what it found
        // (direction, account, asset), so it needs read as well.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ActivitiesDraft,
            AgentScope::ActivitiesWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        pairs_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let (linked, errors) = apply_pairs(env, args, PairAction::Link).await?;
        Ok(AgentToolResult {
            content: serde_json::to_value(LinkTransfersOutput { linked, errors })?,
        })
    }
}

/// Unlink transfer pairs.
pub struct UnlinkTransferActivities;

#[async_trait::async_trait]
impl AgentTool for UnlinkTransferActivities {
    fn name(&self) -> &'static str {
        "unlink_transfer_activities"
    }

    fn description(&self) -> &'static str {
        "Unlink transfer pairs that were linked by mistake. Each pair names the two linked sides (in either order); both become transfers from or to outside the portfolio again, counted as income and spending, and broker syncs keep them unlinked. This MUTATES data: only call it after the user confirmed. Up to 100 pairs; each is unlinked on its own, with unlinked pairs listed in unlinked and failures in errors."
    }

    fn input_schema(&self) -> serde_json::Value {
        pairs_schema("unlink")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Linking reads both stored activities and reports what it found
        // (direction, account, asset), so it needs read as well.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ActivitiesDraft,
            AgentScope::ActivitiesWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        pairs_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let (unlinked, errors) = apply_pairs(env, args, PairAction::Unlink).await?;
        Ok(AgentToolResult {
            content: serde_json::to_value(UnlinkTransfersOutput { unlinked, errors })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_must_be_present_and_bounded() {
        assert!(matches!(
            parse_pairs(json!({ "pairs": [] })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let pairs: Vec<_> = (0..=MAX_PAIRS)
            .map(|_| json!({ "activityAId": "a", "activityBId": "b" }))
            .collect();
        assert!(matches!(
            parse_pairs(json!({ "pairs": pairs })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let parsed =
            parse_pairs(json!({ "pairs": [{ "activityAId": "a", "activityBId": "b" }] })).unwrap();
        assert_eq!(parsed[0].activity_b_id, "b");
    }

    #[test]
    fn audit_keeps_only_pair_ids() {
        let args = json!({
            "pairs": [{ "activityAId": "a", "activityBId": "b", "note": "balance 1234.56" }],
            "comment": "secret"
        });
        assert_eq!(
            LinkTransferActivities.sanitize_args_for_audit(&args),
            json!({ "pairs": [{ "activityAId": "a", "activityBId": "b" }], "pairCount": 1 })
        );
        let oversized: Vec<_> = (0..MAX_PAIRS + 5)
            .map(|_| json!({ "activityAId": "a", "activityBId": "b" }))
            .collect();
        let audit = LinkTransferActivities.sanitize_args_for_audit(&json!({ "pairs": oversized }));
        assert_eq!(audit["pairs"].as_array().unwrap().len(), MAX_PAIRS);
        assert_eq!(audit["pairCount"], MAX_PAIRS + 5);
    }

    #[test]
    fn dates_must_be_calendar_days() {
        assert_eq!(
            parse_date(Some(" 2026-04-01 "), "dateFrom").unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 1)
        );
        assert_eq!(parse_date(Some(""), "dateFrom").unwrap(), None);
        assert!(matches!(
            parse_date(Some("04/01/2026"), "dateFrom"),
            Err(AgentToolError::InvalidInput(_))
        ));
    }
}
