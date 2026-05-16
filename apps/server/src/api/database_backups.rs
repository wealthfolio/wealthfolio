use std::{
    io::ErrorKind,
    path::{Path as StdPath, PathBuf},
    sync::Arc,
};

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
    let backup_path = task::spawn_blocking(move || db::backup_database(&data_root))
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileResponse {
    filename: String,
    size_bytes: u64,
    modified_at: String,
}

fn backups_dir(data_root: &str) -> PathBuf {
    StdPath::new(data_root).join("backups")
}

async fn resolve_backup_path(data_root: &str, filename: &str) -> ApiResult<PathBuf> {
    if !is_valid_backup_filename(filename) {
        return Err(ApiError::BadRequest("Invalid backup filename".to_string()));
    }

    let backup_dir = backups_dir(data_root);
    let canonical_dir = match fs::canonicalize(&backup_dir).await {
        Ok(path) => path,
        Err(err) if err.kind() == ErrorKind::NotFound => return Err(ApiError::NotFound),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "Failed to access backup directory {}: {}",
                backup_dir.display(),
                err
            )
            .into())
        }
    };

    let requested = backup_dir.join(filename);
    let canonical = match fs::canonicalize(&requested).await {
        Ok(path) => path,
        Err(err) if err.kind() == ErrorKind::NotFound => return Err(ApiError::NotFound),
        Err(err) => {
            return Err(anyhow::anyhow!("Backup file not found: {}: {}", filename, err).into())
        }
    };

    if !canonical.starts_with(&canonical_dir) {
        return Err(ApiError::BadRequest("Invalid backup filename".to_string()));
    }

    Ok(canonical)
}

async fn list_backup_files_route(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<BackupFileResponse>>> {
    let backup_dir = backups_dir(&state.data_root);
    let mut entries = match fs::read_dir(&backup_dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Json(Vec::new())),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "Failed to read backup directory {}: {}",
                backup_dir.display(),
                err
            )
            .into())
        }
    };

    let mut backups = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .context("Failed to read backup directory entry")?
    {
        let filename = match entry.file_name().to_str() {
            Some(filename) if is_valid_backup_filename(filename) => filename.to_string(),
            _ => continue,
        };

        let metadata = entry
            .metadata()
            .await
            .with_context(|| format!("Failed to read backup metadata for {}", filename))?;
        if !metadata.is_file() {
            continue;
        }

        let modified_at = metadata
            .modified()
            .with_context(|| format!("Failed to read backup modified time for {}", filename))
            .map(chrono::DateTime::<chrono::Utc>::from)?;
        backups.push(BackupFileResponse {
            filename,
            size_bytes: metadata.len(),
            modified_at: modified_at.to_rfc3339(),
        });
    }

    backups.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(Json(backups))
}

async fn download_backup_file_route(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> ApiResult<Response> {
    let backup_path = resolve_backup_path(&state.data_root, &filename).await?;
    let file = fs::File::open(&backup_path)
        .await
        .with_context(|| format!("Failed to open backup file {}", filename))?;
    let body = stream_file(file);

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

fn stream_file(file: fs::File) -> Body {
    let stream = stream::unfold(file, |mut file| async move {
        let mut buffer = vec![0; 64 * 1024];
        match file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(bytes_read) => {
                buffer.truncate(bytes_read);
                Some((Ok::<Bytes, std::io::Error>(Bytes::from(buffer)), file))
            }
            Err(err) => Some((Err(err), file)),
        }
    });

    Body::from_stream(stream)
}

async fn delete_backup_file_route(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> ApiResult<StatusCode> {
    let backup_path = resolve_backup_path(&state.data_root, &filename).await?;
    fs::remove_file(&backup_path)
        .await
        .with_context(|| format!("Failed to delete backup file {}", filename))?;

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
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
    use tempfile::tempdir;

    #[tokio::test]
    async fn resolve_backup_path_rejects_invalid_filename() {
        let data_root = tempdir().unwrap();

        let result = resolve_backup_path(
            data_root.path().to_str().unwrap(),
            "../wealthfolio_backup_20260514_150409.db",
        )
        .await;

        assert!(matches!(result, Err(ApiError::BadRequest(_))));
    }

    #[tokio::test]
    async fn resolve_backup_path_accepts_valid_backup_inside_backup_dir() {
        let data_root = tempdir().unwrap();
        let backup_dir = data_root.path().join("backups");
        std::fs::create_dir_all(&backup_dir).unwrap();
        let backup_file = backup_dir.join("wealthfolio_backup_20260514_150409.db");
        std::fs::write(&backup_file, b"backup").unwrap();

        let resolved = resolve_backup_path(
            data_root.path().to_str().unwrap(),
            "wealthfolio_backup_20260514_150409.db",
        )
        .await
        .unwrap();

        assert_eq!(resolved, std::fs::canonicalize(backup_file).unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_backup_path_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let data_root = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();
        let backup_dir = data_root.path().join("backups");
        std::fs::create_dir_all(&backup_dir).unwrap();
        let outside_file = outside_dir.path().join("outside.db");
        std::fs::write(&outside_file, b"not a backup").unwrap();
        symlink(
            &outside_file,
            backup_dir.join("wealthfolio_backup_20260514_150409.db"),
        )
        .unwrap();

        let result = resolve_backup_path(
            data_root.path().to_str().unwrap(),
            "wealthfolio_backup_20260514_150409.db",
        )
        .await;

        assert!(matches!(result, Err(ApiError::BadRequest(_))));
    }
}
