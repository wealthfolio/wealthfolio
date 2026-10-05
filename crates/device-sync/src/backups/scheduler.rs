//! One profile-owned timer, reset by user actions and native lifecycle events.
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
pub struct BackupScheduler {
    wake: Notify,
    paused: AtomicBool,
    generation: AtomicU64,
    status: Mutex<CaptureStatus>,
}

/// Ephemeral, profile-local capture health. Never contains errors, secrets or portfolio data.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: CaptureState,
    pub retry_at: Option<chrono::DateTime<chrono::Utc>>,
    pub completed: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    #[default]
    Idle,
    Running,
    Failed,
}

/// An outer request timeout or task abort drops capture before its caller can
/// finalize status. Lifecycle changes are protected by `finished`'s generation check.
struct CaptureCancellation<'a> {
    scheduler: &'a BackupScheduler,
    generation: u64,
    armed: bool,
}

impl Drop for CaptureCancellation<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.scheduler.finished(self.generation, true);
        }
    }
}

impl BackupScheduler {
    /// Cancel admitted work using the existing lifecycle generation. Notify has
    /// one consumer (the due timer), so a bounded local wait observes revocation
    /// without stealing its wake. No cloud requests or detached task are added.
    pub async fn until_changed<F: Future>(&self, generation: u64, work: F) -> Option<F::Output> {
        if !self.is_current(generation) {
            return None;
        }
        let mut cancellation = CaptureCancellation {
            scheduler: self,
            generation,
            armed: true,
        };
        tokio::pin!(work);
        loop {
            tokio::select! {
                result = &mut work => {
                    cancellation.armed = false;
                    return self.is_current(generation).then_some(result);
                },
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    if !self.is_current(generation) { return None; }
                }
            }
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation() == generation
    }
    pub fn status(&self) -> CaptureStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
    pub fn started(&self, generation: u64) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.is_current(generation) {
            status.state = CaptureState::Running;
            status.retry_at = None;
        }
    }
    pub fn finished(&self, generation: u64, failed: bool) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.is_current(generation) {
            status.state = if failed {
                CaptureState::Failed
            } else {
                CaptureState::Idle
            };
            status.retry_at = failed.then(|| chrono::Utc::now() + chrono::Duration::minutes(30));
        }
    }

    pub fn published(&self, generation: u64) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.is_current(generation) {
            status.completed = status.completed.wrapping_add(1);
        }
    }
    pub fn wake(&self) {
        // Existing lifecycle/user notifications also invalidate an admitted capture.
        // An upload may finish, but an obsolete account/profile must not publish it.
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
        status.state = CaptureState::Idle;
        status.retry_at = None;
        self.wake.notify_one();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Mobile lifecycle events pause new checks; resume immediately checks whether one is due.
    pub fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::SeqCst) != paused {
            self.wake();
        }
    }

    /// Check once at startup, then sleep until due or a relevant state change.
    /// Disabled sources wait for a notification without making periodic requests.
    pub async fn run<F, Fut, E>(&self, check: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<Duration>, E>>,
    {
        self.run_with_clock(check, chrono::Utc::now).await;
    }

    async fn run_with_clock<F, Fut, E, C>(&self, mut check: F, now: C)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<Duration>, E>>,
        C: Fn() -> chrono::DateTime<chrono::Utc>,
    {
        loop {
            let wake = self.wake.notified();
            if self.is_paused() {
                wake.await;
                continue;
            }
            let generation = self.generation();
            let result = check().await;
            // A manual capture may own the export slot while this check waits.
            // Its status must not be overwritten by the competing due check.
            {
                let mut status = self
                    .status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if self.is_current(generation) && status.state != CaptureState::Running {
                    status.state = if result.is_err() {
                        CaptureState::Failed
                    } else {
                        CaptureState::Idle
                    };
                    status.retry_at = result
                        .is_err()
                        .then(|| chrono::Utc::now() + chrono::Duration::minutes(30));
                }
            }
            let next = result.unwrap_or(Some(Duration::from_secs(30 * 60)));
            match next {
                Some(delay) => {
                    // Instant may exclude suspended time. Bounded local waits
                    // recheck UTC without contacting the cloud on each tick.
                    let deadline = now()
                        + chrono::Duration::from_std(delay.max(Duration::from_secs(1)))
                            .unwrap_or(chrono::Duration::minutes(30));
                    let mut notified = Box::pin(wake);
                    loop {
                        let remaining = (deadline - now()).to_std().unwrap_or_default();
                        if remaining.is_zero() {
                            break;
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(remaining.min(Duration::from_secs(60))) => {},
                            _ = &mut notified => break,
                        }
                    }
                }
                None => wake.await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completing_capture_leaves_finalization_to_its_caller() {
        let scheduler = BackupScheduler::default();
        let generation = scheduler.generation();
        let result = scheduler
            .until_changed(generation, async {
                scheduler.started(generation);
                scheduler.published(generation);
                Ok::<_, ()>(())
            })
            .await
            .unwrap();
        assert_eq!(scheduler.status().state, CaptureState::Running);
        assert_eq!(scheduler.status().completed, 1);
        scheduler.finished(generation, result.is_err());
        assert_eq!(scheduler.status().state, CaptureState::Idle);
        assert!(scheduler.status().retry_at.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn request_timeout_releases_capture_and_exposes_retry() {
        let scheduler = BackupScheduler::default();
        let slot = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let generation = scheduler.generation();
        let capture = async {
            let _permit = slot.clone().try_acquire_owned().unwrap();
            let result = scheduler
                .until_changed(generation, async {
                    scheduler.started(generation);
                    std::future::pending::<Result<(), ()>>().await
                })
                .await
                .unwrap_or(Ok(()));
            scheduler.finished(generation, result.is_err());
        };

        assert!(tokio::time::timeout(Duration::from_secs(1), capture)
            .await
            .is_err());
        assert_eq!(slot.available_permits(), 1);
        let status = scheduler.status();
        assert_eq!(status.state, CaptureState::Failed);
        assert!(status.retry_at.is_some());
        assert_eq!(status.completed, 0);
    }

    #[tokio::test]
    async fn aborting_capture_preserves_status_after_a_lifecycle_change() {
        for change_generation in [false, true] {
            let scheduler = std::sync::Arc::new(BackupScheduler::default());
            let slot = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
            let generation = scheduler.generation();
            let (started, ready) = tokio::sync::oneshot::channel();
            let task = tokio::spawn({
                let scheduler = scheduler.clone();
                let slot = slot.clone();
                async move {
                    let _permit = slot.try_acquire_owned().unwrap();
                    let result = scheduler
                        .until_changed(generation, async {
                            scheduler.started(generation);
                            started.send(()).unwrap();
                            std::future::pending::<Result<(), ()>>().await
                        })
                        .await
                        .unwrap_or(Ok(()));
                    scheduler.finished(generation, result.is_err());
                }
            });
            ready.await.unwrap();
            if change_generation {
                scheduler.wake();
                scheduler.started(scheduler.generation());
            }
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert_eq!(slot.available_permits(), 1);
            let status = scheduler.status();
            assert_eq!(
                status.state,
                if change_generation {
                    CaptureState::Running
                } else {
                    CaptureState::Failed
                }
            );
            assert_eq!(status.retry_at.is_some(), !change_generation);
            assert_eq!(status.completed, 0);
        }
    }

    async fn run_test_clock<F, Fut, E>(scheduler: &BackupScheduler, check: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<Duration>, E>>,
    {
        let utc = chrono::Utc::now();
        let instant = tokio::time::Instant::now();
        scheduler
            .run_with_clock(check, || {
                utc + chrono::Duration::from_std(instant.elapsed()).unwrap()
            })
            .await;
    }

    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test(start_paused = true)]
    async fn lifecycle_change_drops_in_flight_work_and_releases_its_resources() {
        let scheduler = Arc::new(BackupScheduler::default());
        let lifecycle = Arc::new(tokio::sync::Mutex::new(()));
        let generation = scheduler.generation();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let lifecycle = lifecycle.clone();
            async move {
                scheduler
                    .until_changed(generation, async {
                        let _resource = lifecycle.lock().await;
                        started.send(()).unwrap();
                        tokio::time::sleep(Duration::from_secs(300)).await;
                        panic!("obsolete upload must never reach completion")
                    })
                    .await
            }
        });
        ready.await.unwrap();
        assert!(lifecycle.try_lock().is_err());
        scheduler.wake();
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(task.await.unwrap().is_none());
        assert!(lifecycle.try_lock().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn another_due_check_preserves_active_capture_and_completion_is_observable() {
        let scheduler = Arc::new(BackupScheduler::default());
        let generation = scheduler.generation();
        scheduler.started(generation);
        run_success_once(&scheduler).await;
        assert_eq!(scheduler.status().state, CaptureState::Running);
        scheduler.published(generation);
        scheduler.finished(generation, false);
        assert_eq!(scheduler.status().completed, 1);
        scheduler.wake();
        scheduler.published(generation);
        assert_eq!(
            scheduler.status().completed,
            1,
            "revoked work must not report success"
        );
        assert_eq!(scheduler.status().state, CaptureState::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn expected_waits_do_not_use_the_network_failure_retry_timer() {
        for wait in [
            super::super::client::BackupSource::AccessRequired,
            super::super::client::BackupSource::SubscriptionRequired,
        ] {
            let delay = wait.wait_delay();
            let scheduler = Arc::new(BackupScheduler::default());
            let calls = Arc::new(AtomicUsize::new(0));
            let task = tokio::spawn({
                let scheduler = scheduler.clone();
                let calls = calls.clone();
                async move {
                    run_test_clock(&scheduler, || {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok::<_, ()>(delay)
                        }
                    })
                    .await
                }
            });
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(23 * 60 * 60)).await;
            tokio::task::yield_now().await;
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(scheduler.status().state, CaptureState::Idle);
            tokio::time::advance(Duration::from_secs(60 * 60)).await;
            tokio::task::yield_now().await;
            assert_eq!(
                calls.load(Ordering::SeqCst),
                if delay.is_some() { 2 } else { 1 }
            );
            scheduler.wake();
            tokio::task::yield_now().await;
            assert_eq!(
                calls.load(Ordering::SeqCst),
                if delay.is_some() { 3 } else { 2 }
            );
            task.abort();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failure_is_visible_until_a_successful_check_and_wake_cancels_old_capture() {
        let scheduler = Arc::new(BackupScheduler::default());
        let generation = scheduler.generation();
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            async move { run_test_clock(&scheduler, || async { Err::<Option<Duration>, _>(()) }).await }
        });
        tokio::task::yield_now().await;
        assert_eq!(scheduler.status().state, CaptureState::Failed);
        assert!(scheduler.status().retry_at.is_some());
        scheduler.wake();
        assert!(!scheduler.is_current(generation));
        task.abort();
        let _ = task.await;
        run_success_once(&scheduler).await;
        assert_eq!(scheduler.status().state, CaptureState::Idle);
        assert!(scheduler.status().retry_at.is_none());
    }

    async fn run_success_once(scheduler: &BackupScheduler) {
        let run = run_test_clock(scheduler, || async { Ok::<_, ()>(None) });
        tokio::pin!(run);
        tokio::select! { _ = &mut run => {}, _ = tokio::task::yield_now() => {} }
    }

    #[tokio::test(start_paused = true)]
    async fn suspended_sources_make_no_checks_until_resume() {
        let scheduler = Arc::new(BackupScheduler::default());
        scheduler.set_paused(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let calls = calls.clone();
            async move {
                run_test_clock(&scheduler, || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, ()>(Some(Duration::from_secs(24 * 60 * 60)))
                    }
                })
                .await;
            }
        });
        tokio::task::yield_now().await;
        scheduler.wake();
        tokio::time::advance(Duration::from_secs(48 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        scheduler.set_paused(false);
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        scheduler.set_paused(true);
        tokio::time::advance(Duration::from_secs(48 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        scheduler.set_paused(false);
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn checks_startup_and_due_time_without_periodic_polling() {
        let scheduler = Arc::new(BackupScheduler::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let calls = calls.clone();
            async move {
                run_test_clock(&scheduler, || {
                    let calls = calls.clone();
                    async move {
                        let call = calls.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, ()>((call == 0).then_some(Duration::from_secs(24 * 60 * 60)))
                    }
                })
                .await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(23 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(7 * 24 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        scheduler.wake();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn state_changes_during_a_check_are_not_lost() {
        let scheduler = Arc::new(BackupScheduler::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let calls = calls.clone();
            async move {
                run_test_clock(&scheduler, || {
                    let scheduler = scheduler.clone();
                    let calls = calls.clone();
                    async move {
                        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            scheduler.wake();
                        }
                        Ok::<_, ()>(None)
                    }
                })
                .await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
    }
    #[tokio::test(start_paused = true)]
    async fn failed_checks_retry_after_a_delay_and_cancellation_stops_the_timer() {
        let scheduler = Arc::new(BackupScheduler::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let calls = calls.clone();
            async move {
                run_test_clock(&scheduler, || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Err::<Option<Duration>, _>(())
                    }
                })
                .await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(29 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        task.abort();
        let _ = task.await;
        tokio::time::advance(Duration::from_secs(24 * 60 * 60)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    use std::sync::{atomic::AtomicU64, Arc};
    #[tokio::test(start_paused = true)]
    async fn wall_clock_jump_checks_due_without_cloud_polling() {
        let scheduler = Arc::new(BackupScheduler::default());
        let seconds = Arc::new(AtomicU64::new(0));
        let calls = Arc::new(AtomicU64::new(0));
        let utc = chrono::Utc::now();
        let task = tokio::spawn({
            let scheduler = scheduler.clone();
            let seconds = seconds.clone();
            let calls = calls.clone();
            async move {
                scheduler
                    .run_with_clock(
                        || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            async { Ok::<_, ()>(Some(Duration::from_secs(86400))) }
                        },
                        || utc + chrono::Duration::seconds(seconds.load(Ordering::SeqCst) as i64),
                    )
                    .await;
            }
        });
        tokio::task::yield_now().await;
        for _ in 0..5 {
            tokio::time::advance(Duration::from_secs(60)).await;
            tokio::task::yield_now().await;
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "local ticks must not call cloud check"
        );
        seconds.store(48 * 3600, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "catch up after suspend even if Instant barely advances"
        );
        task.abort();
    }
}
