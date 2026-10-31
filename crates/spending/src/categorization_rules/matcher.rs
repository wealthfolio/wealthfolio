//! Rule-matching algorithm. Ported semantics from PR #494's category_rules matcher.

use regex::{Regex, RegexBuilder};
use rust_decimal::Decimal;

use super::model::{CategorizationRule, RuleAmountOp, RuleMatchType};

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
/// `amount` must be the activity's unsigned amount (callers pass
/// `activity.amount.map(|d| d.abs())`); an activity without an amount never
/// matches a rule that has an amount condition.
pub fn match_compiled<'c, 'r: 'c>(
    compiled: impl IntoIterator<Item = &'c CompiledRule<'r>>,
    notes_upper: &str,
    notes_raw: &str,
    activity_type: &str,
    account_id: &str,
    amount: Option<Decimal>,
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

        if let Some(op) = rule.amount_op {
            let (Some(amt), Some(value)) = (amount, rule.amount_value) else {
                continue;
            };
            let amount_matched = match op {
                RuleAmountOp::Eq => amt == value,
                RuleAmountOp::Gt => amt > value,
                RuleAmountOp::Gte => amt >= value,
                RuleAmountOp::Lt => amt < value,
                RuleAmountOp::Lte => amt <= value,
                RuleAmountOp::Between => rule
                    .amount_value2
                    .is_some_and(|upper| amt >= value && amt <= upper),
            };
            if !amount_matched {
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
    amount: Option<Decimal>,
) -> Option<RuleMatch<'r>> {
    let compiled = compile_rules(rules);
    let notes_upper = notes.to_uppercase();
    match_compiled(
        &compiled,
        &notes_upper,
        notes,
        activity_type,
        account_id,
        amount.map(|d| d.abs()),
    )
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
            amount_op: None,
            amount_value: None,
            amount_value2: None,
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

    fn amount_rule(
        name: &str,
        op: RuleAmountOp,
        value: &str,
        value2: Option<&str>,
        prio: i32,
    ) -> CategorizationRule {
        let mut r = rule(name, "FOO", RuleMatchType::Contains, prio);
        r.amount_op = Some(op);
        r.amount_value = Some(value.parse().unwrap());
        r.amount_value2 = value2.map(|v| v.parse().unwrap());
        r
    }

    fn dec(s: &str) -> Option<Decimal> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn contains_matches_case_insensitive() {
        let rules = vec![rule("amazon", "AMAZON", RuleMatchType::Contains, 0)];
        let m = match_rules(&rules, "amazon order #123", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "amazon");
    }

    #[test]
    fn higher_priority_wins() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("b", "FOO", RuleMatchType::Contains, 5),
        ];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "b");
    }

    #[test]
    fn account_scoped_rule_skipped_for_other_account() {
        let mut r = rule("scoped", "FOO", RuleMatchType::Contains, 10);
        r.is_global = false;
        r.account_id = Some("acct-other".to_string());
        let rules = vec![r];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", None);
        assert!(m.is_none());
    }

    #[test]
    fn compiled_matches_same_as_uncompiled() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("re", r"^bar.*", RuleMatchType::Regex, 2),
        ];
        let compiled = compile_rules(&rules);

        let m = match_compiled(&compiled, "FOO X", "FOO X", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "a");
        let m = match_compiled(&compiled, "BARABC", "barabc", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "re");
    }

    #[test]
    fn regex_matches_remain_case_sensitive_by_default() {
        let rules = vec![rule("re", r"^Coffee$", RuleMatchType::Regex, 1)];

        assert!(match_rules(&rules, "Coffee", "WITHDRAWAL", "acct1", None).is_some());
        assert!(match_rules(&rules, "COFFEE", "WITHDRAWAL", "acct1", None).is_none());
    }

    #[test]
    fn invalid_regex_never_matches_but_doesnt_crash() {
        let rules = vec![rule("bad", "(unclosed", RuleMatchType::Regex, 5)];
        let compiled = compile_rules(&rules);
        let m = match_compiled(
            &compiled,
            "ANYTHING",
            "anything",
            "WITHDRAWAL",
            "acct1",
            None,
        );
        assert!(m.is_none());
    }

    fn matches_amount(r: &CategorizationRule, amount: Option<Decimal>) -> bool {
        let rules = std::slice::from_ref(r);
        match_rules(rules, "FOO BAR", "WITHDRAWAL", "acct1", amount).is_some()
    }

    #[test]
    fn amount_eq_matches_exact_value_only() {
        let r = amount_rule("eq", RuleAmountOp::Eq, "10.50", None, 0);
        assert!(matches_amount(&r, dec("10.50")));
        assert!(matches_amount(&r, dec("10.5")));
        assert!(!matches_amount(&r, dec("10.49")));
        assert!(!matches_amount(&r, dec("10.51")));
    }

    #[test]
    fn amount_gt_is_strict_gte_is_inclusive() {
        let gt = amount_rule("gt", RuleAmountOp::Gt, "100", None, 0);
        assert!(matches_amount(&gt, dec("100.01")));
        assert!(!matches_amount(&gt, dec("100")));
        assert!(!matches_amount(&gt, dec("99.99")));

        let gte = amount_rule("gte", RuleAmountOp::Gte, "100", None, 0);
        assert!(matches_amount(&gte, dec("100")));
        assert!(matches_amount(&gte, dec("100.01")));
        assert!(!matches_amount(&gte, dec("99.99")));
    }

    #[test]
    fn amount_lt_is_strict_lte_is_inclusive() {
        let lt = amount_rule("lt", RuleAmountOp::Lt, "100", None, 0);
        assert!(matches_amount(&lt, dec("99.99")));
        assert!(!matches_amount(&lt, dec("100")));
        assert!(!matches_amount(&lt, dec("100.01")));

        let lte = amount_rule("lte", RuleAmountOp::Lte, "100", None, 0);
        assert!(matches_amount(&lte, dec("100")));
        assert!(matches_amount(&lte, dec("99.99")));
        assert!(!matches_amount(&lte, dec("100.01")));
    }

    #[test]
    fn amount_between_is_inclusive_both_ends() {
        let r = amount_rule("between", RuleAmountOp::Between, "45", Some("55"), 0);
        assert!(matches_amount(&r, dec("45")));
        assert!(matches_amount(&r, dec("50")));
        assert!(matches_amount(&r, dec("55")));
        assert!(!matches_amount(&r, dec("44.99")));
        assert!(!matches_amount(&r, dec("55.01")));
    }

    #[test]
    fn amount_zero_compares_normally() {
        let eq = amount_rule("eq0", RuleAmountOp::Eq, "0", None, 0);
        assert!(matches_amount(&eq, dec("0")));
        let lte = amount_rule("lte0", RuleAmountOp::Lte, "0", None, 0);
        assert!(matches_amount(&lte, dec("0")));
    }

    #[test]
    fn missing_activity_amount_never_matches_amount_rule() {
        let r = amount_rule("gt", RuleAmountOp::Gt, "0", None, 0);
        assert!(!matches_amount(&r, None));
        // ...but a rule without an amount condition still matches.
        let plain = rule("plain", "FOO", RuleMatchType::Contains, 0);
        assert!(matches_amount(&plain, None));
    }

    #[test]
    fn amount_rule_missing_value_never_matches() {
        let mut r = amount_rule("broken", RuleAmountOp::Gt, "1", None, 0);
        r.amount_value = None;
        assert!(!matches_amount(&r, dec("100")));
    }

    #[test]
    fn between_missing_upper_bound_never_matches() {
        let r = amount_rule("half", RuleAmountOp::Between, "10", None, 0);
        assert!(!matches_amount(&r, dec("10")));
    }

    #[test]
    fn negative_amount_is_compared_unsigned() {
        let r = amount_rule("between", RuleAmountOp::Between, "40", Some("60"), 0);
        assert!(matches_amount(&r, dec("-50")));
    }

    #[test]
    fn amount_gate_is_anded_with_text_and_type_gates() {
        let r = amount_rule("combo", RuleAmountOp::Gte, "100", None, 0);
        // Amount matches, text doesn't.
        assert!(match_rules(
            std::slice::from_ref(&r),
            "NO MATCH HERE",
            "WITHDRAWAL",
            "acct1",
            dec("150")
        )
        .is_none());
        // Text matches, amount doesn't (covered by matches_amount negatives too).
        assert!(!matches_amount(&r, dec("50")));

        let mut typed = amount_rule("typed", RuleAmountOp::Gte, "100", None, 0);
        typed.activity_type = Some("DEPOSIT".to_string());
        // Amount + text match, activity type doesn't.
        assert!(!matches_amount(&typed, dec("150")));
    }

    #[test]
    fn amount_gate_filters_before_priority_selection() {
        let high = amount_rule("high", RuleAmountOp::Gte, "1000", None, 10);
        let low = rule("low", "FOO", RuleMatchType::Contains, 1);
        let rules = vec![high, low];
        // Below the high-priority rule's threshold, the low-priority rule wins.
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", dec("50")).unwrap();
        assert_eq!(m.rule.id, "low");
        // At the threshold, the high-priority rule wins.
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", dec("1000")).unwrap();
        assert_eq!(m.rule.id, "high");
    }
}
