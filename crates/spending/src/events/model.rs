use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventType {
    pub id: String,
    /// Stable slug for the 7 seeded types (Travel, Wedding, …). Present only
    /// on rows seeded by the migration; user-created types have `None`. Used
    /// by the UI as an i18n lookup key so seeded names can be localized.
    pub key: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEventType {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub event_type_id: String,
    /// RFC3339 string
    pub start_date: String,
    pub end_date: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub event_type_id: String,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_event_preserves_explicit_null_description() {
        let patch: UpdateEvent = serde_json::from_str(r#"{"description":null}"#).unwrap();
        assert_eq!(patch.description, Some(None));
    }

    #[test]
    fn update_event_omitted_description_means_unchanged() {
        let patch: UpdateEvent = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(patch.description, None);
    }

    #[test]
    fn update_event_serializes_omitted_fields_as_absent() {
        let patch = UpdateEvent::default();
        assert_eq!(serde_json::to_value(patch).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn update_event_serializes_explicit_null_description() {
        let patch = UpdateEvent {
            description: Some(None),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(patch).unwrap(),
            serde_json::json!({ "description": null })
        );
    }
}

/// Event with its event_type's name joined in. Returned by `get_events_with_names`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWithTypeName {
    #[serde(flatten)]
    pub event: Event,
    pub event_type_name: String,
}
