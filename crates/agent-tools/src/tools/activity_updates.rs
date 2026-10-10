//! Activity update tools (MCP-only).
//!
//! `prepare_activity_updates` previews corrections to existing activities and
//! `commit_activity_updates` applies them in place, both through the core
//! update the activity grid uses: omitted fields keep their stored value, a
//! bare date lands on that day in the configured timezone, a linked transfer's
//! other leg receives the mirrored changes, the portfolio recalculates from
//! the earlier date, and the activity is marked user-modified so broker syncs
//! keep the edit. An update never creates an activity and never goes through
//! the import flow.
//!
//! Two limits keep an update off the network and linked pairs intact:
//! - an asset changes only by the id of a stored asset, since resolving a
//!   symbol can look up or create assets through market-data providers;
//! - a leg of a linked transfer keeps its account, currency, type and asset
//!   (the quantity of a security leg, the FX rate of a cross-currency cash
//!   leg), which would break the pair.

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;

use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use wealthfolio_core::activities::{
    is_securities_transfer, Activity, ActivityServiceTrait, ActivityStatus, ActivityUpdate,
    ActivityUpdatePreview, AssetResolutionInput, PreviewedActivityUpdate, ACTIVITY_SUBTYPE_BONUS,
    ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND, ACTIVITY_SUBTYPE_DRIP, ACTIVITY_SUBTYPE_OPTION_EXPIRY,
    ACTIVITY_SUBTYPE_POSITION_CLOSE, ACTIVITY_SUBTYPE_POSITION_OPEN, ACTIVITY_SUBTYPE_REBATE,
    ACTIVITY_SUBTYPE_REFUND, ACTIVITY_SUBTYPE_REIMBURSEMENT, ACTIVITY_SUBTYPE_STAKING_REWARD,
    ACTIVITY_TYPE_ADJUSTMENT, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL,
};
use wealthfolio_core::errors::{DatabaseError, Error as CoreError};
use wealthfolio_core::fx::currency::get_normalization_rule;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::record_activity::validate_activity_type;

/// Max rows per call, so one call cannot force unbounded writes.
const MAX_UPDATES: usize = 100;

/// The fields a row may set, as the activity grid edits them. Also the
/// allowlist of field names the audit log keeps.
const UPDATE_FIELDS: &[&str] = &[
    "date",
    "accountId",
    "activityType",
    "subtype",
    "assetId",
    "quantity",
    "unitPrice",
    "amount",
    "currency",
    "fee",
    "tax",
    "fxRate",
    "notes",
    "approve",
];

/// Changes that would break a linked transfer pair.
const LINKED_LEG_FIXED_FIELDS: &[&str] = &["accountId", "currency", "activityType", "assetId"];

/// Ways to name the asset by symbol, refused with a pointer to `assetId`.
const SYMBOL_FIELDS: &[&str] = &["symbol", "assetSymbol", "ticker"];

/// Subtypes the grid offers per activity type.
fn allowed_subtypes(activity_type: &str) -> &'static [&'static str] {
    match activity_type {
        ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL => &[
            ACTIVITY_SUBTYPE_POSITION_OPEN,
            ACTIVITY_SUBTYPE_POSITION_CLOSE,
        ],
        ACTIVITY_TYPE_DIVIDEND => &[ACTIVITY_SUBTYPE_DRIP, ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND],
        ACTIVITY_TYPE_INTEREST => &[ACTIVITY_SUBTYPE_STAKING_REWARD],
        ACTIVITY_TYPE_CREDIT => &[
            ACTIVITY_SUBTYPE_BONUS,
            ACTIVITY_SUBTYPE_REBATE,
            ACTIVITY_SUBTYPE_REFUND,
            ACTIVITY_SUBTYPE_REIMBURSEMENT,
        ],
        ACTIVITY_TYPE_ADJUSTMENT => &[ACTIVITY_SUBTYPE_OPTION_EXPIRY],
        _ => &[],
    }
}

/// Absent stays `None`; `null` becomes `Some(None)`.
fn patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One row as the agent sends it. Unknown fields are refused, so a
/// misspelled field cannot be silently ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateRow {
    activity_id: String,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    activity_type: Option<String>,
    #[serde(default, deserialize_with = "patch")]
    subtype: Option<Option<String>>,
    #[serde(default, deserialize_with = "patch")]
    asset_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "patch")]
    quantity: Option<Option<Value>>,
    #[serde(default, deserialize_with = "patch")]
    unit_price: Option<Option<Value>>,
    #[serde(default, deserialize_with = "patch")]
    amount: Option<Option<Value>>,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default, deserialize_with = "patch")]
    fee: Option<Option<Value>>,
    #[serde(default, deserialize_with = "patch")]
    tax: Option<Option<Value>>,
    #[serde(default, deserialize_with = "patch")]
    fx_rate: Option<Option<Value>>,
    #[serde(default, deserialize_with = "patch")]
    notes: Option<Option<String>>,
    #[serde(default)]
    approve: Option<bool>,
}

/// Reads a number from its JSON text (never through f64) or a numeric string.
fn parse_decimal(value: &Value, field: &str) -> Result<Decimal, String> {
    let text = match value {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.trim().to_string(),
        _ => return Err(format!("{field} must be a number")),
    };
    Decimal::from_str(&text)
        .or_else(|_| Decimal::from_scientific(&text))
        .map_err(|_| format!("{field} must be a number, got '{text}'"))
}

