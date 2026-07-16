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
//!
//! The deterministic pass (`compute_categorization_state`) and the shared
//! DTOs live in [`crate::tools::categorization_context`], shared with the
//! migrated `list_categorization_context` read tool.

use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::categorization_context::{
    compute_categorization_state, CategorizationFilters, CategoryExample, Proposal,
    TaxonomySummary, UnproposedActivity, MAX_LIMIT,
};

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
    /// AI-inferred category to reach the widget. Use an empty array only when the
    /// context call returned `needsAiJudgement == 0`.
    #[serde(default)]
    pub ai_proposals: Option<Vec<AiProposal>>,
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

const PROPOSE_CATEGORIES_DESCRIPTION: &str =
    "Render the categorization widget for the user to review and confirm. Run \
     `list_categorization_context` FIRST to see the taxonomies, recent few-shot \
     examples, and the unproposed rows. If `needsAiJudgement` is 0 and total is > 0, \
     still call this tool with `aiProposals: []` so the rule/history draft proposals \
     appear in the review widget. Otherwise reason about each unproposed row, then \
     call this tool with `aiProposals` filled in. The tool runs deterministic rule + \
     same-payee history matches, merges your `aiProposals` for the rows those passes \
     didn't cover, and renders the widget. Do NOT pass `accountIds` for generic \
     mentions like 'credit card' or 'this account'.";

pub struct ProposeCategories;

impl ProposeCategories {
    pub(crate) async fn build_output(
        env: &dyn AgentEnvironment,
        args: ProposeCategoriesArgs,
    ) -> Result<ProposeCategoriesOutput, AgentToolError> {
        debug!(
            "propose_transaction_categories called (ai_proposals: {})",
            args.ai_proposals.as_ref().map(|v| v.len()).unwrap_or(0)
        );

        let mut state = compute_categorization_state(
            env,
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

#[async_trait::async_trait]
impl AgentTool for ProposeCategories {
    fn name(&self) -> &'static str {
        "propose_transaction_categories"
    }

    fn description(&self) -> &'static str {
        PROPOSE_CATEGORIES_DESCRIPTION
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
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
                    "description": "Your inferred categories for the rows returned as `unproposed` from `list_categorization_context`. Pass [] only when that context result returned needsAiJudgement = 0. Each entry: { activityId, taxonomyId, categoryKey, confidence (0–1), reason }.",
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
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Returns cash-activity rows AND the taxonomy tree, so it requires
        // activities:read and classification:read alongside classification:suggest.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ClassificationRead,
            AgentScope::ClassificationSuggest,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Suggest
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ProposeCategoriesArgs = serde_json::from_value(args)?;
        let output = ProposeCategories::build_output(env.as_ref(), args).await?;
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::categorization_context::UnproposedActivity;

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
