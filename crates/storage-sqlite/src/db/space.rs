//! A last preflight before replacement, not a reservation or a disk quota.
use std::{io, path::Path};

// Leave room for reopening SQLite and small filesystem/journal updates too.
const HEADROOM: u64 = 16 * 1024 * 1024;

pub(super) fn require(directory: &Path, recovery_bytes: u64) -> io::Result<()> {
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Recovery space must be checked on a directory",
        ));
    }
    #[cfg(test)]
    let available = AVAILABLE
        .with(|value| value.get())
        .map_or_else(|| fs2::available_space(directory), Ok);
    #[cfg(not(test))]
    let available = fs2::available_space(directory);
    let available = available.map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Cannot check free space in {}: {error}",
                directory.display()
            ),
        )
    })?;
    let required = recovery_bytes.saturating_add(HEADROOM);
    if available < required {
        return Err(io::Error::other(format!(
            "Not enough free space in {} to preserve recovery data: need at least {required} bytes, available {available} bytes. Free space and retry; the live database has not been replaced.",
            directory.display(),
        )));
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static AVAILABLE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(super) fn with_available<T>(bytes: u64, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<u64>);
    impl Drop for Reset {
        fn drop(&mut self) {
            AVAILABLE.with(|value| value.set(self.0));
        }
    }
    let _reset = Reset(AVAILABLE.with(|value| value.replace(Some(bytes))));
    run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_budget_has_headroom_and_cannot_overflow() {
        let root = tempfile::tempdir().unwrap();
        with_available(HEADROOM, || {
            require(root.path(), 0).unwrap();
            assert!(require(root.path(), 1).is_err());
            assert!(require(root.path(), u64::MAX).is_err());
        });
    }

    #[test]
    fn missing_filesystem_path_is_an_actionable_error() {
        let root = tempfile::tempdir().unwrap();
        let error = require(&root.path().join("missing"), 0).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
