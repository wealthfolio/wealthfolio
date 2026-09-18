use crate::database::DatabaseRuntime;

use tauri::State;

use wealthfolio_core::portfolios::{NewPortfolio, PortfolioUpdate, PortfolioWithAccounts};

#[tauri::command]
pub async fn get_portfolios(
    state: State<'_, DatabaseRuntime>,
) -> Result<Vec<PortfolioWithAccounts>, String> {
    let context = state.context()?;
    context
        .portfolio_service()
        .list_portfolios()
        .map_err(|e| format!("Failed to load portfolios: {}", e))
}

#[tauri::command]
pub async fn get_portfolio(
    portfolio_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<PortfolioWithAccounts, String> {
    let context = state.context()?;
    context
        .portfolio_service()
        .get_portfolio(&portfolio_id)
        .map_err(|e| format!("Failed to load portfolio: {}", e))
}

#[tauri::command]
pub async fn create_portfolio(
    portfolio: NewPortfolio,
    state: State<'_, DatabaseRuntime>,
) -> Result<PortfolioWithAccounts, String> {
    let context = state.context()?;
    context
        .portfolio_service()
        .create_portfolio(portfolio)
        .await
        .map_err(|e| format!("Failed to create portfolio: {}", e))
}

#[tauri::command]
pub async fn update_portfolio_entry(
    portfolio: PortfolioUpdate,
    state: State<'_, DatabaseRuntime>,
) -> Result<PortfolioWithAccounts, String> {
    let context = state.context()?;
    context
        .portfolio_service()
        .update_portfolio(portfolio)
        .await
        .map_err(|e| format!("Failed to update portfolio: {}", e))
}

#[tauri::command]
pub async fn delete_portfolio_entry(
    portfolio_id: String,
    state: State<'_, DatabaseRuntime>,
) -> Result<(), String> {
    let context = state.context()?;
    context
        .portfolio_service()
        .delete_portfolio(&portfolio_id)
        .await
        .map_err(|e| format!("Failed to delete portfolio: {}", e))
}
