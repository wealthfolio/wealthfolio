use std::{path::Path as StdPath, sync::Arc};

use crate::{
    error::{ApiError, ApiResult},
    main_lib::AppState,
};
use anyhow::Context;
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Json, Router,
};
use futures::stream;
use tokio::{fs, io::AsyncReadExt, task};
use wealthfolio_storage_sqlite::{db, is_valid_backup_filename};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupDatabaseResponse {
    filename: String,
}

async fn backup_database_route(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<BackupDatabaseResponse>> {
    let data_root = state.data_root.clone();
    // Faithful copy: on an encrypted server the backup is encrypted too, and
    // opens on any instance sharing WF_SECRET_KEY.
    let access = state.db_access.clone();
    let backup_path = task::spawn_blocking(move || db::backup_database(&access, &data_root))
        .await
        .map_err(|e| anyhow::anyhow!("Failed to execute backup task: {}", e))??;

    let filename = StdPath::new(&backup_path)
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid backup filename"))?
        .to_string();

    if !is_valid_backup_filename(&filename) {
        return Err(ApiError::Internal(
            "Backup service returned an invalid filename".to_string(),
        ));
    }

    Ok(Json(BackupDatabaseResponse { filename }))
}

async fn list_backup_files_route(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<db::snapshots::Snapshot>>> {
    let root = state.data_root.clone();
    let key = state.database_key.clone();
    let snapshots = task::spawn_blocking(move || db::snapshots::list(&root, Some(key)))
        .await
        .map_err(|error| anyhow::anyhow!(error))??;
    Ok(Json(snapshots))
}

async fn download_backup_file_route(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> ApiResult<Response> {
    let lease = db::snapshots::acquire(&state.data_root, &filename).map_err(ApiError::backup)?;
    let file = fs::File::open(&lease.path)
        .await
        .with_context(|| format!("Failed to open backup file {}", filename))?;
    let body = stream_file(file, lease);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(body)
        .map_err(|e| anyhow::anyhow!("Failed to build backup download response: {}", e).into())
}

fn stream_file(file: fs::File, lease: db::snapshots::SnapshotLease) -> Body {
    let stream = stream::unfold((file, lease), |(mut file, lease)| async move {
        let mut buffer = vec![0; 64 * 1024];
        match file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(bytes_read) => {
                buffer.truncate(bytes_read);
                Some((
                    Ok::<Bytes, std::io::Error>(Bytes::from(buffer)),
                    (file, lease),
                ))
            }
            Err(err) => Some((Err(err), (file, lease))),
        }
    });

    Body::from_stream(stream)
}

async fn delete_backup_file_route(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> ApiResult<StatusCode> {
    let root = state.data_root.clone();
    task::spawn_blocking(move || db::snapshots::delete(&root, &filename))
        .await
        .map_err(|error| anyhow::anyhow!(error))?
        .map_err(ApiError::backup)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseEncryptionStatus {
    /// Whether the database file is encrypted right now.
    enabled: bool,
    /// Always false on the server: encryption is set by `WF_DB_REQUIRE_ENCRYPTION` and
    /// converted with an offline command, never toggled through the API.
    supported: bool,
}

async fn database_encryption_status_route(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<DatabaseEncryptionStatus>> {
    Ok(Json(DatabaseEncryptionStatus {
        enabled: state.db_access.is_encrypted(),
        supported: false,
    }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .merge(super::portable_backups::router())
        .route(
            "/utilities/database/encryption",
            get(database_encryption_status_route),
        )
        .route("/utilities/database/backup", post(backup_database_route))
        .route("/utilities/database/backups", get(list_backup_files_route))
        .route(
            "/utilities/database/backups/{filename}/download",
            get(download_backup_file_route),
        )
        .route(
            "/utilities/database/backups/{filename}",
            delete(delete_backup_file_route),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_download_body_releases_snapshot_lease() {
        let root = tempfile::tempdir().unwrap();
        let root_str = root.path().to_str().unwrap();
        let path =
            db::snapshots::new_path(root_str, db::snapshots::SnapshotReason::Manual).unwrap();
        std::fs::write(&path, b"synthetic snapshot").unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        let lease = db::snapshots::acquire(root_str, name).unwrap();
        let file = fs::File::open(&lease.path).await.unwrap();
        let body = stream_file(file, lease);
        assert!(db::snapshots::delete(root_str, name).is_err());
        drop(body);
        db::snapshots::delete(root_str, name).unwrap();
    }
}
