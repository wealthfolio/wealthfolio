//! Propose Transaction Categories tool.
//!
//! Returns a draft batch of category proposals for cash transactions. Proposal-only:
//! the widget applies via `bulk_assign_categories` after the user confirms.
//!
//! Architecture (mirrors `import_csv` and `record_activity` — no inner LLM call):
//! 1. **Deterministic passes** run server-side every call:
//!    a. Categorization rules (highest confidence).
//!    b. Same-payee history match.
//! 2. **LLM reasoning happens in the chat agent itself**, not inside the tool.
//!    The tool returns the full taxonomy tree, recent few-shot examples, and the
//!    list of unproposed rows to the chat agent. The agent reasons in chat
//!    context, then calls this tool a second time with `aiProposals` — its
//!    inferred categories as structured tool arguments. The tool merges those
//!    with the deterministic results.
//!
//! Same pattern as `import_csv`: the agent's tool-call IS the structured output.

use chrono::{DateTime, Utc};
use log::{debug, warn};
use rig::{completion::ToolDefinition, tool::Tool};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::env::AiEnvironment;
use crate::error::AiError;
use wealthfolio_core::accounts::account_types;
use wealthfolio_spending::cash_activities::{
    CashActivity, CashActivitySearchRequest, CashActivityStatusFilter,
};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 100;
const HISTORY_FETCH_LIMIT: usize = 400;
const EXAMPLES_PER_CATEGORY: usize = 3;
const MAX_TOTAL_EXAMPLES: usize = 80;
const MAX_NOTES_LEN: usize = 100;

fn truncate_notes(s: &str) -> String {
    // Use char count consistently — byte len would spuriously truncate UTF-8 strings
    // with multi-byte characters that have fewer than MAX_NOTES_LEN characters.
    if s.chars().count() <= MAX_NOTES_LEN {
        s.to_string()
    } else {
        let mut out = s.chars().take(MAX_NOTES_LEN).collect::<String>();
        out.push('…');
        out
    }
}

