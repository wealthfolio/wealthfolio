use std::collections::HashMap;
use std::sync::Arc;

use crate::context::ServiceContext;
use log::debug;
use tauri::State;
use wealthfolio_core::activities::{
    Activity, ActivityBulkMutationRequest, ActivityBulkMutationResult, ActivityImport,
    ActivitySearchResponse, ActivityUpdate, ImportActivitiesResult, ImportAssetCandidate,
    ImportAssetPreviewItem, ImportMappingData, ImportTemplateData, InternalTransferPairRequest,
    InternalTransferPairResponse, NewActivity, ParseConfig, ParsedCsvResult, Sort,
    TransferMatchCandidate, TransferMatchCandidateRequest,
};
use wealthfolio_core::health::HealthServiceTrait;
use wealthfolio_core::utils::time_utils::{
    local_date_range_utc_bounds, parse_user_timezone_or_default,
};

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn search_activities(
    page: i64,                                 // Page number, 0-based
    page_size: i64,                            // Number of items per page
    account_id_filter: Option<Vec<String>>,    // Optional account_id filter
    activity_type_filter: Option<Vec<String>>, // Optional activity_type filter
    asset_id_keyword: Option<String>,          // Optional asset_id keyword for search
    sort: Option<Sort>,
    needs_review_filter: Option<bool>, // Optional needs_review filter for pending review
    date_from: Option<String>,         // Optional start date filter (YYYY-MM-DD, inclusive)
    date_to: Option<String>,           // Optional end date filter (YYYY-MM-DD, inclusive)
    instrument_type_filter: Option<Vec<String>>, // Optional instrument_type filter
    activity_id_filter: Option<Vec<String>>, // Optional exact activity-id filter
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ActivitySearchResponse, String> {
    debug!("Search activities... {}, {}", page, page_size);

    // Parse date strings to NaiveDate
    let date_from_parsed = date_from
        .map(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid date_from format: {}", e))?;
    let date_to_parsed = date_to
        .map(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d"))
        .transpose()
        .map_err(|e| format!("Invalid date_to format: {}", e))?;
    let timezone = state.get_timezone();
    let tz = parse_user_timezone_or_default(&timezone);
    let (date_from_utc, date_to_utc_exclusive) =
        local_date_range_utc_bounds(date_from_parsed, date_to_parsed, tz)
            .map_err(|e| e.to_string())?;

    Ok(state.activity_service().search_activities_in_utc_range(
        page,
        page_size,
        account_id_filter,
        activity_type_filter,
        asset_id_keyword,
        sort,
        needs_review_filter,
        date_from_utc,
        date_to_utc_exclusive,
        instrument_type_filter,
        activity_id_filter,
    )?)
}

#[tauri::command]
pub async fn create_activity(
    activity: NewActivity,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Activity, String> {
    debug!("Creating activity...");
    // Domain events handle recalculation and asset enrichment automatically
    let created = state
        .activity_service()
        .create_activity(activity)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(created)
}

#[tauri::command]
pub async fn update_activity(
    activity: ActivityUpdate,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Activity, String> {
    debug!("Updating activity...");
    // Domain events handle recalculation and asset enrichment automatically
    let updated = state
        .activity_service()
        .update_activity(activity)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_activity(
    activity_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Activity, String> {
    debug!("Deleting activity...");
    // Domain events handle recalculation automatically
    let deleted = state
        .activity_service()
        .delete_activity(activity_id)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(deleted)
}

#[tauri::command]
pub async fn get_transfer_pair_for_activity(
    activity_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<InternalTransferPairResponse, String> {
    debug!("Getting transfer pair...");
    state
        .activity_service()
        .get_transfer_pair_for_activity(activity_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn find_transfer_match_candidates(
    request: TransferMatchCandidateRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<TransferMatchCandidate>, String> {
    debug!("Finding transfer match candidates...");
    state
        .activity_service()
        .find_transfer_match_candidates(request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_internal_transfer_pair(
    request: InternalTransferPairRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<InternalTransferPairResponse, String> {
    debug!("Saving internal transfer pair...");
    let pair = state
        .activity_service()
        .save_internal_transfer_pair(request)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(pair)
}

#[tauri::command]
pub async fn link_transfer_activities(
    activity_a_id: String,
    activity_b_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(Activity, Activity), String> {
    debug!("Linking transfer activities...");
    // Domain events handle recalculation automatically
    let pair = state
        .activity_service()
        .link_transfer_activities(activity_a_id, activity_b_id)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(pair)
}

#[tauri::command]
pub async fn unlink_transfer_activities(
    activity_a_id: String,
    activity_b_id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(Activity, Activity), String> {
    debug!("Unlinking transfer activities...");
    // Domain events handle recalculation automatically
    let pair = state
        .activity_service()
        .unlink_transfer_activities(activity_a_id, activity_b_id)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(pair)
}

#[tauri::command]
pub async fn save_activities(
    request: ActivityBulkMutationRequest,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ActivityBulkMutationResult, String> {
    let create_count = request.creates.len();
    let update_count = request.updates.len();
    let delete_count = request.delete_ids.len();
    debug!(
        "Bulk activity mutation request: {} creates, {} updates, {} deletes",
        create_count, update_count, delete_count
    );

    // Domain events handle recalculation and asset enrichment automatically
    let result = state
        .activity_service()
        .bulk_mutate_activities(request)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(result)
}

#[tauri::command]
pub async fn get_account_import_mapping(
    account_id: String,
    context_kind: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ImportMappingData, String> {
    debug!("Getting import mapping for account: {}", account_id);
    Ok(state
        .activity_service()
        .get_import_mapping(account_id, context_kind)?)
}

#[tauri::command]
pub async fn save_account_import_mapping(
    mapping: ImportMappingData,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ImportMappingData, String> {
    debug!("Saving import mapping for account: {}", mapping.account_id);
    state
        .activity_service()
        .save_import_mapping(mapping)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn link_account_template(
    account_id: String,
    template_id: String,
    context_kind: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    debug!("Linking account {} to template {}", account_id, template_id);
    state
        .activity_service()
        .link_account_template(account_id, template_id, context_kind)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_import_templates(
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ImportTemplateData>, String> {
    Ok(state.activity_service().list_import_templates()?)
}

#[tauri::command]
pub async fn get_import_template(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ImportTemplateData, String> {
    Ok(state.activity_service().get_import_template(id)?)
}

#[tauri::command]
pub async fn save_import_template(
    template: ImportTemplateData,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ImportTemplateData, String> {
    state
        .activity_service()
        .save_import_template(template)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_import_template(
    id: String,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<(), String> {
    state
        .activity_service()
        .delete_import_template(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_activities_import(
    activities: Vec<ActivityImport>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ActivityImport>, String> {
    debug!("Checking activities import for {} rows", activities.len());
    let result = state
        .activity_service()
        .check_activities_import(activities)
        .await?;
    Ok(result)
}

#[tauri::command]
pub async fn preview_import_assets(
    candidates: Vec<ImportAssetCandidate>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<Vec<ImportAssetPreviewItem>, String> {
    let result = state
        .activity_service()
        .preview_import_assets(candidates)
        .await?;
    Ok(result)
}

#[tauri::command]
pub async fn import_activities(
    activities: Vec<ActivityImport>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ImportActivitiesResult, String> {
    debug!("Importing {} activities", activities.len());
    // Domain events handle recalculation and asset enrichment automatically
    let result = state
        .activity_service()
        .import_activities(activities)
        .await
        .map_err(|e| e.to_string())?;
    state.health_service().clear_cache().await;
    Ok(result)
}

#[tauri::command]
pub async fn check_existing_duplicates(
    idempotency_keys: Vec<String>,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<HashMap<String, String>, String> {
    debug!(
        "Checking for existing duplicates with {} idempotency keys",
        idempotency_keys.len()
    );
    state
        .activity_service()
        .check_existing_duplicates(idempotency_keys)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn parse_csv(
    content: Vec<u8>,
    config: ParseConfig,
    state: State<'_, Arc<ServiceContext>>,
) -> Result<ParsedCsvResult, String> {
    debug!(
        "Parsing CSV with {} bytes, config: {:?}",
        content.len(),
        config
    );
    state
        .activity_service()
        .parse_csv(&content, &config)
        .map_err(|e| {
            debug!("CSV parse error: {}", e);
            e.to_string()
        })
}
