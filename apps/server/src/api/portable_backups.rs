//! Password export staging. The browser downloads a completed file as a stream.
use crate::{
    auth::BackupSession,
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use futures::stream;
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, sync::Semaphore};
use uuid::Uuid;
use wealthfolio_storage_sqlite::db;

const EXPORT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_EXPORTS: usize = 2;
struct ExportJob {
    id: Uuid,
    session: String,
    created: Instant,
    file: db::portable::PortableExport,
    _quota: tokio::sync::OwnedSemaphorePermit,
}
pub struct BackupExports {
    jobs: Mutex<Vec<ExportJob>>,
    slot: Arc<Semaphore>,
    outstanding: Arc<Semaphore>,
}
impl Default for BackupExports {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(vec![]),
            slot: Arc::new(Semaphore::new(1)),
            outstanding: Arc::new(Semaphore::new(MAX_EXPORTS)),
        }
    }
}
impl BackupExports {
    fn jobs(&self) -> ApiResult<MutexGuard<'_, Vec<ExportJob>>> {
        self.jobs.lock().map_err(|_| {
            ApiError::Internal(
                "Backup export state is unavailable. Restart the server before exporting again."
                    .into(),
            )
        })
    }

    fn purge_expired(&self) -> ApiResult<()> {
        self.jobs()?
            .retain(|job| job.created.elapsed() < EXPORT_TTL);
        Ok(())
    }
    fn take(&self, id: Uuid, session: &str) -> ApiResult<ExportJob> {
        self.purge_expired()?;
        let mut jobs = self.jobs()?;
        let index = jobs
            .iter()
            .position(|job| job.id == id && job.session == session)
            .ok_or(ApiError::NotFound)?;
        Ok(jobs.swap_remove(index))
    }
}

/// Reject cross-site forms and cross-origin fetches, even with a broad CORS policy.
pub(crate) fn check_export_request(headers: &HeaderMap, protected: bool) -> ApiResult<()> {
    let forbidden = || ApiError::Forbidden("Open Backups on this server to export a backup".into());
    if headers
        .get("x-wealthfolio-backup")
        .and_then(|v| v.to_str().ok())
        != Some("1")
    {
        return Err(forbidden());
    }
    if headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !matches!(v, "same-origin" | "none"))
    {
        return Err(forbidden());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(forbidden)?;
    let mut https = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        == Some("https");
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = reqwest::Url::parse(origin.to_str().map_err(|_| forbidden())?)
            .map_err(|_| forbidden())?;
        let expected = reqwest::Url::parse(&format!("{}://{host}", origin.scheme()))
            .map_err(|_| forbidden())?;
        if origin != expected || !matches!(origin.scheme(), "http" | "https") {
            return Err(forbidden());
        }
        https = origin.scheme() == "https";
    }
    let local = reqwest::Url::parse(&format!("http://{host}"))
        .ok()
        .is_some_and(|url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")));
    if protected && !https && !local {
        return Err(ApiError::BadRequest(
            "Password-protected exports require HTTPS (or localhost for development)".into(),
        ));
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct ExportRequest {
    password: Option<String>,
    #[serde(default)]
    unencrypted: bool,
}
#[derive(serde::Serialize)]
struct ExportResponse {
    id: Uuid,
    filename: String,
}

async fn export_snapshot(
    State(state): State<Arc<AppState>>,
    Extension(session): Extension<BackupSession>,
    Path(filename): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExportRequest>,
) -> ApiResult<Json<ExportResponse>> {
    let password = request.password.map(zeroize::Zeroizing::new);
    if request.unencrypted == password.is_some() {
        return Err(ApiError::BadRequest(
            "Choose password protection or explicitly choose an unencrypted export".into(),
        ));
    }
    check_export_request(&headers, password.is_some())?;
    state.backup_exports.purge_expired()?;
    let permit = state
        .backup_exports
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::BadRequest("Another backup export is running".into()))?;
    let quota = state
        .backup_exports
        .outstanding
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::BadRequest("Finish or discard earlier exports before creating another".into())
        })?;
    let root = state.data_root.clone();
    let key = state.database_key.clone();
    let id = Uuid::new_v4();
    let output = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let lease = db::snapshots::acquire(&root, &filename)?;
        let source = lease.access(Some(key))?;
        let file = db::portable::export(
            &source,
            &db::scratch_dir(&root)?,
            password.as_deref().map(String::as_str),
        )?;
        Ok::<_, anyhow::Error>(ExportJob {
            id,
            session: session.0,
            created: Instant::now(),
            file,
            _quota: quota,
        })
    })
    .await
    .map_err(|_| ApiError::Internal("Backup export task failed".into()))?
    .map_err(ApiError::backup)?;
    let filename = output.file.filename.clone();
    state.backup_exports.jobs()?.push(output);
    Ok(Json(ExportResponse { id, filename }))
}

async fn download_export(
    State(state): State<Arc<AppState>>,
    Extension(session): Extension<BackupSession>,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    let output = state.backup_exports.take(id, &session.0)?;
    let filename = output.file.filename.clone();
    let file = tokio::fs::File::open(&output.file.path)
        .await
        .map_err(anyhow::Error::from)?;
    let bytes = stream::try_unfold((file, output), |(mut file, output)| async move {
        let mut buffer = vec![0; 64 * 1024];
        let size = file.read(&mut buffer).await?;
        if size == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        buffer.truncate(size);
        Ok(Some((Bytes::from(buffer), (file, output))))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from_stream(bytes))
        .map_err(|error| ApiError::Internal(error.to_string()))
}

async fn discard_export(
    State(state): State<Arc<AppState>>,
    Extension(session): Extension<BackupSession>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<axum::http::StatusCode> {
    check_export_request(&headers, false)?;
    drop(state.backup_exports.take(id, &session.0)?);
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/utilities/database/backups/{filename}/export",
            post(export_snapshot),
        )
        .route(
            "/utilities/database/exports/{id}",
            get(download_export).delete(discard_export),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_exports_return_internal_errors() {
        let exports = BackupExports::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = exports.jobs.lock().unwrap();
            panic!("interrupted export publication");
        }));
        assert!(matches!(
            exports.purge_expired(),
            Err(ApiError::Internal(_))
        ));
        assert!(matches!(
            exports.take(Uuid::new_v4(), "session"),
            Err(ApiError::Internal(_))
        ));
        assert!(exports.jobs().is_err());
    }
}
