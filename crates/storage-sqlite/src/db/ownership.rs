//! Cooperative ownership across Wealthfolio processes. SQLite locks alone cannot
//! protect a file replacement: a connection's lock disappears when it closes.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use wealthfolio_core::errors::{DatabaseError, Error, Result};

/// Exclusive ownership of one database, retained through startup, maintenance
/// and runtime rebuild. External SQLite tools must still be closed manually.
///
/// The sidecar is deliberately never removed: unlinking a locked file would let
/// another process create a different inode and acquire an independent lock.
/// The OS releases the lock when the owner exits, including after a crash.
#[derive(Debug)]
pub struct DatabaseOwner {
    path: PathBuf,
    _lock: File,
}

impl DatabaseOwner {
    pub fn acquire(db_path: &str) -> Result<Self> {
        super::create_parent_dir(Path::new(db_path))?;
        let path = resolved_path(Path::new(db_path))?;
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        try_lock(&lock).map_err(|e| {
            Error::Database(DatabaseError::TransactionFailed(format!(
                "Cannot acquire database ownership for {} ({e}). Stop the other Wealthfolio \
                 instance or wait for database maintenance to finish.",
                path.display()
            )))
        })?;
        Ok(Self { path, _lock: lock })
    }

    /// Verify that this owner protects the requested, non-symlink database path.
    pub fn check_path(&self, db_path: &str) -> Result<()> {
        // Replacing a symlink would install a new database at the alias while
        // ownership still protects the original target's lock file.
        match std::fs::symlink_metadata(db_path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(Error::Database(DatabaseError::TransactionFailed(
                    "Database maintenance cannot replace a symbolic link. Use the real database path."
                        .to_string(),
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if self.path != resolved_path(Path::new(db_path))? {
            return Err(Error::Database(DatabaseError::TransactionFailed(
                "Database ownership does not match the maintenance target".to_string(),
            )));
        }
        Ok(())
    }
}

// Rust's standard File lock API is unsupported on Android. Bionic supplies
// flock, with the same open-file lifetime and crash-release behavior.
#[cfg(target_os = "android")]
fn try_lock(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: the borrowed File keeps its descriptor valid for this call.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "android"))]
fn try_lock(file: &File) -> std::io::Result<()> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => std::io::ErrorKind::WouldBlock.into(),
        std::fs::TryLockError::Error(error) => error,
    })
}

fn resolved_path(path: &Path) -> std::io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
            Ok(parent
                .unwrap_or_else(|| Path::new("."))
                .canonicalize()?
                .join(path.file_name().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Missing database filename",
                    )
                })?))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn child(path: &Path, mode: &str) {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::ownership::tests::ownership_child",
                "--nocapture",
            ])
            .env("WF_OWNERSHIP_TEST_PATH", path)
            .env("WF_OWNERSHIP_TEST_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn ownership_child() {
        let Ok(path) = std::env::var("WF_OWNERSHIP_TEST_PATH") else {
            return;
        };
        match std::env::var("WF_OWNERSHIP_TEST_MODE").unwrap().as_str() {
            "blocked" => assert!(DatabaseOwner::acquire(&path).is_err()),
            "exit" => {
                let _owner = DatabaseOwner::acquire(&path).unwrap();
                // Skip destructors, as a terminated process would.
                std::process::exit(0);
            }
            _ => panic!("unknown child mode"),
        }
    }

    #[test]
    fn excludes_other_processes_before_open_and_after_file_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let owner = DatabaseOwner::acquire(path.to_str().unwrap()).unwrap();
        child(&path, "blocked");
        std::fs::write(&path, b"old").unwrap();
        let replacement = dir.path().join("candidate.db");
        std::fs::write(&replacement, b"new").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(replacement, &path).unwrap();
        child(&path, "blocked");
        drop(owner);
        assert!(DatabaseOwner::acquire(path.to_str().unwrap()).is_ok());
    }

    #[test]
    fn process_exit_releases_ownership_without_deleting_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        child(&path, "exit");
        assert!(dir.path().join("app.db.lock").exists());
        assert!(DatabaseOwner::acquire(path.to_str().unwrap()).is_ok());
    }
}
