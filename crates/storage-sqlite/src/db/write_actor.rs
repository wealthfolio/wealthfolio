use super::DbPool;
use crate::errors::StorageError;
use crate::sync::app_sync::ProjectedChange;
use crate::sync::{flush_projected_outbox, OutboxWriteRequest, SyncOutboxModel};
use diesel::SqliteConnection;
use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use wealthfolio_core::errors::{DatabaseError, Error, Result};
use wealthfolio_core::sync::SyncOperation;

struct WriteJobResult {
    value: Box<dyn Any + Send + 'static>,
    outbox_writes: usize,
}

// Type alias for the job to be executed by the writer actor.
// It takes a mutable reference to a SqliteConnection and returns a Result.
// We use core::Result here since that's what callers expect.
type Job = Box<dyn FnOnce(&mut SqliteConnection) -> Result<WriteJobResult> + Send + 'static>;
/// Called synchronously by the writer actor after a transaction commits outbox rows.
/// Implementations must stay non-blocking; use this only to signal lightweight wakeups.
pub type OutboxObserver = Arc<dyn Fn() + Send + Sync + 'static>;

/// A message for the writer actor: a job, or the request to stop.
///
/// Stopping travels through the same channel as the jobs so that it is observed
/// only after everything already queued has run — the actor drains naturally,
/// with no `select!` and no risk of dropping committed-but-unsent work.
#[allow(clippy::type_complexity)]
enum WriteMessage {
    Job(Job, oneshot::Sender<Result<Box<dyn Any + Send + 'static>>>),
    Shutdown(oneshot::Sender<()>),
}

/// Handle for sending jobs to the writer actor.
#[derive(Clone)]
pub struct WriteHandle {
    // Sender part of the MPSC channel to send jobs.
    // Each job is a boxed closure, and a oneshot sender is used for the reply.
    // The Box<dyn Any + Send> is used for type erasure of the job's return type.
    tx: mpsc::Sender<WriteMessage>,
}

/// Ownership of the writer actor's task.
///
/// The actor holds a pooled connection for the life of its task, so database
/// maintenance cannot proceed until that task has actually finished. Retaining
/// the `JoinHandle` is what makes "wait for it" possible at all.
pub struct WriterTask {
    join: tokio::task::JoinHandle<()>,
}

impl WriterTask {
    /// Waits for the actor's task to finish, after [`WriteHandle::shutdown`].
    pub async fn join(self) {
        if let Err(e) = self.join.await {
            log::warn!("Writer actor task did not exit cleanly: {}", e);
        }
    }
}

impl WriteHandle {
    /// Executes a database job on the writer actor's dedicated connection.
    ///
    /// # Arguments
    /// * `job`: A closure that takes a mutable reference to `SqliteConnection`
    ///   and performs database operations.
    ///
    /// # Returns
    /// A `Result<T>` containing the outcome of the job.
    pub async fn exec<F, T>(&self, job: F) -> Result<T>
    where
        F: FnOnce(&mut SqliteConnection) -> Result<T> + Send + 'static,
        T: Send + 'static + Any, // Add Any bound for T
    {
        self.exec_job(move |conn| {
            job(conn).map(|value| WriteJobResult {
                value: Box::new(value) as Box<dyn Any + Send>,
                outbox_writes: 0,
            })
        })
        .await
    }

    async fn exec_job<F, T>(&self, job: F) -> Result<T>
    where
        F: FnOnce(&mut SqliteConnection) -> Result<WriteJobResult> + Send + 'static,
        T: Send + 'static + Any,
    {
        let (ret_tx, ret_rx) = oneshot::channel();

        // The actor stops during database maintenance, so a closed channel is a
        // normal outcome that callers must be able to surface — not a panic.
        self.tx
            .send(WriteMessage::Job(Box::new(job), ret_tx))
            .await
            .map_err(|_| writer_stopped())?;

        ret_rx
            .await
            .map_err(|_| writer_stopped())?
            .map(|boxed: Box<dyn Any + Send + 'static>| {
                *boxed
                    .downcast::<T>()
                    .unwrap_or_else(|_| panic!("Failed to downcast writer actor result."))
            })
    }

    /// Executes a database job and appends projected sync-outbox records in the same transaction.
    pub async fn exec_projected<F, T>(&self, job: F) -> Result<T>
    where
        F: FnOnce(&mut SqliteConnection, &mut WriteProjection) -> Result<T> + Send + 'static,
        T: Send + 'static + Any,
    {
        self.exec_job(move |conn| {
            let mut projection = WriteProjection::default();
            let result = job(conn, &mut projection)?;
            let outbox_writes = projection.flush(conn)?;
            Ok(WriteJobResult {
                value: Box::new(result) as Box<dyn Any + Send>,
                outbox_writes,
            })
        })
        .await
    }