fn parse_decimal_patch(
    patch: &Option<Option<Value>>,
    field: &str,
) -> Result<Option<Option<Decimal>>, String> {
    match patch {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(value)) => parse_decimal(value, field).map(|value| Some(Some(value))),
    }
}

/// A three-letter code, as imports require and the grid's selector offers,
/// in capitals unless core reads it as a minor unit (GBp, ZAc).
fn parse_currency(value: &Option<String>) -> Result<Option<String>, String> {
    let Some(code) = non_empty(value, "currency")? else {
        return Ok(None);
    };
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "currency must be a three-letter code, got '{code}'"
        ));
    }
    Ok(Some(if get_normalization_rule(&code).is_some() {
        code
    } else {
        code.to_ascii_uppercase()
    }))
}

fn non_empty(value: &Option<String>, field: &str) -> Result<Option<String>, String> {
    match value.as_deref().map(str::trim) {
        None => Ok(None),
        Some("") => Err(format!("{field} cannot be empty")),
        Some(value) => Ok(Some(value.to_string())),
    }
}

/// Parses one raw row into its activity id and fields.
fn parse_row(raw: &Value) -> Result<(String, UpdateRow), String> {
    let object = raw
        .as_object()
        .ok_or_else(|| "Each update must be an object".to_string())?;
    if let Some(field) = SYMBOL_FIELDS
        .iter()
        .find(|field| object.contains_key(**field))
    {
        return Err(format!(
            "{field} is not accepted: change the asset by assetId, the id of an asset already \
             stored (get_asset_taxonomy_assignments finds it by ticker or name). Resolving a \
             symbol may look up or create assets through market-data providers."
        ));
    }
    let row: UpdateRow = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
    let activity_id = row.activity_id.trim().to_string();
    if activity_id.is_empty() {
        return Err("activityId is required".to_string());
    }
    if !UPDATE_FIELDS
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return Err("The update names no field to change".to_string());
    }
    Ok((activity_id, row))
}

/// The core update for `row`: what the row names, and the stored value of
/// each required field it omits. `notes` is filled too, because core stores
/// the notes as given.
fn build_update(row: &UpdateRow, existing: &Activity) -> Result<ActivityUpdate, String> {
    let activity_type = match non_empty(&row.activity_type, "activityType")? {
        Some(activity_type) => validate_activity_type(&activity_type)
            .ok_or_else(|| format!("Unknown activityType '{activity_type}'"))?,
        None => existing.effective_type().to_string(),
    };
    let subtype = match &row.subtype {
        None => None,
        Some(None) => Some(String::new()),
        Some(Some(subtype)) if subtype.trim().is_empty() => Some(String::new()),
        Some(Some(subtype)) => {
            let subtype = subtype.trim().to_uppercase();
            let allowed = allowed_subtypes(&activity_type);
            if !allowed.contains(&subtype.as_str()) {
                return Err(if allowed.is_empty() {
                    format!("{activity_type} activities take no subtype")
                } else {
                    format!(
                        "subtype '{subtype}' is not one of {} for {activity_type}",
                        allowed.join(", ")
                    )
                });
            }
            Some(subtype)
        }
    };
    let asset = match &row.asset_id {
        None => None,
        Some(None) => Some(AssetResolutionInput::default()),
        Some(Some(asset_id)) if asset_id.trim().is_empty() => {
            return Err("assetId cannot be empty; use null to clear the asset".to_string())
        }
        Some(Some(asset_id)) => Some(AssetResolutionInput {
            id: Some(asset_id.trim().to_string()),
            ..Default::default()
        }),
    };
    let amount = parse_decimal_patch(&row.amount, "amount")?;

    let approve = row.approve == Some(true);
    if approve && !existing.needs_review {
        return Err(format!(
            "Activity {} is not waiting for review, so there is nothing to approve",
            existing.id
        ));
    }
    let status =
        (approve && existing.status == ActivityStatus::Draft).then_some(ActivityStatus::Posted);
    // As the grid: a trade total the user states is its own review, except
    // on a Draft, which stays queued until approved.
    let attests_total = matches!(amount, Some(Some(_)))
        && matches!(
            activity_type.as_str(),
            ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL
        )
        && status.as_ref().unwrap_or(&existing.status) != &ActivityStatus::Draft;
    let needs_review = (approve || attests_total).then_some(false);

    let notes = match &row.notes {
        None => existing.notes.clone(),
        Some(None) => None,
        Some(Some(notes)) if notes.trim().is_empty() => None,
        Some(Some(notes)) => Some(notes.trim().to_string()),
    };

    Ok(ActivityUpdate {
        destination_amount: None,
        destination_currency: None,
        id: existing.id.clone(),
        account_id: non_empty(&row.account_id, "accountId")?
            .unwrap_or_else(|| existing.account_id.clone()),
        asset,
        activity_type,
        subtype,
        activity_date: non_empty(&row.date, "date")?
            .unwrap_or_else(|| existing.activity_date.to_rfc3339()),
        quantity: parse_decimal_patch(&row.quantity, "quantity")?,
        unit_price: parse_decimal_patch(&row.unit_price, "unitPrice")?,
        currency: parse_currency(&row.currency)?.unwrap_or_else(|| existing.currency.clone()),
        fee: parse_decimal_patch(&row.fee, "fee")?,
        tax: parse_decimal_patch(&row.tax, "tax")?,
        amount,
        status,
        needs_review,
        notes,
        fx_rate: parse_decimal_patch(&row.fx_rate, "fxRate")?,
        metadata: None,
    })
}

