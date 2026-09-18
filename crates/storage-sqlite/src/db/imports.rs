//! Short-lived, validated restore candidates. Handles never expose local paths.
use super::{portable, DbEncryptionKey};
use anyhow::{ensure, Result};
use serde::Serialize;
use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub id: Uuid,
    pub summary: portable::BackupSummary,
}

/// Retain through installation, including rollback. Dropping releases staging
/// and its capacity; taking a handle alone must not release the capacity.
pub struct ValidatedImport {
    pub backup: portable::PreparedBackup,
    _capacity: OwnedSemaphorePermit,
}

struct Entry {
    id: Uuid,
    session: String,
    created: Instant,
    candidate: ValidatedImport,
}

pub struct PendingImports {
    entries: Mutex<Vec<Entry>>,
    capacity: Arc<Semaphore>,
    processing: Arc<Semaphore>,
}

impl Default for PendingImports {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            capacity: Arc::new(Semaphore::new(2)),
            processing: Arc::new(Semaphore::new(1)),
        }
    }
}

/// Own this in the blocking task so cancellation cannot admit another copy
/// while the first is still using disk and CPU.
pub struct ImportReservation {
    capacity: OwnedSemaphorePermit,
    _processing: OwnedSemaphorePermit,
}

impl ImportReservation {
    pub fn prepare(
        self,
        path: &Path,
        scratch: &Path,
        password: Option<&str>,
        legacy_key: Option<Arc<DbEncryptionKey>>,
    ) -> Result<ValidatedImport> {
        ensure!(
            std::fs::symlink_metadata(path)?.file_type().is_file(),
            "Select a regular backup file"
        );
        let backup = portable::prepare_import(path, scratch, password, legacy_key)?;
        Ok(ValidatedImport {
            backup,
            _capacity: self.capacity,
        })
    }
}

impl PendingImports {
    fn entries(&self) -> Result<MutexGuard<'_, Vec<Entry>>> {
        self.entries.lock().map_err(|_| {
            anyhow::anyhow!(
                "Backup import state is unavailable. Restart the application before importing again."
            )
        })
    }

    /// Expiration is enforced on access, and abandoned files are also removed
    /// by owner-protected startup cleanup after a process exit.
    pub fn reserve(&self) -> Result<ImportReservation> {
        self.entries()?
            .retain(|entry| entry.created.elapsed() < TTL);
        let processing = self
            .processing
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::anyhow!("Another backup is being inspected"))?;
        let capacity = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::anyhow!("Finish or discard earlier backup imports first"))?;
        Ok(ImportReservation {
            capacity,
            _processing: processing,
        })
    }

    /// Publish only after the caller receives the blocking result. If its
    /// future was cancelled, the unpublished candidate is dropped instead.
    pub fn publish(&self, candidate: ValidatedImport, session: String) -> Result<ImportPreview> {
        let preview = ImportPreview {
            id: Uuid::new_v4(),
            summary: candidate.backup.summary.clone(),
        };
        self.entries()?.push(Entry {
            id: preview.id,
            session,
            created: Instant::now(),
            candidate,
        });
        Ok(preview)
    }

    pub fn take(&self, id: Uuid, session: &str) -> Result<ValidatedImport> {
        let mut entries = self.entries()?;
        entries.retain(|entry| entry.created.elapsed() < TTL);
        let index = entries
            .iter()
            .position(|entry| entry.id == id && entry.session == session)
            .ok_or_else(|| anyhow::anyhow!("This backup preview has expired or is unavailable"))?;
        Ok(entries.swap_remove(index).candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_imports_reject_work_and_release_unpublished_staging() {
        let dir = tempfile::tempdir().unwrap();
        let source = source(dir.path());
        let pending = PendingImports::default();
        let candidate = pending
            .reserve()
            .unwrap()
            .prepare(Path::new(source.path()), dir.path(), None, None)
            .unwrap();
        let staged = candidate.backup.access.path().to_owned();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = pending.entries.lock().unwrap();
            panic!("interrupted import publication");
        }));
        assert!(pending.reserve().is_err());
        assert!(pending.take(Uuid::new_v4(), "session").is_err());
        assert!(pending.publish(candidate, "session".into()).is_err());
        assert!(!Path::new(&staged).exists());
        assert_eq!(pending.capacity.available_permits(), 2);
    }

    fn source(root: &Path) -> super::super::DbAccess {
        let source = super::super::DbAccess::new(root.join("source.db").to_str().unwrap(), None);
        source.prepare().unwrap();
        source.run_migrations().unwrap();
        source
    }

    #[test]
    fn handles_are_session_bound_immutable_and_hold_capacity_until_consumed() {
        let dir = tempfile::tempdir().unwrap();
        let source = source(dir.path());
        let pending = PendingImports::default();
        let prepare = || {
            pending
                .reserve()
                .unwrap()
                .prepare(Path::new(source.path()), dir.path(), None, None)
                .unwrap()
        };
        let first = pending.publish(prepare(), "first".into()).unwrap();
        let second = pending.publish(prepare(), "first".into()).unwrap();
        assert!(pending.reserve().is_err());
        assert!(pending.take(first.id, "other").is_err());
        let candidate = pending.take(first.id, "first").unwrap();
        assert!(pending.take(first.id, "first").is_err());
        assert!(pending.reserve().is_err());
        std::fs::write(source.path(), b"source replaced after preview").unwrap();
        candidate
            .backup
            .access
            .connect_rusqlite()
            .unwrap()
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get::<_, i64>(0))
            .unwrap();
        let staged = candidate.backup.access.path().to_owned();
        drop(candidate);
        assert!(!Path::new(&staged).exists());
        assert!(pending.reserve().is_ok());
        drop(pending.take(second.id, "first").unwrap());
    }

    #[test]
    fn expiry_failure_and_abandoned_work_release_staging_and_permits() {
        let dir = tempfile::tempdir().unwrap();
        let source = source(dir.path());
        let pending = PendingImports::default();
        let reservation = pending.reserve().unwrap();
        assert!(pending.reserve().is_err());
        assert!(reservation
            .prepare(&dir.path().join("missing"), dir.path(), None, None)
            .is_err());
        let candidate = pending
            .reserve()
            .unwrap()
            .prepare(Path::new(source.path()), dir.path(), None, None)
            .unwrap();
        let staged = candidate.backup.access.path().to_owned();
        drop(candidate); // Cancelled before publication.
        assert!(!Path::new(&staged).exists());
        let candidate = pending
            .reserve()
            .unwrap()
            .prepare(Path::new(source.path()), dir.path(), None, None)
            .unwrap();
        let staged = candidate.backup.access.path().to_owned();
        let preview = pending.publish(candidate, "first".into()).unwrap();
        pending.entries.lock().unwrap()[0].created = Instant::now() - TTL;
        assert!(pending.take(preview.id, "first").is_err());
        assert!(!Path::new(&staged).exists());
        assert!(pending.reserve().is_ok());
    }
}