    /// Executes a database job using the centralized write transaction API.
    pub async fn exec_tx<F, T>(&self, job: F) -> Result<T>
    where
        F: FnOnce(&mut DbWriteTx<'_>) -> Result<T> + Send + 'static,
        T: Send + 'static + Any,
    {
        self.exec_job(move |conn| {
            let mut projection = WriteProjection::default();
            let result = {
                let mut tx = DbWriteTx {
                    conn,
                    projection: &mut projection,
                };
                job(&mut tx)?
            };
            let outbox_writes = projection.flush(conn)?;
            Ok(WriteJobResult {
                value: Box::new(result) as Box<dyn Any + Send>,
                outbox_writes,
            })
        })
        .await
    }

    /// Drains queued work, stops the actor and waits for its pooled connection
    /// to be released.
    ///
    /// Until this returns, the actor's connection keeps the database open — and
    /// that connection does not travel through `ServiceContext`, so dropping the
    /// context does not release it.
    pub async fn shutdown(&self) {
        let (ack_tx, ack_rx) = oneshot::channel();
        if self.tx.send(WriteMessage::Shutdown(ack_tx)).await.is_ok() {
            let _ = ack_rx.await;
        }
    }
}

fn writer_stopped() -> Error {
    Error::Database(DatabaseError::ConnectionFailed(
        "The database writer is not running. Database maintenance may be in progress.".to_string(),
    ))
}

pub struct DbWriteTx<'a> {
    conn: &'a mut SqliteConnection,
    projection: &'a mut WriteProjection,
}

impl<'a> DbWriteTx<'a> {
    pub fn conn(&mut self) -> &mut SqliteConnection {
        self.conn
    }

    pub fn run<T, F>(&mut self, job: F) -> Result<T>
    where
        F: FnOnce(&mut SqliteConnection) -> Result<T>,
    {
        job(self.conn)
    }

    pub fn queue_outbox(&mut self, request: OutboxWriteRequest) {
        self.projection.queue_outbox(request);
    }

    pub fn insert<T: SyncOutboxModel>(&mut self, model: &T) -> Result<()> {
        self.projection.capture_model(model, SyncOperation::Create)
    }

    pub fn update<T: SyncOutboxModel>(&mut self, model: &T) -> Result<()> {
        self.projection.capture_model(model, SyncOperation::Update)
    }

    pub fn delete<T: SyncOutboxModel>(&mut self, subject_id: impl Into<String>) {
        self.projection.capture_delete::<T>(subject_id);
    }

    pub fn delete_model<T: SyncOutboxModel>(&mut self, model: &T) {
        self.projection.capture_model_delete(model);
    }
}

/// Collects projected outbox writes and flushes them before transaction commit.
#[derive(Default)]
pub struct WriteProjection {
    outbox_requests: Vec<OutboxWriteRequest>,
    projected_changes: Vec<ProjectedChange>,
}

impl WriteProjection {
    pub fn queue_outbox(&mut self, request: OutboxWriteRequest) {
        self.outbox_requests.push(request);
    }

    /// Record a generic model mutation to be projected to outbox at commit-time.
    pub fn capture_model<T: SyncOutboxModel>(
        &mut self,
        model: &T,
        op: SyncOperation,
    ) -> Result<()> {
        if !model.should_sync_outbox(op) {
            return Ok(());
        }
        self.projected_changes
            .push(ProjectedChange::for_model(model, op)?);
        Ok(())
    }

    pub fn capture_create<T: SyncOutboxModel>(&mut self, model: &T) -> Result<()> {
        self.capture_model(model, SyncOperation::Create)
    }

    pub fn capture_update<T: SyncOutboxModel>(&mut self, model: &T) -> Result<()> {
        self.capture_model(model, SyncOperation::Update)
    }

    pub fn capture_delete<T: SyncOutboxModel>(&mut self, subject_id: impl Into<String>) {
        let subject_id = subject_id.into();
        if T::should_sync_outbox_delete(&subject_id) {
            self.projected_changes
                .push(ProjectedChange::delete_for_model::<T>(subject_id));
        }
    }

    pub fn capture_model_delete<T: SyncOutboxModel>(&mut self, model: &T) {
        if model.should_sync_outbox(SyncOperation::Delete) {
            self.capture_delete::<T>(model.sync_entity_id_owned());
        }
    }

