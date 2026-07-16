use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

pub fn create_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, tauri::Error> {
    let app_menu = SubmenuBuilder::new(app, "Wealthfolio")
        .item(&MenuItemBuilder::with_id("open_settings", "Settings...").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None).unwrap())
        .item(&PredefinedMenuItem::hide_others(app, None).unwrap())
        .item(&PredefinedMenuItem::show_all(app, None).unwrap())
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None).unwrap())
        .item(&PredefinedMenuItem::redo(app, None).unwrap())
        .separator()
        .item(&PredefinedMenuItem::cut(app, None).unwrap())
        .item(&PredefinedMenuItem::copy(app, None).unwrap())
        .item(&PredefinedMenuItem::paste(app, None).unwrap())
        .item(&PredefinedMenuItem::select_all(app, None).unwrap())
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle_fullscreen", "Toggle Fullscreen")
                .accelerator("F11")
                .build(app)?,
        )
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("report_issue", "Report Issue").build(app)?)
        .separator()
        // Add the new menu item for checking updates
        .item(&MenuItemBuilder::with_id("check_for_update", "Check for Update").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("show_about_dialog", "About Wealthfolio").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    match event_id {
        "open_settings" => {
            if let Some(window) = app.get_webview_window("main") {
                let payload = serde_json::json!({ "route": "/settings/general" });
                let _ = window.emit("navigate-to-route", payload);
            }
        }
        "report_issue" => {
            app.dialog()
                .message("If you encounter any issues, please email us at support@wealthfolio.app")
                .title("Report Issue")
                .show(|_| {});
        }
        "toggle_fullscreen" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(is_fullscreen) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!is_fullscreen);
                } else {
                    // if getting fullscreen state fails just try toggling
                    let _ = window.set_fullscreen(false);
                }
            }
        }
        "check_for_update" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                match crate::updater::check_for_update(app_handle.clone()).await {
                    Ok(Some(update_info)) => {
                        // Update available - emit event for frontend to show dialog
                        let _ = app_handle.emit("app:update-available", &update_info);
                    }
                    Ok(None) => {
                        // Already up-to-date - show native dialog
                        app_handle
                            .dialog()
                            .message("You're already running the latest version of Wealthfolio.")
                            .title("No Updates Available")
                            .show(|_| {});
                    }
                    Err(e) => {
                        // Error - show native dialog
                        app_handle
                            .dialog()
                            .message(format!("Failed to check for updates: {}", e))
                            .title("Update Check Failed")
                            .show(|_| {});
                    }
                }
            });
        }
        "show_about_dialog" => {
            let package_info = app.package_info();
            let app_name = &package_info.name;
            let app_version = &package_info.version.to_string();
            let message = format!("{} version {}", app_name, app_version);
            app.dialog()
                .message(message)
                .title(format!("About {}", app_name))
                .show(|_| {});
        }
        _ => {}
    }
}
