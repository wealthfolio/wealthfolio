//! Rule-suggestion engine. Pure, deterministic, and free of I/O so it can be
//! unit-tested on its own. Given the transactions a user has categorized by
//! hand, the rules they already have, and the transactions still uncategorized,
//! it proposes categorization rules — favouring one alternation rule per
//! category (`(?i)(bristol|gelsons|heinens)`) and extending an existing
//! alternation rule rather than adding a duplicate. It also looks for
//! categories where the user has several separate simple rules and offers to
//! fold them into one.
//!
//! Case sensitivity is respected rather than overridden: a `(?i)`-free regex
//! rule the user wrote by hand stays case-sensitive in the merged pattern
//! (new alternatives are added as a scoped `(?i:...)` branch alongside it),
//! and `SuggestedRule::case_insensitive_pattern` carries the fully
//! case-insensitive alternative so the caller can offer switching to it.

use std::collections::BTreeMap;

use super::model::{SuggestedRule, SuggestionAction};
use crate::categorization_rules::{compile_regex_pattern, CategorizationRule, RuleMatchType};

/// A transaction the user has already assigned to a category by hand.
pub struct CategorizedSample {
    /// The transaction description (`activity.notes`).
    pub text: String,
    pub taxonomy_id: String,
    pub category_id: String,
}

/// A merchant needs to show up this many times in a category before it earns a
/// slot in a suggested pattern. Keeps one-off assignments from spawning rules.
const MIN_MERCHANT_OCCURRENCES: usize = 2;
/// A suggestion has to explain at least this many hand-categorized transactions.
const MIN_MATCH_COUNT: usize = 2;
/// Merchant tokens shorter than this are too ambiguous to match on.
const MIN_TOKEN_LEN: usize = 3;
/// Two merchant tokens at or above this Jaro-Winkler similarity are treated as
/// the same merchant (`schnucks` / `schnuck`).
const CLUSTER_SIMILARITY: f64 = 0.90;
/// Uncategorized hits are normalized against this for the confidence blend.
const OPPORTUNITY_SCALE: f64 = 5.0;
/// Cap on suggestions returned in one pass so the panel stays readable.
const MAX_SUGGESTIONS: usize = 15;

