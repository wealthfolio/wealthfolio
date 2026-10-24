//! Helpers shared by the integration tests.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Temporary directory for a database opened through a pool.
///
/// The integration-test copy of the crate's `db::TestDir`: r2d2 can still be
/// opening a connection when a test ends, so SQLite can create the database
/// again while `TempDir` removes the directory, and `TempDir` ignores the
/// failure. Removing it again works once the directory is gone. Windows can't
/// remove a database that is still open, so there the directory stays behind,
/// as with `TempDir`.
pub struct TestDir(PathBuf);

impl TestDir {
    pub fn new() -> Self {
        Self(tempfile::tempdir().expect("create temp dir").keep())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        for _ in 0..10 {
            match std::fs::remove_dir_all(&self.0) {
                Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => return,
            }
        }
    }
}
