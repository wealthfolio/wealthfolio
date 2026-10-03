//! Reads that must go through one definition, checked by scanning the
//! workspace's code (tests excluded), so a new query or reader cannot bypass
//! them:
//!
//! - An activity's type is its override when the override is not blank, else
//!   its stored type, wherever it is read (engine rules §5): SQL through
//!   `effective_type_sql`, Rust through core's `type_override` and
//!   `effective_activity_type`.
//! - A holdings account's positions read as of a day are carried across the
//!   splits recorded since its snapshot (engine rules R1.5): readers get them
//!   from `SnapshotService` (snapshots) or `HoldingsService` (the asset lot
//!   view); repositories return them as stored.
//!
//! The scan matches calls by name, so it catches a reader that calls a
//! repository's read method or the lot view directly; it cannot see raw SQL
//! over the snapshot tables, or code after a file's first `#[cfg(test)]`.

use std::fs;
use std::path::{Path, PathBuf};

const ROOTS: &[&str] = &["crates", "apps/server/src", "apps/tauri/src"];

fn rust_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !matches!(
                name.as_str(),
                "target" | "tests" | "test_support" | "migrations" | "node_modules"
            ) {
                rust_files(&path, files);
            }
        } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
            files.push(path);
        }
    }
}

/// Each source file's path from the workspace root, and its code:
/// lowercased, without whitespace or line continuations, and without the
/// file's test module.
fn workspace_code() -> Vec<(String, String)> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for root in ROOTS {
        rust_files(&workspace.join(root), &mut files);
    }
    assert!(files.len() > 100, "the scan found the workspace's sources");
    files
        .into_iter()
        .map(|file| {
            let relative = file
                .strip_prefix(&workspace)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            let text = fs::read_to_string(&file).unwrap_or_default();
            let code = text
                .split("#[cfg(test)]")
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '\\')
                .flat_map(char::to_lowercase)
                .collect();
            (relative, code)
        })
        .collect()
}

/// Files outside `allowed` whose code contains one of `calls`.
fn violations(code: &[(String, String)], calls: &[&str], allowed: &[&str]) -> Vec<String> {
    code.iter()
        .filter(|(path, _)| !allowed.contains(&path.as_str()))
        .flat_map(|(path, code)| {
            calls
                .iter()
                .filter(|call| code.contains(*call))
                .map(move |call| format!("{path}: `{call}`"))
        })
        .collect()
}

/// `COALESCE(` or `IFNULL(` over the override, optionally table-qualified.
fn sql_override_reads(code: &str) -> usize {
    code.match_indices("activity_type_override")
        .filter(|(index, _)| {
            let mut before = &code[..*index];
            if let Some(qualified) = before.strip_suffix('.') {
                before = qualified.trim_end_matches(|c: char| c.is_alphanumeric() || c == '_');
            }
            before.ends_with("coalesce(") || before.ends_with("ifnull(")
        })
        .count()
}

#[test]
fn every_read_of_the_activity_type_treats_a_blank_override_as_none() {
    let code = workspace_code();
    let mut found: Vec<String> = code
        .iter()
        .filter(|(_, code)| sql_override_reads(code) > 0)
        .map(|(path, _)| format!("{path}: SQL reads the override raw"))
        .collect();
    found.extend(violations(
        &code,
        &[
            ".activity_type_override.is_none()",
            ".activity_type_override.is_some()",
            "activity_type_override.as_deref().unwrap_or(",
        ],
        // Where the type is defined: core's helpers and the engine's normalize.
        &[
            "crates/core/src/activities/activities_model.rs",
            "crates/portfolio-engine/src/normalize.rs",
        ],
    ));
    assert!(
        found.is_empty(),
        "read the type through effective_type_sql or core's type_override:\n{}",
        found.join("\n")
    );
}

#[test]
fn every_read_of_holdings_positions_goes_through_the_services_that_carry_splits() {
    let code = workspace_code();
    let mut found = violations(
        &code,
        &[
            ".get_latest_snapshot_before_date(",
            ".get_latest_snapshots_before_date(",
            ".get_all_latest_snapshots(",
            ".get_all_non_archived_account_snapshots(",
            ".get_snapshots_by_account(",
            ".get_snapshot_positions(",
            ".get_snapshot_positions_batch(",
        ],
        &[
            // The reader that carries, and the repository it reads.
            "crates/core/src/portfolio/snapshot/snapshot_service.rs",
            "crates/core/src/portfolio/snapshot/snapshot_traits.rs",
            "crates/storage-sqlite/src/portfolio/snapshot/repository.rs",
            // The engine's facts are the stored snapshots: the engine carries.
            "crates/core/src/portfolio/coordinator/facts.rs",
            "crates/core/src/portfolio/coordinator/run.rs",
            "crates/storage-sqlite/src/portfolio/projection/mod.rs",
            // Broker sync compares the broker's positions with the stored ones.
            "crates/connect/src/broker/service.rs",
        ],
    );
    found.extend(violations(
        &code,
        &[
            "lots_repository.get_asset_lot_view(",
            "lot_repository.get_asset_lot_view(",
        ],
        &["crates/core/src/portfolio/holdings/holdings_service.rs"],
    ));
    assert!(
        found.is_empty(),
        "read holdings positions through SnapshotService or HoldingsService:\n{}",
        found.join("\n")
    );
}
