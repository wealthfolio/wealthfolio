// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod context;
mod domain_events;
mod events;
mod listeners;
mod mcp;
mod scheduler;
mod secret_store;
mod services;

#[cfg(desktop)]
mod menu;
#[cfg(desktop)]
mod updater;

use std::sync::Arc;

use dotenvy::dotenv;
use log::error;
#[cfg(feature = "device-sync")]
use log::warn;
use tauri::{AppHandle, Emitter, Manager};

use events::{emit_app_ready, emit_portfolio_trigger_recalculate, PortfolioRequestPayload};
use tauri_plugin_deep_link::DeepLinkExt;

fn portfolio_history_backfill_needed(context: &Arc<context::ServiceContext>) -> bool {
    let accounts = match context.account_service().get_non_archived_accounts() {
        Ok(accounts) => accounts,
        Err(err) => {
            error!("Failed to inspect accounts for valuation backfill: {}", err);
            return false;
        }
    };
    let account_ids: Vec<String> = accounts.into_iter().map(|account| account.id).collect();
    if account_ids.is_empty() {
        return false;
    }

    let latest = match context
        .valuation_service()
        .get_latest_valuations(&account_ids)
    {
        Ok(latest) => latest,
        Err(err) => {
            error!("Failed to inspect valuation history for backfill: {}", err);
            return false;
        }
    };
    let accounts_with_valuations: std::collections::HashSet<_> = latest
        .into_iter()
        .map(|valuation| valuation.account_id)
        .collect();
    let missing_ids: Vec<String> = account_ids
        .into_iter()
        .filter(|account_id| !accounts_with_valuations.contains(account_id))
        .collect();
    if missing_ids.is_empty() {
        return false;
    }

    if matches!(
        context
            .activity_service()
            .get_first_activity_date(Some(&missing_ids)),
        Ok(Some(_))
    ) {
        return true;
    }

    missing_ids.iter().any(|account_id| {
        matches!(
            context
                .snapshot_service()
                .get_latest_holdings_snapshot(account_id),
            Ok(Some(_))
        )
    })
}

