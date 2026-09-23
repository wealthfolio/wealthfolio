#![cfg(feature = "test-utils")]

use std::sync::Arc;
use wealthfolio_agent_tools::{
    tools::activities::ActivityDto, tools::SearchActivities, AgentScopeSet, AgentTool,
    AgentToolCatalog,
};
use wealthfolio_ai::env::test_env::{MockActivityService, MockEnvironment};
use wealthfolio_core::activities::ActivityDetails;

fn activity_with_notes(notes: Option<&str>) -> ActivityDetails {
    serde_json::from_value(serde_json::json!({
        "id": "activity-1",
        "accountId": "account-1",
        "assetId": "cash-eur",
        "activityType": "FEE",
        "status": "POSTED",
        "date": "2026-09-01T00:00:00Z",
        "currency": "EUR",
        "amount": "0",
        "needsReview": false,
        "comment": notes,
        "createdAt": "2026-09-01T00:00:00Z",
        "updatedAt": "2026-09-01T00:00:00Z",
        "accountName": "Synthetic account",
        "accountCurrency": "EUR",
        "assetSymbol": "EUR",
        "assetPricingMode": "NONE",
        "isUserModified": false
    }))
    .unwrap()
}

#[tokio::test]
async fn search_activities_returns_stored_notes() {
    let notes = [Some("test-note\n备注"), Some(""), None];
    let mut env = MockEnvironment::new();
    env.activity_service = Arc::new(MockActivityService {
        activities: notes.into_iter().map(activity_with_notes).collect(),
    });

    let env = Arc::new(env);
    let result = SearchActivities
        .call(env.clone(), serde_json::json!({}))
        .await
        .unwrap();
    let mcp_result = AgentToolCatalog::mcp_catalog()
        .execute(
            env,
            &AgentScopeSet::from_strs(["activities:read"]),
            "search_activities",
            serde_json::json!({}),
        )
        .await
        .unwrap();
    assert_eq!(mcp_result.content, result.content);

    let activities = result.content["activities"].as_array().unwrap();
    assert_eq!(activities.len(), notes.len());
    for (activity, expected) in activities.iter().zip(notes) {
        assert_eq!(activity["id"], "activity-1");
        assert_eq!(activity.get("notes"), Some(&serde_json::json!(expected)));
    }

    // Older stored tool outputs do not contain the new optional field.
    let mut legacy = activities[0].clone();
    legacy.as_object_mut().unwrap().remove("notes");
    assert!(serde_json::from_value::<ActivityDto>(legacy)
        .unwrap()
        .notes
        .is_none());
}
