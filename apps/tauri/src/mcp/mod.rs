//! Embedded local MCP server (Phase D of the agent-access design).
//!
//! Hosts the `wealthfolio-mcp` Streamable HTTP service on loopback when
//! enabled in settings, guarded by per-client Personal Access Tokens and
//! Origin validation, discovered through `<app_data>/mcp.lock`.

#[cfg(desktop)]
pub mod audit_sink;
#[cfg(desktop)]
pub mod lockfile;
#[cfg(desktop)]
pub mod middleware;
#[cfg(desktop)]
pub mod server;

#[cfg(all(test, desktop))]
mod tests;

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
#[cfg(desktop)]
use wealthfolio_mcp::AuditSink;

use crate::context::ServiceContext;
#[cfg(desktop)]
use audit_sink::RepoAuditSink;

/// Settings keys (app_settings k/v; values are "true"/"false").
pub const SETTING_ENABLED: &str = "mcp_server_enabled";
pub const SETTING_AUTO_START: &str = "mcp_server_auto_start";
/// Optional port override; defaults to [`server::DEFAULT_PORT`].
pub const SETTING_PORT: &str = "mcp_server_port";
/// Audit logging of agent tool calls; defaults to enabled when unset.
pub const SETTING_AUDIT_ENABLED: &str = "mcp_audit_enabled";

/// Managed Tauri state holding the running server, if any.
#[derive(Default)]
pub struct McpServerState {
    inner: tokio::sync::Mutex<Option<RunningServer>>,
    /// Serializes start/stop orchestration end-to-end so concurrent
    /// operations cannot interleave (e.g. a start racing a slow stop and
    /// landing on a random fallback port).
    ops: tokio::sync::Mutex<()>,
}

impl McpServerState {
    /// Snapshot of the running server: `(port, started_at_rfc3339)`.
    pub async fn running_info(&self) -> Option<(u16, String)> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|server| (server.port, server.started_at.to_rfc3339()))
    }
}

/// A started embedded MCP server. Lives here (not in `server`) so
/// [`McpServerState`] can hold it on all platforms; the heavy server
/// machinery that constructs it is desktop-only.
pub struct RunningServer {
    pub port: u16,
    pub started_at: DateTime<Utc>,
    // Unused on mobile: the server is never started there, but the type
    // must compile so command signatures using `McpServerState` resolve.
    #[allow(dead_code)]
    cancel: CancellationToken,
    #[allow(dead_code)]
    join: JoinHandle<()>,
}

impl RunningServer {
    /// Cancels in-flight MCP sessions and waits for the listener to exit.
    #[allow(dead_code)]
    pub async fn stop(self) {
        self.cancel.cancel();
        let _ = self.join.await;
    }
}

fn setting_is_true(ctx: &ServiceContext, key: &str) -> bool {
    matches!(
        ctx.settings_service().get_setting_value(key),
        Ok(Some(value)) if value == "true"
    )
}

/// Current persisted flags: `(enabled, auto_start)`.
pub fn flags(ctx: &ServiceContext) -> (bool, bool) {
    (
        setting_is_true(ctx, SETTING_ENABLED),
        setting_is_true(ctx, SETTING_AUTO_START),
    )
}

/// Whether agent tool calls are written to the audit log. Defaults to
/// `true` when the setting is unset; only an explicit "false" disables it.
pub fn audit_enabled(ctx: &ServiceContext) -> bool {
    !matches!(
        ctx.settings_service().get_setting_value(SETTING_AUDIT_ENABLED),
        Ok(Some(value)) if value == "false"
    )
}

/// Audit sink for the MCP service, or `None` when audit logging is off.
#[cfg(desktop)]
fn build_audit_sink(ctx: &ServiceContext) -> Option<Arc<dyn AuditSink>> {
    audit_enabled(ctx)
        .then(|| Arc::new(RepoAuditSink(ctx.mcp_audit_repository())) as Arc<dyn AuditSink>)
}

#[cfg(desktop)]
fn configured_port(ctx: &ServiceContext) -> Option<u16> {
    ctx.settings_service()
        .get_setting_value(SETTING_PORT)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u16>().ok())
}

#[cfg(desktop)]
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