    fn flush(self, conn: &mut SqliteConnection) -> Result<usize> {
        flush_projected_outbox(conn, self.outbox_requests, self.projected_changes)
    }
}

/// Spawns a background Tokio task that acts as a single writer to the database.
/// This actor owns one database connection from the pool and processes write jobs serially.
///
/// # Arguments
/// * `pool`: The database connection pool.
///
/// # Returns
/// A `WriteHandle` to send jobs to the spawned actor.
/// Spawns a writer and **detaches** its task.
///
/// Without the [`WriterTask`] nobody can wait for the actor's pooled connection
/// to be released, so database maintenance would fail its zero-connection proof.
/// Use [`spawn_writer_with_outbox_observer`] anywhere that matters; this is for
/// tests and throwaway pools.
pub fn spawn_writer(pool: DbPool) -> Result<WriteHandle> {
    spawn_writer_inner(pool, None).map(|(handle, _task)| handle)
}

pub fn spawn_writer_with_outbox_observer(
    pool: DbPool,
    outbox_observer: OutboxObserver,
) -> Result<(WriteHandle, WriterTask)> {
    spawn_writer_inner(pool, Some(outbox_observer))
}

fn spawn_writer_inner(
    pool: DbPool,
    outbox_observer: Option<OutboxObserver>,
) -> Result<(WriteHandle, WriterTask)> {
    fn acquire_writer_connection(pool: &DbPool) -> Result<super::DbConnection> {
        const PER_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(800);
        const RETRY_SLEEP: Duration = Duration::from_millis(200);
        const MAX_TOTAL_WAIT: Duration = Duration::from_secs(8);

        let start = Instant::now();
        let mut attempts: u32 = 0;
        let mut last_err: Option<String> = None;

        while start.elapsed() < MAX_TOTAL_WAIT {
            attempts += 1;
            match pool.get_timeout(PER_ATTEMPT_TIMEOUT) {
                Ok(conn) => return Ok(conn),
                Err(e) => {
                    last_err = Some(e.to_string());
                    log::warn!(
                        "Writer actor init: pool.get_timeout() attempt {} failed ({}), retrying...",
                        attempts,
                        e
                    );
                    std::thread::sleep(RETRY_SLEEP);
                }
            }
        }

        let reason = last_err.unwrap_or_else(|| "unknown pool acquisition error".to_string());
        Err(Error::Database(DatabaseError::ConnectionFailed(format!(
            "Failed to initialize writer connection after {} attempts within {:?}: {}",
            attempts, MAX_TOTAL_WAIT, reason
        ))))
    }

    let mut conn = acquire_writer_connection(&pool)?;

    // Create an MPSC channel for sending jobs to the actor.
    // The channel is bounded; 1024 is an arbitrary size.
    let (tx, mut rx) = mpsc::channel::<WriteMessage>(1024);

    let join = tokio::spawn(async move {
        let mut shutdown_ack: Option<oneshot::Sender<()>> = None;

        // Loop to receive and process jobs.
        while let Some(message) = rx.recv().await {
            let (job, reply_tx) = match message {
                WriteMessage::Job(job, reply_tx) => (job, reply_tx),
                WriteMessage::Shutdown(ack) => {
                    shutdown_ack = Some(ack);
                    break;
                }
            };

            // Execute the job within an immediate database transaction.
            // We wrap the job to return StorageError which implements From<diesel::result::Error>.
            // Then convert back to core::Error at the boundary.
            let result: Result<WriteJobResult> = conn
                .immediate_transaction::<_, StorageError, _>(|c| {
                    // Call the job and convert its error to StorageError if needed
                    job(c).map_err(StorageError::from)
                })
                .map_err(|e: StorageError| e.into());

            let result = result.map(|job_result| {
                if job_result.outbox_writes > 0 {
                    if let Some(observer) = &outbox_observer {
                        observer();
                    }
                }
                job_result.value
            });

            // Send the result back to the requester.
            // Ignore error if the receiver has dropped (e.g., request timed out or was cancelled).
            let _ = reply_tx.send(result);
        }
        // If rx.recv() returns None, it means every sender (WriteHandle) was
        // dropped, so the actor can terminate.

        // Release the pooled connection before acknowledging, so that a caller
        // awaiting the acknowledgement knows the database handle is gone.
        drop(conn);
        if let Some(ack) = shutdown_ack {
            let _ = ack.send(());
        }
    });

    Ok((WriteHandle { tx }, WriterTask { join }))
}

