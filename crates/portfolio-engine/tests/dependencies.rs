//! P3 (architecture §4.1): the kernel's runtime dependency list is closed. A
//! database, runtime or workspace crate added here fails this test instead of
//! slipping through review.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use std::collections::BTreeSet;

const ALLOWED: [&str; 6] = [
    "chrono",
    "chrono-tz",
    "rust_decimal",
    "rust_decimal_macros",
    "serde",
    "thiserror",
];

#[test]
fn runtime_dependencies_are_the_closed_list() {
    let manifest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .expect("read Cargo.toml");
    let mut in_dependencies = false;
    let mut found = BTreeSet::new();
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_dependencies = line == "[dependencies]";
            continue;
        }
        if in_dependencies && !line.is_empty() && !line.starts_with('#') {
            if let Some((name, _)) = line.split_once('=') {
                found.insert(name.trim().to_string());
            }
        }
    }
    let allowed: BTreeSet<String> = ALLOWED.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        found, allowed,
        "the kernel's runtime dependencies changed; update architecture §4.1 first"
    );
}
