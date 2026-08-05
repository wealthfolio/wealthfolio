// Mirrors `wealthfolio_spending::suggestions::model`. Kept in sync by hand — the
// backend serializes camelCase, and `SuggestionAction` is an internally-tagged
// union on `type`.

export type SuggestionAction =
  | { type: "newRule" }
  | {
      type: "extendRule";
      existingRuleId: string;
      existingRuleName: string;
      proposedPattern: string;
    }
  | {
      type: "combineRules";
      ruleIds: string[];
      ruleNames: string[];
    };

export interface SuggestedRule {
  /** Stable content hash — used to persist dismissals. */
  id: string;
  /** Proposed regex, e.g. `(?i)(aldi|coles|woolworths)`. */
  pattern: string;
  taxonomyId: string;
  categoryId: string;
  /** Merchant labels the pattern covers, for display. */
  merchants: string[];
  /** Hand-categorized transactions the pattern explains. */
  matchCount: number;
  /** Uncategorized transactions the pattern would newly catch. */
  uncategorizedMatchCount: number;
  /** 0.0–1.0. */
  confidence: number;
  /** A few real transaction descriptions the pattern matches. */
  examples: string[];
  /** True when `pattern` preserves a case-sensitive rule the user wrote,
   * instead of the usual fully case-insensitive merge. */
  caseSensitive: boolean;
  /** Present only when `caseSensitive` is true: the same merge folded to
   * fully case-insensitive, offered as an opt-in switch. */
  caseInsensitivePattern: string | null;
  action: SuggestionAction;
}

export interface ApplySuggestionRequest {
  pattern: string;
  taxonomyId: string;
  categoryId: string;
  /** New rule's name. Ignored when extending an existing rule. */
  categoryName?: string | null;
  action: SuggestionAction;
}
