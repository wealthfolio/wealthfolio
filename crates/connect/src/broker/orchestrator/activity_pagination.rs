use chrono::{NaiveDate, Utc};
use log::{debug, info};

use super::super::progress::{SyncProgressPayload, SyncProgressReporter, SyncStatus};
use super::super::traits::BrokerApiClient;
use super::super::traits::BrokerTrackingMode;
use super::{ActivityQueryWindow, ActivitySyncOutcome, SyncOrchestrator};

impl<P: SyncProgressReporter> SyncOrchestrator<P> {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn sync_account_activities(
        &self,
        api_client: &dyn BrokerApiClient,
        account_id: &str,
        account_name: &str,
        broker_account_id: &str,
        tracking_mode: BrokerTrackingMode,
        account_context: &super::super::traits::BrokerAccountContext,
        start_date: Option<&str>,
        end_date: Option<&str>,
        import_run_id: Option<String>,
    ) -> Result<ActivitySyncOutcome, String> {
        let mut offset: i64 = 0;
        let limit = self.config.page_limit;
        let mut pages_fetched: usize = 0;
        let mut last_page_first_id: Option<String> = None;
        let mut inconsistent_empty_page = false;

        let mut total_fetched: u32 = 0;
        let mut total_inserted: u32 = 0;
        let mut total_assets_created: u32 = 0;
        let mut total_needs_review: u32 = 0;
        let mut all_new_asset_ids: Vec<String> = Vec::new();

        loop {
            if pages_fetched >= self.config.max_pages {
                return Err(format!(
                    "Pagination exceeded max pages ({}). Aborting.",
                    self.config.max_pages
                ));
            }

            let page = api_client
                .get_account_activities_with_context(
                    broker_account_id,
                    tracking_mode,
                    account_context,
                    start_date,
                    end_date,
                    Some(offset),
                    Some(limit),
                )
                .await
                .map_err(|e| e.to_string())?;

            let data = page.data;
            pages_fetched += 1;
            total_fetched += data.len() as u32;

            let page_total = page.pagination.as_ref().and_then(|p| p.total);

            self.progress_reporter.report_progress(
                SyncProgressPayload::new(account_id, account_name, SyncStatus::Syncing)
                    .with_page(pages_fetched)
                    .with_activities_fetched(total_fetched as usize)
                    .with_message(format!(
                        "Fetched {} activities (total: {:?})",
                        total_fetched, page_total
                    )),
            );

            info!(
                "Fetched {} activities for '{}' (offset {}, total {:?})",
                data.len(),
                account_name,
                offset,
                page_total
            );

            if !data.is_empty() {
                if let Some(first_id) = data.first().and_then(|a| a.id.clone()) {
                    if offset > 0 {
                        if let Some(prev) = &last_page_first_id {
                            if prev == &first_id {
                                return Err(
                                    "Pagination appears stuck (same first activity id returned for multiple pages)."
                                        .to_string(),
                                );
                            }
                        }
                    }
                    last_page_first_id = Some(first_id);
                }

                debug!(
                    "Upserting {} activities for account '{}'...",
                    data.len(),
                    account_name
                );

                let (upserted, assets, new_asset_ids, needs_review) = self
                    .sync_service
                    .upsert_account_activities(
                        account_id.to_string(),
                        import_run_id.clone(),
                        data.clone(),
                    )
                    .await
                    .map_err(|e| format!("Failed to upsert activities: {}", e))?;

                info!(
                    "Upserted {} activities, {} assets for '{}' ({} need review)",
                    upserted, assets, account_name, needs_review
                );

                total_inserted += upserted as u32;
                total_assets_created += assets as u32;
                total_needs_review += needs_review as u32;
                all_new_asset_ids.extend(new_asset_ids);
            }

            let received = data.len() as i64;
            let next_offset = offset + received;

            if received == 0 {
                inconsistent_empty_page = page.pagination.as_ref().is_some_and(|p| {
                    p.has_more == Some(true) || p.total.is_some_and(|total| offset < total)
                });
                break;
            }

            let has_more = match page.pagination.as_ref() {
                Some(p) => match p.has_more {
                    Some(true) => true,
                    Some(false) => false,
                    None => {
                        if let Some(total) = p.total {
                            next_offset < total
                        } else if let Some(page_limit) = p.limit {
                            received >= page_limit
                        } else {
                            received >= limit
                        }
                    }
                },
                None => received >= limit,
            };

            offset = next_offset;

            if !has_more {
                break;
            }
        }

        Ok(ActivitySyncOutcome {
            fetched: total_fetched,
            inserted: total_inserted,
            assets_created: total_assets_created,
            needs_review: total_needs_review,
            new_asset_ids: all_new_asset_ids,
            inconsistent_empty_page,
        })
    }

    pub(super) fn compute_activity_query_window(
        &self,
        account_id: &str,
        provider_waterline: NaiveDate,
    ) -> Result<ActivityQueryWindow, String> {
        let today = Utc::now().date_naive();
        let end_date = provider_waterline.min(today);
        let sync_state = self
            .sync_service
            .get_activity_sync_state(account_id)
            .map_err(|e| format!("Failed to read activity sync state: {}", e))?;

        let local_cursor = sync_state.and_then(|s| s.last_successful_at);
        let has_local_cursor = local_cursor.is_some();
        let start_date = local_cursor
            .map(|dt| dt.date_naive())
            .map(|d| (d - chrono::Days::new(1)).min(end_date))
            .map(|d| d.format("%Y-%m-%d").to_string());

        Ok(ActivityQueryWindow {
            start_date,
            end_date: end_date.format("%Y-%m-%d").to_string(),
            has_local_cursor,
        })
    }
}
