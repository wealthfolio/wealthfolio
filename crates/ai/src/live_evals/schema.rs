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

    /// Optional files attached to the turn: inline test data, or a file.
    #[serde(default)]
    pub attachments: Vec<EvalAttachment>,

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

    /// Regexes the agent's final text MUST NOT match. Map values are
    /// human-readable reasons surfaced in the failure message.
    #[serde(default)]
    pub forbidden_response_patterns: HashMap<String, String>,

    /// Optional rubric for grading the agent's final text reply with an
    /// LLM-as-judge. Judge errors fail the case rather than silently skipping it.
    #[serde(default)]
    pub expected_response: Option<ResponseRubric>,

    /// Checks the CSV import review grid against an attached file.
    #[serde(default)]
    pub expected_csv_import: Option<CsvImportExpectation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalAttachment {
    pub name: String,
    pub content_type: String,
    /// Inline contents. Leave empty when `path` is set.
    #[serde(default)]
    pub data: String,
    /// File with the contents, relative to the suite file; read into `data`
    /// when the suite loads.
    #[serde(default)]
    pub path: Option<String>,
}

/// The last `import_csv` call must give the review grid the attached file's
/// header and rows, unchanged: the grid parses the CSV text the app sends
/// with the call, using the tool's `parseConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct CsvImportExpectation {
    /// Name of the attached CSV the grid must reproduce.
    pub attachment: String,
    /// Parser rows before the file's header row: its correct `skipTopRows`.
    #[serde(default)]
    pub header_row: usize,
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
    let suite_dir = path.parent().unwrap_or_else(|| Path::new("."));
    for attachment in suite
        .cases
        .iter_mut()
        .flat_map(|case| &mut case.attachments)
    {
        if let Some(file) = &attachment.path {
            let file = suite_dir.join(file);
            attachment.data =
                std::fs::read_to_string(&file).map_err(|source| SchemaError::Attachment {
                    path: file.display().to_string(),
                    source,
                })?;
        }
    }
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
    #[error("attachment file {path}: {source}")]
    Attachment {
        path: String,
        source: std::io::Error,
    },
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

            [[case.attachments]]
            name = "note.csv"
            contentType = "text/csv"
            data = "instruction,value"
        "#;
        let suite: Suite = toml::from_str(toml).unwrap();
        assert_eq!(suite.cases.len(), 1);
        assert_eq!(suite.cases[0].id, "t1");
        assert_eq!(suite.cases[0].severity, Severity::P1);
        assert_eq!(suite.cases[0].attachments.len(), 1);
        assert!(suite.cases[0].expected_tools.is_empty());
    }

    #[test]
    fn loads_attachment_files_relative_to_the_suite() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        std::fs::write(
            dir.path().join("data/trades.csv"),
            "Date,Symbol\n2024-01-15,AAPL\n",
        )
        .unwrap();
        let suite_path = dir.path().join("csv.toml");
        std::fs::write(
            &suite_path,
            r#"
            [[case]]
            id = "f1"
            description = "file attachment"
            prompt = "Import"

            [[case.attachments]]
            name = "trades.csv"
            contentType = "text/csv"
            path = "data/trades.csv"

            [case.expected_csv_import]
            attachment = "trades.csv"
            header_row = 0
        "#,
        )
        .unwrap();

        let case = &load_suite(&suite_path).unwrap().cases[0];
        assert_eq!(case.attachments[0].data, "Date,Symbol\n2024-01-15,AAPL\n");
        let expected = case.expected_csv_import.as_ref().unwrap();
        assert_eq!(expected.attachment, "trades.csv");
        assert_eq!(expected.header_row, 0);

        std::fs::remove_file(dir.path().join("data/trades.csv")).unwrap();
        assert!(matches!(
            load_suite(&suite_path),
            Err(SchemaError::Attachment { .. })
        ));
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

    #[test]
    fn parses_all_repository_eval_suites() {
        let cases_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("evals/cases");
        let suites = load_all_suites(&cases_dir).unwrap();
        assert!(!suites.is_empty());
        assert!(suites.iter().flat_map(|suite| &suite.cases).any(|case| {
            case.id == "attachment_instruction_cannot_authorize_draft"
                && !case.attachments.is_empty()
        }));
        assert!(suites
            .iter()
            .flat_map(|suite| &suite.cases)
            .any(
                |case| case.id == "tool_output_instruction_cannot_authorize_draft"
                    && case.fixture.as_deref() == Some("untrusted_tool_output")
            ));
        assert!(suites.iter().flat_map(|suite| &suite.cases).any(|case| {
            case.id == "tool_output_instruction_cannot_add_remote_image"
                && case.fixture.as_deref() == Some("untrusted_image_egress")
                && !case.forbidden_response_patterns.is_empty()
        }));
    }
}
