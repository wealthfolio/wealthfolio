//! `mcp.lock` discovery file.
//!
//! Written to the app data directory when the embedded MCP server starts
//! and removed on stop / clean shutdown. It is a discovery hint only — it
//! never contains a token.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const LOCK_FILE_NAME: &str = "mcp.lock";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLockFile {
    pub lock_file_version: u32,
    pub port: u16,
    pub pid: u32,
    /// RFC3339 timestamp of when the server started.
    pub started_at: String,
}

fn lock_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LOCK_FILE_NAME)
}

pub fn write(app_data_dir: &Path, lock: &McpLockFile) -> io::Result<()> {
    let json = serde_json::to_string_pretty(lock)?;
    std::fs::write(lock_path(app_data_dir), json)
}

/// Removes the lock file; missing files are not an error.
pub fn remove(app_data_dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(lock_path(app_data_dir)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> McpLockFile {
        McpLockFile {
            lock_file_version: 1,
            port: 8639,
            pid: 12345,
            started_at: "2026-05-17T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn writes_camel_case_json() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &sample()).unwrap();

        let raw = std::fs::read_to_string(dir.path().join(LOCK_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["lockFileVersion"], 1);
        assert_eq!(value["port"], 8639);
        assert_eq!(value["pid"], 12345);
        assert_eq!(value["startedAt"], "2026-05-17T00:00:00Z");

        let parsed: McpLockFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.port, 8639);
    }

    #[test]
    fn remove_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing written yet — still Ok.
        remove(dir.path()).unwrap();

        write(dir.path(), &sample()).unwrap();
        remove(dir.path()).unwrap();
        assert!(!dir.path().join(LOCK_FILE_NAME).exists());
        remove(dir.path()).unwrap();
    }
}
