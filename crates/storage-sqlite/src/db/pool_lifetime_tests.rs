use super::*;
use std::sync::{mpsc, Mutex, Weak};

fn wait_for_release(lifetime: &Weak<DatabaseOwner>) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while lifetime.strong_count() != 0 {
        assert!(std::time::Instant::now() < deadline, "pool did not release");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn pool_retains_owner_through_raw_clones_and_checked_out_connections() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.db");
    let path = path.to_str().unwrap();
    let access = DbAccess::plaintext(path);
    let owner = Arc::new(DatabaseOwner::acquire(path).unwrap());
    let lifetime = Arc::downgrade(&owner);
    let pool = access.create_pool_with_owner(owner).unwrap();
    let outer = Arc::downgrade(&pool);
    let raw = pool.as_ref().clone();
    let mut connection = raw.get().unwrap();
    connection
        .batch_execute("PRAGMA journal_mode=WAL; CREATE TABLE probe (id INTEGER);")
        .unwrap();
    drop(pool);
    assert!(outer.upgrade().is_none());
    assert!(lifetime.upgrade().is_some());
    drop(raw);
    assert!(lifetime.upgrade().is_some());
    drop(connection);
    wait_for_release(&lifetime);
    maintenance::check_sqlite_locks(&access).unwrap();
    DatabaseOwner::acquire(path).unwrap();
}

#[derive(Debug)]
struct BlockingManager {
    inner: ConnectionManager<SqliteConnection>,
    started: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl r2d2::ManageConnection for BlockingManager {
    type Connection = SqliteConnection;
    type Error = diesel::r2d2::Error;

    fn connect(&self) -> std::result::Result<Self::Connection, Self::Error> {
        self.started.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        self.inner.connect()
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> std::result::Result<(), Self::Error> {
        self.inner.is_valid(conn)
    }

    fn has_broken(&self, conn: &mut Self::Connection) -> bool {
        self.inner.has_broken(conn)
    }
}

#[test]
fn failed_pool_build_retains_owner_until_internal_connector_finishes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.db").to_str().unwrap().to_owned();
    let owner = Arc::new(DatabaseOwner::acquire(&path).unwrap());
    let lifetime = Arc::downgrade(&owner);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let manager = BlockingManager {
        inner: ConnectionManager::new(&path),
        started: started_tx,
        release: Mutex::new(release_rx),
    };
    let builder = std::thread::spawn(move || {
        r2d2::Pool::builder()
            .max_size(1)
            .min_idle(Some(1))
            .connection_timeout(Duration::from_millis(100))
            .connection_customizer(Box::new(ConnectionCustomizer {
                key: None,
                _owner: Some(owner),
            }))
            .build(manager)
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(builder.join().unwrap().is_err());
    // No application pool exists, but the connector can still open the file.
    assert!(lifetime.upgrade().is_some());
    assert!(DatabaseOwner::acquire(&path).is_err());
    release_tx.send(()).unwrap();
    wait_for_release(&lifetime);
    let _owner = DatabaseOwner::acquire(&path).unwrap();
    maintenance::check_sqlite_locks(&DbAccess::plaintext(&path)).unwrap();
}

#[test]
fn owned_pool_rejects_a_different_database_before_opening_it() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned.db");
    let other = root.path().join("other.db");
    let owner = Arc::new(DatabaseOwner::acquire(path.to_str().unwrap()).unwrap());
    let result = DbAccess::plaintext(other.to_str().unwrap()).create_pool_with_owner(owner);
    assert!(result.is_err());
    assert!(!other.exists());
}
