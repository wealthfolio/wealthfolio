//! Rule-matching algorithm. Ported semantics from PR #494's category_rules matcher.

use regex::{Regex, RegexBuilder};

use super::model::{CategorizationRule, RuleMatchType};

#[derive(Debug, Clone)]
pub struct RuleMatch<'r> {
    pub rule: &'r CategorizationRule,
}

/// A `CategorizationRule` with its pattern pre-normalized (uppercase for the
/// non-regex variants, compiled `Regex` for the regex variant). Built once
/// per rerun via [`compile_rules`] so the per-activity loop avoids
/// re-normalizing strings and re-compiling regex on every comparison.
pub struct CompiledRule<'r> {
    pub rule: &'r CategorizationRule,
    pattern_upper: String,
    regex: Option<Regex>,
}

pub const MAX_REGEX_PATTERN_LEN: usize = 512;
const REGEX_SIZE_LIMIT_BYTES: usize = 64 * 1024;

pub fn compile_regex_pattern(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT_BYTES)
        .build()
}

/// Precompile a slice of rules: uppercase their patterns and compile regex
/// patterns. Rules whose regex fails to compile are kept with `regex = None`
/// so they will simply never match (matches the previous
/// `Regex::new(...).ok()` fall-through).
pub fn compile_rules(rules: &[CategorizationRule]) -> Vec<CompiledRule<'_>> {
    rules
        .iter()
        .map(|rule| {
            let regex = if matches!(rule.match_type, RuleMatchType::Regex) {
                match compile_regex_pattern(&rule.pattern) {
                    Ok(re) => Some(re),
                    Err(err) => {
                        log::debug!("Categorization rule {} has invalid regex: {}", rule.id, err);
                        None
                    }
                }
            } else {
                None
            };
            CompiledRule {
                rule,
                pattern_upper: rule.pattern.to_uppercase(),
                regex,
            }
        })
        .collect()
}

/// Highest-priority match against a precompiled rule set. Callers that loop
/// over many activities should normalize each activity's notes to uppercase
/// once and pass it as `notes_upper`; `notes_raw` is needed for regex
/// matching (regex matches against the original casing, same as today).
pub fn match_compiled<'r>(
    compiled: &[CompiledRule<'r>],
    notes_upper: &str,
    notes_raw: &str,
    activity_type: &str,
    account_id: &str,
) -> Option<RuleMatch<'r>> {
    let mut best: Option<&CategorizationRule> = None;

    for c in compiled {
        let rule = c.rule;

        if !rule.is_global {
            match &rule.account_id {
                Some(rule_acc) if rule_acc == account_id => {}
                _ => continue,
            }
        }

        if let Some(rt) = &rule.activity_type {
            if rt != activity_type {
                continue;
            }
        }

        let matched = match rule.match_type {
            RuleMatchType::Contains => notes_upper.contains(&c.pattern_upper),
            RuleMatchType::StartsWith => notes_upper.starts_with(&c.pattern_upper),
            RuleMatchType::Exact => notes_upper == c.pattern_upper,
            RuleMatchType::Regex => c.regex.as_ref().is_some_and(|re| re.is_match(notes_raw)),
        };

        if !matched {
            continue;
        }

        match best {
            None => best = Some(rule),
            Some(current) if rule.priority > current.priority => best = Some(rule),
            _ => {}
        }
    }

    best.map(|rule| RuleMatch { rule })
}

/// Single-shot match against an un-compiled rule slice. Convenience for the
/// rule-tester / single-activity paths where the per-call compile cost is
/// negligible. Bulk paths should use [`compile_rules`] + [`match_compiled`].
pub fn match_rules<'r>(
    rules: &'r [CategorizationRule],
    notes: &str,
    activity_type: &str,
    account_id: &str,
) -> Option<RuleMatch<'r>> {
    let compiled = compile_rules(rules);
    let notes_upper = notes.to_uppercase();
    match_compiled(&compiled, &notes_upper, notes, activity_type, account_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn rule(name: &str, pattern: &str, mt: RuleMatchType, prio: i32) -> CategorizationRule {
        CategorizationRule {
            id: name.to_string(),
            name: name.to_string(),
            pattern: pattern.to_string(),
            match_type: mt,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some("cat_food".to_string()),
            activity_type: None,
            priority: prio,
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
    fn contains_matches_case_insensitive() {
        let rules = vec![rule("amazon", "AMAZON", RuleMatchType::Contains, 0)];
        let m = match_rules(&rules, "amazon order #123", "WITHDRAWAL", "acct1").unwrap();
        assert_eq!(m.rule.id, "amazon");
    }

    #[test]
    fn higher_priority_wins() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("b", "FOO", RuleMatchType::Contains, 5),
        ];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1").unwrap();
        assert_eq!(m.rule.id, "b");
    }

    #[test]
    fn account_scoped_rule_skipped_for_other_account() {
        let mut r = rule("scoped", "FOO", RuleMatchType::Contains, 10);
        r.is_global = false;
        r.account_id = Some("acct-other".to_string());
        let rules = vec![r];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1");
        assert!(m.is_none());
    }

    #[test]
    fn compiled_matches_same_as_uncompiled() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("re", r"^bar.*", RuleMatchType::Regex, 2),
        ];
        let compiled = compile_rules(&rules);

        let m = match_compiled(&compiled, "FOO X", "FOO X", "WITHDRAWAL", "acct1").unwrap();
        assert_eq!(m.rule.id, "a");
        let m = match_compiled(&compiled, "BARABC", "barabc", "WITHDRAWAL", "acct1").unwrap();
        assert_eq!(m.rule.id, "re");
    }

    #[test]
    fn regex_matches_remain_case_sensitive_by_default() {
        let rules = vec![rule("re", r"^Coffee$", RuleMatchType::Regex, 1)];

        assert!(match_rules(&rules, "Coffee", "WITHDRAWAL", "acct1").is_some());
        assert!(match_rules(&rules, "COFFEE", "WITHDRAWAL", "acct1").is_none());
    }

    #[test]
    fn invalid_regex_never_matches_but_doesnt_crash() {
        let rules = vec![rule("bad", "(unclosed", RuleMatchType::Regex, 5)];
        let compiled = compile_rules(&rules);
        let m = match_compiled(&compiled, "ANYTHING", "anything", "WITHDRAWAL", "acct1");
        assert!(m.is_none());
    }
}