/// Build the suggestion list. `existing_rules` is the user's full rule set;
/// only global-or-matching rules for the same category are considered for the
/// extend-vs-new decision.
pub fn generate_suggestions(
    categorized: &[CategorizedSample],
    uncategorized: &[String],
    existing_rules: &[CategorizationRule],
) -> Vec<SuggestedRule> {
    // Bucket hand-categorized samples by (taxonomy, category).
    let mut by_category: BTreeMap<(String, String), Vec<&CategorizedSample>> = BTreeMap::new();
    for s in categorized {
        by_category
            .entry((s.taxonomy_id.clone(), s.category_id.clone()))
            .or_default()
            .push(s);
    }

    let mut out: Vec<SuggestedRule> = Vec::new();
    for ((taxonomy_id, category_id), samples) in &by_category {
        if let Some(suggestion) = suggest_for_category(
            taxonomy_id,
            category_id,
            samples,
            uncategorized,
            existing_rules,
        ) {
            out.push(suggestion);
        }
    }
    out.extend(combine_suggestions(existing_rules));

    // Most useful first: biggest uncategorized win, then confidence. `id` breaks
    // ties so the order is stable across runs.
    out.sort_by(|a, b| {
        b.uncategorized_match_count
            .cmp(&a.uncategorized_match_count)
            .then(
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(a.id.cmp(&b.id))
    });

    if out.len() > MAX_SUGGESTIONS {
        log::debug!(
            "rule suggestions truncated from {} to {}",
            out.len(),
            MAX_SUGGESTIONS
        );
        out.truncate(MAX_SUGGESTIONS);
    }
    out
}

/// One merchant cluster: a canonical token, a display label, and an example of
/// a transaction that seeded it.
struct Merchant {
    token: String,
    label: String,
    /// How often the user assigned this merchant to the category. Only the
    /// clustering tests read it, so it isn't built into the release binary.
    #[cfg(test)]
    count: usize,
    example: String,
}

fn suggest_for_category(
    taxonomy_id: &str,
    category_id: &str,
    samples: &[&CategorizedSample],
    uncategorized: &[String],
    existing_rules: &[CategorizationRule],
) -> Option<SuggestedRule> {
    let merchants = cluster_merchants(samples);
    if merchants.is_empty() {
        return None;
    }

    // An existing alternation rule for this category, if any, decides whether we
    // extend or create.
    let existing = find_alternation_rule(existing_rules, taxonomy_id, category_id);
    let existing_tokens: Vec<String> = existing
        .as_ref()
        .map(|(_, _, toks, _)| toks.clone())
        .unwrap_or_default();

    // Only propose merchants the existing rule doesn't already cover.
    let added: Vec<&Merchant> = merchants
        .iter()
        .filter(|m| !existing_tokens.iter().any(|t| t == &m.token))
        .collect();
    if added.is_empty() {
        return None;
    }

    let added_tokens: Vec<String> = {
        let mut t: Vec<String> = added.iter().map(|m| m.token.clone()).collect();
        t.sort();
        t.dedup();
        t
    };
    let counting_pattern = alternation_pattern(&added_tokens);
    let matcher = compile_regex_pattern(&counting_pattern).ok()?;

    let group_total = samples.len();
    let match_count = samples.iter().filter(|s| matcher.is_match(&s.text)).count();
    if match_count < MIN_MATCH_COUNT {
        return None;
    }
    let uncategorized_hits: Vec<&String> = uncategorized
        .iter()
        .filter(|t| matcher.is_match(t))
        .collect();
    let uncategorized_match_count = uncategorized_hits.len();

    // Worth surfacing if it either catches new transactions or folds several
    // merchants into a single rule.
    if uncategorized_match_count == 0 && added.len() < 2 {
        return None;
    }

    let coverage = match_count as f64 / group_total.max(1) as f64;
    let opportunity = (uncategorized_match_count as f64 / OPPORTUNITY_SCALE).min(1.0);
    let confidence = (0.65 * coverage + 0.35 * opportunity).clamp(0.0, 1.0);

    let (action, output_pattern, case_sensitive, case_insensitive_pattern) = match existing {
        Some((rule_id, rule_name, existing_tokens, existing_case_insensitive)) => {
            let (default_pattern, insensitive_pattern) =
                merge_tokens(&existing_tokens, existing_case_insensitive, &added_tokens);
            (
                SuggestionAction::ExtendRule {
                    existing_rule_id: rule_id,
                    existing_rule_name: rule_name,
                    proposed_pattern: default_pattern.clone(),
                },
                default_pattern,
                !existing_case_insensitive,
                (!existing_case_insensitive).then_some(insensitive_pattern),
            )
        }
        None => (
            SuggestionAction::NewRule,
            counting_pattern.clone(),
            false,
            None,
        ),
    };

    let merchants_display: Vec<String> = {
        let mut labels: Vec<String> = added.iter().map(|m| m.label.clone()).collect();
        labels.sort();
        labels.dedup();
        labels
    };
    let examples = collect_examples(&added, &uncategorized_hits);
    let id = suggestion_id(taxonomy_id, category_id, &added_tokens, &action);

    Some(SuggestedRule {
        id,
        pattern: output_pattern,
        taxonomy_id: taxonomy_id.to_string(),
        category_id: category_id.to_string(),
        merchants: merchants_display,
        match_count,
        uncategorized_match_count,
        confidence,
        examples,
        case_sensitive,
        case_insensitive_pattern,
        action,
    })
}

/// Merge new (always lowercase, always-matches-any-case) tokens into an
/// existing alternation's tokens. If the existing rule was case-insensitive,
/// everything folds into one `(?i)(...)` pattern as before. If it was
/// case-sensitive, its alternatives are left exactly as the user wrote them
/// and the new tokens are added as a scoped `(?i:...)` branch instead of
/// forcing `(?i)` over the whole thing — the second element of the returned
/// tuple is what that blanket-insensitive merge would have looked like, for
/// callers that want to offer it as an opt-in switch.
fn merge_tokens(
    existing_tokens: &[String],
    existing_case_insensitive: bool,
    new_tokens: &[String],
) -> (String, String) {
    let fully_insensitive = {
        let mut all: Vec<String> = existing_tokens
            .iter()
            .map(|t| t.to_lowercase())
            .chain(new_tokens.iter().cloned())
            .collect();
        all.sort();
        all.dedup();
        alternation_pattern(&all)
    };

    if existing_case_insensitive {
        return (fully_insensitive.clone(), fully_insensitive);
    }

    let mut existing_sorted = existing_tokens.to_vec();
    existing_sorted.sort();
    existing_sorted.dedup();
    let mut new_sorted = new_tokens.to_vec();
    new_sorted.sort();
    new_sorted.dedup();
    let default = format!(
        "({}|(?i:{}))",
        existing_sorted.join("|"),
        new_sorted.join("|")
    );
    (default, fully_insensitive)
}

/// Group a category's samples into merchants, keeping only those seen enough
/// times to be worth a rule. Greedy Jaro-Winkler clustering folds near-identical
/// tokens together (`schnucks` / `schnuck`).
fn cluster_merchants(samples: &[&CategorizedSample]) -> Vec<Merchant> {
    struct Cluster {
        token: String,
        count: usize,
        label_counts: BTreeMap<String, usize>,
        example: String,
    }

    let mut clusters: Vec<Cluster> = Vec::new();
    for s in samples {
        let normalized = normalize_description(&s.text);
        let Some(token) = merchant_token(&normalized) else {
            continue;
        };
        let existing = clusters
            .iter_mut()
            .find(|c| c.token == token || jaro_winkler(&c.token, &token) >= CLUSTER_SIMILARITY);
        match existing {
            Some(c) => {
                c.count += 1;
                *c.label_counts.entry(normalized.clone()).or_insert(0) += 1;
            }
            None => clusters.push(Cluster {
                token: token.clone(),
                count: 1,
                label_counts: BTreeMap::from([(normalized.clone(), 1)]),
                example: s.text.clone(),
            }),
        }
    }

    clusters
        .into_iter()
        .filter(|c| c.count >= MIN_MERCHANT_OCCURRENCES)
        .map(|c| {
            // Most common cleaned phrase becomes the display label.
            let label = c
                .label_counts
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map(|(phrase, _)| title_case(phrase))
                .unwrap_or_else(|| title_case(&c.token));
            Merchant {
                token: c.token,
                label,
                #[cfg(test)]
                count: c.count,
                example: c.example,
            }
        })
        .collect()
}

/// Strip the noise banks bolt onto merchant names — casing, card/terminal
/// numbers, `*POS`-style prefixes, trailing state codes, and generic payment
/// words — leaving something close to the merchant name.
fn normalize_description(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let mut cleaned = String::with_capacity(lower.len());
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            cleaned.push(ch);
        } else {
            cleaned.push(' ');
        }
    }

    const STOPWORDS: &[&str] = &[
        "pos",
        "purchase",
        "payment",
        "visa",
        "mastercard",
        "debit",
        "credit",
        "card",
        "value",
        "date",
        "ref",
        "tap",
        "contactless",
        "the",
        "usa",
        "usd",
        "inc",
        "llc",
        "corp",
    ];

    let mut words: Vec<&str> = Vec::new();
    for word in cleaned.split_whitespace() {
        // Drop pure numbers and mixed alphanumeric ids (card suffixes, store #s).
        if word.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        // Anything shorter than a merchant token is state codes and noise — and
        // could never be picked as the token anyway.
        if word.len() < MIN_TOKEN_LEN {
            continue;
        }
        if STOPWORDS.contains(&word) {
            continue;
        }
        words.push(word);
    }
    words.join(" ")
}

