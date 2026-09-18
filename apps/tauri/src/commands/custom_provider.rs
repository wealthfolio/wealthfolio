use crate::database::DatabaseRuntime;
use tauri::State;
use wealthfolio_core::custom_provider::{
    CustomProviderWithSources, NewCustomProvider, TestSourceRequest, TestSourceResult,
    UpdateCustomProvider,
};

use super::error::CommandResult;

#[tauri::command]
pub async fn get_custom_providers(
    context: State<'_, DatabaseRuntime>,
) -> CommandResult<Vec<CustomProviderWithSources>> {
    let context = context.context()?;
    Ok(context.custom_provider_service.get_all()?)
}

#[tauri::command]
pub async fn create_custom_provider(
    context: State<'_, DatabaseRuntime>,
    payload: NewCustomProvider,
) -> CommandResult<CustomProviderWithSources> {
    let context = context.context()?;
    Ok(context.custom_provider_service.create(payload).await?)
}

#[tauri::command]
pub async fn update_custom_provider(
    context: State<'_, DatabaseRuntime>,
    provider_id: String,
    payload: UpdateCustomProvider,
) -> CommandResult<CustomProviderWithSources> {
    let context = context.context()?;
    Ok(context
        .custom_provider_service
        .update(&provider_id, payload)
        .await?)
}

#[tauri::command]
pub async fn delete_custom_provider(
    context: State<'_, DatabaseRuntime>,
    provider_id: String,
) -> CommandResult<()> {
    let context = context.context()?;
    Ok(context.custom_provider_service.delete(&provider_id).await?)
}

#[tauri::command]
pub async fn test_custom_provider_source(
    context: State<'_, DatabaseRuntime>,
    payload: TestSourceRequest,
) -> CommandResult<TestSourceResult> {
    let context = context.context()?;
    Ok(context.custom_provider_service.test_source(payload).await?)
}
