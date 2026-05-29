//! System-prompt content evals.
//!
//! Catches accidental deletions of behaviors we depend on. Substring checks,
//! not exact wording — phrasing can change, but the *contract* shouldn't.

use wealthfolio_ai::SYSTEM_PROMPT;

#[test]
fn is_non_empty_and_has_persona() {
    assert!(SYSTEM_PROMPT.len() > 200);
    assert!(SYSTEM_PROMPT.to_lowercase().contains("wealthfolio"));
}

#[test]
fn has_confirmation_utterance_rule() {
    let lower = SYSTEM_PROMPT.to_lowercase();
    assert!(
        lower.contains("confirmation utterance") || lower.contains("briefly state"),
        "system prompt should instruct the agent to confirm before mutation/widget tools",
    );
}

#[test]
fn warns_against_fabrication() {
    let lower = SYSTEM_PROMPT.to_lowercase();
    assert!(
        lower.contains("speculate") || lower.contains("fabricat"),
        "system prompt should warn against fabricating financial data",
    );
}

#[test]
fn mentions_displaymode_compact_pattern() {
    // Catches accidental removal of the prereq-call collapsing convention.
    assert!(SYSTEM_PROMPT.contains("displayMode"));
    assert!(SYSTEM_PROMPT.contains("compact"));
}

#[test]
fn does_not_repeat_full_tool_listing() {
    // We slimmed this in the cleanup pass — re-introducing duplicate tool
    // listings would re-introduce the per-tool drift problem. Tool descriptions
    // on the actual tool definitions are the source of truth.
    let bad_pattern_count = SYSTEM_PROMPT.matches(". get_accounts").count()
        + SYSTEM_PROMPT.matches(". record_activity").count()
        + SYSTEM_PROMPT.matches(". search_activities").count();
    assert!(
        bad_pattern_count == 0,
        "system prompt re-introduced numbered tool listings; tool definitions should be the source of truth",
    );
}

#[test]
fn keeps_investigate_before_answering_directive() {
    let lower = SYSTEM_PROMPT.to_lowercase();
    assert!(
        lower.contains("investigate before answering")
            || lower.contains("call the appropriate tool"),
        "system prompt should retain the 'fetch fresh data, don't answer from memory' rule",
    );
}

#[test]
fn keeps_image_pdf_attachment_rules() {
    let lower = SYSTEM_PROMPT.to_lowercase();
    assert!(
        lower.contains("attachment") && lower.contains("record_activities"),
        "system prompt should retain image/PDF extraction → record_activities flow",
    );
}
