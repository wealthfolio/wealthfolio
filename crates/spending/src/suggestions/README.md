# Rule suggestions

This module looks at the transactions a user has categorized by hand and
proposes categorization rules that would reproduce those choices and catch
similar transactions in future. It favours one alternation rule per category
(`(?i)(bristol|gelsons|heinens)`) and, when the user already has a rule of that
shape, offers to add the new merchants to it instead of creating a second rule.
It also looks for categories where the user already has several separate
simple rules and offers to fold them into one.

Case sensitivity is respected, not overridden: a hand-written regex rule
without `(?i)` stays case-sensitive by default — new alternatives are added as
a scoped `(?i:...)` branch alongside it rather than forcing insensitivity onto
the whole pattern. `SuggestedRule::case_insensitive_pattern` carries the fully
case-insensitive alternative so the caller can offer switching to it.

## How it fits together

The engine in `service.rs` is pure: it takes the hand-categorized samples, the
uncategorized descriptions, and the current rule set, and returns a list of
`SuggestedRule`. It does no I/O, so its logic is covered by unit tests in the
same file.

`CategorizationRulesService` (in `categorization_rules/service.rs`) supplies the
two async methods that talk to the repositories:

- `suggest_rules(account_ids)` reads the activities in the given accounts and
  their category assignments, splits them into hand-categorized samples (source
  `manual`, taxonomy `spending_categories`) and still-uncategorized
  descriptions, then calls the engine. Read-only.
- `apply_suggestion(request)` creates a new rule, rewrites the pattern of an
  existing alternation rule in place, or — for a combine suggestion — rewrites
  the first of the combined rules and deletes the rest. It reuses the existing
  `create` / `update` / `delete` paths, so the same regex validation and scope
  checks apply. The pattern written is always `request.pattern` (not whatever
  the action embeds), so the caller can substitute
  `SuggestedRule::case_insensitive_pattern` when the user opts to switch.

Applying a suggestion does not re-run categorization itself. The command layer
triggers the same background categorize it already runs after any rule change.

## Surfaces

Tauri commands (`apps/tauri/src/commands/spending.rs`):

- `get_spending_rule_suggestions`
- `apply_spending_rule_suggestion`

HTTP routes (`apps/server/src/api/spending.rs`):

- `GET /spending/rule-suggestions`
- `POST /spending/rule-suggestions/apply`

Frontend (`apps/frontend/src/features/spending/`):

- `types/suggestion.ts` mirrors the Rust model.
- `adapters/suggestions.ts` calls the two commands through the shared `invoke`.
- `hooks/use-spending-rule-suggestions.ts` fetches suggestions, applies them,
  and remembers dismissals in `localStorage`.
- `components/rule-suggestions-panel.tsx` renders the panel above the rule list
  on the spending rules settings page.

## Notes

- No new crates, database migrations, or repository methods are required. The
  engine reuses the crate's existing `regex` dependency and the rule/assignment
  repositories already on `CategorizationRulesService`.
- Suggestion ids are a content hash (FNV-1a) of the category and merchants, so
  they are stable across refetches and usable as `localStorage` keys for
  dismissals.
- Accepted suggestions become global regex rules at priority 50, below the
  bundled country presets (70–95) and above the user-rule default (0).

## Tuning

The thresholds live as constants at the top of `service.rs`:
`MIN_MERCHANT_OCCURRENCES`, `MIN_MATCH_COUNT`, `MIN_TOKEN_LEN`,
`CLUSTER_SIMILARITY`, and `MAX_SUGGESTIONS`. Raise them to be more conservative,
lower them to surface more.