fn decimal_value(value: Option<Decimal>) -> Value {
    value.map_or(Value::Null, |value| json!(value.normalize().to_string()))
}

fn text_value(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| json!(value))
}

/// The fields the tools report, in `UPDATE_FIELDS` order (without approve).
fn stored_fields(activity: &Activity) -> Vec<(&'static str, Value)> {
    vec![
        ("date", json!(activity.activity_date.to_rfc3339())),
        ("accountId", json!(activity.account_id)),
        ("activityType", json!(activity.effective_type())),
        ("subtype", text_value(activity.subtype.as_deref())),
        ("assetId", text_value(activity.asset_id.as_deref())),
        ("quantity", decimal_value(activity.quantity)),
        ("unitPrice", decimal_value(activity.unit_price)),
        ("amount", decimal_value(activity.amount)),
        ("currency", json!(activity.currency)),
        ("fee", decimal_value(activity.fee)),
        ("tax", decimal_value(activity.tax)),
        ("fxRate", decimal_value(activity.fx_rate)),
        ("notes", text_value(activity.notes.as_deref())),
        ("status", json!(activity.status)),
        ("needsReview", json!(activity.needs_review)),
    ]
}

/// The same fields as `previewed` would store them: a `None` patch keeps the
/// stored value.
fn proposed_fields(previewed: &PreviewedActivityUpdate) -> Vec<(&'static str, Value)> {
    let existing = &previewed.existing;
    let update = &previewed.update;
    let decimal = |patch: Option<Option<Decimal>>, stored: Option<Decimal>| {
        decimal_value(patch.unwrap_or(stored))
    };
    let subtype = match update.subtype.as_deref() {
        None => existing.subtype.as_deref(),
        Some(subtype) if subtype.trim().is_empty() => None,
        Some(subtype) => Some(subtype),
    };
    let asset_id = match update.asset.as_ref() {
        None => existing.asset_id.as_deref(),
        Some(asset) if asset.is_empty() => None,
        Some(asset) => asset.id.as_deref(),
    };
    vec![
        ("date", json!(previewed.activity_date.to_rfc3339())),
        ("accountId", json!(update.account_id)),
        ("activityType", json!(update.activity_type)),
        ("subtype", text_value(subtype)),
        ("assetId", text_value(asset_id)),
        ("quantity", decimal(update.quantity, existing.quantity)),
        ("unitPrice", decimal(update.unit_price, existing.unit_price)),
        ("amount", decimal(update.amount, existing.amount)),
        ("currency", json!(update.currency)),
        ("fee", decimal(update.fee, existing.fee)),
        ("tax", decimal(update.tax, existing.tax)),
        ("fxRate", decimal(update.fx_rate, existing.fx_rate)),
        ("notes", text_value(update.notes.as_deref())),
        (
            "status",
            json!(update.status.as_ref().unwrap_or(&existing.status)),
        ),
        (
            "needsReview",
            json!(update.needs_review.unwrap_or(existing.needs_review)),
        ),
    ]
}

/// A field whose value differs between two snapshots.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: &'static str,
    pub current: Value,
    pub proposed: Value,
}

/// A field a commit changed, as stored before and after.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChange {
    pub field: &'static str,
    pub before: Value,
    pub after: Value,
}

fn changed_fields(
    before: Vec<(&'static str, Value)>,
    after: Vec<(&'static str, Value)>,
) -> Vec<(&'static str, Value, Value)> {
    before
        .into_iter()
        .zip(after)
        .filter(|((_, before), (_, after))| before != after)
        .map(|((field, before), (_, after))| (field, before, after))
        .collect()
}

fn preview_changes(previewed: &PreviewedActivityUpdate) -> Vec<FieldChange> {
    changed_fields(
        stored_fields(&previewed.existing),
        proposed_fields(previewed),
    )
    .into_iter()
    .map(|(field, current, proposed)| FieldChange {
        field,
        current,
        proposed,
    })
    .collect()
}

fn stored_changes(before: &Activity, after: &Activity) -> Vec<StoredChange> {
    changed_fields(stored_fields(before), stored_fields(after))
        .into_iter()
        .map(|(field, before, after)| StoredChange {
            field,
            before,
            after,
        })
        .collect()
}

/// Refuses what would break a linked pair.
fn check_guards(preview: &ActivityUpdatePreview, changes: &[FieldChange]) -> Result<(), String> {
    let existing = &preview.activity.existing;
    let Some(linked) = &preview.linked else {
        return Ok(());
    };
    let securities = [existing, &linked.existing]
        .into_iter()
        .any(|leg| is_securities_transfer(leg.effective_type(), leg.asset_id.as_deref()));
    // Core mirrors a cross-currency cash amount with the pair's stored rate,
    // not the row's, so a new rate would no longer match the two amounts.
    let cross_currency_cash = [existing, &linked.existing]
        .into_iter()
        .all(|leg| leg.asset_id.is_none())
        && !existing
            .currency
            .eq_ignore_ascii_case(&linked.existing.currency);
    let blocked: Vec<&str> = changes
        .iter()
        .map(|change| change.field)
        .filter(|field| {
            LINKED_LEG_FIXED_FIELDS.contains(field)
                || (securities && *field == "quantity")
                || (cross_currency_cash && *field == "fxRate")
        })
        .collect();
    if blocked.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Activity {} is one leg of a linked transfer with activity {}; changing its {} would \
         break the pair. Unlink the pair first with unlink_transfer_activities, update the \
         activities, then link them again with link_transfer_activities.",
        existing.id,
        linked.existing.id,
        blocked.join(", ")
    ))
}