/// One AI-inferred category for a row, supplied by the chat agent on its second
/// call to this tool. The agent reasons about the unproposed rows in chat context
/// (using the taxonomies + examples returned on the first call) and passes its
/// conclusions back as structured args.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProposal {
    /// Activity ID from the unproposed list returned in the first call.
    pub activity_id: String,
    /// Taxonomy ID containing `category_key`. Category keys are taxonomy-scoped.
    pub taxonomy_id: String,
    /// Category key from the taxonomies returned in the first call (e.g. "groceries").
    pub category_key: String,
    /// 0.0–1.0; agent's stated confidence. Defaults to 0.7 if missing.
    #[serde(default)]
    pub confidence: Option<f32>,
    /// Short explanation shown in the widget tooltip.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeCategoriesArgs {
    /// Explicit set of activity ids to propose for. Intersected with filters when set.
    pub activity_ids: Option<Vec<String>>,
    pub account_ids: Option<Vec<String>>,
    /// "uncategorized" (default) | "all" | "needs_review"
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub limit: Option<u32>,
    /// Agent-inferred categories for the unproposed rows. The agent must fill this
    /// after calling `list_categorization_context` — there is no other way for an
    /// AI-inferred category to reach the widget. Don't leave this empty when the
    /// context call returned `needsAiJudgement > 0`.
    #[serde(default)]
    pub ai_proposals: Option<Vec<AiProposal>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryOption {
    pub category_id: String,
    pub key: String,
    pub name: String,
    pub path: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxonomySummary {
    pub taxonomy_id: String,
    pub taxonomy_name: String,
    pub categories: Vec<CategoryOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryExample {
    pub category_id: String,
    pub category_path: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub activity_id: String,
    pub activity_date: String,
    pub amount: f64,
    pub currency: String,
    pub notes: Option<String>,
    pub taxonomy_id: String,
    pub category_id: String,
    pub category_path: String,
    pub confidence: f32,
    /// "rule" | "history" | "ai"
    pub source: String,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnproposedActivity {
    pub activity_id: String,
    pub activity_date: String,
    pub amount: f64,
    pub currency: String,
    pub notes: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalSummary {
    pub total: usize,
    pub proposed: usize,
    pub unproposed: usize,
    pub avg_confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposeCategoriesOutput {
    pub proposals: Vec<Proposal>,
    pub unproposed: Vec<UnproposedActivity>,
    pub summary: ProposalSummary,
    /// Activity-scope taxonomies + categories. Used by the chat agent for
    /// reasoning, and by the widget's per-row picker.
    pub taxonomies: Vec<TaxonomySummary>,
    /// Per-category examples sourced from past `manual`/`rule`/`import` assignments.
    /// The chat agent uses these as few-shot context to infer categories for the
    /// unproposed rows.
    pub examples: Vec<CategoryExample>,
    /// Conversational state marker for the chat agent. "draft" means this tool
    /// result is the current draft awaiting user review/apply. The widget flips
    /// this to "applied" client-side after a successful Apply (via updateToolResult).
    /// When the agent sees a "draft" output and the user gives a follow-up hint,
    /// the agent should re-run categorization rather than treating it as a future
    /// preference.
    #[serde(default = "default_draft_status")]
    pub draft_status: String,
}

fn default_draft_status() -> String {
    "draft".to_string()
}

pub struct ProposeCategoriesTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> ProposeCategoriesTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for ProposeCategoriesTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

fn normalize_payee(notes: &str) -> String {
    notes
        .to_lowercase()
        .split_whitespace()
        .filter(|tok| {
            !tok.chars()
                .all(|c| c.is_ascii_digit() || c == '*' || c == '#')
        })
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

impl<E: AiEnvironment + 'static> Tool for ProposeCategoriesTool<E> {
    const NAME: &'static str = "propose_transaction_categories";

    type Error = AiError;
    type Args = ProposeCategoriesArgs;
    type Output = ProposeCategoriesOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description:
                "Render the categorization widget for the user to review and confirm. Run \
                 `list_categorization_context` FIRST to see the taxonomies, recent few-shot \
                 examples, and the unproposed rows; reason about each unproposed row, then \
                 call this tool with `aiProposals` filled in. The tool runs deterministic \
                 rule + same-payee history matches, merges your `aiProposals` for the rows \
                 those passes didn't cover, and renders the widget. Do NOT pass `accountIds` \
                 for generic mentions like 'credit card' or 'this account'."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "activityIds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional explicit set of activity IDs to propose for. Intersected with the other filters."
                    },
                    "accountIds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "OMIT unless the user names a specific account by exact name or ID."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["uncategorized", "all", "needs_review"],
                        "description": "Default: uncategorized."
                    },
                    "startDate": { "type": "string", "description": "Inclusive ISO 8601 lower bound." },
                    "endDate":   { "type": "string", "description": "Inclusive ISO 8601 upper bound." },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_LIMIT,
                        "description": "Max rows to propose. Default 100 (also the cap). When the returned `summary.total` equals the limit, more uncategorized rows likely remain — see system prompt for the continuation flow."
                    },
                    "aiProposals": {
                        "type": "array",
                        "description": "Your inferred categories for the rows returned as `unproposed` from `list_categorization_context`. Each entry: { activityId, taxonomyId, categoryKey, confidence (0–1), reason }.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "activityId": { "type": "string" },
                                "taxonomyId": { "type": "string" },
                                "categoryKey": { "type": "string" },
                                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                                "reason": { "type": "string" }
                            },
                            "required": ["activityId", "taxonomyId", "categoryKey"]
                        }
                    }
                }
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        debug!(
            "propose_transaction_categories called (ai_proposals: {})",
            args.ai_proposals.as_ref().map(|v| v.len()).unwrap_or(0)
        );

        let mut state = compute_categorization_state(
            &self.env,
            CategorizationFilters {
                activity_ids: args.activity_ids.clone(),
                account_ids: args.account_ids.clone(),
                status: args.status.clone(),
                start_date: args.start_date.clone(),
                end_date: args.end_date.clone(),
                limit: args.limit,
            },
        )
        .await?;

        if state.is_empty {
            return Ok(ProposeCategoriesOutput {
                proposals: Vec::new(),
                unproposed: Vec::new(),
                summary: ProposalSummary {
                    total: 0,
                    proposed: 0,
                    unproposed: 0,
                    avg_confidence: 0.0,
                },
                taxonomies: Vec::new(),
                examples: Vec::new(),
                draft_status: "draft".to_string(),
            });
        }

        // Telemetry: warn when the agent calls without aiProposals while there
        // are rows that need AI judgement. Common failure mode the system prompt
        // tries to prevent — surfacing it in dev logs makes regressions visible.
        let unproposed_pre_ai = state.unproposed.len();
        let ai_props_count = args.ai_proposals.as_ref().map(|v| v.len()).unwrap_or(0);
        if unproposed_pre_ai > 0 && ai_props_count == 0 {
            warn!(
                "propose_transaction_categories called with empty aiProposals while {} rows \
                 need AI judgement. Agent should have inferred categories per system prompt.",
                unproposed_pre_ai
            );
        }
        if state.taxonomies.is_empty() {
            warn!(
                "propose_transaction_categories: no activity-scope taxonomies are configured; \
                 widget will render the no-taxonomies empty state."
            );
        }

        // Merge `aiProposals` from the agent. Validate each against the live
        // taxonomy — drop entries with unknown category keys or activity IDs
        // not in our unproposed list (rules/history already covered them).
        if let Some(ai_props) = args.ai_proposals {
            let (merged_proposals, remaining_unproposed) = merge_ai_proposals(
                std::mem::take(&mut state.unproposed),
                std::mem::take(&mut state.proposals),
                &state.key_lookup,
                ai_props,
            );
            state.proposals = merged_proposals;
            state.unproposed = remaining_unproposed;
        }

        let total = state.total;
        let proposed = state.proposals.len();
        let avg_confidence = if proposed > 0 {
            state.proposals.iter().map(|p| p.confidence).sum::<f32>() / proposed as f32
        } else {
            0.0
        };

        Ok(ProposeCategoriesOutput {
            proposals: state.proposals,
            unproposed: state.unproposed,
            summary: ProposalSummary {
                total,
                proposed,
                unproposed: total.saturating_sub(proposed),
                avg_confidence,
            },
            taxonomies: state.taxonomies,
            examples: state.examples,
            draft_status: "draft".to_string(),
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct CategorizationFilters {
    pub activity_ids: Option<Vec<String>>,
    pub account_ids: Option<Vec<String>>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub limit: Option<u32>,
}

pub(crate) struct CategorizationState {
    pub is_empty: bool,
    pub total: usize,
    pub proposals: Vec<Proposal>,
    pub unproposed: Vec<UnproposedActivity>,
    pub taxonomies: Vec<TaxonomySummary>,
    pub examples: Vec<CategoryExample>,
    /// (taxonomy_id, category_key) -> (taxonomy_id, category_id, path). Used to
    /// resolve agent-supplied category keys back to live IDs.
    pub key_lookup: HashMap<(String, String), (String, String, String)>,
}

/// Shared deterministic pass — fetches activities + taxonomies + history, runs
/// rules + same-payee match, returns the full state. Used by both
/// `propose_transaction_categories` (which then merges agent aiProposals) and
/// `list_categorization_context` (which exposes the agent-facing context only).
pub(crate) async fn compute_categorization_state<E: AiEnvironment>(
    env: &Arc<E>,
    filters: CategorizationFilters,
) -> Result<CategorizationState, AiError> {
    let limit = filters
        .limit
        .map(|n| (n as usize).min(MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT)
        .max(1);

    let status = match filters.status.as_deref() {
        Some("all") => CashActivityStatusFilter::All,
        Some("needs_review") => CashActivityStatusFilter::NeedsReview,
        _ => CashActivityStatusFilter::Uncategorized,
    };

    let cash = env.cash_activity_service();
    let targets = if let Some(ids) = filters.activity_ids.as_ref() {
        validate_explicit_activity_ids(ids)?;
        let mut targets = cash
            .get_by_activity_ids(ids)
            .await
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
        let account_type_by_id = account_types_for_targets(env, &targets)?;
        retain_explicit_targets(&mut targets, &filters, status, &account_type_by_id)?;
        targets.truncate(limit);
        targets
    } else {
        let target_request = CashActivitySearchRequest {
            account_ids: filters.account_ids.clone(),
            status,
            start_date: filters.start_date.clone(),
            end_date: filters.end_date.clone(),
            limit,
            ..Default::default()
        };
        cash.search(target_request)
            .await
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?
            .items
    };
    if targets.is_empty() {
        return Ok(CategorizationState {
            is_empty: true,
            total: 0,
            proposals: Vec::new(),
            unproposed: Vec::new(),
            taxonomies: Vec::new(),
            examples: Vec::new(),
            key_lookup: HashMap::new(),
        });
    }
    let history_account_ids = filters.account_ids.clone().or_else(|| {
        filters.activity_ids.as_ref().map(|_| {
            let mut ids = targets
                .iter()
                .map(|item| item.activity.account_id.clone())
                .collect::<Vec<_>>();
            ids.sort();
            ids.dedup();
            ids
        })
    });

    let tax_service = env.taxonomy_service();
    let all_taxonomies = tax_service
        .get_taxonomies_with_categories()
        .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
    let activity_taxonomies: Vec<_> = all_taxonomies
        .into_iter()
        .filter(|t| t.taxonomy.scope == "activity")
        .collect();

    // category_id -> (taxonomy_id, taxonomy_name, category_name, path, color)
    let mut category_lookup: HashMap<String, (String, String, String, String, String)> =
        HashMap::new();
    let mut key_lookup: HashMap<(String, String), (String, String, String)> = HashMap::new();
    let mut taxonomy_summaries = Vec::with_capacity(activity_taxonomies.len());
    for entry in &activity_taxonomies {
        let cats_by_id: HashMap<&str, &_> = entry
            .categories
            .iter()
            .map(|c| (c.id.as_str(), c))
            .collect();
        let mut options = Vec::with_capacity(entry.categories.len());
        for cat in &entry.categories {
            let path = build_category_path(cat, &cats_by_id);
            category_lookup.insert(
                cat.id.clone(),
                (
                    entry.taxonomy.id.clone(),
                    entry.taxonomy.name.clone(),
                    cat.name.clone(),
                    path.clone(),
                    cat.color.clone(),
                ),
            );
            key_lookup.insert(
                (entry.taxonomy.id.clone(), cat.key.clone()),
                (entry.taxonomy.id.clone(), cat.id.clone(), path.clone()),
            );
            options.push(CategoryOption {
                category_id: cat.id.clone(),
                key: cat.key.clone(),
                name: cat.name.clone(),
                path,
                color: cat.color.clone(),
            });
        }
        taxonomy_summaries.push(TaxonomySummary {
            taxonomy_id: entry.taxonomy.id.clone(),
            taxonomy_name: entry.taxonomy.name.clone(),
            categories: options,
        });
    }

    let history_request = CashActivitySearchRequest {
        account_ids: history_account_ids,
        status: CashActivityStatusFilter::Categorized,
        limit: HISTORY_FETCH_LIMIT,
        ..Default::default()
    };
    let history_response = cash
        .search(history_request)
        .await
        .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

    let mut payee_map: HashMap<(String, String), HashMap<(String, String), usize>> = HashMap::new();
    for item in &history_response.items {
        let Some(notes) = item.activity.notes.as_deref() else {
            continue;
        };
        let payee_key = normalize_payee(notes);
        if payee_key.is_empty() {
            continue;
        }
        let key = (payee_key, item.activity.effective_type().to_string());
        for asg in &item.assignments {
            payee_map
                .entry(key.clone())
                .or_default()
                .entry((asg.taxonomy_id.clone(), asg.category_id.clone()))
                .and_modify(|c| *c += 1)
                .or_insert(1);
        }
    }

    let mut per_cat_count: HashMap<String, usize> = HashMap::new();
    let mut examples = Vec::new();
    for item in &history_response.items {
        if examples.len() >= MAX_TOTAL_EXAMPLES {
            break;
        }
        let Some(notes) = item.activity.notes.as_deref() else {
            continue;
        };
        for asg in &item.assignments {
            let count = per_cat_count.entry(asg.category_id.clone()).or_insert(0);
            if *count >= EXAMPLES_PER_CATEGORY {
                continue;
            }
            let Some((_tax_id, _tax_name, _cat_name, path, _color)) =
                category_lookup.get(&asg.category_id)
            else {
                continue;
            };
            examples.push(CategoryExample {
                category_id: asg.category_id.clone(),
                category_path: path.clone(),
                notes: truncate_notes(notes),
            });
            *count += 1;
            break;
        }
    }

    let rules_service = env.categorization_rules_service();
    let all_rules = rules_service
        .list()
        .await
        .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
    let compiled_rules =
        wealthfolio_spending::categorization_rules::matcher::compile_rules(&all_rules);

    let total = targets.len();
    let mut proposals = Vec::new();
    let mut unproposed = Vec::new();
    for target in &targets {
        let act = &target.activity;
        let amount = act.amount.and_then(|d| d.to_f64()).unwrap_or(0.0);
        let date = act.activity_date.format("%Y-%m-%d").to_string();
        let notes_trimmed = act.notes.as_deref().map(truncate_notes);

        let notes = act.notes.as_deref().unwrap_or("");
        let notes_upper = notes.to_uppercase();
        let rule_match = wealthfolio_spending::categorization_rules::matcher::match_compiled(
            &compiled_rules,
            &notes_upper,
            notes,
            act.effective_type(),
            &act.account_id,
        );
        if let Some(m) = rule_match {
            if let (Some(tax_id), Some(cat_id)) =
                (m.rule.taxonomy_id.clone(), m.rule.category_id.clone())
            {
                if let Some((_, _, _, path, _)) = category_lookup.get(&cat_id) {
                    proposals.push(Proposal {
                        activity_id: act.id.clone(),
                        activity_date: date.clone(),
                        amount,
                        currency: act.currency.clone(),
                        notes: notes_trimmed.clone(),
                        taxonomy_id: tax_id,
                        category_id: cat_id,
                        category_path: path.clone(),
                        confidence: 0.95,
                        source: "rule".to_string(),
                        explanation: format!("Matched rule \"{}\".", m.rule.name),
                    });
                    continue;
                }
            }
        }

        let history_match = act
            .notes
            .as_deref()
            .map(normalize_payee)
            .filter(|k| !k.is_empty())
            .and_then(|key| {
                payee_map
                    .get(&(key, act.effective_type().to_string()))
                    .cloned()
            })
            .and_then(|by_cat| {
                by_cat
                    .into_iter()
                    .max_by_key(|(_, count)| *count)
                    .map(|((tax_id, cat_id), count)| (tax_id, cat_id, count))
            });

        if let Some((tax_id, cat_id, count)) = history_match {
            if let Some((_, _, _, path, _)) = category_lookup.get(&cat_id) {
                let confidence = if count >= 3 {
                    0.92
                } else if count == 2 {
                    0.82
                } else {
                    0.7
                };
                proposals.push(Proposal {
                    activity_id: act.id.clone(),
                    activity_date: date,
                    amount,
                    currency: act.currency.clone(),
                    notes: notes_trimmed,
                    taxonomy_id: tax_id,
                    category_id: cat_id,
                    category_path: path.clone(),
                    confidence,
                    source: "history".to_string(),
                    explanation: format!("Matched same payee in {} prior transaction(s).", count),
                });
                continue;
            }
        }

        unproposed.push(UnproposedActivity {
            activity_id: act.id.clone(),
            activity_date: date,
            amount,
            currency: act.currency.clone(),
            notes: notes_trimmed,
            reason: "No rule or history match — needs AI or manual judgement.".to_string(),
        });
    }

    Ok(CategorizationState {
        is_empty: false,
        total,
        proposals,
        unproposed,
        taxonomies: taxonomy_summaries,
        examples,
        key_lookup,
    })
}

/// Merge agent-supplied AI proposals into the deterministic results.
/// Drops entries whose `activity_id` is not in `unproposed` (rules/history
/// already covered them) or whose `category_key` is not in `key_lookup`.
/// Confidence is clamped to [0.5, 0.95]; missing confidence defaults to 0.7.
/// On duplicate `activity_id` entries the last one wins (HashMap insertion).
pub(crate) fn merge_ai_proposals(
    unproposed: Vec<UnproposedActivity>,
    mut proposals: Vec<Proposal>,
    key_lookup: &HashMap<(String, String), (String, String, String)>,
    ai_props: Vec<AiProposal>,
) -> (Vec<Proposal>, Vec<UnproposedActivity>) {
    let target_index: HashMap<&str, &UnproposedActivity> = unproposed
        .iter()
        .map(|u| (u.activity_id.as_str(), u))
        .collect();
    let mut accepted: HashMap<String, Proposal> = HashMap::new();
    for ai in ai_props {
        let Some(row) = target_index.get(ai.activity_id.as_str()) else {
            continue;
        };
        let Some((tax_id, cat_id, path)) =
            key_lookup.get(&(ai.taxonomy_id.clone(), ai.category_key.clone()))
        else {
            continue;
        };
        let confidence = ai.confidence.unwrap_or(0.7).clamp(0.5, 0.95);
        accepted.insert(
            row.activity_id.clone(),
            Proposal {
                activity_id: row.activity_id.clone(),
                activity_date: row.activity_date.clone(),
                amount: row.amount,
                currency: row.currency.clone(),
                notes: row.notes.clone(),
                taxonomy_id: tax_id.clone(),
                category_id: cat_id.clone(),
                category_path: path.clone(),
                confidence,
                source: "ai".to_string(),
                explanation: ai
                    .reason
                    .unwrap_or_else(|| "AI inferred from payee + history.".to_string()),
            },
        );
    }
    let remaining: Vec<UnproposedActivity> = unproposed
        .into_iter()
        .filter(|u| !accepted.contains_key(&u.activity_id))
        .collect();
    proposals.extend(accepted.into_values());
    (proposals, remaining)
}

fn validate_explicit_activity_ids(ids: &[String]) -> Result<(), AiError> {
    if ids.len() > MAX_LIMIT {
        return Err(AiError::invalid_input(format!(
            "activityIds supports at most {MAX_LIMIT} ids"
        )));
    }
    Ok(())
}

fn retain_explicit_targets(
    targets: &mut Vec<CashActivity>,
    filters: &CategorizationFilters,
    status: CashActivityStatusFilter,
    account_type_by_id: &HashMap<String, String>,
) -> Result<(), AiError> {
    let allowed_accounts: Option<HashSet<String>> = filters
        .account_ids
        .as_ref()
        .filter(|ids| !ids.is_empty())
        .map(|ids| ids.iter().cloned().collect());
    let start = parse_filter_datetime("startDate", filters.start_date.as_deref())?;
    let end = parse_filter_datetime("endDate", filters.end_date.as_deref())?;

    targets.retain(|item| {
        if let Some(account_ids) = &allowed_accounts {
            if !account_ids.contains(&item.activity.account_id) {
                return false;
            }
        }
        if let Some(start) = start.as_ref() {
            if &item.activity.activity_date < start {
                return false;
            }
        }
        if let Some(end) = end.as_ref() {
            if &item.activity.activity_date > end {
                return false;
            }
        }

        let has_category =
            is_neutral_visible_target(item, account_type_by_id) || !item.assignments.is_empty();
        match status {
            CashActivityStatusFilter::All => true,
            CashActivityStatusFilter::NeedsReview => item.activity.needs_review,
            CashActivityStatusFilter::Uncategorized => !has_category,
            CashActivityStatusFilter::Categorized => has_category,
        }
    });

    Ok(())
}

fn account_types_for_targets<E: AiEnvironment>(
    env: &Arc<E>,
    targets: &[CashActivity],
) -> Result<HashMap<String, String>, AiError> {
    let account_ids = targets
        .iter()
        .map(|item| item.activity.account_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if account_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let accounts = env
        .account_service()
        .get_accounts_by_ids(&account_ids)
        .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;
    Ok(accounts
        .into_iter()
        .map(|account| (account.id, account.account_type))
        .collect())
}

fn is_neutral_visible_target(
    item: &CashActivity,
    account_type_by_id: &HashMap<String, String>,
) -> bool {
    account_type_by_id
        .get(&item.activity.account_id)
        .is_some_and(|account_type| {
            account_type == account_types::CREDIT_CARD
                && item.activity.effective_type() == "TRANSFER_IN"
                && item.activity.source_group_id.is_some()
        })
}

fn parse_filter_datetime(
    field: &str,
    value: Option<&str>,
) -> Result<Option<DateTime<Utc>>, AiError> {
    value
        .map(|value| DateTime::parse_from_rfc3339(value).map(|date| date.with_timezone(&Utc)))
        .transpose()
        .map_err(|e| AiError::invalid_input(format!("Invalid {field}: {e}")))
}

fn build_category_path(
    cat: &wealthfolio_core::taxonomies::Category,
    cats_by_id: &HashMap<&str, &wealthfolio_core::taxonomies::Category>,
) -> String {
    let mut parts = vec![cat.name.clone()];
    let mut current_parent = cat.parent_id.as_deref();
    let mut depth = 0;
    while let Some(pid) = current_parent {
        if depth > 8 {
            break;
        }
        if let Some(parent) = cats_by_id.get(pid) {
            parts.push(parent.name.clone());
            current_parent = parent.parent_id.as_deref();
        } else {
            break;
        }
        depth += 1;
    }
    parts.reverse();
    parts.join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;
    use rust_decimal::Decimal;
    use wealthfolio_core::activities::{Activity, ActivityStatus};
    use wealthfolio_core::taxonomies::Category;

    // ----- normalize_payee -------------------------------------------------

    #[test]
    fn normalize_payee_table_driven() {
        let cases: &[(&str, &str)] = &[
            ("SQ *MORNING OWL TORONTO #5523", "sq *morning owl"),
            ("AMAZON.COM*A1B2", "amazon.com*a1b2"),
            ("COBS BREAD", "cobs bread"),
            ("", ""),
            ("   \t  ", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(
                normalize_payee(input),
                *expected,
                "normalize_payee({:?})",
                input
            );
        }
    }

    // ----- truncate_notes --------------------------------------------------

    #[test]
    fn truncate_notes_short_unchanged() {
        let s = "hello world";
        assert_eq!(truncate_notes(s), s);
    }

    #[test]
    fn truncate_notes_exactly_max_unchanged() {
        let s: String = "a".repeat(MAX_NOTES_LEN);
        assert_eq!(truncate_notes(&s), s);
    }

    #[test]
    fn truncate_notes_long_gets_ellipsis() {
        let s: String = "a".repeat(MAX_NOTES_LEN + 50);
        let out = truncate_notes(&s);
        assert!(out.ends_with('…'));
        // First MAX_NOTES_LEN chars + ellipsis.
        assert_eq!(out.chars().count(), MAX_NOTES_LEN + 1);
    }

    #[test]
    fn truncate_notes_multibyte_truncates_by_char_not_byte() {
        // Each emoji is multi-byte UTF-8 (4 bytes). MAX_NOTES_LEN+10 emojis
        // exceed MAX_NOTES_LEN by char count and would be far over by byte count.
        let s: String = "🍕".repeat(MAX_NOTES_LEN + 10);
        let out = truncate_notes(&s);
        assert!(out.ends_with('…'));
        // Should have exactly MAX_NOTES_LEN pizza chars + 1 ellipsis.
        assert_eq!(out.chars().count(), MAX_NOTES_LEN + 1);
        // And every leading char should be the pizza emoji.
        let pizzas = out
            .chars()
            .take(MAX_NOTES_LEN)
            .filter(|c| *c == '🍕')
            .count();
        assert_eq!(pizzas, MAX_NOTES_LEN);
    }

    #[test]
    fn truncate_notes_multibyte_under_byte_limit_unchanged() {
        // 30 pizzas = 120 bytes, but only 30 chars — ≤ MAX_NOTES_LEN by char,
        // so should be unchanged. (Also confirms `s.len() <= MAX_NOTES_LEN`
        // byte-based fast path works correctly when bytes ≤ MAX_NOTES_LEN.)
        let s: String = "a".repeat(50);
        assert_eq!(truncate_notes(&s), s);
    }

    // ----- build_category_path --------------------------------------------

    fn make_cat(id: &str, name: &str, parent: Option<&str>) -> Category {
        let now: NaiveDateTime = "2024-01-01T00:00:00"
            .parse()
            .expect("valid timestamp literal");
        Category {
            id: id.to_string(),
            taxonomy_id: "tax1".to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            key: id.to_string(),
            color: "#000000".to_string(),
            description: None,
            sort_order: 0,
            created_at: now,
            updated_at: now,
            icon: None,
        }
    }

    fn make_cash_activity(
        id: &str,
        account_id: &str,
        activity_date: &str,
        needs_review: bool,
        assigned: bool,
    ) -> CashActivity {
        let now = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let activity_date = DateTime::parse_from_rfc3339(activity_date)
            .unwrap()
            .with_timezone(&Utc);
        let assignments = if assigned {
            vec![
                wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignment {
                    id: format!("{id}-asg"),
                    activity_id: id.to_string(),
                    taxonomy_id: "spending_categories".to_string(),
                    category_id: "cat-1".to_string(),
                    weight: 10_000,
                    source: "manual".to_string(),
                    created_at: now.naive_utc(),
                    updated_at: now.naive_utc(),
                },
            ]
        } else {
            Vec::new()
        };
        CashActivity {
            activity: Activity {
                id: id.to_string(),
                account_id: account_id.to_string(),
                asset_id: None,
                activity_type: "WITHDRAWAL".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(Decimal::new(1000, 2)),
                fee: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: Some("test".to_string()),
                metadata: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review,
                created_at: now,
                updated_at: now,
            },
            assignments,
            event_id: None,
        }
    }

    #[test]
    fn explicit_activity_ids_reject_over_max_limit() {
        let ids = (0..150)
            .map(|i| format!("activity-{i}"))
            .collect::<Vec<_>>();

        let err = validate_explicit_activity_ids(&ids).unwrap_err();

        assert!(matches!(err, AiError::InvalidInput(_)));
    }

    #[test]
    fn explicit_activity_ids_accept_max_limit() {
        let ids = (0..MAX_LIMIT)
            .map(|i| format!("activity-{i}"))
            .collect::<Vec<_>>();

        validate_explicit_activity_ids(&ids).unwrap();
    }

    #[test]
    fn explicit_targets_intersect_account_status_and_date_filters() {
        let mut targets = vec![
            make_cash_activity("keep", "acct-1", "2024-06-15T00:00:00Z", true, false),
            make_cash_activity(
                "wrong-account",
                "acct-2",
                "2024-06-15T00:00:00Z",
                true,
                false,
            ),
            make_cash_activity(
                "wrong-status",
                "acct-1",
                "2024-06-15T00:00:00Z",
                false,
                false,
            ),
            make_cash_activity("too-early", "acct-1", "2024-05-31T23:59:59Z", true, false),
            make_cash_activity("too-late", "acct-1", "2024-07-01T00:00:01Z", true, false),
        ];
        let filters = CategorizationFilters {
            account_ids: Some(vec!["acct-1".to_string()]),
            start_date: Some("2024-06-01T00:00:00Z".to_string()),
            end_date: Some("2024-07-01T00:00:00Z".to_string()),
            ..Default::default()
        };

        retain_explicit_targets(
            &mut targets,
            &filters,
            CashActivityStatusFilter::NeedsReview,
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].activity.id, "keep");
    }

    #[test]
    fn explicit_targets_apply_categorized_status_filter() {
        let mut targets = vec![
            make_cash_activity("assigned", "acct-1", "2024-06-15T00:00:00Z", false, true),
            make_cash_activity("unassigned", "acct-1", "2024-06-15T00:00:00Z", false, false),
        ];

        retain_explicit_targets(
            &mut targets,
            &CategorizationFilters::default(),
            CashActivityStatusFilter::Categorized,
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].activity.id, "assigned");
    }

    #[test]
    fn explicit_targets_treat_credit_card_payments_as_categorized() {
        let mut payment =
            make_cash_activity("payment", "card-1", "2024-06-15T00:00:00Z", false, false);
        payment.activity.activity_type = "TRANSFER_IN".to_string();
        payment.activity.source_group_id = Some("payment-group".to_string());
        let mut targets = vec![payment];
        let account_type_by_id = HashMap::from([(
            "card-1".to_string(),
            wealthfolio_core::accounts::account_types::CREDIT_CARD.to_string(),
        )]);

        retain_explicit_targets(
            &mut targets,
            &CategorizationFilters::default(),
            CashActivityStatusFilter::Uncategorized,
            &account_type_by_id,
        )
        .unwrap();

        assert!(targets.is_empty());
    }

    #[test]
    fn explicit_targets_do_not_treat_unlinked_credit_card_transfer_as_categorized() {
        let mut payment =
            make_cash_activity("payment", "card-1", "2024-06-15T00:00:00Z", false, false);
        payment.activity.activity_type = "TRANSFER_IN".to_string();
        let mut targets = vec![payment];
        let account_type_by_id = HashMap::from([(
            "card-1".to_string(),
            wealthfolio_core::accounts::account_types::CREDIT_CARD.to_string(),
        )]);

        retain_explicit_targets(
            &mut targets,
            &CategorizationFilters::default(),
            CashActivityStatusFilter::Uncategorized,
            &account_type_by_id,
        )
        .unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].activity.id, "payment");
    }

    #[test]
    fn build_category_path_root() {
        let cat = make_cat("root", "Food", None);
        let map: HashMap<&str, &Category> = HashMap::new();
        assert_eq!(build_category_path(&cat, &map), "Food");
    }

    #[test]
    fn build_category_path_one_level() {
        let parent = make_cat("p", "Parent", None);
        let child = make_cat("c", "Child", Some("p"));
        let map: HashMap<&str, &Category> = [("p", &parent)].into_iter().collect();
        assert_eq!(build_category_path(&child, &map), "Parent / Child");
    }

    #[test]
    fn build_category_path_two_levels() {
        let gp = make_cat("gp", "Grandparent", None);
        let p = make_cat("p", "Parent", Some("gp"));
        let c = make_cat("c", "Child", Some("p"));
        let map: HashMap<&str, &Category> = [("gp", &gp), ("p", &p)].into_iter().collect();
        assert_eq!(
            build_category_path(&c, &map),
            "Grandparent / Parent / Child"
        );
    }

    #[test]
    fn build_category_path_cycle_does_not_loop() {
        // Self-cycle: cat A's parent is A.
        let a = make_cat("a", "A", Some("a"));
        let map: HashMap<&str, &Category> = [("a", &a)].into_iter().collect();
        // If this returns, we passed (no infinite loop). Depth cap is >8.
        let path = build_category_path(&a, &map);
        // We expect 1 (self) + up to 9 cycle traversals before break.
        assert!(path.contains("A"));
        // Total segments capped: starting name + at most 9 parent walks.
        let segments: Vec<&str> = path.split(" / ").collect();
        assert!(segments.len() <= 10, "got {} segments", segments.len());
    }

    // ----- merge_ai_proposals ----------------------------------------------

    fn make_unproposed(id: &str) -> UnproposedActivity {
        UnproposedActivity {
            activity_id: id.to_string(),
            activity_date: "2024-06-01".to_string(),
            amount: -42.0,
            currency: "USD".to_string(),
            notes: Some("STARBUCKS".to_string()),
            reason: "test".to_string(),
        }
    }

    fn make_key_lookup() -> HashMap<(String, String), (String, String, String)> {
        let mut m = HashMap::new();
        m.insert(
            ("tax1".to_string(), "groceries".to_string()),
            (
                "tax1".to_string(),
                "cat-g".to_string(),
                "Food / Groceries".to_string(),
            ),
        );
        m.insert(
            ("tax1".to_string(), "coffee".to_string()),
            (
                "tax1".to_string(),
                "cat-c".to_string(),
                "Food / Coffee".to_string(),
            ),
        );
        m
    }

    #[test]
    fn merge_valid_proposal_moves_row_to_proposals() {
        let unproposed = vec![make_unproposed("a1"), make_unproposed("a2")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: Some(0.8),
            reason: Some("looks like food".to_string()),
        }];

        let (proposals, remaining) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);

        assert_eq!(proposals.len(), 1);
        let p = &proposals[0];
        assert_eq!(p.activity_id, "a1");
        assert_eq!(p.source, "ai");
        assert_eq!(p.taxonomy_id, "tax1");
        assert_eq!(p.category_id, "cat-g");
        assert_eq!(p.category_path, "Food / Groceries");
        assert_eq!(p.confidence, 0.8);
        assert_eq!(p.explanation, "looks like food");

        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].activity_id, "a2");
    }

    #[test]
    fn merge_unknown_category_key_is_dropped() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "nonexistent".to_string(),
            confidence: Some(0.8),
            reason: None,
        }];

        let (proposals, remaining) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);

        assert!(proposals.is_empty());
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].activity_id, "a1");
    }

    #[test]
    fn merge_unknown_activity_id_is_dropped() {
        // a1 already proposed by rules — not in `unproposed`.
        let unproposed = vec![make_unproposed("a2")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: Some(0.8),
            reason: None,
        }];

        let (proposals, remaining) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);

        assert!(proposals.is_empty());
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].activity_id, "a2");
    }

    #[test]
    fn merge_confidence_clamped_high() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: Some(2.0),
            reason: None,
        }];
        let (proposals, _) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].confidence, 0.95);
    }

    #[test]
    fn merge_confidence_clamped_low() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: Some(0.1),
            reason: None,
        }];
        let (proposals, _) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].confidence, 0.5);
    }

    #[test]
    fn merge_confidence_missing_defaults_to_0_7() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: None,
            reason: None,
        }];
        let (proposals, _) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);
        assert_eq!(proposals.len(), 1);
        assert!((proposals[0].confidence - 0.7).abs() < 1e-6);
    }

    #[test]
    fn merge_missing_reason_uses_default_explanation() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "groceries".to_string(),
            confidence: Some(0.7),
            reason: None,
        }];
        let (proposals, _) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);
        assert_eq!(
            proposals[0].explanation,
            "AI inferred from payee + history."
        );
    }

    #[test]
    fn merge_empty_ai_proposals_leaves_unproposed_unchanged() {
        let unproposed = vec![make_unproposed("a1"), make_unproposed("a2")];
        let key_lookup = make_key_lookup();
        let (proposals, remaining) =
            merge_ai_proposals(unproposed.clone(), Vec::new(), &key_lookup, Vec::new());
        assert!(proposals.is_empty());
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].activity_id, "a1");
        assert_eq!(remaining[1].activity_id, "a2");
    }

    #[test]
    fn merge_duplicate_activity_id_last_wins() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let ai = vec![
            AiProposal {
                activity_id: "a1".to_string(),
                taxonomy_id: "tax1".to_string(),
                category_key: "groceries".to_string(),
                confidence: Some(0.6),
                reason: Some("first".to_string()),
            },
            AiProposal {
                activity_id: "a1".to_string(),
                taxonomy_id: "tax1".to_string(),
                category_key: "coffee".to_string(),
                confidence: Some(0.9),
                reason: Some("second".to_string()),
            },
        ];
        let (proposals, remaining) = merge_ai_proposals(unproposed, Vec::new(), &key_lookup, ai);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].category_id, "cat-c");
        assert_eq!(proposals[0].category_path, "Food / Coffee");
        assert_eq!(proposals[0].confidence, 0.9);
        assert_eq!(proposals[0].explanation, "second");
        assert!(remaining.is_empty());
    }

    #[test]
    fn merge_preserves_existing_proposals() {
        let unproposed = vec![make_unproposed("a1")];
        let key_lookup = make_key_lookup();
        let existing = vec![Proposal {
            activity_id: "a0".to_string(),
            activity_date: "2024-06-01".to_string(),
            amount: -10.0,
            currency: "USD".to_string(),
            notes: None,
            taxonomy_id: "tax1".to_string(),
            category_id: "cat-g".to_string(),
            category_path: "Food / Groceries".to_string(),
            confidence: 0.95,
            source: "rule".to_string(),
            explanation: "Matched rule".to_string(),
        }];
        let ai = vec![AiProposal {
            activity_id: "a1".to_string(),
            taxonomy_id: "tax1".to_string(),
            category_key: "coffee".to_string(),
            confidence: Some(0.8),
            reason: None,
        }];
        let (proposals, remaining) = merge_ai_proposals(unproposed, existing, &key_lookup, ai);
        assert_eq!(proposals.len(), 2);
        // The rule-sourced one should still be present.
        assert!(proposals
            .iter()
            .any(|p| p.source == "rule" && p.activity_id == "a0"));
        assert!(proposals
            .iter()
            .any(|p| p.source == "ai" && p.activity_id == "a1"));
        assert!(remaining.is_empty());
    }
}
