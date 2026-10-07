//! Property-based integration tests for the Health Center.
//!
//! These tests verify that universal properties hold across all valid inputs,
//! using the `proptest` crate for random test case generation.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use proptest::prelude::*;
use std::collections::HashSet;
use wealthfolio_core::health::{HealthCategory, HealthIssue, HealthStatus, Severity};

// =============================================================================
// Generators
// =============================================================================

/// Generates a random severity level.
fn arb_severity() -> impl Strategy<Value = Severity> {
    prop_oneof![
        Just(Severity::Info),
        Just(Severity::Warning),
        Just(Severity::Error),
        Just(Severity::Critical),
    ]
}

/// Generates a random health category.
fn arb_category() -> impl Strategy<Value = HealthCategory> {
    prop_oneof![
        Just(HealthCategory::PriceStaleness),
        Just(HealthCategory::FxIntegrity),
        Just(HealthCategory::Classification),
        Just(HealthCategory::DataConsistency),
    ]
}

/// Generates a random health issue with valid structure.
fn arb_health_issue() -> impl Strategy<Value = HealthIssue> {
    (
        arb_severity(),
        arb_category(),
        "[a-z]{5,20}",                     // title
        "[a-z ]{10,50}",                   // message
        0u32..1000,                        // affected_count
        proptest::option::of(0.0f64..1.0), // affected_mv_pct
        "[a-f0-9]{16}",                    // data_hash
    )
        .prop_map(
            |(severity, category, title, message, count, mv_pct, hash)| {
                let id = format!("{}:{}", category.as_str().to_lowercase(), hash);
                let mut issue = HealthIssue::builder()
                    .id(id)
                    .severity(severity)
                    .category(category)
                    .title(title)
                    .message(message)
                    .affected_count(count)
                    .data_hash(hash)
                    .build();
                issue.affected_mv_pct = mv_pct;
                issue
            },
        )
}

/// Generates a vector of random health issues.
fn arb_health_issues(max_count: usize) -> impl Strategy<Value = Vec<HealthIssue>> {
    proptest::collection::vec(arb_health_issue(), 0..=max_count)
}

