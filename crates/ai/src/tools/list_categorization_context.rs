//! List Categorization Context tool — prerequisite for `propose_transaction_categories`.
//!
//! Returns the data the agent needs to reason about uncategorized rows:
//! taxonomies, recent few-shot examples, and the list of rows that need
//! AI/manual judgement (already filtered by rules + same-payee history). The
//! widget for this tool is a one-line compact summary; the full review widget
//! comes from `propose_transaction_categories`.

use log::debug;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::tools::propose_categories::{
    compute_categorization_state, CategorizationFilters, CategoryExample, TaxonomySummary,
    UnproposedActivity,
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCategorizationContextArgs {
    pub activity_ids: Option<Vec<String>>,
    pub account_ids: Option<Vec<String>>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    pub total: usize,
    /// Rows already covered by rules or same-payee history. Agent doesn't need
    /// to propose for these — included only so it knows the count.
    pub deterministically_proposed: usize,
    /// Rows the agent should propose categories for via
    /// `propose_transaction_categories(aiProposals: [...])`.
    pub needs_ai_judgement: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCategorizationContextOutput {
    /// Activity-scope taxonomies — the universe of `categoryKey`s the agent may pick from.
    pub taxonomies: Vec<TaxonomySummary>,
    /// Recent user-confirmed categorizations (few-shot signal).
    pub examples: Vec<CategoryExample>,
    /// Rows the agent should infer categories for.
    pub unproposed: Vec<UnproposedActivity>,
    pub summary: ContextSummary,
}

pub struct ListCategorizationContextTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> ListCategorizationContextTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for ListCategorizationContextTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for ListCategorizationContextTool<E> {
    const NAME: &'static str = "list_categorization_context";

    type Error = AiError;
    type Args = ListCategorizationContextArgs;
    type Output = ListCategorizationContextOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description:
                "Prerequisite for `propose_transaction_categories`. Returns the activity-scope \
                 taxonomies, recent few-shot examples, and the list of cash transactions that \
                 need AI categorization (rows already covered by rules or same-payee history \
                 are excluded). After receiving this result, reason about each row in \
                 `unproposed`, infer the best `taxonomyId` + `categoryKey` pair from \
                 `taxonomies` using `examples` + merchant-name knowledge, then call \
                 `propose_transaction_categories` with `aiProposals` filled in (and the SAME \
                 filters) to render the review widget. \
                 Do NOT pass `accountIds` for generic mentions like 'credit card' — the \
                 spending settings already restrict to opted-in accounts."
                    .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "activityIds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional explicit set of activity IDs."
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
                        "maximum": 100,
                        "description": "Max rows. Default 100."
                    }
                }
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        debug!("list_categorization_context called");

        let state = compute_categorization_state(
            &self.env,
            CategorizationFilters {
                activity_ids: args.activity_ids,
                account_ids: args.account_ids,
                status: args.status,
                start_date: args.start_date,
                end_date: args.end_date,
                limit: args.limit,
            },
        )
        .await?;

        let summary = ContextSummary {
            total: state.total,
            deterministically_proposed: state.proposals.len(),
            needs_ai_judgement: state.unproposed.len(),
        };

        Ok(ListCategorizationContextOutput {
            taxonomies: state.taxonomies,
            examples: state.examples,
            unproposed: state.unproposed,
            summary,
        })
    }
}
