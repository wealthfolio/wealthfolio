use chrono::{Days, NaiveDate};

use super::AccountStateSnapshot;

#[derive(Clone, Debug)]
pub struct HoldingsTimeline {
    start_date: Option<NaiveDate>,
    end_date: NaiveDate,
    keyframes: Vec<AccountStateSnapshot>,
    empty_state: Option<AccountStateSnapshot>,
    deferred_future_snapshots: bool,
}

impl HoldingsTimeline {
    pub(crate) fn new(
        start_date: Option<NaiveDate>,
        end_date: NaiveDate,
        keyframes: Vec<AccountStateSnapshot>,
        empty_state: Option<AccountStateSnapshot>,
        deferred_future_snapshots: bool,
    ) -> Self {
        Self {
            start_date,
            end_date,
            keyframes,
            empty_state,
            deferred_future_snapshots,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.start_date.is_none()
    }

    pub fn start_date(&self) -> Option<NaiveDate> {
        self.start_date
    }

    pub fn end_date(&self) -> Option<NaiveDate> {
        self.start_date.map(|_| self.end_date)
    }

    pub fn has_deferred_future_snapshots(&self) -> bool {
        self.deferred_future_snapshots
    }

    pub fn keyframes(&self) -> &[AccountStateSnapshot] {
        &self.keyframes
    }

    pub fn snapshot_at(&self, date: NaiveDate) -> Option<&AccountStateSnapshot> {
        let start = self.start_date?;
        if date < start || date > self.end_date {
            return None;
        }
        let index = self
            .keyframes
            .partition_point(|snapshot| snapshot.snapshot_date <= date);
        if index == 0 {
            self.empty_state.as_ref()
        } else {
            self.keyframes.get(index - 1)
        }
    }

    pub fn iter(&self) -> HoldingsTimelineIter<'_> {
        HoldingsTimelineIter {
            timeline: self,
            current_date: self.start_date,
            next_keyframe: 0,
            active_keyframe: None,
        }
    }
}

pub struct HoldingsTimelineDay<'a> {
    pub date: NaiveDate,
    pub snapshot: &'a AccountStateSnapshot,
}

pub struct HoldingsTimelineIter<'a> {
    timeline: &'a HoldingsTimeline,
    current_date: Option<NaiveDate>,
    next_keyframe: usize,
    active_keyframe: Option<usize>,
}

impl<'a> Iterator for HoldingsTimelineIter<'a> {
    type Item = HoldingsTimelineDay<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let date = self.current_date?;
            if date > self.timeline.end_date {
                self.current_date = None;
                return None;
            }

            while self.next_keyframe < self.timeline.keyframes.len()
                && self.timeline.keyframes[self.next_keyframe].snapshot_date <= date
            {
                self.active_keyframe = Some(self.next_keyframe);
                self.next_keyframe += 1;
            }

            let snapshot = self
                .active_keyframe
                .map(|index| &self.timeline.keyframes[index])
                .or(self.timeline.empty_state.as_ref());

            self.current_date = date.checked_add_days(Days::new(1));
            if let Some(snapshot) = snapshot {
                return Some(HoldingsTimelineDay { date, snapshot });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::Utc;
    use rust_decimal::Decimal;

    use super::*;
    use crate::portfolio::snapshot::SnapshotSource;

    fn snapshot(date: NaiveDate, marker: &str) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: marker.to_string(),
            account_id: "account".to_string(),
            snapshot_date: date,
            currency: "USD".to_string(),
            positions: HashMap::new(),
            cash_balances: HashMap::new(),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: Utc::now().naive_utc(),
            base_currency: None,
            source: SnapshotSource::ManualEntry,
        }
    }

    #[test]
    fn iterator_borrows_keyframe_until_next_change() {
        let first = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let second = NaiveDate::from_ymd_opt(2026, 8, 3).unwrap();
        let timeline = HoldingsTimeline::new(
            Some(first),
            NaiveDate::from_ymd_opt(2026, 8, 4).unwrap(),
            vec![snapshot(first, "first"), snapshot(second, "second")],
            None,
            false,
        );

        let markers: Vec<_> = timeline
            .iter()
            .map(|day| day.snapshot.id.as_str())
            .collect();
        assert_eq!(markers, vec!["first", "first", "second", "second"]);
    }

    #[test]
    fn interval_iteration_matches_independent_dense_reference() {
        let start = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 6).unwrap();
        let keyframes = vec![
            snapshot(NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(), "first"),
            snapshot(NaiveDate::from_ymd_opt(2026, 8, 3).unwrap(), "second"),
            snapshot(NaiveDate::from_ymd_opt(2026, 8, 6).unwrap(), "third"),
        ];
        let empty = snapshot(start, "empty");
        let timeline = HoldingsTimeline::new(
            Some(start),
            end,
            keyframes.clone(),
            Some(empty.clone()),
            false,
        );

        let interval: Vec<_> = timeline
            .iter()
            .map(|day| (day.date, day.snapshot.id.clone()))
            .collect();
        let dense: Vec<_> = start
            .iter_days()
            .take_while(|date| *date <= end)
            .map(|date| {
                let active = keyframes
                    .iter()
                    .filter(|snapshot| snapshot.snapshot_date <= date)
                    .max_by_key(|snapshot| snapshot.snapshot_date)
                    .unwrap_or(&empty);
                (date, active.id.clone())
            })
            .collect();

        assert_eq!(interval, dense);
    }
}
