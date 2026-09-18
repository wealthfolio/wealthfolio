//! Opt-in storage workload; run the compiled test under the OS memory profiler.
use std::{
    fs,
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use wealthfolio_storage_sqlite::db::{self, maintenance, portable, DbAccess, DbEncryptionKey};

// Apparent file sizes, sampled every 10ms. Transient files can disappear between
// read_dir and metadata; other I/O failures must not silently undercount a run.
fn bytes(path: &Path) -> std::io::Result<u64> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut total = 0;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    for entry in entries {
        total += bytes(&entry?.path())?;
    }
    Ok(total)
}

fn measure<T>(phase: &str, root: &Path, operation: impl FnOnce() -> T) -> T {
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let observer = scope.spawn(|| {
            let mut peak = bytes(root).unwrap();
            while !stop.load(Ordering::Relaxed) {
                peak = peak.max(bytes(root).unwrap());
                std::thread::sleep(Duration::from_millis(10));
            }
            peak.max(bytes(root).unwrap())
        });
        let started = Instant::now();
        // Stop observation on panic too; otherwise scoped-thread join would hang.
        struct Stop<'a>(&'a AtomicBool);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let guard = Stop(&stop);
        let result = operation();
        let elapsed = started.elapsed().as_secs_f64();
        drop(guard);
        let peak = observer.join().unwrap();
        println!(
            "RESOURCE {}",
            serde_json::json!({
                "phase": phase, "elapsedSeconds": elapsed, "sampledPeakWorkdirBytes": peak,
            })
        );
        result
    })
}

#[test]
#[ignore = "Synthetic resource workload; run explicitly, outside normal CI"]
fn portable_backup_resource_matrix() {
    let rows: i64 = std::env::var("WF_BACKUP_BENCH_ROWS")
        .unwrap_or_else(|_| "100000".into())
        .parse()
        .unwrap();
    assert!((100..=1_000_000).contains(&rows));
    let populated = match std::env::var("WF_BACKUP_BENCH_POPULATED")
        .as_deref()
        .unwrap_or("1")
    {
        "1" => true,
        "0" => false,
        _ => panic!("WF_BACKUP_BENCH_POPULATED must be 0 or 1"),
    };
    let root = tempfile::tempdir().unwrap();
    let source_path = root.path().join("source.db");
    let mut source = DbAccess::plaintext(source_path.to_str().unwrap());
    let owner = db::DatabaseOwner::acquire(source.path()).unwrap();
    source.prepare().unwrap();
    source.run_migrations().unwrap();
    let mut conn = source.connect_rusqlite().unwrap();
    let tx = conn.transaction().unwrap();
    for account in 0..100 {
        tx.execute(
            "INSERT INTO accounts(id,name,currency) VALUES (?1,?2,'USD')",
            rusqlite::params![
                format!("account-{account}"),
                format!("Synthetic account {account}")
            ],
        )
        .unwrap();
    }
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO activities
            (id,account_id,activity_type,activity_date,amount,currency,notes,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,'USD',?6,?4,?4)",
            )
            .unwrap();
        for row in 0..rows {
            insert
                .execute(rusqlite::params![
                    format!("activity-{row:08}"),
                    format!("account-{}", row % 100),
                    ["DEPOSIT", "WITHDRAWAL", "INTEREST", "FEE"][row as usize % 4],
                    format!("2025-{:02}-{:02}T12:00:00Z", row % 12 + 1, row % 28 + 1),
                    format!("{}.123456789012345678", row % 10000),
                    format!(
                        "Synthetic imported activity {row}: {}",
                        "portfolio memo ".repeat(8)
                    ),
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    let cipher: String = conn
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .unwrap();
    drop(conn);
    println!(
        "RESOURCE {}",
        serde_json::json!({
            "appVersion": env!("CARGO_PKG_VERSION"), "sqlcipher": cipher,
            "accounts": 100, "activities": rows, "populatedDestination": populated, "sourceBytes": fs::metadata(source.path()).unwrap().len(),
            "profile": "100 accounts; deposit/withdrawal/interest/fee; decimal amounts; 8 repeated memo phrases",
        })
    );

    for encrypted_source in [false, true] {
        if encrypted_source {
            source = maintenance::run(
                root.path().to_str().unwrap(),
                &source,
                maintenance::MaintenanceRequest::Enable {
                    key: Arc::new(DbEncryptionKey::generate()),
                },
                &owner,
            )
            .unwrap()
            .access;
        }
        for protected in [false, true] {
            let case = format!("source-{encrypted_source}-protected-{protected}");
            let scratch = tempfile::tempdir_in(root.path()).unwrap();
            let password = protected.then_some("resource benchmark password 日本語");
            let exported = measure(&format!("{case}-export"), root.path(), || {
                portable::export(&source, scratch.path(), password).unwrap()
            });
            let prepared = measure(&format!("{case}-inspect"), root.path(), || {
                portable::prepare_import(&exported.path, scratch.path(), password, None).unwrap()
            });
            assert_eq!(prepared.summary.account_count, 100);
            assert_eq!(prepared.summary.activity_count, rows);
            for encrypted_destination in [false, true] {
                let destination_root = tempfile::tempdir_in(root.path()).unwrap();
                let destination = DbAccess::new(
                    destination_root.path().join("app.db").to_str().unwrap(),
                    encrypted_destination.then(|| Arc::new(DbEncryptionKey::generate())),
                );
                let destination_owner = db::DatabaseOwner::acquire(destination.path()).unwrap();
                destination.prepare().unwrap();
                destination.run_migrations().unwrap();
                let restore = || {
                    maintenance::run(
                        destination_root.path().to_str().unwrap(),
                        &destination,
                        maintenance::MaintenanceRequest::Restore {
                            backup_path: prepared.access.path().into(),
                            device_key: prepared.access.key().cloned(),
                        },
                        &destination_owner,
                    )
                    .unwrap();
                };
                if populated {
                    // Setup is outside the timed phase, but included in process
                    // RSS. Replacement must back up an equally large live DB.
                    restore();
                    destination
                        .connect_rusqlite()
                        .unwrap()
                        .execute(
                            "UPDATE activities SET amount='999.99' WHERE id='activity-00000001'",
                            [],
                        )
                        .unwrap();
                }
                measure(
                    &format!("{case}-restore-{encrypted_destination}"),
                    root.path(),
                    restore,
                );
                let conn = destination.connect_rusqlite().unwrap();
                let count: i64 = conn
                    .query_row("SELECT count(*) FROM activities", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(count, rows);
                let amount: String = conn
                    .query_row(
                        "SELECT amount FROM activities WHERE id='activity-00000001'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(amount, "1.123456789012345678");
                let mut header = [0; 16];
                fs::File::open(destination.path())
                    .unwrap()
                    .read_exact(&mut header)
                    .unwrap();
                assert_eq!(
                    !header.starts_with(b"SQLite format 3\0"),
                    encrypted_destination
                );
            }
        }
    }
}
