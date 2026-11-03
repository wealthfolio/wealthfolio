#![cfg(feature = "test-utils")]
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use std::sync::Arc;
use wealthfolio_agent_tools::{
    tools::activities::ActivityDto, tools::SearchActivities, AgentScopeSet, AgentTool,
    AgentToolCatalog,
};
use wealthfolio_ai::env::test_env::{MockActivityService, MockEnvironment};
use wealthfolio_core::activities::{ActivityDetails, CashBalanceScope};

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
        ..Default::default()
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

#[tokio::test]
async fn search_activities_returns_each_row_cash_balance() {
    // The service fills balances only when the tool asks it to.
    let balanced = activity_with_notes(None);
    let mut unbalanced = activity_with_notes(None);
    unbalanced.id = "activity-2".to_string();
    let mut env = MockEnvironment::new();
    env.activity_service = Arc::new(MockActivityService {
        activities: vec![balanced, unbalanced],
        cash_balances: [(
            "activity-1".to_string(),
            (
                "954.90".to_string(),
                "EUR".to_string(),
                CashBalanceScope::Day,
            ),
        )]
        .into(),
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
    assert_eq!(activities[0]["cashBalance"], serde_json::json!(954.9));
    assert_eq!(activities[0]["cashBalanceCurrency"], "EUR");
    assert_eq!(activities[0]["cashBalanceScope"], "DAY");
    // Rows without a balance leave the fields out.
    assert!(activities[1].get("cashBalance").is_none());
    assert!(activities[1].get("cashBalanceCurrency").is_none());
    assert!(activities[1].get("cashBalanceScope").is_none());
}

#[tokio::test]
async fn search_activities_returns_tax_subtype_and_review_state() {
    let mut activity = activity_with_notes(None);
    activity.activity_type = "DIVIDEND".to_string();
    activity.subtype = Some("DRIP".to_string());
    activity.tax = Some("1.50".to_string());
    activity.needs_review = true;
    activity.asset_id = "asset-1".to_string();
    activity.asset_name = Some("Apple".to_string());
    activity.instrument_type = Some("EQUITY".to_string());
    activity.source_system = Some("CSV".to_string());
    let mut env = MockEnvironment::new();
    env.activity_service = Arc::new(MockActivityService {
        activities: vec![activity],
        ..Default::default()
    });

    let result = SearchActivities
        .call(Arc::new(env), serde_json::json!({}))
        .await
        .unwrap();

    let row = &result.content["activities"][0];
    assert_eq!(row["subtype"], "DRIP");
    assert_eq!(row["tax"], serde_json::json!(1.5));
    assert_eq!(row["status"], "POSTED");
    assert_eq!(row["needsReview"], true);
    assert_eq!(row["assetId"], "asset-1");
    assert_eq!(row["assetName"], "Apple");
    assert_eq!(row["instrumentType"], "EQUITY");
    assert_eq!(row["sourceSystem"], "CSV");
    assert_eq!(row["isUserModified"], false);
}