/// The first meaningful word of a normalized description — the token an
/// alternation rule matches on.
fn merchant_token(normalized: &str) -> Option<String> {
    normalized
        .split_whitespace()
        .find(|w| w.len() >= MIN_TOKEN_LEN)
        .map(|w| w.to_string())
}

/// `["bristol", "gelsons"]` → `(?i)(bristol|gelsons)`. Tokens are alphanumeric by
/// construction, so no escaping is needed.
fn alternation_pattern(tokens: &[String]) -> String {
    format!("(?i)({})", tokens.join("|"))
}

/// If the user already has a regex rule for this category shaped like our own
/// alternations, return `(rule_id, rule_name, alternatives, case_insensitive)`
/// so we can extend it.
fn find_alternation_rule(
    rules: &[CategorizationRule],
    taxonomy_id: &str,
    category_id: &str,
) -> Option<(String, String, Vec<String>, bool)> {
    rules.iter().find_map(|r| {
        if r.match_type != RuleMatchType::Regex {
            return None;
        }
        if r.taxonomy_id.as_deref() != Some(taxonomy_id)
            || r.category_id.as_deref() != Some(category_id)
        {
            return None;
        }
        let (alts, case_insensitive) = parse_alternation(&r.pattern)?;
        Some((r.id.clone(), r.name.clone(), alts, case_insensitive))
    })
}

