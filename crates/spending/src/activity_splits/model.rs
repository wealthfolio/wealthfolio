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
    #[serde(serialize_with = "serialize_review_splits")]
    pub splits: Vec<ActivitySplit>,
}

fn serialize_review_splits<S: serde::Serializer>(
    splits: &[ActivitySplit],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    let mut rows = serde_json::to_value(splits).map_err(S::Error::custom)?;
    for (row, split) in rows.as_array_mut().into_iter().flatten().zip(splits) {
        row["amount"] = serde_json::Value::String(split.amount.to_string());
    }
    rows.serialize(serializer)
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
            #[serde(serialize_with = "serialize_review_splits")]
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
    }
}
