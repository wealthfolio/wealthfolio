use serde::{Deserialize, Serialize};

/// A categorization rule the engine thinks the user would want, derived from
/// how they have already been categorizing transactions by hand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedRule {
    /// Stable id derived from the suggestion's content. The frontend uses it to
    /// remember dismissals across refetches, so it must not depend on wall-clock
    /// time or iteration order.
    pub id: String,
    /// Proposed `regex` pattern, e.g. `(?i)(bristol|gelsons|heinens)`.
    pub pattern: String,
    pub taxonomy_id: String,
    pub category_id: String,
    /// Merchant labels the pattern covers, for display (e.g. `["Bristol Farms", "Gelsons"]`).
    pub merchants: Vec<String>,
    /// Hand-categorized transactions in this category the pattern explains.
    pub match_count: usize,
    /// Currently-uncategorized transactions the pattern would newly catch.
    pub uncategorized_match_count: usize,
    /// 0.0–1.0. Combines how much of the category the pattern explains with how
    /// many uncategorized transactions it would pick up.
    pub confidence: f64,
    /// A few real transaction descriptions the pattern matches.
    pub examples: Vec<String>,
    pub action: SuggestionAction,
}

/// What accepting a suggestion does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SuggestionAction {
    /// Create a brand-new rule from `SuggestedRule::pattern`.
    NewRule,
    /// Merge the new merchants into an existing alternation rule instead of
    /// adding a second rule for the same category.
    // `rename_all` on the enum renames the variants, not their fields — without
    // this the fields would go out as snake_case.
    #[serde(rename_all = "camelCase")]
    ExtendRule {
        existing_rule_id: String,
        existing_rule_name: String,
        /// The existing rule's `name_pattern` after merging in the new
        /// merchants. Applying the suggestion writes this verbatim.
        proposed_pattern: String,
    },
}

/// Payload sent when the user accepts a suggestion.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySuggestionRequest {
    pub pattern: String,
    pub taxonomy_id: String,
    pub category_id: String,
    /// Human-readable category label, used as the new rule's name. Ignored for
    /// `ExtendRule` (the existing rule keeps its name).
    #[serde(default)]
    pub category_name: Option<String>,
    pub action: SuggestionAction,
}
