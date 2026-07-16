#[cfg(feature = "broker")]
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostLoginBootstrapStatus {
    Started,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostLoginBootstrapReason {
    FeatureDisabled,
    NotEntitled,
    NoConnections,
    AlreadyRunning,
    NotEnrolled,
    NotReady,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLoginBootstrapSyncResult {
    pub status: PostLoginBootstrapStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PostLoginBootstrapReason>,
}

impl PostLoginBootstrapSyncResult {
    pub fn started() -> Self {
        Self {
            status: PostLoginBootstrapStatus::Started,
            reason: None,
        }
    }

    pub fn skipped(reason: PostLoginBootstrapReason) -> Self {
        Self {
            status: PostLoginBootstrapStatus::Skipped,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostLoginBootstrapResult {
    pub broker_sync: PostLoginBootstrapSyncResult,
    pub device_sync: PostLoginBootstrapSyncResult,
}

pub struct BrokerSyncRunGuard {
    running: Arc<AtomicBool>,
}

impl Drop for BrokerSyncRunGuard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

pub fn acquire_broker_sync_guard(running: &Arc<AtomicBool>) -> Option<BrokerSyncRunGuard> {
    running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| BrokerSyncRunGuard {
            running: Arc::clone(running),
        })
}

#[cfg(feature = "broker")]
pub enum PostLoginBrokerBootstrapDecision<Guard> {
    Start(Guard),
    Skip(PostLoginBootstrapReason),
}

#[cfg(feature = "broker")]
pub fn is_active_broker_connection(connection: &crate::broker::BrokerConnection) -> bool {
    !connection.disabled
        && connection
            .status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("connected"))
}

#[cfg(feature = "broker")]
pub async fn prepare_post_login_broker_bootstrap<
    CheckEntitlement,
    CheckEntitlementFuture,
    ListConnections,
    ListConnectionsFuture,
    TryStart,
    Guard,
>(
    feature_enabled: bool,
    check_entitlement: CheckEntitlement,
    list_connections: ListConnections,
    try_start: TryStart,
) -> PostLoginBrokerBootstrapDecision<Guard>
where
    CheckEntitlement: FnOnce() -> CheckEntitlementFuture,
    CheckEntitlementFuture: Future<Output = Result<bool, String>>,
    ListConnections: FnOnce() -> ListConnectionsFuture,
    ListConnectionsFuture: Future<Output = Result<Vec<crate::broker::BrokerConnection>, String>>,
    TryStart: FnOnce() -> Option<Guard>,
{
    if !feature_enabled {
        return PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::FeatureDisabled);
    }

    match check_entitlement().await {
        Ok(true) => {}
        Ok(false) => {
            return PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::NotEntitled);
        }
        Err(err) => {
            log::debug!(
                "[Connect] Post-login broker sync skipped: could not verify entitlement ({})",
                err
            );
            return PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::Error);
        }
    }

    let connections = match list_connections().await {
        Ok(connections) => connections,
        Err(err) => {
            log::debug!(
                "[Connect] Post-login broker sync skipped: failed to inspect connections ({})",
                err
            );
            return PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::Error);
        }
    };

    if !connections.iter().any(is_active_broker_connection) {
        return PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::NoConnections);
    }

    match try_start() {
        Some(guard) => PostLoginBrokerBootstrapDecision::Start(guard),
        None => PostLoginBrokerBootstrapDecision::Skip(PostLoginBootstrapReason::AlreadyRunning),
    }
}
