use chrono::NaiveDateTime;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySplit {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    // Reads are also replacement evidence. Preserve every digit while still
    // accepting legacy JSON numbers on input.
    #[serde(serialize_with = "rust_decimal::serde::str::serialize")]
    pub amount: Decimal,
    pub note: Option<String>,
    pub sort_order: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewActivitySplit {
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: Decimal,
    pub note: Option<String>,
    pub sort_order: Option<i32>,
}

/// Transient review evidence, never persisted. Financial and allocation edits
/// between preview and commit must invalidate a replacement proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitReviewState {
    pub activity: wealthfolio_core::activities::Activity,
    pub assignments: Vec<crate::activity_assignments::ActivityTaxonomyAssignment>,
    pub splits: Vec<ActivitySplit>,
}

#[cfg(test)]
mod review_tests {
    use super::*;
    #[test]
    fn review_split_amounts_preserve_exact_decimal_text() {
        let split = ActivitySplit {
            id: "s".into(),
            activity_id: "a".into(),
            taxonomy_id: "spending_categories".into(),
            category_id: "c".into(),
            amount: "12345678901234567890.12345678".parse().expect("decimal"),
            note: None,
            sort_order: 0,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        };
        #[derive(Serialize)]
        struct Review<'a> {
            splits: &'a [ActivitySplit],
        }
        let value = serde_json::to_value(Review {
            splits: std::slice::from_ref(&split),
        })
        .expect("serialized");
        assert_eq!(value["splits"][0]["amount"], split.amount.to_string());
        let restored: Vec<ActivitySplit> =
            serde_json::from_value(value["splits"].clone()).expect("roundtrip");
        assert_eq!(restored[0], split);
        let mut legacy = value["splits"][0].clone();
        legacy["amount"] = serde_json::json!(1.25);
        let restored: ActivitySplit = serde_json::from_value(legacy).expect("legacy numeric input");
        assert_eq!(restored.amount, Decimal::new(125, 2));
    }
}