/// Parse `(?i)(a|b|c)` or `(a|b|c)` into (`["a", "b", "c"]`, whether it had
/// `(?i)`). Returns `None` for anything that isn't a plain alternation, so we
/// never try to splice into a pattern we don't fully understand.
fn parse_alternation(pattern: &str) -> Option<(Vec<String>, bool)> {
    let case_insensitive = pattern.starts_with("(?i)");
    let body = pattern.strip_prefix("(?i)").unwrap_or(pattern);
    let inner = body.strip_prefix('(')?.strip_suffix(')')?;
    if inner.is_empty() {
        return None;
    }
    let alts: Vec<String> = inner.split('|').map(|a| a.trim().to_string()).collect();
    if alts
        .iter()
        .any(|a| a.is_empty() || a.chars().any(|c| !c.is_ascii_alphanumeric() && c != ' '))
    {
        return None;
    }
    Some((alts, case_insensitive))
}

/// Rule types eligible for the "combine multiple manual rules" suggestion.
const COMBINABLE_MATCH_TYPES: [RuleMatchType; 2] = [RuleMatchType::Contains, RuleMatchType::Regex];

/// Find categories with two or more separate simple rules and suggest folding
/// them into one alternation rule. Independent of hand-categorized samples —
/// this only looks at the rules the user already wrote. Presets are left
/// alone; `Regex` rules are only combinable when they're already a plain
/// alternation (parsed by [`parse_alternation`]) so we never mangle a
/// hand-written pattern we don't fully understand.
fn combine_suggestions(existing_rules: &[CategorizationRule]) -> Vec<SuggestedRule> {
    let mut by_category: BTreeMap<(String, String), Vec<&CategorizationRule>> = BTreeMap::new();
    for r in existing_rules {
        if r.preset_id.is_some() || !COMBINABLE_MATCH_TYPES.contains(&r.match_type) {
            continue;
        }
        let (Some(taxonomy_id), Some(category_id)) =
            (r.taxonomy_id.as_deref(), r.category_id.as_deref())
        else {
            continue;
        };
        by_category
            .entry((taxonomy_id.to_string(), category_id.to_string()))
            .or_default()
            .push(r);
    }

    by_category
        .iter()
        .filter_map(|((taxonomy_id, category_id), rules)| {
            combine_for_category(taxonomy_id, category_id, rules)
        })
        .collect()
}

/// One alternative contributed by an existing rule, and whether it should
/// stay case-sensitive in the combined pattern.
struct RuleToken {
    text: String,
    case_insensitive: bool,
}

fn combine_for_category(
    taxonomy_id: &str,
    category_id: &str,
    rules: &[&CategorizationRule],
) -> Option<SuggestedRule> {
    let mut included: Vec<&CategorizationRule> = Vec::new();
    let mut tokens: Vec<RuleToken> = Vec::new();

    for r in rules {
        match r.match_type {
            RuleMatchType::Contains => {
                let text = r.pattern.trim();
                if text.is_empty() {
                    continue;
                }
                tokens.push(RuleToken {
                    text: regex::escape(text),
                    case_insensitive: true,
                });
                included.push(r);
            }
            RuleMatchType::Regex => {
                let Some((alts, case_insensitive)) = parse_alternation(&r.pattern) else {
                    continue;
                };
                tokens.extend(alts.into_iter().map(|text| RuleToken {
                    text,
                    case_insensitive,
                }));
                included.push(r);
            }
            _ => {}
        }
    }

    if included.len() < 2 {
        return None;
    }

    let dedup_sorted = |mut v: Vec<String>| {
        v.sort();
        v.dedup();
        v
    };
    let ci_tokens = dedup_sorted(
        tokens
            .iter()
            .filter(|t| t.case_insensitive)
            .map(|t| t.text.clone())
            .collect(),
    );
    let cs_tokens = dedup_sorted(
        tokens
            .iter()
            .filter(|t| !t.case_insensitive)
            .map(|t| t.text.clone())
            .collect(),
    );

    let default_pattern = combine_pattern(&ci_tokens, &cs_tokens);
    let case_sensitive = !cs_tokens.is_empty();
    let case_insensitive_pattern = case_sensitive.then(|| {
        let all_lower = dedup_sorted(
            ci_tokens
                .iter()
                .chain(cs_tokens.iter())
                .map(|t| t.to_lowercase())
                .collect(),
        );
        alternation_pattern(&all_lower)
    });

    let rule_ids: Vec<String> = included.iter().map(|r| r.id.clone()).collect();
    let rule_names: Vec<String> = included.iter().map(|r| r.name.clone()).collect();
    let merchants = dedup_sorted(
        included
            .iter()
            .map(|r| title_case(r.pattern.trim()))
            .collect(),
    );
    let examples: Vec<String> = included.iter().map(|r| truncate(&r.pattern)).collect();

    let action = SuggestionAction::CombineRules {
        rule_ids: rule_ids.clone(),
        rule_names,
    };
    let id = suggestion_id(taxonomy_id, category_id, &rule_ids, &action);

    Some(SuggestedRule {
        id,
        pattern: default_pattern,
        taxonomy_id: taxonomy_id.to_string(),
        category_id: category_id.to_string(),
        merchants,
        // These consolidate rules the user already wrote rather than infer
        // anything from transaction data, so there's nothing to count here.
        match_count: 0,
        uncategorized_match_count: 0,
        confidence: 1.0,
        examples,
        case_sensitive,
        case_insensitive_pattern,
        action,
    })
}

