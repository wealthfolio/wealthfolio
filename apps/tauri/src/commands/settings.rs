use crate::profiles::ProfileAccess;

use crate::events::{emit_portfolio_trigger_recalculate, PortfolioRequestPayload};
use log::debug;
use tauri::AppHandle;
use wealthfolio_core::fx::{
    ExchangeRate, ExchangeRateDateBatchRequest, ExchangeRateDateResult, NewExchangeRate,
};
use wealthfolio_core::health::HealthServiceTrait;
use wealthfolio_core::quotes::{MarketSyncMode, DATA_SOURCE_MANUAL};
use wealthfolio_core::settings::{Settings, SettingsUpdate};

fn recalculate_mode_for_settings_change(
    base_currency_changed: bool,
    timezone_changed: bool,
) -> Option<MarketSyncMode> {
    if base_currency_changed {
        Some(MarketSyncMode::BackfillHistory {
            asset_ids: None,
            days: wealthfolio_core::quotes::DEFAULT_HISTORY_DAYS,
        })
    } else if timezone_changed {
        Some(MarketSyncMode::None)
    } else {
        None
    }
}

#[tauri::command]
pub async fn get_settings(state: ProfileAccess) -> Result<Settings, String> {
    let context = state.context()?;
    debug!("Fetching active settings...");
    context
        .settings_service()
        .get_settings()
        .map_err(|e| format!("Failed to load settings: {}", e))
}

#[tauri::command]
pub async fn is_auto_update_check_enabled(state: ProfileAccess) -> Result<bool, String> {
    let context = state.context()?;
    debug!("Checking if auto-update check is enabled...");
    context
        .settings_service()
        .is_auto_update_check_enabled()
        .map_err(|e| format!("Failed to check auto-update setting: {}", e))
}

#[tauri::command]
pub async fn update_settings(
    settings_update: SettingsUpdate,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<Settings, String> {
    // Only sync settings participate in Connect account replacement.
    let _connect = settings_update
        .sync_enabled
        .map(|_| state.connect_guard())
        .transpose()?;
    let context = state.context()?;
    debug!("Updating settings...");
    let service = context.settings_service();
    let previous_base_currency = context.get_base_currency();
    let previous_timezone = context.get_timezone();

    // Update settings in the database (this applies all changes in settings_update)
    service
        .update_settings(&settings_update)
        .await
        .map_err(|e| format!("Failed to update settings: {}", e))?;
    let updated_settings = service
        .get_settings()
        .map_err(|e| format!("Failed to load updated settings after change: {}", e))?;

    let base_currency_changed = updated_settings.base_currency != previous_base_currency;
    let timezone_changed = updated_settings.timezone != previous_timezone;

    if let Some(menu_visible) = settings_update.menu_bar_visible {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            if menu_visible {
                // Create and set the menu on desktop platforms
                match crate::menu::create_menu(&handle) {
                    Ok(menu) => {
                        if let Err(e) = handle.set_menu(menu) {
                            debug!("Failed to set menu: {}", e);
                        }
                    }
                    Err(e) => {
                        debug!("Failed to create menu: {}", e);
                    }
                }
            } else {
                // Remove the menu entirely by setting it to None
                if let Err(e) = handle.remove_menu() {
                    debug!("Failed to remove menu: {}", e);
                }
            }
        }

        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = menu_visible;
            debug!("Menu bar visibility toggling is not supported on mobile runtimes.");
        }
    }

    // If the base currency was changed, update the state and emit the event
    if base_currency_changed {
        debug!(
            "Base currency changed from {} to {}, updating state.",
            previous_base_currency, updated_settings.base_currency
        );
        context.update_base_currency(updated_settings.base_currency.clone());
    }

    if timezone_changed {
        debug!(
            "Timezone changed from {} to {}, updating state.",
            previous_timezone, updated_settings.timezone
        );
        context.update_timezone(updated_settings.timezone.clone());
        context.health_service().clear_cache().await;
    }

    if let Some(market_sync_mode) =
        recalculate_mode_for_settings_change(base_currency_changed, timezone_changed)
    {
        let payload = PortfolioRequestPayload::builder()
            .account_ids(None)
            .market_sync_mode(market_sync_mode)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    }

    Ok(updated_settings)
}