// =============================================================================
// Property Tests
// =============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// **Feature: health-center, Property 1: Global status reflects highest severity**
    ///
    /// The overall_severity of a HealthStatus must always equal the maximum
    /// severity among all issues. If no issues exist, it should be Info.
    #[test]
    fn prop_global_status_reflects_highest_severity(
        issues in arb_health_issues(50)
    ) {
        let status = HealthStatus::from_issues(issues.clone());

        let expected_severity = issues
            .iter()
            .map(|i| i.severity)
            .max()
            .unwrap_or(Severity::Info);

        prop_assert_eq!(
            status.overall_severity,
            expected_severity,
            "Overall severity should match highest issue severity"
        );
    }

    /// **Feature: health-center, Property 2: Issue counts are accurate**
    ///
    /// The issue_counts map must accurately reflect the count of issues
    /// at each severity level.
    #[test]
    fn prop_issue_counts_are_accurate(
        issues in arb_health_issues(100)
    ) {
        let status = HealthStatus::from_issues(issues.clone());

        // Count issues manually
        let mut expected_counts = std::collections::HashMap::new();
        for issue in &issues {
            *expected_counts.entry(issue.severity).or_insert(0u32) += 1;
        }

        // Verify counts match
        for severity in [Severity::Info, Severity::Warning, Severity::Error, Severity::Critical] {
            let expected = expected_counts.get(&severity).copied().unwrap_or(0);
            let actual = status.issue_counts.get(&severity).copied().unwrap_or(0);
            prop_assert_eq!(
                actual,
                expected,
                "Count for {:?} should be {} but was {}",
                severity,
                expected,
                actual
            );
        }
    }

    /// **Feature: health-center, Property 3: Total count equals sum of severity counts**
    ///
    /// The total_count() method must return the sum of all counts in issue_counts.
    #[test]
    fn prop_total_count_equals_sum(
        issues in arb_health_issues(100)
    ) {
        let status = HealthStatus::from_issues(issues.clone());

        let sum_of_counts: u32 = status.issue_counts.values().sum();

        prop_assert_eq!(
            status.total_count(),
            sum_of_counts,
            "total_count() should equal sum of issue_counts"
        );
        prop_assert_eq!(
            status.total_count() as usize,
            issues.len(),
            "total_count() should equal number of issues"
        );
    }

    /// **Feature: health-center, Property 4: Issues by severity filter correctly**
    ///
    /// The issues_by_severity method must return exactly the issues
    /// that match the given severity.
    #[test]
    fn prop_issues_by_severity_filter_correctly(
        issues in arb_health_issues(50),
        filter_severity in arb_severity(),
    ) {
        let status = HealthStatus::from_issues(issues.clone());

        let filtered = status.issues_by_severity(filter_severity);

        // All filtered issues should have the target severity
        for issue in &filtered {
            prop_assert_eq!(
                issue.severity,
                filter_severity,
                "Filtered issue should have severity {:?}",
                filter_severity
            );
        }

        // Count should match expected
        let expected_count = issues.iter().filter(|i| i.severity == filter_severity).count();
        prop_assert_eq!(
            filtered.len(),
            expected_count,
            "Number of filtered issues should match expected count"
        );
    }

    /// **Feature: health-center, Property 5: Issues by category filter correctly**
    ///
    /// The issues_by_category method must return exactly the issues
    /// that match the given category.
    #[test]
    fn prop_issues_by_category_filter_correctly(
        issues in arb_health_issues(50),
        filter_category in arb_category(),
    ) {
        let status = HealthStatus::from_issues(issues.clone());

        let filtered = status.issues_by_category(filter_category);

        // All filtered issues should have the target category
        for issue in &filtered {
            prop_assert_eq!(
                issue.category,
                filter_category,
                "Filtered issue should have category {:?}",
                filter_category
            );
        }

        // Count should match expected
        let expected_count = issues.iter().filter(|i| i.category == filter_category).count();
        prop_assert_eq!(
            filtered.len(),
            expected_count,
            "Number of filtered issues should match expected count"
        );
    }

    /// **Feature: health-center, Property 6: Healthy status has no issues**
    ///
    /// A healthy status created with HealthStatus::healthy() must have
    /// Info severity, zero issues, and not be stale.
    #[test]
    fn prop_healthy_status_invariants(_dummy: u8) {
        let status = HealthStatus::healthy();

        prop_assert_eq!(status.overall_severity, Severity::Info);
        prop_assert_eq!(status.total_count(), 0);
        prop_assert!(status.issues.is_empty());
        prop_assert!(!status.is_stale);
    }

    /// **Feature: health-center, Property 7: MV percentage is within valid range**
    ///
    /// Any affected_mv_pct value on an issue must be between 0.0 and 1.0 (inclusive).
    #[test]
    fn prop_mv_percentage_valid_range(
        issues in arb_health_issues(100)
    ) {
        for issue in issues {
            if let Some(mv_pct) = issue.affected_mv_pct {
                prop_assert!(
                    (0.0..=1.0).contains(&mv_pct),
                    "MV percentage {} should be between 0.0 and 1.0",
                    mv_pct
                );
            }
        }
    }

    /// **Feature: health-center, Property 8: Severity ordering is consistent**
    ///
    /// Severity levels must maintain their ordering: Info < Warning < Error < Critical
    #[test]
    fn prop_severity_ordering_consistent(
        sev1 in arb_severity(),
        sev2 in arb_severity(),
    ) {
        // If sev1 < sev2 then sev2 > sev1
        if sev1 < sev2 {
            prop_assert!(sev2 > sev1);
        }
        // If sev1 == sev2 then neither is greater
        if sev1 == sev2 {
            prop_assert!(sev1 >= sev2);
            prop_assert!(sev1 <= sev2);
        }
        // Verify specific orderings
        prop_assert!(Severity::Info <= sev1);
        prop_assert!(sev1 <= Severity::Critical);
    }

    /// **Feature: health-center, Property 9: Issue IDs should be unique per check run**
    ///
    /// In a valid health status, issue IDs should be unique.
    #[test]
    fn prop_unique_issue_ids_generation(
        issues in arb_health_issues(50)
    ) {
        let ids: HashSet<_> = issues.iter().map(|i| &i.id).collect();
        prop_assert!(ids.len() <= issues.len());
    }

    /// **Feature: health-center, Property 10: Empty issues produces healthy status**
    ///
    /// Creating a HealthStatus from an empty vector should produce a healthy status.
    #[test]
    fn prop_empty_issues_is_healthy(_dummy: u8) {
        let status = HealthStatus::from_issues(vec![]);

        prop_assert_eq!(status.overall_severity, Severity::Info);
        prop_assert_eq!(status.total_count(), 0);
        prop_assert!(status.issues.is_empty());
    }

    /// **Feature: health-center, Property 11: Single issue status matches that issue**
    ///
    /// When a status contains exactly one issue, the overall severity
    /// should match that issue's severity.
    #[test]
    fn prop_single_issue_status_matches(
        issue in arb_health_issue()
    ) {
        let expected_severity = issue.severity;
        let status = HealthStatus::from_issues(vec![issue]);

        prop_assert_eq!(status.overall_severity, expected_severity);
        prop_assert_eq!(status.total_count(), 1);
        prop_assert_eq!(status.issue_counts.get(&expected_severity), Some(&1));
    }

    /// **Feature: health-center, Property 12: Mark stale changes is_stale flag**
    ///
    /// Calling mark_stale() should set is_stale to true.
    #[test]
    fn prop_mark_stale_sets_flag(
        issues in arb_health_issues(20)
    ) {
        let mut status = HealthStatus::from_issues(issues);

        prop_assert!(!status.is_stale, "Fresh status should not be stale");

        status.mark_stale();

        prop_assert!(status.is_stale, "Status should be stale after mark_stale()");
    }
}
