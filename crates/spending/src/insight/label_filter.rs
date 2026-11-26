//! Narrowing a spending report by the labels its activities carry.
//!
//! A label is something an activity is filed under besides its amount and
//! date: a category in an activity taxonomy (a payee, or a spending, income or
//! savings category), the spending event it is tagged to, or that event's type.
//! A report can keep only activities carrying some label ("spending at this
//! payee") or drop the ones that do ("spending without travel events").

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::activity_assignments::ActivityTaxonomyAssignment;
use crate::activity_splits::ActivitySplit;

/// One thing an activity can be filed under.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActivityLabel {
    /// A category of an activity taxonomy. Matches that category only, not
    /// its children.
    #[serde(rename_all = "camelCase")]
    Category {
        taxonomy_id: String,
        category_id: String,
    },
    /// A spending event.
    #[serde(rename_all = "camelCase")]
    Event { event_id: String },
    /// Every spending event of one type.
    #[serde(rename_all = "camelCase")]
    EventType { event_type_id: String },
}

/// Which activities a report covers, by label. The default covers them all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActivityLabelFilter {
    /// Keep only activities carrying at least one of these. Empty keeps all.
    pub include: Vec<ActivityLabel>,
    /// Then drop activities carrying any of these.
    pub exclude: Vec<ActivityLabel>,
}

impl ActivityLabelFilter {
    pub fn is_empty(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }

    /// Whether any label refers to spending events, which are loaded only then.
    pub fn uses_events(&self) -> bool {
        self.include.iter().chain(&self.exclude).any(|label| {
            matches!(
                label,
                ActivityLabel::Event { .. } | ActivityLabel::EventType { .. }
            )
        })
    }

    pub fn keeps(&self, activity_id: &str, labels: &ActivityLabels) -> bool {
        let carries = |label: &ActivityLabel| labels.carries(activity_id, label);
        (self.include.is_empty() || self.include.iter().any(carries))
            && !self.exclude.iter().any(carries)
    }
}

/// The labels each activity carries, gathered once per report.
#[derive(Debug, Default)]
pub struct ActivityLabels {
    by_activity: HashMap<String, HashSet<ActivityLabel>>,
}

impl ActivityLabels {
    pub fn add_assignments(&mut self, assignments: &[ActivityTaxonomyAssignment]) {
        for assignment in assignments {
            self.add(
                &assignment.activity_id,
                ActivityLabel::Category {
                    taxonomy_id: assignment.taxonomy_id.clone(),
                    category_id: assignment.category_id.clone(),
                },
            );
        }
    }

    /// A split activity's categories are its splits', which replace the
    /// assignment it has in the same taxonomy, as they do in the report's
    /// breakdowns. Call after [`Self::add_assignments`].
    pub fn add_splits(&mut self, splits: &[ActivitySplit]) {
        for split in splits {
            if let Some(labels) = self.by_activity.get_mut(&split.activity_id) {
                labels.retain(|label| {
                    !matches!(label, ActivityLabel::Category { taxonomy_id, .. }
                        if *taxonomy_id == split.taxonomy_id)
                });
            }
        }
        for split in splits {
            self.add(
                &split.activity_id,
                ActivityLabel::Category {
                    taxonomy_id: split.taxonomy_id.clone(),
                    category_id: split.category_id.clone(),
                },
            );
        }
    }

    /// `event_by_activity` maps an activity to the event it is tagged to;
    /// `type_by_event` maps an event to its type.
    pub fn add_events(
        &mut self,
        event_by_activity: &HashMap<String, String>,
        type_by_event: &HashMap<String, String>,
    ) {
        for (activity_id, event_id) in event_by_activity {
            self.add(
                activity_id,
                ActivityLabel::Event {
                    event_id: event_id.clone(),
                },
            );
            if let Some(event_type_id) = type_by_event.get(event_id) {
                self.add(
                    activity_id,
                    ActivityLabel::EventType {
                        event_type_id: event_type_id.clone(),
                    },
                );
            }
        }
    }

    pub fn carries(&self, activity_id: &str, label: &ActivityLabel) -> bool {
        self.by_activity
            .get(activity_id)
            .is_some_and(|labels| labels.contains(label))
    }

