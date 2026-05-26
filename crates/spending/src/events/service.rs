use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use wealthfolio_core::activities::{Activity, ActivityRepositoryTrait};

use super::model::{Event, EventType, EventWithTypeName, NewEvent, NewEventType, UpdateEvent};
use super::traits::{EventTypesRepositoryTrait, EventsRepositoryTrait};
use crate::error::SpendingError;

pub struct EventsService {
    types_repo: Arc<dyn EventTypesRepositoryTrait>,
    events_repo: Arc<dyn EventsRepositoryTrait>,
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
}

impl EventsService {
    pub fn new(
        types_repo: Arc<dyn EventTypesRepositoryTrait>,
        events_repo: Arc<dyn EventsRepositoryTrait>,
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
    ) -> Self {
        Self {
            types_repo,
            events_repo,
            activity_repo,
            activity_events,
        }
    }

    pub async fn list_types(&self) -> Result<Vec<EventType>> {
        self.types_repo.list().await
    }
    pub async fn create_type(&self, new_type: NewEventType) -> Result<EventType> {
        self.types_repo.create(new_type).await
    }
    pub async fn update_type(
        &self,
        id: &str,
        name: Option<String>,
        color: Option<Option<String>>,
    ) -> Result<EventType> {
        self.types_repo.update(id, name, color).await
    }
    /// Pre-checks that no events reference this type, returning a friendly
    /// `SpendingError::EventTypeInUse` instead of bubbling a raw FK error from
    /// the storage layer.
    pub async fn delete_type(&self, id: &str) -> Result<()> {
        let in_use = self.events_repo.count_by_type(id).await?;
        if in_use > 0 {
            return Err(SpendingError::EventTypeInUse { count: in_use }.into());
        }
        self.types_repo.delete(id).await
    }

    pub async fn list_events(&self) -> Result<Vec<Event>> {
        self.events_repo.list().await
    }

    /// List events joined with their event_type name for UI display.
    pub async fn list_events_with_names(&self) -> Result<Vec<EventWithTypeName>> {
        let types = self.types_repo.list().await?;
        let type_by_id: std::collections::HashMap<String, String> =
            types.into_iter().map(|t| (t.id, t.name)).collect();
        let events = self.events_repo.list().await?;
        Ok(events
            .into_iter()
            .map(|e| {
                let event_type_name = type_by_id
                    .get(&e.event_type_id)
                    .cloned()
                    .unwrap_or_else(|| e.event_type_id.clone());
                EventWithTypeName {
                    event: e,
                    event_type_name,
                }
            })
            .collect())
    }
    pub async fn get_event(&self, id: &str) -> Result<Option<Event>> {
        self.events_repo.get(id).await
    }

    pub fn contains_activity_date(
        &self,
        event: &Event,
        activity_date: &DateTime<Utc>,
    ) -> Result<bool> {
        let start = parse_event_start_bound(&event.start_date)?;
        let end = parse_event_end_bound(&event.end_date)?;
        Ok(activity_date >= &start && activity_date <= &end)
    }