#[cfg(feature = "device-sync")]
fn start_sync_outbox_wake_worker(
    mut receiver: tokio::sync::mpsc::Receiver<()>,
    context: Arc<context::ServiceContext>,
) {
    tauri::async_runtime::spawn(async move {
        while receiver.recv().await.is_some() {
            while receiver.try_recv().is_ok() {}
            let was_running = context.device_sync_runtime().is_background_running().await;
            if let Err(err) =
                crate::commands::device_sync::ensure_background_engine_started(Arc::clone(&context))
                    .await
            {
                warn!(
                    "Failed to start background device sync engine after local outbox write: {}",
                    err
                );
                continue;
            }
            if was_running {
                context.device_sync_runtime().notify_sync_work_available();
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop-only setup
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(desktop)]
mod desktop {
    use super::*;

    /// Sets up the application menu and its event handler.
    pub fn setup_menu(handle: &AppHandle) {
        match menu::create_menu(handle) {
            Ok(menu) => {
                if let Err(e) = handle.set_menu(menu) {
                    error!("Failed to set menu: {}", e);
                }
            }
            Err(e) => {
                error!("Failed to create menu: {}", e);
            }
        }

        handle.on_menu_event(move |app, event| {
            menu::handle_menu_event(app, event.id().as_ref());
        });
    }

    /// Initializes desktop-specific plugins.
    pub fn init_plugins(handle: &AppHandle) {
        let _ = handle.plugin(tauri_plugin_updater::Builder::new().build());
    }

    /// Performs synchronous setup on desktop: initializes context, menu, and registers listeners.
    pub fn setup(handle: AppHandle, app_data_dir: &str) -> Result<(), Box<dyn std::error::Error>> {
        // Initialize context synchronously (required before any commands can work)
        let init_result = tauri::async_runtime::block_on(async {
            context::initialize_context(app_data_dir).await
        })?;
        let context = Arc::new(init_result.context);
        let event_receiver = init_result.event_receiver;
        let sync_outbox_wake_receiver = init_result.sync_outbox_wake_receiver;

        // Make context available to all commands
        handle.manage(Arc::clone(&context));

        // Embedded MCP server: clear any stale lock file from an unclean
        // shutdown, then auto-start when enabled + auto-start are both set.
        mcp::remove_stale_lock(&handle);
        {
            let mcp_handle = handle.clone();
            let mcp_context = Arc::clone(&context);
            tauri::async_runtime::spawn(async move {
                mcp::start_if_enabled(&mcp_handle, &mcp_context).await;
            });
        }

        #[cfg(feature = "device-sync")]
        start_sync_outbox_wake_worker(sync_outbox_wake_receiver, Arc::clone(&context));

        // Start the domain event queue worker now that context is managed
        // This must be done in an async context since it spawns a tokio task
        let worker_handle = handle.clone();
        let worker_context = Arc::clone(&context);
        tauri::async_runtime::spawn(async move {
            domain_events::TauriDomainEventSink::start_queue_worker(
                event_receiver,
                worker_handle,
                worker_context,
            );
        });

        // Menu setup is synchronous (no I/O)
        setup_menu(&handle);

        // Notify frontend that app is ready
        // The frontend will trigger the initial portfolio update and update check after it's mounted
        emit_app_ready(&handle);

        if portfolio_history_backfill_needed(&context) {
            emit_portfolio_trigger_recalculate(&handle, PortfolioRequestPayload::builder().build());
        }

        // Trigger startup sync (async, non-blocking)
        // After this, user manually triggers sync via button
        let startup_handle = handle.clone();
        let startup_context = Arc::clone(&context);
        tauri::async_runtime::spawn(async move {
            scheduler::run_startup_sync(&startup_handle, &startup_context).await;
        });

        // Start periodic market data sync (6h interval, 2min initial delay)
        let periodic_quote_service = Arc::clone(&context.quote_service);
        tauri::async_runtime::spawn(async move {
            wealthfolio_core::quotes::scheduler::run_periodic_sync(
                periodic_quote_service,
                std::time::Duration::from_secs(120),
                std::time::Duration::from_secs(6 * 3600),
            )
            .await;
        });

        // Start background device sync engine (self-skips when device is not READY).
        #[cfg(feature = "device-sync")]
        {
            let device_sync_context = Arc::clone(&context);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = crate::commands::device_sync::ensure_background_engine_started(
                    device_sync_context,
                )
                .await
                {
                    log::warn!("Failed to start background device sync engine: {}", err);
                }
            });
        }

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile-only setup
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(mobile)]
mod mobile {
    use super::*;

    /// Initializes mobile-specific plugins.
    pub fn init_plugins(handle: &AppHandle) {
        let _ = handle.plugin(tauri_plugin_haptics::init());
        let _ = handle.plugin(tauri_plugin_barcode_scanner::init());

        // iOS-specific: Web Auth plugin for ASWebAuthenticationSession (required for Google OAuth)
        #[cfg(target_os = "ios")]
        {
            let _ = handle.plugin(tauri_plugin_web_auth::init());
            let _ = handle.plugin(tauri_plugin_mobile_share::init());
        }
    }

    /// Performs async setup on mobile without blocking the main thread.
    pub fn setup(handle: AppHandle, app_data_dir: String) {
        tauri::async_runtime::spawn(async move {
            match context::initialize_context(&app_data_dir).await {
                Ok(init_result) => {
                    let context = Arc::new(init_result.context);
                    let event_receiver = init_result.event_receiver;
                    let sync_outbox_wake_receiver = init_result.sync_outbox_wake_receiver;

                    handle.manage(Arc::clone(&context));

                    #[cfg(feature = "device-sync")]
                    start_sync_outbox_wake_worker(sync_outbox_wake_receiver, Arc::clone(&context));

                    // Start the domain event queue worker now that context is managed
                    domain_events::TauriDomainEventSink::start_queue_worker(
                        event_receiver,
                        handle.clone(),
                        Arc::clone(&context),
                    );

                    // Notify frontend that app is ready
                    // The frontend will trigger the initial portfolio update after it's mounted
                    emit_app_ready(&handle);

                    if portfolio_history_backfill_needed(&context) {
                        emit_portfolio_trigger_recalculate(
                            &handle,
                            PortfolioRequestPayload::builder().build(),
                        );
                    }

                    // Trigger startup broker sync (async, non-blocking).
                    // After this, user manually triggers sync via button.
                    let startup_handle = handle.clone();
                    let startup_context = Arc::clone(&context);
                    tauri::async_runtime::spawn(async move {
                        scheduler::run_startup_sync(&startup_handle, &startup_context).await;
                    });

                    // Start background device sync while the mobile app is active.
                    // The loop self-skips when identity is not configured, and frontend lifecycle
                    // triggers still cover resume/online cases after iOS suspends the process.
                    #[cfg(feature = "device-sync")]
                    {
                        let device_sync_context = Arc::clone(&context);
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) =
                                crate::commands::device_sync::ensure_background_engine_started(
                                    device_sync_context,
                                )
                                .await
                            {
                                log::warn!(
                                    "Failed to start background device sync engine: {}",
                                    err
                                );
                            }
                        });
                    }
                }
                Err(e) => {
                    error!("Failed to initialize context on mobile: {}", e);
                    // Emit ready so UI can show error state
                    emit_app_ready(&handle);
                }
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Returns the app data directory path.
fn get_app_data_dir(handle: &AppHandle) -> Result<String, Box<dyn std::error::Error>> {
    Ok(handle.path().app_data_dir()?.to_string_lossy().into_owned())
}

// The main window is built here in code (rather than auto-created by Tauri)
// solely so we can attach `on_web_resource_request` and rewrite the
// Access-Control-Allow-Origin header — the only mechanism Tauri exposes for
// customizing asset-protocol response headers. This is REQUIRED for add-ons to
// load on WebKit webviews (iOS, and macOS/Linux release builds), where add-on
// assets are served over `tauri://` instead of the dev server. It is paired
// with `"create": false` on the "main" window in tauri.conf.json — if that flag
// is removed, Tauri auto-creates the window WITHOUT this handler and add-ons
// silently break on iOS while still working in `tauri dev`. Keep them together.
fn create_main_window<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("main window config is missing");

    tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
        .on_web_resource_request(|_request, response| {
            // The addon sandbox iframe (sandbox="allow-scripts") has an opaque
            // origin, so its module-script loads are CORS requests that Tauri's
            // reflected `Access-Control-Allow-Origin: tauri://localhost` can never
            // satisfy (and the mobile dev proxy appends a second ACAO header).
            // WKWebView does not reliably forward the `Origin` header to scheme
            // handlers, so reply `*` unconditionally: this protocol only serves
            // the public app bundle — IPC does not go through it.
            response.headers_mut().insert(
                "access-control-allow-origin",
                tauri::http::HeaderValue::from_static("*"),
            );
        })
        .build()?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Application entry point
// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenv().ok();

    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin registered (per Tauri docs).
    // With the "deep-link" feature, it automatically forwards deep link URLs
    // to the existing instance's on_open_url handler instead of spawning a new process.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // Focus the existing window when a second instance is attempted
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // Suppress verbose debug logs from the updater plugin
                .filter(|metadata| {
                    !metadata.target().starts_with("tauri_plugin_updater")
                        || metadata.level() <= log::Level::Info
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .setup(|app| {
            create_main_window(app)?;

            let handle = app.handle().clone();

            // Embedded MCP server state (commands need it managed up front)
            handle.manage(mcp::McpServerState::default());

            // Platform-specific plugin initialization
            #[cfg(desktop)]
            desktop::init_plugins(&handle);

            #[cfg(mobile)]
            mobile::init_plugins(&handle);

            // Get app data directory
            let app_data_dir = get_app_data_dir(&handle)?;

            // Setup event listeners (platform-agnostic)
            listeners::setup_event_listeners(handle.clone());

            // Setup deep link handler
            let deep_link_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                log::debug!("Deep link received (count: {})", urls.len());
                for url in urls {
                    let _ = deep_link_handle.emit("deep-link-received", url.to_string());
                }
            });

            // Platform-specific setup
            #[cfg(desktop)]
            desktop::setup(handle, &app_data_dir).map_err(|e| {
                error!("Desktop setup failed: {}", e);
                e
            })?;

            #[cfg(mobile)]
            mobile::setup(handle, app_data_dir);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Account commands
            commands::account::get_accounts,
            commands::account::create_account,
            commands::account::update_account,
            commands::account::delete_account,
            // Activity commands
            commands::activity::search_activities,
            commands::activity::create_activity,
            commands::activity::update_activity,
            commands::activity::save_activities,
            commands::activity::delete_activity,
            commands::activity::get_transfer_pair_for_activity,
            commands::activity::find_transfer_match_candidates,
            commands::activity::save_internal_transfer_pair,
            commands::activity::link_transfer_activities,
            commands::activity::unlink_transfer_activities,
            commands::activity::check_activities_import,
            commands::activity::preview_import_assets,
            commands::activity::import_activities,
            commands::activity::get_account_import_mapping,
            commands::activity::save_account_import_mapping,
            commands::activity::link_account_template,
            commands::activity::list_import_templates,
            commands::activity::get_import_template,
            commands::activity::save_import_template,
            commands::activity::delete_import_template,
            commands::activity::check_existing_duplicates,
            commands::activity::parse_csv,
            // Settings commands
            commands::settings::get_settings,
            commands::settings::is_auto_update_check_enabled,
            commands::settings::update_settings,
            commands::settings::get_latest_exchange_rates,
            commands::settings::update_exchange_rate,
            commands::settings::add_exchange_rate,
            commands::settings::delete_exchange_rate,
            // Spending commands
            commands::spending::get_spending_settings,
            commands::spending::update_spending_settings,
            commands::spending::list_cash_activities,
            commands::spending::search_cash_activities,
            commands::spending::set_activity_event,
            commands::spending::get_activity_assignments,
            commands::spending::assign_activity_category,
            commands::spending::unassign_activity_category,
            commands::spending::get_activity_splits,
            commands::spending::replace_activity_splits,
            commands::spending::clear_activity_splits,
            commands::spending::bulk_assign_categories,
            commands::spending::list_categorization_rules,
            commands::spending::create_categorization_rule,
            commands::spending::update_categorization_rule,
            commands::spending::delete_categorization_rule,
            commands::spending::rerun_categorization_rules,
            commands::spending::list_rule_presets,
            commands::spending::import_rule_preset,
            commands::spending::remove_rule_preset,
            commands::spending::list_event_types,
            commands::spending::create_event_type,
            commands::spending::update_event_type,
            commands::spending::delete_event_type,
            commands::spending::list_events,
            commands::spending::create_event,
            commands::spending::update_event,
            commands::spending::delete_event,
            commands::spending::get_budget,
            commands::spending::upsert_budget_target,
            commands::spending::delete_budget_target,
            commands::spending::upsert_budget_rollover_setting,
            commands::spending::delete_budget_rollover_setting,
            commands::spending::create_budget_group,
            commands::spending::update_budget_group,
            commands::spending::delete_budget_group,
            commands::spending::assign_category_to_group,
            commands::spending::reset_budget_groups,
            commands::spending::copy_budget_targets,
            commands::spending::get_spending_report,
            commands::spending::get_spending_insight,
            commands::spending::get_event_spending_summaries,
            // Goal commands
            commands::goal::create_goal,
            commands::goal::update_goal,
            commands::goal::delete_goal,
            commands::goal::get_goals,
            commands::goal::get_goal,
            commands::goal::get_goal_funding,
            commands::goal::save_goal_funding,
            commands::goal::get_goal_plan,
            commands::goal::save_goal_plan,
            commands::goal::delete_goal_plan,
            commands::goal::refresh_all_goal_summaries,
            commands::goal::refresh_goal_summary,
            commands::goal::get_retirement_overview,
            commands::goal::get_save_up_overview,
            commands::goal::preview_save_up_overview,
            // Portfolios (saved reporting scopes)
            commands::portfolios::get_portfolios,
            commands::portfolios::get_portfolio,
            commands::portfolios::create_portfolio,
            commands::portfolios::update_portfolio_entry,
            commands::portfolios::delete_portfolio_entry,
            // Portfolio commands
            commands::portfolio::get_holdings,
            commands::portfolio::get_holdings_list,
            commands::portfolio::get_holding,
            commands::portfolio::get_asset_holdings,
            commands::portfolio::get_asset_lots,
            commands::portfolio::get_portfolio_allocations,
            commands::portfolio::get_holdings_by_allocation,
            commands::portfolio::get_income_summary,
            commands::portfolio::get_historical_valuations,
            commands::portfolio::get_latest_valuations,
            commands::portfolio::get_current_valuation,
            commands::portfolio::calculate_accounts_simple_performance,
            commands::portfolio::update_portfolio,
            commands::portfolio::recalculate_portfolio,
            commands::portfolio::calculate_performance_summary,
            commands::portfolio::calculate_performance_history,
            commands::portfolio::get_performance_summaries,
            commands::portfolio::save_manual_holdings,
            commands::portfolio::import_holdings_csv,
            commands::portfolio::check_holdings_import,
            commands::portfolio::get_snapshots,
            commands::portfolio::get_snapshot_by_date,
            commands::portfolio::delete_snapshot,
            // Contribution limit commands
            commands::limits::get_contribution_limits,
            commands::limits::create_contribution_limit,
            commands::limits::update_contribution_limit,
            commands::limits::delete_contribution_limit,
            commands::limits::calculate_deposits_for_contribution_limit,
            // Utility commands
            commands::utilities::save_text_file_with_dialog,
            commands::utilities::save_file_with_dialog,
            commands::utilities::write_pending_export_text_file,
            commands::utilities::write_pending_export_file,
            commands::utilities::export_data_file,
            commands::utilities::open_external_url,
            commands::utilities::get_app_info,
            commands::utilities::check_for_updates,
            commands::utilities::install_app_update,
            commands::utilities::backup_database,
            commands::utilities::backup_database_to_pending_export,
            commands::utilities::backup_database_to_path,
            commands::utilities::restore_database,
            // Asset commands
            commands::asset::get_asset_profile,
            commands::asset::get_assets,
            commands::asset::update_asset_profile,
            commands::asset::update_quote_mode,
            commands::asset::delete_asset,
            commands::asset::create_asset,
            // Alternative asset commands
            commands::alternative_assets::create_alternative_asset,
            commands::alternative_assets::update_alternative_asset_valuation,
            commands::alternative_assets::update_alternative_asset_metadata,
            commands::alternative_assets::delete_alternative_asset,
            commands::alternative_assets::link_liability,
            commands::alternative_assets::unlink_liability,
            commands::alternative_assets::get_net_worth,
            commands::alternative_assets::get_net_worth_history,
            commands::alternative_assets::get_alternative_holdings,
            // Market data commands
            commands::market_data::search_symbol,
            commands::market_data::resolve_symbol_quote,
            commands::market_data::synch_quotes,
            commands::market_data::sync_market_data,
            commands::market_data::update_quote,
            commands::market_data::delete_quote,
            commands::market_data::get_quote_history,
            commands::market_data::get_latest_quotes,
            commands::market_data::get_market_data_providers,
            commands::market_data::check_quotes_import,
            commands::market_data::import_quotes_csv,
            commands::market_data::get_exchanges,
            commands::market_data::fetch_dividends,
            // Taxonomy commands
            commands::taxonomy::get_taxonomies,
            commands::taxonomy::get_taxonomy,
            commands::taxonomy::create_taxonomy,
            commands::taxonomy::update_taxonomy,
            commands::taxonomy::delete_taxonomy,
            commands::taxonomy::create_category,
            commands::taxonomy::update_category,
            commands::taxonomy::delete_category,
            commands::taxonomy::move_category,
            commands::taxonomy::import_taxonomy_json,
            commands::taxonomy::export_taxonomy_json,
            commands::taxonomy::get_asset_taxonomy_assignments,
            commands::taxonomy::assign_asset_to_category,
            commands::taxonomy::replace_asset_taxonomy_assignments,
            commands::taxonomy::remove_asset_taxonomy_assignment,
            // Taxonomy migration commands
            commands::taxonomy::get_migration_status,
            commands::taxonomy::migrate_legacy_classifications,
            // Platform commands
            commands::platform::get_platform,
            commands::platform::is_mobile,
            commands::platform::is_desktop,
            // Secrets commands
            commands::secrets::set_secret,
            commands::secrets::get_secret,
            commands::secrets::delete_secret,
            commands::secrets::set_addon_secret,
            commands::secrets::get_addon_secret,
            commands::secrets::delete_addon_secret,
            commands::addon_network::addon_network_request,
            // Provider settings commands
            commands::providers_settings::get_market_data_providers_settings,
            commands::providers_settings::update_market_data_provider_settings,
            // AI provider commands
            commands::ai_providers::get_ai_providers,
            commands::ai_providers::update_ai_provider_settings,
            commands::ai_providers::set_default_ai_provider,
            commands::ai_providers::list_ai_models,
            // AI chat commands
            commands::ai_chat::stream_ai_chat,
            commands::ai_chat::list_ai_threads,
            commands::ai_chat::get_ai_thread,
            commands::ai_chat::get_ai_thread_messages,
            commands::ai_chat::update_ai_thread,
            commands::ai_chat::delete_ai_thread,
            commands::ai_chat::add_ai_thread_tag,
            commands::ai_chat::remove_ai_thread_tag,
            commands::ai_chat::get_ai_thread_tags,
            commands::ai_chat::update_tool_result,
            // MCP server (Agent Access) commands
            commands::mcp::mcp_get_status,
            commands::mcp::mcp_set_enabled,
            commands::mcp::mcp_set_audit_enabled,
            commands::mcp::mcp_set_auto_start,
            commands::mcp::mcp_start,
            commands::mcp::mcp_stop,
            commands::mcp::mcp_list_audit_log,
            commands::mcp::mcp_purge_audit_log,
            commands::mcp::mcp_list_tokens,
            commands::mcp::mcp_create_token,
            commands::mcp::mcp_delete_token,
            // Addon commands
            commands::addon::extract_addon_zip,
            commands::addon::install_addon_zip,
            commands::addon::list_installed_addons,
            commands::addon::toggle_addon,
            commands::addon::uninstall_addon,
            commands::addon::load_addon_for_runtime,
            commands::addon::get_enabled_addons_on_startup,
            commands::addon::check_addon_update,
            commands::addon::check_all_addon_updates,
            commands::addon::update_addon_from_store_by_id,
            commands::addon::fetch_addon_store_listings,
            commands::addon::download_addon_to_staging,
            commands::addon::install_addon_from_staging,
            commands::addon::update_addon_network_approvals,
            commands::addon::clear_addon_staging,
            commands::addon::submit_addon_rating,
            commands::addon::get_addon_storage_item,
            commands::addon::set_addon_storage_item,
            commands::addon::delete_addon_storage_item,
            // Sync commands
            #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
            commands::wealthfolio_connect::store_sync_session,
            #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
            commands::wealthfolio_connect::post_login_bootstrap,
            #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
            commands::wealthfolio_connect::clear_sync_session,
            #[cfg(any(feature = "connect-sync", feature = "device-sync"))]
            commands::wealthfolio_connect::restore_sync_session,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::sync_broker_data,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::broker_ingest_run,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_synced_accounts,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_platforms,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::list_broker_connections,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::list_broker_accounts,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_subscription_plans,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_subscription_plans_public,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_user_info,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_broker_sync_states,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_broker_ingest_states,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_import_runs,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_data_import_runs,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::get_broker_sync_profile,
            #[cfg(feature = "connect-sync")]
            commands::brokers_sync::save_broker_sync_profile_rules,
            // Device sync commands
            #[cfg(feature = "device-sync")]
            commands::device_sync::enroll_device,
            #[cfg(feature = "device-sync")]
            commands::device_sync::get_device,
            #[cfg(feature = "device-sync")]
            commands::device_sync::list_devices,
            #[cfg(feature = "device-sync")]
            commands::device_sync::update_device,
            #[cfg(feature = "device-sync")]
            commands::device_sync::delete_device,
            #[cfg(feature = "device-sync")]
            commands::device_sync::revoke_device,
            // Team keys (E2EE)
            #[cfg(feature = "device-sync")]
            commands::device_sync::initialize_team_keys,
            #[cfg(feature = "device-sync")]
            commands::device_sync::commit_initialize_team_keys,
            #[cfg(feature = "device-sync")]
            commands::device_sync::rotate_team_keys,
            #[cfg(feature = "device-sync")]
            commands::device_sync::commit_rotate_team_keys,
            #[cfg(feature = "device-sync")]
            commands::device_sync::reset_team_sync,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_bootstrap_snapshot_if_needed,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_engine_status,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_pairing_source_status,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_bootstrap_overwrite_check,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_reconcile_ready_state,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_trigger_cycle,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_start_background_engine,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_stop_background_engine,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_generate_snapshot_now,
            #[cfg(feature = "device-sync")]
            commands::device_sync::device_sync_cancel_snapshot_upload,
            // Pairing (Issuer - Trusted Device)
            #[cfg(feature = "device-sync")]
            commands::device_sync::create_pairing,
            #[cfg(feature = "device-sync")]
            commands::device_sync::get_pairing,
            #[cfg(feature = "device-sync")]
            commands::device_sync::approve_pairing,
            #[cfg(feature = "device-sync")]
            commands::device_sync::complete_pairing,
            #[cfg(feature = "device-sync")]
            commands::device_sync::cancel_pairing,
            // Pairing (Claimer - New Device)
            #[cfg(feature = "device-sync")]
            commands::device_sync::claim_pairing,
            #[cfg(feature = "device-sync")]
            commands::device_sync::get_pairing_messages,
            #[cfg(feature = "device-sync")]
            commands::device_sync::confirm_pairing,
            // Composite pairing endpoints
            #[cfg(feature = "device-sync")]
            commands::device_sync::complete_pairing_with_transfer,
            #[cfg(feature = "device-sync")]
            commands::device_sync::confirm_pairing_with_bootstrap,
            // Pairing flow coordinator
            #[cfg(feature = "device-sync")]
            commands::device_sync::begin_pairing_confirm,
            #[cfg(feature = "device-sync")]
            commands::device_sync::get_pairing_flow_state,
            #[cfg(feature = "device-sync")]
            commands::device_sync::approve_pairing_overwrite,
            #[cfg(feature = "device-sync")]
            commands::device_sync::cancel_pairing_flow,
            // Device enroll service (high-level commands)
            #[cfg(feature = "device-sync")]
            commands::device_enroll_service::get_device_sync_state,
            #[cfg(feature = "device-sync")]
            commands::device_enroll_service::enable_device_sync,
            #[cfg(feature = "device-sync")]
            commands::device_enroll_service::clear_device_sync_data,
            #[cfg(feature = "device-sync")]
            commands::device_enroll_service::reinitialize_device_sync,
            // Sync crypto commands
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_generate_root_key,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_derive_dek,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_generate_keypair,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_compute_shared_secret,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_derive_session_key,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_encrypt,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_decrypt,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_generate_pairing_code,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_hash_pairing_code,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_hmac_sha256,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_compute_sas,
            #[cfg(feature = "device-sync")]
            commands::sync_crypto::sync_generate_device_id,
            // Custom provider commands
            commands::custom_provider::get_custom_providers,
            commands::custom_provider::create_custom_provider,
            commands::custom_provider::update_custom_provider,
            commands::custom_provider::delete_custom_provider,
            commands::custom_provider::test_custom_provider_source,
            // Health commands
            commands::health::get_health_status,
            commands::health::run_health_checks,
            commands::health::dismiss_health_issue,
            commands::health::restore_health_issue,
            commands::health::get_dismissed_health_issues,
            commands::health::execute_health_fix,
            commands::health::get_health_config,
            commands::health::update_health_config,
            // Allocation target commands
            commands::allocation_targets::list_allocation_targets,
            commands::allocation_targets::get_allocation_target,
            commands::allocation_targets::create_allocation_target,
            commands::allocation_targets::update_allocation_target,
            commands::allocation_targets::archive_allocation_target,
            commands::allocation_targets::delete_allocation_target,
            commands::allocation_targets::list_allocation_target_weights,
            commands::allocation_targets::save_allocation_target_weights,
            commands::allocation_targets::save_allocation_target_with_weights,
            commands::allocation_targets::list_target_constraints,
            commands::allocation_targets::save_target_constraints,
            commands::allocation_targets::get_allocation_target_drift,
            commands::allocation_targets::calculate_rebalance_plan,
            // RetirementPlan-based FIRE commands
            commands::fire::calculate_retirement_projection,
            commands::fire::run_retirement_decision_sensitivity_map,
            commands::fire::run_retirement_monte_carlo,
            commands::fire::run_retirement_scenario_analysis,
            commands::fire::run_retirement_sorr,
            commands::fire::run_retirement_stress_tests,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build Wealthfolio application")
        .run(|_handle, event| {
            #[cfg(desktop)]
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // Stop the embedded MCP server and delete mcp.lock.
                if _handle.try_state::<mcp::McpServerState>().is_some() {
                    let mcp_handle = _handle.clone();
                    tauri::async_runtime::block_on(async move {
                        mcp::stop_server(&mcp_handle).await;
                    });
                }

                #[cfg(feature = "device-sync")]
                if let Some(context) = _handle.try_state::<Arc<context::ServiceContext>>() {
                    let context = Arc::clone(context.inner());
                    tauri::async_runtime::block_on(async move {
                        if let Err(err) =
                            crate::commands::device_sync::ensure_background_engine_stopped(context)
                                .await
                        {
                            warn!("Failed to stop background device sync engine: {}", err);
                        }
                    });
                }
            }
        });
}