/// Combine case-insensitive and case-sensitive alternatives into one pattern.
/// Case-sensitive alternatives (already alphanumeric-only, validated by
/// [`parse_alternation`]) are left bare; case-insensitive ones are scoped
/// with `(?i:...)` so they don't force insensitivity onto the rest.
fn combine_pattern(ci_tokens: &[String], cs_tokens: &[String]) -> String {
    match (ci_tokens.is_empty(), cs_tokens.is_empty()) {
        (_, true) => alternation_pattern(ci_tokens),
        (true, false) => format!("({})", cs_tokens.join("|")),
        (false, false) => format!("((?i:{})|{})", ci_tokens.join("|"), cs_tokens.join("|")),
    }
}

fn collect_examples(added: &[&Merchant], uncategorized_hits: &[&String]) -> Vec<String> {
    let mut examples: Vec<String> = Vec::new();
    // Lead with uncategorized hits — they show the payoff — then fall back to the
    // hand-categorized examples that seeded the merchant.
    for hit in uncategorized_hits.iter().take(3) {
        push_unique(&mut examples, truncate(hit));
    }
    for m in added {
        if examples.len() >= 3 {
            break;
        }
        push_unique(&mut examples, truncate(&m.example));
    }
    examples
}

fn push_unique(v: &mut Vec<String>, item: String) {
    if !v.contains(&item) {
        v.push(item);
    }
}

