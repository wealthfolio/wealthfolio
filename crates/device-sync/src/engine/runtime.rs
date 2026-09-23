use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::{
    run_background_loop, run_sync_cycle, CredentialStore, OutboxStore, ReplayStore,
    SyncCycleResult, SyncTransport,
};

#[derive(Debug, Clone)]
pub struct DeviceSyncWakeHandle {
    notify: Arc<Notify>,
}

impl DeviceSyncWakeHandle {
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn notify_work_available(&self) {
        self.notify.notify_one();
    }

    pub async fn wait_for_work(&self) {
        self.notify.notified().await;
    }
}

impl Default for DeviceSyncWakeHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct DeviceSyncRuntimeState {
    pub(super) cycle_mutex: Mutex<()>,
    background_task: Mutex<Option<JoinHandle<()>>>,
    wake_handle: DeviceSyncWakeHandle,
    pub snapshot_upload_cancelled: AtomicBool,
    /// The profile's single restore operation; see `restore.rs`.
    pub(super) restore: std::sync::Mutex<super::restore::RestoreSlot>,
}

impl DeviceSyncRuntimeState {
    pub fn new() -> Self {
        Self::with_wake_handle(DeviceSyncWakeHandle::new())
    }

    pub fn with_wake_handle(wake_handle: DeviceSyncWakeHandle) -> Self {
        Self {
            cycle_mutex: Mutex::new(()),
            background_task: Mutex::new(None),
            wake_handle,
            snapshot_upload_cancelled: AtomicBool::new(false),
            restore: std::sync::Mutex::new(Default::default()),
        }
    }
}

impl Default for DeviceSyncRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceSyncRuntimeState {
    pub async fn run_cycle_serialized<P>(
        &self,
        ports: &P,
        post_bootstrap: bool,
    ) -> Result<SyncCycleResult, String>
    where
        P: OutboxStore + ReplayStore + SyncTransport + CredentialStore + Send + Sync,
    {
        let _cycle_guard = self.cycle_mutex.lock().await;
        run_sync_cycle(ports, post_bootstrap).await
    }

    pub async fn run_cycle<P>(
        &self,
        ports: &P,
        post_bootstrap: bool,
    ) -> Result<SyncCycleResult, String>
    where
        P: OutboxStore + ReplayStore + SyncTransport + CredentialStore + Send + Sync,
    {
        self.run_cycle_serialized(ports, post_bootstrap).await
    }

    pub fn notify_sync_work_available(&self) {
        self.wake_handle.notify_work_available();
    }

    pub(crate) async fn wait_for_sync_work(&self) {
        self.wake_handle.wait_for_work().await;
    }

    pub async fn ensure_background_started<P>(self: &Arc<Self>, ports: Arc<P>)
    where
        P: OutboxStore + ReplayStore + SyncTransport + CredentialStore + Send + Sync + 'static,
    {
        let mut guard = self.background_task.lock().await;
        if let Some(handle) = guard.as_ref() {
            if !handle.is_finished() {
                return;
            }
            guard.take();
        }

        let runtime = Arc::clone(self);
        let handle = tokio::spawn(async move {
            run_background_loop(runtime, ports).await;
        });
        *guard = Some(handle);
    }

    pub async fn ensure_background_stopped(&self) {
        let mut guard = self.background_task.lock().await;
        if let Some(handle) = guard.take() {
            handle.abort();
            let _ = handle.await;
        }
    }

    pub async fn is_background_running(&self) -> bool {
        let guard = self.background_task.lock().await;
        guard.as_ref().is_some_and(|handle| !handle.is_finished())
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;

    #[tokio::test]
    async fn stopping_background_waits_for_captured_resources_to_drop() {
        let runtime = DeviceSyncRuntimeState::new();
        let resource = Arc::new(());
        let captured = resource.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        *runtime.background_task.lock().await = Some(tokio::spawn(async move {
            let _resource = captured;
            let _ = started.send(());
            std::future::pending::<()>().await;
        }));
        ready.await.unwrap();
        runtime.ensure_background_stopped().await;
        assert_eq!(Arc::strong_count(&resource), 1);
        assert!(!runtime.is_background_running().await);
        runtime.ensure_background_stopped().await;
    }
}