#[tauri::command]
pub async fn update_exchange_rate(
    rate: ExchangeRate,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<ExchangeRate, String> {
    let context = state.context()?;
    debug!("Updating exchange rate...");
    let result = context
        .fx_service()
        .update_exchange_rate(&rate.from_currency, &rate.to_currency, rate.rate)
        .await
        .map_err(|e| format!("Failed to update exchange rate: {}", e))?;

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        // Emit event to trigger portfolio recalculation only - no market sync needed
        // for manual exchange rate updates
        let payload = PortfolioRequestPayload::builder()
            .market_sync_mode(MarketSyncMode::None)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    });
    Ok(result)
}

#[tauri::command]
pub async fn get_latest_exchange_rates(state: ProfileAccess) -> Result<Vec<ExchangeRate>, String> {
    let context = state.context()?;
    debug!("Fetching exchange rates...");
    context
        .fx_service()
        .get_latest_exchange_rates()
        .map_err(|e| format!("Failed to load exchange rates: {}", e))
}

#[tauri::command]
pub async fn get_exchange_rates_for_dates(
    request: ExchangeRateDateBatchRequest,
    state: ProfileAccess,
) -> Result<Vec<ExchangeRateDateResult>, String> {
    let context = state.context()?;
    debug!("Fetching historical exchange rates for dates...");
    Ok(context
        .fx_service()
        .get_exchange_rates_for_dates(request.pairs))
}

#[tauri::command]
pub async fn add_exchange_rate(
    new_rate: NewExchangeRate,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<ExchangeRate, String> {
    let context = state.context()?;
    debug!("Adding new exchange rate...");
    let result = context
        .fx_service()
        .add_exchange_rate(new_rate)
        .await
        .map_err(|e| format!("Failed to add exchange rate: {}", e))?;

    // Manual rates are saved as-is and need no market sync. Provider-backed
    // pairs store no quote on add (#1143); sync their real rate now so the pair
    // populates immediately instead of waiting for the next periodic sync.
    let market_sync_mode = if result.source == DATA_SOURCE_MANUAL {
        MarketSyncMode::None
    } else {
        MarketSyncMode::Incremental {
            asset_ids: Some(vec![result.id.clone()]),
        }
    };

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let payload = PortfolioRequestPayload::builder()
            .market_sync_mode(market_sync_mode)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    });
    Ok(result)
}

#[tauri::command]
pub async fn delete_exchange_rate(
    rate_id: String,
    state: ProfileAccess,
    handle: AppHandle,
) -> Result<(), String> {
    let context = state.context()?;
    debug!("Deleting exchange rate...");
    context
        .fx_service()
        .delete_exchange_rate(&rate_id)
        .await
        .map_err(|e| format!("Failed to delete exchange rate: {}", e))?;

    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        // Emit event to trigger portfolio recalculation only - no market sync needed
        // for manual exchange rate deletions
        let payload = PortfolioRequestPayload::builder()
            .market_sync_mode(MarketSyncMode::None)
            .build();
        emit_portfolio_trigger_recalculate(&handle, payload, &context);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recalculate_mode_none_when_nothing_changed() {
        assert_eq!(recalculate_mode_for_settings_change(false, false), None);
    }

    #[test]
    fn recalculate_mode_none_for_timezone_only_change() {
        assert_eq!(
            recalculate_mode_for_settings_change(false, true),
            Some(MarketSyncMode::None)
        );
    }

    #[test]
    fn recalculate_mode_backfill_for_base_currency_only_change() {
        assert_eq!(
            recalculate_mode_for_settings_change(true, false),
            Some(MarketSyncMode::BackfillHistory {
                asset_ids: None,
                days: wealthfolio_core::quotes::DEFAULT_HISTORY_DAYS,
            })
        );
    }

    #[test]
    fn recalculate_mode_prefers_base_currency_when_both_changed() {
        assert_eq!(
            recalculate_mode_for_settings_change(true, true),
            Some(MarketSyncMode::BackfillHistory {
                asset_ids: None,
                days: wealthfolio_core::quotes::DEFAULT_HISTORY_DAYS,
            })
        );
    }
}
