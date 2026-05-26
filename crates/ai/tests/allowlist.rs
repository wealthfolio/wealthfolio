//! Tool allowlist contract evals.
//!
//! When a chat thread is created, its provider config carries a
//! `tools_allowlist` snapshot. Two paths matter:
//!
//! - `DEFAULT_TOOLS_ALLOWLIST` — what new threads get out of the box.
//! - `normalize_tools_allowlist` — expands legacy "visible-tool" lists into
//!   the actual backend tools each capability group covers.
//!
//! Drift between either of these and the registered tools is the most common
//! cause of "I added a tool and the agent never calls it."

use wealthfolio_ai::types::{normalize_tools_allowlist, DEFAULT_TOOLS_ALLOWLIST};

#[test]
fn default_allowlist_includes_all_categorization_tools() {
    for tool in [
        "list_categorization_context",
        "propose_transaction_categories",
        "create_categorization_rule",
    ] {
        assert!(
            DEFAULT_TOOLS_ALLOWLIST.contains(&tool),
            "DEFAULT_TOOLS_ALLOWLIST missing {tool} — new chat threads won't have access to it",
        );
    }
}

#[test]
fn default_allowlist_includes_core_data_tools() {
    for tool in [
        "get_accounts",
        "get_holdings",
        "get_performance",
        "search_activities",
        "get_valuation_history",
        "get_income",
        "get_asset_allocation",
        "get_goals",
        "get_cash_balances",
    ] {
        assert!(
            DEFAULT_TOOLS_ALLOWLIST.contains(&tool),
            "DEFAULT_TOOLS_ALLOWLIST missing read-only tool {tool}",
        );
    }
}

#[test]
fn default_allowlist_includes_action_tools() {
    for tool in ["record_activity", "record_activities", "import_csv"] {
        assert!(
            DEFAULT_TOOLS_ALLOWLIST.contains(&tool),
            "DEFAULT_TOOLS_ALLOWLIST missing action tool {tool}",
        );
    }
}

#[test]
fn normalize_expands_transactions_group_to_full_set() {
    // Legacy chat threads stored only `search_activities` for the Transactions
    // capability — the normalizer expands that to the full action set.
    let tools = normalize_tools_allowlist(Some(vec!["search_activities".to_string()])).unwrap();

    for tool in [
        "record_activity",
        "record_activities",
        "import_csv",
        "propose_transaction_categories",
        "list_categorization_context",
        "create_categorization_rule",
    ] {
        assert!(
            tools.contains(&tool.to_string()),
            "normalize_tools_allowlist did not expand search_activities → {tool}; \
             group expansion is broken",
        );
    }
}

#[test]
fn normalize_expands_accounts_group_to_cash_balances() {
    let tools = normalize_tools_allowlist(Some(vec!["get_accounts".to_string()])).unwrap();
    assert!(tools.contains(&"get_cash_balances".to_string()));
}

#[test]
fn normalize_expands_full_data_set_to_health_status() {
    let tools = normalize_tools_allowlist(Some(vec![
        "get_accounts".to_string(),
        "get_holdings".to_string(),
        "search_activities".to_string(),
        "get_performance".to_string(),
        "get_income".to_string(),
        "get_asset_allocation".to_string(),
        "get_valuation_history".to_string(),
        "get_goals".to_string(),
    ]))
    .unwrap();
    assert!(
        tools.contains(&"get_health_status".to_string()),
        "full data-tool set should imply health status access",
    );
}

#[test]
fn normalize_preserves_none_and_empty() {
    assert!(normalize_tools_allowlist(None).is_none());
    assert_eq!(
        normalize_tools_allowlist(Some(Vec::new())),
        Some(Vec::new()),
    );
}