fn truncate(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= 60 {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(57).collect();
    format!("{cut}…")
}

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Content-addressed id (FNV-1a, hex). Deterministic so the frontend can persist
/// dismissals — no clock, no randomness.
fn suggestion_id(
    taxonomy_id: &str,
    category_id: &str,
    tokens: &[String],
    action: &SuggestionAction,
) -> String {
    let kind = match action {
        SuggestionAction::NewRule => "new",
        SuggestionAction::ExtendRule { .. } => "extend",
        SuggestionAction::CombineRules { .. } => "combine",
    };
    let seed = format!(
        "{taxonomy_id}\u{1}{category_id}\u{1}{}\u{1}{kind}",
        tokens.join(",")
    );
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in seed.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Jaro-Winkler similarity in `0.0..=1.0`. Implemented here to avoid a
/// dependency; only used for merchant-token clustering.
fn jaro_winkler(a: &str, b: &str) -> f64 {
    let jaro = jaro(a, b);
    // Winkler boost for a shared prefix (up to 4 chars), standard scaling 0.1.
    let prefix = a
        .chars()
        .zip(b.chars())
        .take(4)
        .take_while(|(x, y)| x == y)
        .count();
    jaro + prefix as f64 * 0.1 * (1.0 - jaro)
}

fn jaro(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let max_dist = (a.len().max(b.len()) / 2).saturating_sub(1);

    let mut a_matches = vec![false; a.len()];
    let mut b_matches = vec![false; b.len()];
    let mut matches = 0;
    for (i, &ca) in a.iter().enumerate() {
        let start = i.saturating_sub(max_dist);
        let end = (i + max_dist + 1).min(b.len());
        for j in start..end {
            if !b_matches[j] && b[j] == ca {
                a_matches[i] = true;
                b_matches[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }

    // Transpositions: count matched pairs that are out of order.
    let mut transpositions = 0;
    let mut k = 0;
    for i in 0..a.len() {
        if !a_matches[i] {
            continue;
        }
        while !b_matches[k] {
            k += 1;
        }
        if a[i] != b[k] {
            transpositions += 1;
        }
        k += 1;
    }
    let matches = matches as f64;
    let t = transpositions as f64 / 2.0;
    (matches / a.len() as f64 + matches / b.len() as f64 + (matches - t) / matches) / 3.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn sample(text: &str, cat: &str) -> CategorizedSample {
        CategorizedSample {
            text: text.to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: cat.to_string(),
        }
    }

    fn regex_rule(id: &str, pattern: &str, cat: &str) -> CategorizationRule {
        CategorizationRule {
            id: id.to_string(),
            name: format!("rule {id}"),
            pattern: pattern.to_string(),
            match_type: RuleMatchType::Regex,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some(cat.to_string()),
            activity_type: None,
            priority: 50,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
            preset_modified: false,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[test]
    fn normalize_strips_noise() {
        assert_eq!(normalize_description("GELSONS 1234 CA"), "gelsons");
        assert_eq!(normalize_description("POS BRISTOL 5521 VALUE"), "bristol");
        assert_eq!(
            normalize_description("HEINENS FINE FOODS 09"),
            "heinens fine foods"
        );
    }

    #[test]
    fn clusters_variants_of_same_merchant() {
        let samples = [
            sample("SCHNUCKS 1234 MO", "groceries"),
            sample("SCHNUCKS MARKET 88", "groceries"),
            sample("SCHNUCK ONLINE", "groceries"),
        ];
        let refs: Vec<&CategorizedSample> = samples.iter().collect();
        let merchants = cluster_merchants(&refs);
        assert_eq!(merchants.len(), 1, "schnucks variants should collapse");
        assert_eq!(merchants[0].count, 3);
    }

    #[test]
    fn multi_merchant_new_rule() {
        let categorized = vec![
            sample("BRISTOL FARMS 552 CA", "groceries"),
            sample("BRISTOL FARMS STORE", "groceries"),
            sample("GELSONS 1201", "groceries"),
            sample("GELSONS MARKET", "groceries"),
            sample("HEINENS FINE FOODS", "groceries"),
            sample("HEINENS 88", "groceries"),
        ];
        let uncategorized = vec!["BRISTOL FARMS 9910 CA".to_string()];
        let out = generate_suggestions(&categorized, &uncategorized, &[]);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.pattern, "(?i)(bristol|gelsons|heinens)");
        assert_eq!(s.action, SuggestionAction::NewRule);
        assert_eq!(s.uncategorized_match_count, 1);
        assert_eq!(s.merchants.len(), 3);
    }

    #[test]
    fn extends_existing_alternation_rule() {
        let categorized = vec![
            sample("BRISTOL FARMS 552", "groceries"),
            sample("BRISTOL FARMS STORE", "groceries"),
        ];
        let uncategorized = vec!["BRISTOL FARMS 9910".to_string()];
        let existing = vec![regex_rule("r1", "(?i)(gelsons|heinens)", "groceries")];
        let out = generate_suggestions(&categorized, &uncategorized, &existing);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        match &s.action {
            SuggestionAction::ExtendRule {
                existing_rule_id,
                proposed_pattern,
                ..
            } => {
                assert_eq!(existing_rule_id, "r1");
                assert_eq!(proposed_pattern, "(?i)(bristol|gelsons|heinens)");
                assert_eq!(&s.pattern, proposed_pattern);
            }
            other => panic!("expected ExtendRule, got {other:?}"),
        }
    }

    #[test]
    fn no_suggestion_when_already_covered() {
        let categorized = vec![
            sample("BRISTOL FARMS 552", "groceries"),
            sample("BRISTOL FARMS STORE", "groceries"),
        ];
        // Existing alternation already contains the only merchant we'd propose.
        let existing = vec![regex_rule("r1", "(?i)(bristol|gelsons)", "groceries")];
        let out = generate_suggestions(&categorized, &[], &existing);
        assert!(out.is_empty());
    }

    #[test]
    fn single_merchant_with_no_opportunity_is_skipped() {
        // One merchant, nothing uncategorized to catch → not worth a rule.
        let categorized = vec![
            sample("NETFLIX.COM", "streaming"),
            sample("NETFLIX.COM", "streaming"),
        ];
        let out = generate_suggestions(&categorized, &[], &[]);
        assert!(out.is_empty());
    }

    #[test]
    fn ids_are_stable_across_runs() {
        let categorized = vec![
            sample("BRISTOL FARMS 1", "groceries"),
            sample("BRISTOL FARMS 2", "groceries"),
            sample("GELSONS 1", "groceries"),
            sample("GELSONS 2", "groceries"),
        ];
        let a = generate_suggestions(&categorized, &[], &[]);
        let b = generate_suggestions(&categorized, &[], &[]);
        assert_eq!(a[0].id, b[0].id);
    }

    #[test]
    fn jaro_winkler_sane_bounds() {
        assert_eq!(jaro_winkler("gelsons", "gelsons"), 1.0);
        assert!(jaro_winkler("schnucks", "schnuck") >= CLUSTER_SIMILARITY);
        assert!(jaro_winkler("gelsons", "bristol") < CLUSTER_SIMILARITY);
    }

    fn contains_rule(id: &str, pattern: &str, cat: &str) -> CategorizationRule {
        CategorizationRule {
            match_type: RuleMatchType::Contains,
            ..regex_rule(id, pattern, cat)
        }
    }

    #[test]
    fn extend_respects_case_sensitive_existing_rule() {
        let categorized = vec![
            sample("BRISTOL FARMS 552", "groceries"),
            sample("BRISTOL FARMS STORE", "groceries"),
        ];
        let uncategorized = vec!["BRISTOL FARMS 9910".to_string()];
        // No `(?i)` — the user wrote this case-sensitively.
        let existing = vec![regex_rule("r1", "(Gelsons|Heinens)", "groceries")];
        let out = generate_suggestions(&categorized, &uncategorized, &existing);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert!(s.case_sensitive);
        // The user's original alternatives stay untouched and bare; the new
        // merchant is added as a scoped case-insensitive branch instead of
        // forcing `(?i)` over everything.
        assert_eq!(s.pattern, "(Gelsons|Heinens|(?i:bristol))");
        assert_eq!(
            s.case_insensitive_pattern.as_deref(),
            Some("(?i)(bristol|gelsons|heinens)")
        );
        match &s.action {
            SuggestionAction::ExtendRule {
                existing_rule_id, ..
            } => assert_eq!(existing_rule_id, "r1"),
            other => panic!("expected ExtendRule, got {other:?}"),
        }
    }

    #[test]
    fn combines_multiple_contains_rules() {
        let existing = vec![
            contains_rule("r1", "aldi", "groceries"),
            contains_rule("r2", "coles", "groceries"),
            contains_rule("r3", "woolworths", "groceries"),
        ];
        let out = generate_suggestions(&[], &[], &existing);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert!(!s.case_sensitive);
        assert_eq!(s.case_insensitive_pattern, None);
        assert_eq!(s.pattern, "(?i)(aldi|coles|woolworths)");
        match &s.action {
            SuggestionAction::CombineRules { rule_ids, .. } => {
                let mut ids = rule_ids.clone();
                ids.sort();
                assert_eq!(ids, vec!["r1", "r2", "r3"]);
            }
            other => panic!("expected CombineRules, got {other:?}"),
        }
    }

    #[test]
    fn combine_respects_case_sensitive_regex_rule_and_offers_switch() {
        let existing = vec![
            contains_rule("r1", "aldi", "groceries"),
            // Case-sensitive — no `(?i)`.
            regex_rule("r2", "(Coles)", "groceries"),
        ];
        let out = generate_suggestions(&[], &[], &existing);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert!(s.case_sensitive);
        assert_eq!(s.pattern, "((?i:aldi)|Coles)");
        assert_eq!(
            s.case_insensitive_pattern.as_deref(),
            Some("(?i)(aldi|coles)")
        );
    }

    #[test]
    fn does_not_combine_a_single_rule() {
        let existing = vec![contains_rule("r1", "aldi", "groceries")];
        let out = generate_suggestions(&[], &[], &existing);
        assert!(out.is_empty());
    }

    #[test]
    fn does_not_combine_preset_rules() {
        let mut r = contains_rule("r1", "aldi", "groceries");
        r.preset_id = Some("preset-au".to_string());
        let mut r2 = contains_rule("r2", "coles", "groceries");
        r2.preset_id = Some("preset-au".to_string());
        let out = generate_suggestions(&[], &[], &[r, r2]);
        assert!(out.is_empty());
    }
}