// Note: DbConnection (PooledConnection) derefs to SqliteConnection.
// The immediate_transaction method is on SqliteConnection via the Connection trait.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbAccess;
    use crate::sync::OutboxWriteRequest;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;
    use tokio::sync::oneshot as tokio_oneshot;
    use wealthfolio_core::sync::{SyncEntity, SyncOperation};

    fn setup_pool() -> DbPool {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        // An explicit path: `get_db_path` resolves to `$DATABASE_URL` when that
        // is set, which would point the test at a real database.
        let access = DbAccess::plaintext(format!("{app_data}/app.db"));
        access.prepare().expect("init db");
        access.run_migrations().expect("migrate db");
        access.create_pool().expect("create pool").as_ref().clone()
    }

    #[tokio::test]
    async fn notifies_observer_once_for_transaction_with_multiple_outbox_rows() {
        let notify_count = Arc::new(AtomicUsize::new(0));
        let observer_count = notify_count.clone();
        let (writer, _task) = spawn_writer_with_outbox_observer(
            setup_pool(),
            Arc::new(move || {
                observer_count.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("spawn writer");

        writer
            .exec_projected(|_conn, projection| {
                projection.queue_outbox(OutboxWriteRequest::new(
                    SyncEntity::CustomProvider,
                    "provider-1",
                    SyncOperation::Create,
                    json!({ "id": "provider-1", "name": "Provider 1" }),
                ));
                projection.queue_outbox(OutboxWriteRequest::new(
                    SyncEntity::CustomProvider,
                    "provider-2",
                    SyncOperation::Create,
                    json!({ "id": "provider-2", "name": "Provider 2" }),
                ));
                Ok(())
            })
            .await
            .expect("projected write");

        assert_eq!(notify_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn notifies_observer_even_if_caller_is_cancelled() {
        let notify_count = Arc::new(AtomicUsize::new(0));
        let observer_count = notify_count.clone();
        let (writer, _task) = spawn_writer_with_outbox_observer(
            setup_pool(),
            Arc::new(move || {
                observer_count.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("spawn writer");

        let (started_tx, started_rx) = tokio_oneshot::channel();
        let writer_for_task = writer.clone();
        let task = tokio::spawn(async move {
            writer_for_task
                .exec_projected(move |_conn, projection| {
                    started_tx.send(()).expect("signal writer started");
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    projection.queue_outbox(OutboxWriteRequest::new(
                        SyncEntity::CustomProvider,
                        "provider-cancelled",
                        SyncOperation::Create,
                        json!({ "id": "provider-cancelled", "name": "Provider Cancelled" }),
                    ));
                    Ok(())
                })
                .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(1), started_rx)
            .await
            .expect("writer job started")
            .expect("writer start signal sent");
        task.abort();
        let _ = task.await;

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(notify_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shutdown_releases_the_pooled_connection_and_fails_later_writes() {
        let pool = setup_pool();
        let (writer, task) =
            spawn_writer_with_outbox_observer(pool.clone(), Arc::new(|| {})).expect("spawn writer");

        writer
            .exec_tx(|tx| tx.run(|_conn| Ok(())))
            .await
            .expect("write before shutdown");

        writer.shutdown().await;
        task.join().await;

        // The actor's connection is what would otherwise keep the database open
        // through maintenance, so it must be back in the pool by now.
        assert_eq!(pool.state().idle_connections, pool.state().connections);

        // A write after shutdown is an error, not a panic: maintenance stops the
        // actor while commands may still be unwinding.
        let result = writer.exec_tx(|tx| tx.run(|_conn| Ok(()))).await;
        assert!(result.is_err(), "writes after shutdown must fail cleanly");
    }

    #[tokio::test]
    async fn shutdown_drains_work_already_queued() {
        let (writer, task) =
            spawn_writer_with_outbox_observer(setup_pool(), Arc::new(|| {})).expect("spawn writer");

        let queued = writer.exec_tx(|tx| {
            tx.run(|_conn| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                Ok(7u8)
            })
        });
        let stopped = writer.shutdown();

        let (queued, ()) = tokio::join!(queued, stopped);
        assert_eq!(queued.expect("queued write must still run"), 7);
        task.join().await;
    }

    #[tokio::test]
    async fn does_not_notify_observer_when_transaction_writes_no_outbox_rows() {
        let notify_count = Arc::new(AtomicUsize::new(0));
        let observer_count = notify_count.clone();
        let (writer, _task) = spawn_writer_with_outbox_observer(
            setup_pool(),
            Arc::new(move || {
                observer_count.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("spawn writer");

        writer
            .exec_tx(|tx| tx.run(|_conn| Ok(())))
            .await
            .expect("plain write");

        assert_eq!(notify_count.load(Ordering::SeqCst), 0);
    }
}