    fn add(&mut self, activity_id: &str, label: ActivityLabel) {
        self.by_activity
            .entry(activity_id.to_string())
            .or_default()
            .insert(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn category(taxonomy_id: &str, category_id: &str) -> ActivityLabel {
        ActivityLabel::Category {
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
        }
    }

    fn assignment(
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> ActivityTaxonomyAssignment {
        ActivityTaxonomyAssignment {
            id: format!("{activity_id}:{taxonomy_id}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            weight: 10_000,
            source: "manual".to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    /// `shoes` and `book` were bought at one shop, `fuel` at another, `flight`
    /// during a trip, and `cash` carries no label at all.
    fn labels() -> ActivityLabels {
        let mut labels = ActivityLabels::default();
        labels.add_assignments(&[
            assignment("shoes", "spending_categories", "clothing"),
            assignment("shoes", "payees", "bigshop"),
            assignment("book", "spending_categories", "books"),
            assignment("book", "payees", "bigshop"),
            assignment("fuel", "payees", "station"),
            assignment("flight", "spending_categories", "airfare"),
        ]);
        labels.add_events(
            &HashMap::from([("flight".to_string(), "trip-1".to_string())]),
            &HashMap::from([("trip-1".to_string(), "travel".to_string())]),
        );
        labels
    }

    fn kept(filter: &ActivityLabelFilter) -> Vec<&'static str> {
        let labels = labels();
        ["shoes", "book", "fuel", "flight", "cash"]
            .into_iter()
            .filter(|id| filter.keeps(id, &labels))
            .collect()
    }

    #[test]
    fn an_empty_filter_keeps_everything() {
        let filter = ActivityLabelFilter::default();
        assert!(filter.is_empty());
        assert_eq!(kept(&filter), ["shoes", "book", "fuel", "flight", "cash"]);
    }

    #[test]
    fn excluding_a_payee_drops_its_activities_whatever_their_category() {
        let filter = ActivityLabelFilter {
            exclude: vec![category("payees", "bigshop")],
            ..Default::default()
        };
        assert_eq!(kept(&filter), ["fuel", "flight", "cash"]);
    }

    #[test]
    fn including_a_payee_keeps_only_its_activities() {
        let filter = ActivityLabelFilter {
            include: vec![category("payees", "bigshop")],
            ..Default::default()
        };
        assert_eq!(kept(&filter), ["shoes", "book"]);
    }

    #[test]
    fn an_event_type_covers_every_event_of_that_type() {
        let by_type = ActivityLabelFilter {
            exclude: vec![ActivityLabel::EventType {
                event_type_id: "travel".to_string(),
            }],
            ..Default::default()
        };
        assert!(by_type.uses_events());
        assert_eq!(kept(&by_type), ["shoes", "book", "fuel", "cash"]);

        let by_event = ActivityLabelFilter {
            include: vec![ActivityLabel::Event {
                event_id: "trip-1".to_string(),
            }],
            ..Default::default()
        };
        assert_eq!(kept(&by_event), ["flight"]);
    }

    #[test]
    fn include_is_any_of_and_exclude_wins() {
        let filter = ActivityLabelFilter {
            include: vec![category("payees", "bigshop"), category("payees", "station")],
            exclude: vec![category("spending_categories", "books")],
        };
        assert!(!filter.uses_events());
        assert_eq!(kept(&filter), ["shoes", "fuel"]);
    }

    fn split(activity_id: &str, taxonomy_id: &str, category_id: &str) -> ActivitySplit {
        ActivitySplit {
            id: format!("{activity_id}:{category_id}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            amount: rust_decimal::Decimal::ONE,
            note: None,
            sort_order: 0,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[test]
    fn a_split_activity_carries_its_splits_categories_and_keeps_its_payee() {
        // `shoes` is split between clothing and gifts; the category it was
        // assigned before the split no longer describes it.
        let mut labels = ActivityLabels::default();
        labels.add_assignments(&[
            assignment("shoes", "spending_categories", "household"),
            assignment("shoes", "payees", "bigshop"),
        ]);
        labels.add_splits(&[
            split("shoes", "spending_categories", "clothing"),
            split("shoes", "spending_categories", "gifts"),
        ]);

        for carried in ["clothing", "gifts"] {
            assert!(labels.carries("shoes", &category("spending_categories", carried)));
        }
        assert!(!labels.carries("shoes", &category("spending_categories", "household")));
        assert!(labels.carries("shoes", &category("payees", "bigshop")));
    }

    #[test]
    fn the_same_category_id_in_another_taxonomy_is_a_different_label() {
        let filter = ActivityLabelFilter {
            include: vec![category("activity_tags", "bigshop")],
            ..Default::default()
        };
        assert!(kept(&filter).is_empty());
    }

    #[test]
    fn a_filter_reads_from_the_request_shape_the_frontend_sends() {
        let filter: ActivityLabelFilter = serde_json::from_str(
            r#"{"exclude":[{"kind":"category","taxonomyId":"payees","categoryId":"bigshop"},
                           {"kind":"eventType","eventTypeId":"travel"}]}"#,
        )
        .unwrap();
        assert!(filter.include.is_empty());
        assert_eq!(
            filter.exclude,
            [
                category("payees", "bigshop"),
                ActivityLabel::EventType {
                    event_type_id: "travel".to_string()
                }
            ]
        );
    }
}