fn read_error(activity_id: &str, error: CoreError) -> String {
    match error {
        CoreError::Database(DatabaseError::NotFound(_)) => {
            format!("Activity {activity_id} not found")
        }
        error => error.to_string(),
    }
}

/// A row that passed validation, with what the commit sends to core.
struct PlannedRow {
    update: ActivityUpdate,
    preview: ActivityUpdatePreview,
    changes: Vec<FieldChange>,
}

/// Validates one row as core would update it, without writing.
fn plan_row(
    activity_service: &dyn ActivityServiceTrait,
    activity_id: &str,
    row: &UpdateRow,
) -> Result<PlannedRow, String> {
    let existing = activity_service
        .get_activity(activity_id)
        .map_err(|error| read_error(activity_id, error))?;
    let update = build_update(row, &existing)?;
    let preview = activity_service
        .preview_activity_update(update.clone())
        .map_err(|error| error.to_string())?;
    let changes = preview_changes(&preview.activity);
    if changes.is_empty() {
        return Err(format!(
            "Nothing to change: every field already matches activity {activity_id}"
        ));
    }
    check_guards(&preview, &changes)?;
    Ok(PlannedRow {
        update,
        preview,
        changes,
    })
}

/// A row's activity id and fields, or why the row was refused.
type ParsedRow = Result<(String, UpdateRow), String>;

/// Rejects an oversized or empty batch from the raw array, then parses
/// each row on its own so one bad row only fails itself.
fn parse_rows(args: &Value) -> Result<Vec<ParsedRow>, AgentToolError> {
    let rows = args
        .get("updates")
        .and_then(Value::as_array)
        .ok_or_else(|| AgentToolError::InvalidInput("updates must be an array".to_string()))?;
    if rows.len() > MAX_UPDATES {
        return Err(AgentToolError::InvalidInput(format!(
            "Batch limited to {MAX_UPDATES} updates, got {}",
            rows.len()
        )));
    }
    if rows.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "updates must contain at least one update".to_string(),
        ));
    }
    let mut seen = HashSet::new();
    Ok(rows
        .iter()
        .map(|raw| {
            let (activity_id, row) = parse_row(raw)?;
            if !seen.insert(activity_id.clone()) {
                return Err(format!(
                    "Activity {activity_id} appears more than once; put its changes in one update"
                ));
            }
            Ok((activity_id, row))
        })
        .collect())
}

fn row_activity_id(raw: &Value) -> Option<String> {
    raw.get("activityId")
        .and_then(Value::as_str)
        .map(|id| id.trim().to_string())
}

/// Keeps only each row's activity id and the names of the fields it sets,
/// for at most `MAX_UPDATES` rows: never amounts, prices, notes or any other
/// value.
fn updates_for_audit(args: &Value) -> Value {
    let rows = args.get("updates").and_then(Value::as_array);
    let updates: Vec<Value> = rows
        .map(|rows| {
            rows.iter()
                .take(MAX_UPDATES)
                .map(|row| {
                    let fields: Vec<&str> = UPDATE_FIELDS
                        .iter()
                        .copied()
                        .filter(|field| row.get(*field).is_some())
                        .collect();
                    json!({ "activityId": row_activity_id(row), "fields": fields })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "updates": updates, "updateCount": rows.map_or(0, Vec::len) })
}

fn decimal_schema(description: &str) -> Value {
    json!({ "type": ["number", "string", "null"], "description": description })
}

fn updates_schema(action: &str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "updates": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_UPDATES,
                "description": format!("Activities to {action}, one row each. Name only the fields to change: omitted fields keep their stored value, and null clears an optional one."),
                "items": {
                    "type": "object",
                    "properties": {
                        "activityId": { "type": "string", "description": "The activity to update." },
                        "date": { "type": "string", "description": "YYYY-MM-DD, stored on that day in the configured timezone, or an RFC 3339 timestamp." },
                        "accountId": { "type": "string" },
                        "activityType": { "type": "string", "description": "BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, SPLIT, CREDIT, ADJUSTMENT or UNKNOWN." },
                        "subtype": { "type": ["string", "null"], "description": "BUY/SELL: POSITION_OPEN, POSITION_CLOSE; DIVIDEND: DRIP, DIVIDEND_IN_KIND; INTEREST: STAKING_REWARD; CREDIT: BONUS, REBATE, REFUND, REIMBURSEMENT; ADJUSTMENT: OPTION_EXPIRY." },
                        "assetId": { "type": ["string", "null"], "description": "Id of an asset already stored. Symbols are not accepted." },
                        "quantity": decimal_schema("Units."),
                        "unitPrice": decimal_schema("Price per unit in the activity currency."),
                        "amount": decimal_schema("Total in the activity currency."),
                        "currency": { "type": "string", "description": "Three-letter activity currency code." },
                        "fee": decimal_schema("Fee in the activity currency."),
                        "tax": decimal_schema("Tax in the activity currency."),
                        "fxRate": decimal_schema("Activity currency to account currency rate."),
                        "notes": { "type": ["string", "null"] },
                        "approve": { "type": "boolean", "description": "true approves an activity waiting for review; a draft becomes posted." }
                    },
                    "required": ["activityId"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["updates"]
    })
}

/// One previewed row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdatePreviewRow {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    /// "ready" or "invalid".
    pub status: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<FieldChange>,
    /// The other leg of a linked transfer, which receives `linkedChanges`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_activity_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_changes: Vec<FieldChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdatePreviewSummary {
    pub total: usize,
    pub ready: usize,
    pub invalid: usize,
}

/// Output for `prepare_activity_updates`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivityUpdatesOutput {
    pub rows: Vec<ActivityUpdatePreviewRow>,
    pub summary: ActivityUpdatePreviewSummary,
}