    pub async fn create_event(&self, new_event: NewEvent) -> Result<Event> {
        validate_event_range(&new_event.start_date, &new_event.end_date)?;
        self.events_repo.create(new_event).await
    }
    /// Update an event. Validates the new (possibly partial) window. If the
    /// window narrowed on either side, untags any activities that fell out of
    /// range. On expansion, logs the count of newly in-range untagged
    /// activities (we don't auto-tag — that's a UX decision).
    pub async fn update_event(&self, id: &str, patch: UpdateEvent) -> Result<Event> {
        let existing = self
            .events_repo
            .get(id)
            .await?
            .ok_or_else(|| SpendingError::NotFound {
                entity: "Event",
                id: id.to_string(),
            })?;

        let new_start = patch
            .start_date
            .clone()
            .unwrap_or_else(|| existing.start_date.clone());
        let new_end = patch
            .end_date
            .clone()
            .unwrap_or_else(|| existing.end_date.clone());
        validate_event_range(&new_start, &new_end)?;

        let old_start_dt = parse_event_start_bound(&existing.start_date)?;
        let old_end_dt = parse_event_end_bound(&existing.end_date)?;
        let new_start_dt = parse_event_start_bound(&new_start)?;
        let new_end_dt = parse_event_end_bound(&new_end)?;

        let narrowed_start = new_start_dt > old_start_dt;
        let narrowed_end = new_end_dt < old_end_dt;
        let expanded_start = new_start_dt < old_start_dt;
        let expanded_end = new_end_dt > old_end_dt;

        let updated = self.events_repo.update(id, patch).await?;

        // Untag activities that fell out of the new window on either narrowed
        // side. Indexed lookup on activity_events gives us just the ids
        // tagged to this event (typically small), and we fetch each by id
        // instead of scanning the whole activities table.
        if narrowed_start || narrowed_end {
            let tagged_ids = self.activity_events.list_for_event(id).await?;
            for activity_id in &tagged_ids {
                let a = self
                    .activity_repo
                    .get_activity(activity_id)
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                if a.activity_date < new_start_dt || a.activity_date > new_end_dt {
                    self.activity_events
                        .set_activity_event_tag(&a.id, None)
                        .await?;
                }
            }
        }

        // On expansion, surface count of newly-eligible (untagged) activities so
        // the frontend can offer a "tag these N activities" CTA. We do not
        // auto-tag.
        //
        // Perf: filter activities by the diff window (newly-included rows
        // only) *before* preloading the tag map — preloading tags for the
        // whole activity table is wasted work when most activities aren't
        // even in the date diff.
        if expanded_start || expanded_end {
            let all = self
                .activity_repo
                .get_activities()
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let diff_candidates: Vec<&Activity> = all
                .iter()
                .filter(|a| a.activity_date >= new_start_dt && a.activity_date <= new_end_dt)
                .filter(|a| a.activity_date < old_start_dt || a.activity_date > old_end_dt)
                .collect();
            let activity_ids: Vec<String> = diff_candidates.iter().map(|a| a.id.clone()).collect();
            let tag_map = self
                .activity_events
                .list_for_activities(&activity_ids)
                .await?;
            let newly_eligible = diff_candidates
                .iter()
                .filter(|a| !tag_map.contains_key(&a.id))
                .count();
            if newly_eligible > 0 {
                log::info!(
                    "Event {} expanded — {} previously untagged in-range activities are now eligible for tagging",
                    id,
                    newly_eligible
                );
            }
        }

        Ok(updated)
    }
    pub async fn delete_event(&self, id: &str) -> Result<()> {
        if self.events_repo.get(id).await?.is_none() {
            return Err(SpendingError::NotFound {
                entity: "Event",
                id: id.to_string(),
            }
            .into());
        }
        self.events_repo.delete(id).await
    }
}

/// Reject `start_date > end_date`. Accepts either RFC3339 timestamps or
/// `YYYY-MM-DD` date strings; lexicographic comparison works for both (RFC3339
/// is sortable and pure dates are sortable).
fn validate_event_range(start: &str, end: &str) -> Result<()> {
    // Prefer a parsed comparison when possible — falls back to lexicographic
    // for `YYYY-MM-DD` strings (which the model documents as the on-disk shape
    // even though the type calls itself "RFC3339").
    let parsed = (parse_event_start_bound(start), parse_event_end_bound(end));
    let bad = match parsed {
        (Ok(s), Ok(e)) => s > e,
        _ => start > end,
    };
    if bad {
        return Err(SpendingError::InvalidEventRange.into());
    }
    Ok(())
}

/// Parse an event start boundary. Tries RFC3339 first, then `YYYY-MM-DD`
/// (interpreted as the start of that UTC day).
fn parse_event_start_bound(s: &str) -> Result<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let naive = date.and_hms_opt(0, 0, 0).unwrap();
        return Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
    }
    Err(SpendingError::InvalidInput {
        message: format!("Unparseable event date: {s}"),
    }
    .into())
}

