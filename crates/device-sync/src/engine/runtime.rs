use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::{
    run_background_loop, run_sync_cycle, CredentialStore, OutboxStore, ReplayStore,
    SyncCycleResult, SyncTransport,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Flow Coordinator Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteTableInfo {
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteInfo {
    pub local_rows: i64,
    pub non_empty_tables: Vec<OverwriteTableInfo>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum PairingFlowPhase {
    OverwriteRequired { info: OverwriteInfo },
    Syncing { detail: String },
    Success,
    Error { message: String },
}

#[derive(Debug)]
pub struct PairingFlowState {
    pub phase: PairingFlowPhase,
    pub pairing_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingFlowResponse {
    pub flow_id: String,
    pub phase: PairingFlowPhase,
}

// ─────────────────────────────────────────────────────────────────────────────

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
    cycle_mutex: Mutex<()>,
    background_task: Mutex<Option<JoinHandle<()>>>,
    wake_handle: DeviceSyncWakeHandle,
    pub snapshot_upload_cancelled: AtomicBool,
    pairing_flows: std::sync::Mutex<HashMap<String, PairingFlowState>>,
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
            pairing_flows: std::sync::Mutex::new(HashMap::new()),
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

    // ─── Pairing flow store ──────────────────────────────────────────────

    fn flows(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, PairingFlowState>>, String> {
        self.pairing_flows.lock().map_err(|_| {
            "Pairing state is unavailable. Restart the application before pairing again."
                .to_string()
        })
    }

    pub fn create_flow(
        &self,
        pairing_id: String,
        phase: PairingFlowPhase,
    ) -> Result<String, String> {
        let flow_id = uuid::Uuid::new_v4().to_string();
        let mut flows = self.flows()?;
        flows.insert(flow_id.clone(), PairingFlowState { phase, pairing_id });
        Ok(flow_id)
    }

    pub fn get_flow_phase(&self, flow_id: &str) -> Result<Option<PairingFlowPhase>, String> {
        let flows = self.flows()?;
        Ok(flows.get(flow_id).map(|s| s.phase.clone()))
    }

    pub fn get_flow_pairing_id(&self, flow_id: &str) -> Result<Option<String>, String> {
        let flows = self.flows()?;
        Ok(flows.get(flow_id).map(|s| s.pairing_id.clone()))
    }

    pub fn set_flow_phase(&self, flow_id: &str, phase: PairingFlowPhase) -> Result<(), String> {
        let mut flows = self.flows()?;
        if let Some(state) = flows.get_mut(flow_id) {
            state.phase = phase;
        }
        Ok(())
    }

    pub fn remove_flow(&self, flow_id: &str) -> Result<(), String> {
        let mut flows = self.flows()?;
        flows.remove(flow_id);
        Ok(())
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;

    #[test]
    fn poisoned_pairing_state_returns_errors_for_every_operation() {
        let runtime = DeviceSyncRuntimeState::new();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = runtime.pairing_flows.lock().unwrap();
            panic!("interrupted pairing transition");
        }));
        assert!(runtime
            .create_flow("pairing".into(), PairingFlowPhase::Success)
            .is_err());
        assert!(runtime.get_flow_phase("flow").is_err());
        assert!(runtime.get_flow_pairing_id("flow").is_err());
        assert!(runtime
            .set_flow_phase("flow", PairingFlowPhase::Success)
            .is_err());
        assert!(runtime.remove_flow("flow").is_err());
    }

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