/// Removes any stale `mcp.lock` left behind by an unclean shutdown.
/// Call once at app startup, before deciding whether to auto-start.
pub fn remove_stale_lock(app: &AppHandle) {
    #[cfg(desktop)]
    {
        if let Ok(dir) = app_data_dir(app) {
            if let Err(err) = lockfile::remove(&dir) {
                log::warn!("Failed to remove stale mcp.lock: {err}");
            }
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
    }
}

/// Starts the server (no-op when already running) and writes `mcp.lock`.
// Public orchestration entry point; internal callers already hold `ops`
// and use `start_server_locked` directly.
pub async fn start_server(app: &AppHandle, ctx: &ServiceContext) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // Respect the master feature flag: never open the loopback server while
        // AI Agent Access is disabled, even if a command reaches this directly.
        if !flags(ctx).0 {
            return Err("Enable AI Agent Access before starting the server".to_string());
        }
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;
        start_server_locked(app, ctx).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, ctx);
        Err("MCP server is not available on mobile".to_string())
    }
}

/// Start implementation; callers must hold the `ops` mutex.
#[cfg(desktop)]
async fn start_server_locked(app: &AppHandle, ctx: &ServiceContext) -> Result<(), String> {
    let state = app.state::<McpServerState>();
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let sink = build_audit_sink(ctx);
    let running = server::start(
        ctx.agent_environment(),
        sink,
        ctx.pat_repository(),
        configured_port(ctx),
    )
    .await?;

    if let Err(err) = write_lock_file(app, &running) {
        // Don't drop the server without stopping it: dropping the
        // CancellationToken doesn't cancel and dropping the JoinHandle
        // detaches, which would orphan the listener (AddrInUse on retry).
        running.stop().await;
        return Err(err);
    }
    *guard = Some(running);
    Ok(())
}

/// Stops the server when running and removes `mcp.lock`.
pub async fn stop_server(app: &AppHandle) {
    #[cfg(desktop)]
    {
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;
        stop_server_locked(app).await;
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
    }
}

/// Stop implementation; callers must hold the `ops` mutex.
#[cfg(desktop)]
async fn stop_server_locked(app: &AppHandle) {
    let state = app.state::<McpServerState>();
    let running = state.inner.lock().await.take();
    if let Some(running) = running {
        running.stop().await;
        log::info!("MCP server stopped");
    }
    remove_stale_lock(app);
}

/// App-launch hook: start only when BOTH enabled and auto-start are set.
pub async fn start_if_enabled(app: &AppHandle, ctx: &ServiceContext) {
    #[cfg(desktop)]
    {
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;
        let (enabled, auto_start) = flags(ctx);
        if enabled && auto_start {
            if let Err(err) = start_server_locked(app, ctx).await {
                log::error!("Failed to auto-start MCP server: {err}");
            }
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, ctx);
    }
}

/// Persists the feature-enabled flag. Disabling stops a running server;
/// enabling only makes the feature available — the server is started
/// explicitly via [`start_server`] (or on launch by [`start_if_enabled`]).
pub async fn set_enabled(
    app: &AppHandle,
    ctx: &ServiceContext,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;

        ctx.settings_service()
            .set_setting_value(SETTING_ENABLED, if enabled { "true" } else { "false" })
            .await
            .map_err(|e| e.to_string())?;

        if !enabled {
            stop_server_locked(app).await;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, ctx, enabled);
        Err("MCP server is not available on mobile".to_string())
    }
}

/// Persists the auto-start flag. Takes effect on next launch; does not
/// start or stop the currently running server.
pub async fn set_auto_start(
    app: &AppHandle,
    ctx: &ServiceContext,
    auto_start: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;

        ctx.settings_service()
            .set_setting_value(
                SETTING_AUTO_START,
                if auto_start { "true" } else { "false" },
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, ctx, auto_start);
        Err("MCP server is not available on mobile".to_string())
    }
}

/// Persists the audit-logging flag. When the server is running it is
/// restarted so the change takes effect immediately.
pub async fn set_audit_enabled(
    app: &AppHandle,
    ctx: &ServiceContext,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let state = app.state::<McpServerState>();
        let _ops = state.ops.lock().await;

        ctx.settings_service()
            .set_setting_value(
                SETTING_AUDIT_ENABLED,
                if enabled { "true" } else { "false" },
            )
            .await
            .map_err(|e| e.to_string())?;

        let running = state.inner.lock().await.is_some();
        if running {
            stop_server_locked(app).await;
            start_server_locked(app, ctx).await?;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, ctx, enabled);
        Err("MCP server is not available on mobile".to_string())
    }
}

#[cfg(desktop)]
fn write_lock_file(app: &AppHandle, running: &RunningServer) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    let lock = lockfile::McpLockFile {
        lock_file_version: 1,
        port: running.port,
        pid: std::process::id(),
        started_at: running.started_at.to_rfc3339(),
    };
    lockfile::write(&dir, &lock).map_err(|e| format!("Failed to write mcp.lock: {e}"))
}