/// Parse an event end boundary. Date-only end dates are inclusive for the full
/// day so narrowing an event to `YYYY-MM-DD` does not untag same-day activity.
fn parse_event_end_bound(s: &str) -> Result<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let naive = date.and_hms_nano_opt(23, 59, 59, 999_999_999).unwrap();
        return Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
    }
    Err(SpendingError::InvalidInput {
        message: format!("Unparseable event date: {s}"),
    }
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{NaiveDateTime, TimeZone};
    use std::sync::Mutex;
    use wealthfolio_core::activities::{
        Activity, ActivityBulkMutationResult, ActivitySearchResponse, ActivityStatus,
        ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate,
        IncomeData, NewActivity, Sort,
    };
    use wealthfolio_core::limits::ContributionActivity;

    // --------------- Mock events repo ---------------

    #[derive(Default)]
    struct MockEventsRepo {
        events: Mutex<Vec<Event>>,
    }

    fn now() -> NaiveDateTime {
        Utc::now().naive_utc()
    }

    #[async_trait]
    impl EventsRepositoryTrait for MockEventsRepo {
        async fn list(&self) -> Result<Vec<Event>> {
            Ok(self.events.lock().unwrap().clone())
        }
        async fn get(&self, id: &str) -> Result<Option<Event>> {
            Ok(self
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.id == id)
                .cloned())
        }
        async fn create(&self, new_event: NewEvent) -> Result<Event> {
            let ev = Event {
                id: new_event.id.unwrap_or_else(|| "ev_1".to_string()),
                name: new_event.name,
                description: new_event.description,
                event_type_id: new_event.event_type_id,
                start_date: new_event.start_date,
                end_date: new_event.end_date,
                created_at: now(),
                updated_at: now(),
            };
            self.events.lock().unwrap().push(ev.clone());
            Ok(ev)
        }
        async fn update(&self, id: &str, patch: UpdateEvent) -> Result<Event> {
            let mut events = self.events.lock().unwrap();
            let ev = events
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("not found"))?;
            if let Some(v) = patch.name {
                ev.name = v;
            }
            if let Some(v) = patch.start_date {
                ev.start_date = v;
            }
            if let Some(v) = patch.end_date {
                ev.end_date = v;
            }
            Ok(ev.clone())
        }
        async fn delete(&self, id: &str) -> Result<()> {
            self.events.lock().unwrap().retain(|e| e.id != id);
            Ok(())
        }
        async fn count_by_type(&self, event_type_id: &str) -> Result<usize> {
            Ok(self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.event_type_id == event_type_id)
                .count())
        }
    }

    // --------------- Mock event_types repo ---------------

    #[derive(Default)]
    struct MockTypesRepo {
        deleted: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl EventTypesRepositoryTrait for MockTypesRepo {
        async fn list(&self) -> Result<Vec<EventType>> {
            Ok(vec![])
        }
        async fn create(&self, _: NewEventType) -> Result<EventType> {
            unimplemented!()
        }
        async fn update(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<Option<String>>,
        ) -> Result<EventType> {
            unimplemented!()
        }
        async fn delete(&self, id: &str) -> Result<()> {
            self.deleted.lock().unwrap().push(id.to_string());
            Ok(())
        }
    }

    // --------------- Mock activity repo ---------------

    // Tag storage lives in a shared map, mirroring how the real
    // `activity_events` join table backs both read and write paths.
    type TagStore = Arc<Mutex<std::collections::HashMap<String, String>>>;

    struct MockActivityRepo {
        activities: Mutex<Vec<Activity>>,
    }

    fn mk_activity(id: &str, date: DateTime<Utc>) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: "acct1".to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: date,
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: None,
            fee: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    struct MockActivityEventsRepo {
        tags: TagStore,
    }

    #[async_trait]
    impl crate::activity_events::ActivityEventsRepositoryTrait for MockActivityEventsRepo {
        async fn list_for_activities(
            &self,
            ids: &[String],
        ) -> Result<std::collections::HashMap<String, String>> {
            let tags = self.tags.lock().unwrap();
            Ok(ids
                .iter()
                .filter_map(|id| tags.get(id).map(|eid| (id.clone(), eid.clone())))
                .collect())
        }
        async fn list_for_event(&self, event_id: &str) -> Result<Vec<String>> {
            Ok(self
                .tags
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, eid)| eid.as_str() == event_id)
                .map(|(aid, _)| aid.clone())
                .collect())
        }
        async fn delete_by_event(&self, event_id: &str) -> Result<usize> {
            let mut tags = self.tags.lock().unwrap();
            let before = tags.len();
            tags.retain(|_, eid| eid.as_str() != event_id);
            Ok(before - tags.len())
        }
        async fn set_activity_event_tag(
            &self,
            activity_id: &str,
            event_id: Option<String>,
        ) -> Result<()> {
            let mut tags = self.tags.lock().unwrap();
            match event_id {
                Some(eid) => {
                    tags.insert(activity_id.to_string(), eid);
                }
                None => {
                    tags.remove(activity_id);
                }
            }
            Ok(())
        }
        async fn list_all(&self) -> Result<Vec<crate::activity_events::ActivityEvent>> {
            let tags = self.tags.lock().unwrap();
            Ok(tags
                .iter()
                .map(|(aid, eid)| crate::activity_events::ActivityEvent {
                    activity_id: aid.clone(),
                    event_id: eid.clone(),
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                })
                .collect())
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepo {
        fn get_activity(&self, id: &str) -> wealthfolio_core::Result<Activity> {
            self.activities
                .lock()
                .unwrap()
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or_else(|| {
                    wealthfolio_core::errors::Error::Validation(
                        wealthfolio_core::errors::ValidationError::InvalidInput(
                            "not found".to_string(),
                        ),
                    )
                })
        }
        fn get_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self.activities.lock().unwrap().clone())
        }
        fn get_activities_by_account_id(&self, _: &str) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_ids(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_trading_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_contribution_activities(
            &self,
            _: &[String],
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> wealthfolio_core::Result<Vec<ContributionActivity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<chrono::NaiveDate>,
            _: Option<chrono::NaiveDate>,
            _: Option<Vec<String>>,
        ) -> wealthfolio_core::Result<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _: NewActivity) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _: ActivityUpdate) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _: String) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> wealthfolio_core::Result<ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _: Vec<NewActivity>) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }
        fn get_import_mapping(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportMapping>> {
            unimplemented!()
        }
        async fn save_import_mapping(&self, _: &ImportMapping) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_account_template(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn list_import_templates(&self) -> wealthfolio_core::Result<Vec<ImportTemplate>> {
            unimplemented!()
        }
        fn get_import_template(&self, _: &str) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_import_template(&self, _: &ImportTemplate) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn delete_import_template(&self, _: &str) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn get_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_broker_sync_profile(
            &self,
            _: &ImportTemplate,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn calculate_average_cost(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<rust_decimal::Decimal> {
            unimplemented!()
        }
        fn get_income_activities_data(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<IncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> wealthfolio_core::Result<DateTime<Utc>> {
            unimplemented!()
        }
        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }
        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }
        fn check_existing_duplicates(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<std::collections::HashMap<String, String>> {
            unimplemented!()
        }
        async fn bulk_upsert(
            &self,
            _: Vec<ActivityUpsert>,
        ) -> wealthfolio_core::Result<BulkUpsertResult> {
            unimplemented!()
        }
        async fn reassign_asset(&self, _: &str, _: &str) -> wealthfolio_core::Result<u32> {
            unimplemented!()
        }
        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<(Vec<String>, Vec<String>)> {
            unimplemented!()
        }
    }

    // --------------- Helpers ---------------

    fn make_service(
        events: Vec<Event>,
        activities: Vec<Activity>,
        initial_tags: Vec<(&str, &str)>,
    ) -> (
        EventsService,
        Arc<MockEventsRepo>,
        Arc<MockActivityRepo>,
        Arc<MockTypesRepo>,
        TagStore,
    ) {
        let events_repo = Arc::new(MockEventsRepo {
            events: Mutex::new(events),
        });
        let tags: TagStore = Arc::new(Mutex::new(
            initial_tags
                .into_iter()
                .map(|(aid, eid)| (aid.to_string(), eid.to_string()))
                .collect(),
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: Mutex::new(activities),
        });
        let activity_events_repo: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait> =
            Arc::new(MockActivityEventsRepo { tags: tags.clone() });
        let types_repo = Arc::new(MockTypesRepo::default());
        let svc = EventsService::new(
            types_repo.clone() as Arc<dyn EventTypesRepositoryTrait>,
            events_repo.clone() as Arc<dyn EventsRepositoryTrait>,
            activity_repo.clone() as Arc<dyn ActivityRepositoryTrait>,
            activity_events_repo,
        );
        (svc, events_repo, activity_repo, types_repo, tags)
    }

    fn ymd(y: i32, m: u32, d: u32) -> String {
        format!("{y:04}-{m:02}-{d:02}")
    }

    fn ev(id: &str, start: &str, end: &str) -> Event {
        Event {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            event_type_id: "type1".to_string(),
            start_date: start.to_string(),
            end_date: end.to_string(),
            created_at: now(),
            updated_at: now(),
        }
    }

    // --------------- Tests ---------------

    #[tokio::test]
    async fn create_event_rejects_inverted_range() {
        let (svc, _, _, _, _) = make_service(vec![], vec![], vec![]);
        let err = svc
            .create_event(NewEvent {
                id: None,
                name: "x".to_string(),
                description: None,
                event_type_id: "t1".to_string(),
                start_date: ymd(2024, 6, 10),
                end_date: ymd(2024, 6, 1),
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Invalid date range"));
    }

    #[tokio::test]
    async fn update_event_rejects_inverted_range() {
        let (svc, _, _, _, _) = make_service(
            vec![ev("ev1", &ymd(2024, 6, 1), &ymd(2024, 6, 10))],
            vec![],
            vec![],
        );
        let patch = UpdateEvent {
            start_date: Some(ymd(2024, 6, 20)),
            ..Default::default()
        };
        let err = svc.update_event("ev1", patch).await.unwrap_err();
        assert!(err.to_string().contains("Invalid date range"));
    }

    #[tokio::test]
    async fn delete_type_rejects_when_in_use() {
        let (svc, _, _, types, _) = make_service(
            vec![Event {
                event_type_id: "type1".to_string(),
                ..ev("ev1", &ymd(2024, 6, 1), &ymd(2024, 6, 10))
            }],
            vec![],
            vec![],
        );
        let err = svc.delete_type("type1").await.unwrap_err();
        assert!(err.to_string().contains("in use"));
        assert!(types.deleted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_type_passes_through_when_unused() {
        let (svc, _, _, types, _) = make_service(vec![], vec![], vec![]);
        svc.delete_type("type1").await.unwrap();
        assert_eq!(types.deleted.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn shrinking_window_untags_out_of_range_activities() {
        let in1 = Utc.with_ymd_and_hms(2024, 6, 5, 12, 0, 0).unwrap();
        let in2 = Utc.with_ymd_and_hms(2024, 6, 7, 12, 0, 0).unwrap();
        let out = Utc.with_ymd_and_hms(2024, 6, 9, 12, 0, 0).unwrap();
        let (svc, _, _, _, tags) = make_service(
            vec![ev("ev1", &ymd(2024, 6, 1), &ymd(2024, 6, 10))],
            vec![
                mk_activity("a1", in1),
                mk_activity("a2", in2),
                mk_activity("a3", out),
            ],
            vec![("a1", "ev1"), ("a2", "ev1"), ("a3", "ev1")],
        );
        let patch = UpdateEvent {
            end_date: Some(ymd(2024, 6, 8)),
            ..Default::default()
        };
        svc.update_event("ev1", patch).await.unwrap();

        let tags = tags.lock().unwrap();
        assert_eq!(tags.get("a1"), Some(&"ev1".to_string()));
        assert_eq!(tags.get("a2"), Some(&"ev1".to_string()));
        assert_eq!(tags.get("a3"), None);
    }

    #[tokio::test]
    async fn date_only_end_date_keeps_same_day_activities() {
        let same_day = Utc.with_ymd_and_hms(2024, 6, 8, 14, 0, 0).unwrap();
        let next_day = Utc.with_ymd_and_hms(2024, 6, 9, 1, 0, 0).unwrap();
        let (svc, _, _, _, tags) = make_service(
            vec![ev("ev1", &ymd(2024, 6, 1), &ymd(2024, 6, 10))],
            vec![mk_activity("a1", same_day), mk_activity("a2", next_day)],
            vec![("a1", "ev1"), ("a2", "ev1")],
        );
        let patch = UpdateEvent {
            end_date: Some(ymd(2024, 6, 8)),
            ..Default::default()
        };
        svc.update_event("ev1", patch).await.unwrap();

        let tags = tags.lock().unwrap();
        assert_eq!(tags.get("a1"), Some(&"ev1".to_string()));
        assert_eq!(tags.get("a2"), None);
    }
}
