#![allow(clippy::unwrap_used, reason = "test code")]
use std::sync::Arc;
use wealthfolio_core::goals::{GoalRepositoryTrait, GoalSummaryUpdate, NewGoal};
use wealthfolio_storage_sqlite::{db, goals::GoalRepository};

#[tokio::test]
async fn stale_goal_edit_preserves_newer_computed_summary() {
    let dir = tempfile::tempdir().unwrap();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    let (writer, _task) = db::write_actor::spawn_writer_with_sync_state(
        (*pool).clone(),
        Arc::new(|| {}),
        Arc::default(),
    )
    .unwrap();
    let repo = GoalRepository::new(pool, writer);
    let mut cached = repo
        .insert_new_goal(
            serde_json::from_value::<NewGoal>(serde_json::json!({
            "goalType":"home", "title":"House", "targetAmount":100000, "targetDate":"2030-12-31"
                }))
            .unwrap(),
        )
        .await
        .unwrap();
    repo.update_goal_summary_fields(
        &cached.id,
        GoalSummaryUpdate {
            summary_target_amount: Some(100000.0),
            summary_current_value: Some(10000.0),
            summary_progress: Some(0.1),
            projected_completion_date: None,
            projected_value_at_target_date: Some(95000.0),
            status_health: "at_risk".into(),
        },
    )
    .await
    .unwrap();
    cached.title = "Renamed".into();
    cached.status_health = "on_track".into();
    let saved = repo.update_goal(cached).await.unwrap();
    assert_eq!(saved.title, "Renamed");
    assert_eq!(saved.status_health, "at_risk");
    assert_eq!(saved.summary_current_value, Some(10000.0));
    assert_eq!(saved.summary_progress, Some(0.1));
    assert_eq!(saved.projected_value_at_target_date, Some(95000.0));
    assert_eq!(saved.target_date.as_deref(), Some("2030-12-31"));
    let mut clear = saved;
    clear.target_date = None;
    assert_eq!(repo.update_goal(clear).await.unwrap().target_date, None);
}
