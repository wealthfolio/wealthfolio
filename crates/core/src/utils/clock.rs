//! Process clock behind one function so tests can pin "now".
//!
//! Production reads the wall clock. Under `cfg(test)` a thread-local override
//! lets the legacy capture harness clamp every clock-relative calculation to a
//! scenario's `as_of` date (architecture §5). Only the current thread sees the
//! override: `spawn_blocking` workers keep the real clock, which is why the
//! harness strips `calculated_at` stamps from goldens instead of relying on
//! them being frozen.

use chrono::{DateTime, Utc};

#[cfg(test)]
thread_local! {
    static FROZEN_NOW: std::cell::Cell<Option<DateTime<Utc>>> =
        const { std::cell::Cell::new(None) };
}

/// Current UTC instant, or the frozen instant when a test pinned the clock on
/// this thread.
pub fn now() -> DateTime<Utc> {
    #[cfg(test)]
    if let Some(frozen) = FROZEN_NOW.with(|cell| cell.get()) {
        return frozen;
    }
    Utc::now()
}

/// Pins [`now`] on the current thread until the returned guard is dropped.
#[cfg(test)]
pub fn freeze(instant: DateTime<Utc>) -> FrozenClock {
    let previous = FROZEN_NOW.with(|cell| cell.replace(Some(instant)));
    FrozenClock { previous }
}

/// Re-pins [`now`] on the current thread while a [`freeze`] guard is active
/// (lifecycle scenarios advance "today" between steps).
#[cfg(test)]
pub fn set_frozen(instant: DateTime<Utc>) {
    FROZEN_NOW.with(|cell| cell.set(Some(instant)));
}

/// Guard returned by [`freeze`]; restores the previous override on drop.
#[cfg(test)]
pub struct FrozenClock {
    previous: Option<DateTime<Utc>>,
}

#[cfg(test)]
impl Drop for FrozenClock {
    fn drop(&mut self) {
        FROZEN_NOW.with(|cell| cell.set(self.previous));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn freeze_overrides_now_only_while_guard_lives() {
        let pinned = Utc.with_ymd_and_hms(2025, 3, 5, 12, 0, 0).unwrap();
        {
            let _guard = freeze(pinned);
            assert_eq!(now(), pinned);
        }
        assert_ne!(now(), pinned);
    }
}