/// Preview corrections to existing activities.
pub struct PrepareActivityUpdates;

#[async_trait::async_trait]
impl AgentTool for PrepareActivityUpdates {
    fn name(&self) -> &'static str {
        "prepare_activity_updates"
    }

    fn description(&self) -> &'static str {
        "Preview corrections to existing activities without writing anything. Each row names an activityId (find it with search_activities) and only the fields to change; omitted fields keep their stored value and null clears an optional one. The fields are those the activity grid edits: date, accountId, activityType, subtype, assetId, quantity, unitPrice, amount, currency, fee, tax, fxRate, notes, and approve (approves an activity waiting for review; a draft becomes posted). A bare YYYY-MM-DD date lands on that day in the configured timezone. Change an asset only by the assetId of an asset already stored; symbols are refused. For a security TRANSFER_IN, the cost basis is quantity x unitPrice, or amount without a unit price. Each ready row lists every field that would change with its current and proposed value, including values the app derives (a trade total recalculated from quantity and price, a cleared stale amount, the review flag); for one leg of a linked transfer, linkedChanges lists what the other leg receives (date, notes, amount, approval). An invalid row gives its error: a missing activity, an invalid value, nothing to change, a change to the account, currency, type or asset of a linked transfer leg (or the quantity of a security transfer, or the fxRate of a cross-currency cash transfer; unlink the pair first with unlink_transfer_activities). Up to 100 rows. Show the preview to the user, then apply the confirmed rows with commit_activity_updates."
    }

    fn input_schema(&self) -> Value {
        updates_schema("preview")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        updates_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let parsed = parse_rows(&args)?;
        let raw_rows = args
            .get("updates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let rows: Vec<ActivityUpdatePreviewRow> = parsed
            .iter()
            .zip(&raw_rows)
            .enumerate()
            .map(|(index, (parsed, raw))| {
                let planned = parsed
                    .as_ref()
                    .map_err(String::clone)
                    .and_then(|(id, row)| plan_row(env.activity_service().as_ref(), id, row));
                match planned {
                    Ok(planned) => ActivityUpdatePreviewRow {
                        index,
                        activity_id: Some(planned.update.id.clone()),
                        status: "ready",
                        linked_activity_id: planned
                            .preview
                            .linked
                            .as_ref()
                            .map(|linked| linked.existing.id.clone()),
                        linked_changes: planned
                            .preview
                            .linked
                            .as_ref()
                            .map(preview_changes)
                            .unwrap_or_default(),
                        changes: planned.changes,
                        error: None,
                    },
                    Err(message) => ActivityUpdatePreviewRow {
                        index,
                        activity_id: row_activity_id(raw),
                        status: "invalid",
                        changes: Vec::new(),
                        linked_activity_id: None,
                        linked_changes: Vec::new(),
                        error: Some(message),
                    },
                }
            })
            .collect();
        let ready = rows.iter().filter(|row| row.status == "ready").count();
        let output = PrepareActivityUpdatesOutput {
            summary: ActivityUpdatePreviewSummary {
                total: rows.len(),
                ready,
                invalid: rows.len() - ready,
            },
            rows,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// One applied row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedActivity {
    pub index: usize,
    pub activity_id: String,
    pub changes: Vec<StoredChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_activity_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked_changes: Vec<StoredChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdateError {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    pub message: String,
}

/// Output for `commit_activity_updates`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityUpdatesOutput {
    pub updated: Vec<UpdatedActivity>,
    pub errors: Vec<ActivityUpdateError>,
}

/// Validates `row` again and applies it through core's update.
async fn apply_row(
    activity_service: &dyn ActivityServiceTrait,
    index: usize,
    activity_id: &str,
    row: &UpdateRow,
) -> Result<UpdatedActivity, String> {
    let planned = plan_row(activity_service, activity_id, row)?;
    let updated = activity_service
        .update_activity(planned.update)
        .await
        .map_err(|error| error.to_string())?;
    let linked = match planned.preview.linked {
        Some(linked) => {
            // The write succeeded; a failed re-read only loses the report.
            let after = activity_service.get_activity(&linked.existing.id).ok();
            Some((
                linked.existing.id.clone(),
                after.map(|after| stored_changes(&linked.existing, &after)),
            ))
        }
        None => None,
    };
    Ok(UpdatedActivity {
        index,
        activity_id: updated.id.clone(),
        changes: stored_changes(&planned.preview.activity.existing, &updated),
        linked_activity_id: linked.as_ref().map(|(id, _)| id.clone()),
        linked_changes: linked.and_then(|(_, changes)| changes).unwrap_or_default(),
    })
}

/// Apply reviewed corrections to existing activities.
pub struct CommitActivityUpdates;

#[async_trait::async_trait]
impl AgentTool for CommitActivityUpdates {
    fn name(&self) -> &'static str {
        "commit_activity_updates"
    }

    fn description(&self) -> &'static str {
        "Apply corrections to existing activities in place: the rows prepare_activity_updates previewed, in the same shape. This MUTATES data: only call it after the user reviewed the preview and confirmed. Each row is validated again and applied on its own through the app's activity update, with the same rules as the preview: it never creates an activity, a linked transfer's other leg receives the mirrored changes, the portfolio is recalculated, and the activity is marked as edited by the user so broker syncs keep the change. Up to 100 rows; updated lists each applied row with every changed field's stored value before and after (and linkedChanges for the other leg of a linked transfer), and errors lists the rows that failed."
    }

    fn input_schema(&self) -> Value {
        updates_schema("update")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Updating reads the stored activities and reports their values, so
        // it needs read as well.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ActivitiesDraft,
            AgentScope::ActivitiesWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        updates_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let parsed = parse_rows(&args)?;
        let raw_rows = args
            .get("updates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut updated = Vec::new();
        let mut errors = Vec::new();
        for (index, (parsed, raw)) in parsed.into_iter().zip(&raw_rows).enumerate() {
            let result = match parsed {
                Ok((activity_id, row)) => {
                    apply_row(env.activity_service().as_ref(), index, &activity_id, &row).await
                }
                Err(message) => Err(message),
            };
            match result {
                Ok(row) => updated.push(row),
                Err(message) => errors.push(ActivityUpdateError {
                    index,
                    activity_id: row_activity_id(raw),
                    message,
                }),
            }
        }
        if !updated.is_empty() {
            env.health_service().clear_cache().await;
        }
        Ok(AgentToolResult {
            content: serde_json::to_value(CommitActivityUpdatesOutput { updated, errors })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    fn d(value: &str) -> Decimal {
        Decimal::from_str(value).unwrap()
    }

    fn date(timestamp: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// A BTC transfer in recorded before its cost was known.
    fn btc_transfer_in() -> Activity {
        Activity {
            destination_amount: None,
            destination_currency: None,
            id: "btc-in".to_string(),
            account_id: "wallet".to_string(),
            asset_id: Some("btc-asset".to_string()),
            activity_type: "TRANSFER_IN".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: date("2026-03-02T09:30:00Z"),
            settlement_date: None,
            quantity: Some(d("0.01")),
            unit_price: None,
            amount: None,
            fee: Some(d("0")),
            tax: None,
            currency: "EUR".to_string(),
            fx_rate: None,
            notes: Some("StackinSat delivery".to_string()),
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: date("2026-03-02T09:30:00Z"),
            updated_at: date("2026-03-02T09:30:00Z"),
        }
    }

    fn cash_leg(id: &str, account_id: &str, activity_type: &str) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            quantity: None,
            amount: Some(d("100")),
            notes: None,
            ..btc_transfer_in()
        }
    }

    fn row(value: Value) -> UpdateRow {
        parse_row(&value).unwrap().1
    }

    fn update_for(value: Value, existing: &Activity) -> Result<ActivityUpdate, String> {
        build_update(&row(value), existing)
    }

    fn change(field: &'static str) -> FieldChange {
        FieldChange {
            field,
            current: Value::Null,
            proposed: Value::Null,
        }
    }

    fn previewed(existing: Activity) -> PreviewedActivityUpdate {
        let update = build_update(
            &row(json!({ "activityId": existing.id, "notes": "x" })),
            &existing,
        )
        .unwrap();
        PreviewedActivityUpdate {
            activity_date: existing.activity_date,
            existing,
            update,
        }
    }

    #[test]
    fn symbols_and_unknown_fields_are_refused() {
        for field in SYMBOL_FIELDS {
            let error = parse_row(&json!({ "activityId": "a", *field: "BTC" })).unwrap_err();
            assert!(error.contains("market-data providers"), "{field}: {error}");
        }
        for value in [
            json!({ "activityId": "a", "status": "POSTED" }),
            json!({ "activityId": "a", "unitprice": 1 }),
            json!({ "activityId": "a" }),
            json!({ "activityId": " ", "fee": 1 }),
            json!({ "fee": 1 }),
            json!("a"),
        ] {
            assert!(parse_row(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn rows_are_bounded_and_unique() {
        assert!(matches!(
            parse_rows(&json!({ "updates": [] })),
            Err(AgentToolError::InvalidInput(_))
        ));
        assert!(matches!(
            parse_rows(&json!({ "updates": {} })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let oversized: Vec<_> = (0..=MAX_UPDATES)
            .map(|index| json!({ "activityId": format!("a{index}"), "fee": 1 }))
            .collect();
        assert!(matches!(
            parse_rows(&json!({ "updates": oversized })),
            Err(AgentToolError::InvalidInput(_))
        ));
        let rows = parse_rows(&json!({ "updates": [
            { "activityId": "a", "fee": 1 },
            { "activityId": "b", "symbol": "BTC" },
            { "activityId": " a ", "notes": "again" }
        ]}))
        .unwrap();
        assert!(rows[0].is_ok());
        assert!(rows[1].is_err());
        assert!(rows[2].as_ref().unwrap_err().contains("more than once"));
    }

    #[test]
    fn omitted_fields_keep_their_stored_values() {
        let existing = btc_transfer_in();
        let update = update_for(
            json!({ "activityId": "btc-in", "amount": 650.5, "fee": "2.5" }),
            &existing,
        )
        .unwrap();
        assert_eq!(update.id, "btc-in");
        assert_eq!(update.account_id, "wallet");
        assert_eq!(update.activity_type, "TRANSFER_IN");
        assert_eq!(update.activity_date, existing.activity_date.to_rfc3339());
        assert_eq!(update.currency, "EUR");
        assert_eq!(update.notes.as_deref(), Some("StackinSat delivery"));
        assert!(update.asset.is_none());
        assert_eq!(update.quantity, None);
        assert_eq!(update.unit_price, None);
        assert_eq!(update.amount, Some(Some(d("650.5"))));
        assert_eq!(update.fee, Some(Some(d("2.5"))));
        assert_eq!(update.status, None);
        assert_eq!(update.needs_review, None);
    }

    #[test]
    fn numbers_come_from_their_json_text() {
        let existing = btc_transfer_in();
        let update = update_for(
            json!({ "activityId": "btc-in", "unitPrice": 0.1, "fee": "1e-3" }),
            &existing,
        )
        .unwrap();
        assert_eq!(update.unit_price, Some(Some(d("0.1"))));
        assert_eq!(update.fee, Some(Some(d("0.001"))));
        for invalid in [json!("abc"), json!(true), json!([1])] {
            let error = update_for(
                json!({ "activityId": "btc-in", "amount": invalid }),
                &existing,
            )
            .unwrap_err();
            assert!(error.contains("amount"), "{error}");
        }
    }

    #[test]
    fn null_clears_optional_fields() {
        let existing = btc_transfer_in();
        let update = update_for(
            json!({ "activityId": "btc-in", "notes": null, "subtype": null, "assetId": null, "fee": null }),
            &existing,
        )
        .unwrap();
        assert_eq!(update.notes, None);
        assert_eq!(update.subtype.as_deref(), Some(""));
        assert!(update.asset.unwrap().is_empty());
        assert_eq!(update.fee, Some(None));
        let blank =
            update_for(json!({ "activityId": "btc-in", "notes": "  " }), &existing).unwrap();
        assert_eq!(blank.notes, None);
        assert!(update_for(json!({ "activityId": "btc-in", "assetId": " " }), &existing).is_err());
        for invalid in ["", "EURO", "E1R"] {
            assert!(
                update_for(
                    json!({ "activityId": "btc-in", "currency": invalid }),
                    &existing
                )
                .is_err(),
                "{invalid}"
            );
        }
        for (given, stored) in [("usd", "USD"), ("GBp", "GBp")] {
            let update = update_for(
                json!({ "activityId": "btc-in", "currency": given }),
                &existing,
            )
            .unwrap();
            assert_eq!(update.currency, stored);
        }
    }

    #[test]
    fn types_and_subtypes_follow_the_grid() {
        let existing = btc_transfer_in();
        let update = update_for(
            json!({ "activityId": "btc-in", "activityType": "buy" }),
            &existing,
        )
        .unwrap();
        assert_eq!(update.activity_type, "BUY");
        assert!(update_for(
            json!({ "activityId": "btc-in", "activityType": "FOO" }),
            &existing
        )
        .is_err());
        let update = update_for(
            json!({ "activityId": "btc-in", "activityType": "DIVIDEND", "subtype": "drip" }),
            &existing,
        )
        .unwrap();
        assert_eq!(update.subtype.as_deref(), Some("DRIP"));
        for (activity_type, subtype) in [("BUY", "DRIP"), ("TRANSFER_IN", "BONUS")] {
            assert!(
                update_for(
                    json!({ "activityId": "btc-in", "activityType": activity_type, "subtype": subtype }),
                    &existing
                )
                .is_err(),
                "{activity_type} {subtype}"
            );
        }
    }

    #[test]
    fn approval_follows_the_grid() {
        let mut draft = btc_transfer_in();
        draft.status = ActivityStatus::Draft;
        draft.needs_review = true;
        let update =
            update_for(json!({ "activityId": "btc-in", "approve": true }), &draft).unwrap();
        assert_eq!(update.status, Some(ActivityStatus::Posted));
        assert_eq!(update.needs_review, Some(false));

        let mut flagged = btc_transfer_in();
        flagged.needs_review = true;
        let update =
            update_for(json!({ "activityId": "btc-in", "approve": true }), &flagged).unwrap();
        assert_eq!(update.status, None);
        assert_eq!(update.needs_review, Some(false));

        let error = update_for(
            json!({ "activityId": "btc-in", "approve": true }),
            &btc_transfer_in(),
        )
        .unwrap_err();
        assert!(error.contains("not waiting for review"), "{error}");
    }

    #[test]
    fn a_stated_trade_total_is_attested_unless_draft() {
        let mut buy = btc_transfer_in();
        buy.activity_type = "BUY".to_string();
        let stated = json!({ "activityId": "btc-in", "amount": 100 });
        assert_eq!(
            update_for(stated.clone(), &buy).unwrap().needs_review,
            Some(false)
        );
        buy.status = ActivityStatus::Draft;
        assert_eq!(update_for(stated.clone(), &buy).unwrap().needs_review, None);
        assert_eq!(
            update_for(stated, &btc_transfer_in()).unwrap().needs_review,
            None,
            "not a trade"
        );
    }

    #[test]
    fn changes_report_current_and_proposed_values() {
        let mut existing = btc_transfer_in();
        existing.fee = Some(d("2.50"));
        let update = update_for(
            json!({ "activityId": "btc-in", "amount": 650.5, "fee": 2.5, "date": "2026-03-01" }),
            &existing,
        )
        .unwrap();
        let changes = preview_changes(&PreviewedActivityUpdate {
            activity_date: date("2026-03-01T00:00:00Z"),
            existing,
            update,
        });
        let changes: Vec<_> = changes
            .iter()
            .map(|change| {
                (
                    change.field,
                    change.current.clone(),
                    change.proposed.clone(),
                )
            })
            .collect();
        assert_eq!(
            changes,
            vec![
                (
                    "date",
                    json!("2026-03-02T09:30:00+00:00"),
                    json!("2026-03-01T00:00:00+00:00")
                ),
                ("amount", Value::Null, json!("650.5")),
            ],
            "an equal fee at another scale is no change"
        );
    }

    #[test]
    fn a_linked_leg_keeps_what_the_pair_depends_on() {
        let preview = |existing: Activity, linked: Activity| ActivityUpdatePreview {
            activity: previewed(existing),
            linked: Some(previewed(linked)),
        };
        let cash = preview(
            cash_leg("in", "savings", "TRANSFER_IN"),
            cash_leg("out", "chequing", "TRANSFER_OUT"),
        );
        for allowed in ["date", "amount", "fee", "notes", "quantity"] {
            assert!(check_guards(&cash, &[change(allowed)]).is_ok(), "{allowed}");
        }
        for blocked in ["accountId", "currency", "activityType", "assetId"] {
            let error = check_guards(&cash, &[change("date"), change(blocked)]).unwrap_err();
            assert!(error.contains(blocked), "{error}");
            assert!(error.contains("unlink_transfer_activities"), "{error}");
        }

        let mut security_out = btc_transfer_in();
        security_out.id = "btc-out".to_string();
        security_out.activity_type = "TRANSFER_OUT".to_string();
        let securities = preview(btc_transfer_in(), security_out);
        assert!(check_guards(&securities, &[change("quantity")]).is_err());
        assert!(check_guards(&securities, &[change("unitPrice")]).is_ok());

        // A cross-currency cash pair is mirrored with its stored rate; on a
        // same-currency pair or a security leg the rate is a valuation rate.
        let mut usd_out = cash_leg("out", "chequing", "TRANSFER_OUT");
        usd_out.currency = "USD".to_string();
        let cross_currency = preview(cash_leg("in", "savings", "TRANSFER_IN"), usd_out);
        let error =
            check_guards(&cross_currency, &[change("amount"), change("fxRate")]).unwrap_err();
        assert!(error.contains("fxRate"), "{error}");
        assert!(check_guards(&cross_currency, &[change("amount")]).is_ok());
        assert!(check_guards(&cash, &[change("fxRate")]).is_ok());
        assert!(check_guards(&securities, &[change("fxRate")]).is_ok());

        let unlinked = ActivityUpdatePreview {
            activity: previewed(cash_leg("in", "savings", "TRANSFER_IN")),
            linked: None,
        };
        assert!(check_guards(&unlinked, &[change("accountId"), change("currency")]).is_ok());
    }

    #[test]
    fn audit_keeps_only_ids_and_field_names() {
        let args = json!({
            "updates": [
                { "activityId": "a", "amount": 650.5, "fee": 2.5, "notes": "IBAN FR76", "extra": "secret" },
                { "activityId": { "nested": "secret" }, "unitPrice": 1 }
            ],
            "comment": "secret"
        });
        assert_eq!(
            CommitActivityUpdates.sanitize_args_for_audit(&args),
            json!({
                "updates": [
                    { "activityId": "a", "fields": ["amount", "fee", "notes"] },
                    { "activityId": null, "fields": ["unitPrice"] }
                ],
                "updateCount": 2
            })
        );
        let oversized: Vec<_> = (0..MAX_UPDATES + 5)
            .map(|_| json!({ "activityId": "a", "fee": 1 }))
            .collect();
        let audit =
            PrepareActivityUpdates.sanitize_args_for_audit(&json!({ "updates": oversized }));
        assert_eq!(audit["updates"].as_array().unwrap().len(), MAX_UPDATES);
        assert_eq!(audit["updateCount"], MAX_UPDATES + 5);
    }

    #[test]
    fn schema_caps_the_batch_and_refuses_unknown_fields() {
        for schema in [
            PrepareActivityUpdates.input_schema(),
            CommitActivityUpdates.input_schema(),
        ] {
            let updates = &schema["properties"]["updates"];
            assert_eq!(updates["maxItems"], json!(MAX_UPDATES));
            assert_eq!(updates["items"]["additionalProperties"], json!(false));
            let properties = updates["items"]["properties"].as_object().unwrap();
            for field in UPDATE_FIELDS {
                assert!(properties.contains_key(*field), "{field}");
            }
            assert!(!properties.contains_key("symbol"));
        }
    }
}
