#[cfg(not(target_os = "linux"))]
use tauri::menu::PredefinedMenuItem;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

pub fn create_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, tauri::Error> {
    let app_menu = SubmenuBuilder::new(app, "Wealthfolio")
        .item(&MenuItemBuilder::with_id("open_settings", "Settings...").build(app)?)
        .separator();
    // Only macOS gets the predefined Hide, Hide Others and Show All. On Windows,
    // muda 0.20 shows Hide Others and Show All disabled, and Hide hides the
    // window with nothing to show it again. On GTK 3 it shows all three
    // disabled, along with Quit, Undo and Redo, which Linux handles in
    // handle_menu_event.
    #[cfg(target_os = "macos")]
    let app_menu = app_menu
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator();
    #[cfg(target_os = "linux")]
    let app_menu = app_menu.item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?);
    #[cfg(not(target_os = "linux"))]
    let app_menu = app_menu.item(&PredefinedMenuItem::quit(app, None)?);
    let app_menu = app_menu.build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit");
    // On GTK 3, muda 0.20's predefined Cut, Copy, Paste and Select All only work
    // through libxdo, which isn't enabled, so Linux handles them in
    // handle_menu_event too. They get no accelerators: WebKitGTK and the data
    // grid's keydown handler already handle those keys, and an accelerator
    // would take them first.
    #[cfg(target_os = "linux")]
    let edit_menu = edit_menu
        .item(
            &MenuItemBuilder::with_id("Undo", "Undo")
                .accelerator("Ctrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("Redo", "Redo")
                .accelerator("Ctrl+Shift+Z")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("Cut", "Cut").build(app)?)
        .item(&MenuItemBuilder::with_id("Copy", "Copy").build(app)?)
        .item(&MenuItemBuilder::with_id("Paste", "Paste").build(app)?)
        .item(&MenuItemBuilder::with_id("SelectAll", "Select All").build(app)?);
    #[cfg(not(target_os = "linux"))]
    let edit_menu = edit_menu
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?);
    let edit_menu = edit_menu.build()?;

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
        // Linux only (see create_menu). exit(0) still runs the RunEvent::Exit
        // cleanup in lib.rs.
        #[cfg(target_os = "linux")]
        "quit" => app.exit(0),
        // On Linux the Edit menu's IDs are WebKitGTK editing commands, which,
        // unlike document.execCommand run through eval, can also paste.
        #[cfg(target_os = "linux")]
        "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" => {
            if let Some(window) = app.get_webview_window("main") {
                let command = event_id.to_owned();
                let _ = window.with_webview(move |webview| {
                    use webkit2gtk::WebViewExt;
                    webview.inner().execute_editing_command(&command);
                });
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
