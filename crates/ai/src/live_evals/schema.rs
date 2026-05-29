//! TOML schema for eval cases.
//!
//! Cases live in `crates/ai/evals/cases/*.toml`. Each file is a suite. Each
//! suite contains one or more `[[case]]` entries with positive + negative tool
//! expectations and optional response rubrics. See the README in the evals
//! directory for the full schema with examples.

use serde::Deserialize;
use std::collections::HashMap;
#[cfg(feature = "eval")]
use std::path::Path;

/// A single eval suite (one TOML file = one suite).
#[derive(Debug, Clone, Deserialize)]
pub struct Suite {
    /// Suite name. Defaults to the filename stem if absent.
    #[serde(default)]
    pub name: Option<String>,

    /// Optional one-line description of what this suite covers.
    #[serde(default)]
    pub description: Option<String>,

    #[serde(default, rename = "case")]
    pub cases: Vec<Case>,
}

/// A single eval case.
#[derive(Debug, Clone, Deserialize)]
pub struct Case {
    /// Stable identifier — used in reports and `--filter` flags.
    pub id: String,

    /// Human-readable description shown in failure output.
    pub description: String,

    /// User prompt that starts the eval turn.
    pub prompt: String,

    /// Optional fixture name (without .json) loaded from `evals/fixtures/`.
    /// Determines the canned tool-result data the mock environment returns.
    #[serde(default)]
    pub fixture: Option<String>,

    /// Severity classification — affects exit code on failure.
    #[serde(default)]
    pub severity: Severity,

    /// Free-form tags for filtering (e.g. ["smoke", "P0", "spending"]).
    #[serde(default)]
    pub tags: Vec<String>,

    /// Tool calls that MUST appear in the trace, in order.
    #[serde(default)]
    pub expected_tools: Vec<ToolExpectation>,

    /// Tool calls that MUST NOT appear in the trace at all. Map values are
    /// human-readable reasons surfaced in the failure message.
    #[serde(default)]
    pub forbidden_tools: HashMap<String, String>,

    /// Per-tool max occurrence cap. Catches accidental repeated calls.
    #[serde(default)]
    pub max_tool_calls: HashMap<String, u32>,

    /// Optional rubric for grading the agent's final text reply with an
    /// LLM-as-judge. Skip the case if the judge model is unavailable.
    #[serde(default)]
    pub expected_response: Option<ResponseRubric>,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Severity {
    /// Must pass for CI to be green. Fails the run.
    P0,
    /// Should pass; failure is logged but doesn't fail the run.
    #[default]
    P1,
    /// Polish-level. Always logged, never fails.
    P2,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolExpectation {
    pub name: String,
    /// Per-arg assertions. Key = arg name (camelCase as agent sends),
    /// value = assertion variant.
    #[serde(default)]
    pub args: HashMap<String, ArgAssertion>,
}

/// What to assert about a tool-call argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ArgAssertion {
    /// Match a sentinel string like "not_empty", "absent_or_empty".
    Sentinel(String),
    /// Structured assertion: { contains = "..." }, { exact = "..." }, { regex = "..." }.
    Predicate(ArgPredicate),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgPredicate {
    /// Substring match on the JSON-serialized arg value.
    Contains(String),
    /// Exact value match (after JSON deserialization).
    Exact(serde_json::Value),
    /// Regex match against the JSON-serialized arg value.
    Regex(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResponseRubric {
    /// Plain-language criteria the judge model grades against.
    pub rubric: String,
    /// Optional model override for the judge. Defaults to the eval-runner provider.
    #[serde(default)]
    pub judge_model: Option<String>,
}

/// Load a single suite TOML file. Requires the `eval` feature (pulls `toml`).
#[cfg(feature = "eval")]
pub fn load_suite(path: &Path) -> Result<Suite, SchemaError> {
    let bytes = std::fs::read_to_string(path).map_err(SchemaError::Io)?;
    let mut suite: Suite = toml::from_str(&bytes).map_err(SchemaError::Parse)?;
    if suite.name.is_none() {
        suite.name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string);
    }
    Ok(suite)
}

/// Load every `*.toml` file under `cases_dir`. Requires the `eval` feature.
#[cfg(feature = "eval")]
pub fn load_all_suites(cases_dir: &Path) -> Result<Vec<Suite>, SchemaError> {
    let mut suites = Vec::new();
    let entries = std::fs::read_dir(cases_dir).map_err(SchemaError::Io)?;
    for entry in entries {
        let entry = entry.map_err(SchemaError::Io)?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("toml") {
            suites.push(load_suite(&path)?);
        }
    }
    suites.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(suites)
}

#[cfg(feature = "eval")]
#[derive(Debug, thiserror::Error)]
pub enum SchemaError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("TOML parse error: {0}")]
    Parse(#[from] toml::de::Error),
}

#[cfg(all(test, feature = "eval"))]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_case() {
        let toml = r#"
            [[case]]
            id = "t1"
            description = "minimal"
            prompt = "hello"
        "#;
        let suite: Suite = toml::from_str(toml).unwrap();
        assert_eq!(suite.cases.len(), 1);
        assert_eq!(suite.cases[0].id, "t1");
        assert_eq!(suite.cases[0].severity, Severity::P1);
        assert!(suite.cases[0].expected_tools.is_empty());
    }

    #[test]
    fn parses_full_case() {
        let toml = r#"
            name = "categorization"

            [[case]]
            id = "c1"
            description = "categorize basic"
            prompt = "Categorize transactions"
            severity = "P0"
            tags = ["smoke", "spending"]

            [[case.expected_tools]]
            name = "list_categorization_context"

            [[case.expected_tools]]
            name = "propose_transaction_categories"
            [case.expected_tools.args]
            aiProposals = "not_empty"
            accountIds  = "absent_or_empty"

            [case.forbidden_tools]
            record_activity = "wrong intent"

            [case.max_tool_calls]
            list_categorization_context = 1
        "#;
        let suite: Suite = toml::from_str(toml).unwrap();
        assert_eq!(suite.name.as_deref(), Some("categorization"));
        let case = &suite.cases[0];
        assert_eq!(case.severity, Severity::P0);
        assert_eq!(case.expected_tools.len(), 2);
        assert_eq!(case.expected_tools[1].args.len(), 2);
        assert_eq!(case.forbidden_tools.len(), 1);
        assert_eq!(
            case.max_tool_calls.get("list_categorization_context"),
            Some(&1)
        );
    }

    #[test]
    fn parses_arg_predicate_table_form() {
        let toml = r#"
            [[case]]
            id = "p1"
            description = "predicate"
            prompt = "x"

            [[case.expected_tools]]
            name = "create_categorization_rule"
            [case.expected_tools.args]
            taxonomyId = "spending_categories"
            categoryKey = "groceries"
            pattern = { contains = "T&T" }
        "#;
        let suite: Suite = toml::from_str(toml).unwrap();
        let args = &suite.cases[0].expected_tools[0].args;
        match args.get("pattern").unwrap() {
            ArgAssertion::Predicate(ArgPredicate::Contains(s)) => assert_eq!(s, "T&T"),
            other => panic!("unexpected predicate: {:?}", other),
        }
        match args.get("taxonomyId").unwrap() {
            ArgAssertion::Sentinel(s) => assert_eq!(s, "spending_categories"),
            other => panic!("unexpected: {:?}", other),
        }
        match args.get("categoryKey").unwrap() {
            ArgAssertion::Sentinel(s) => assert_eq!(s, "groceries"),
            other => panic!("unexpected: {:?}", other),
        }
    }
}
