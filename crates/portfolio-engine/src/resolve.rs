//! FX resolution over an observation surface (architecture §4.3, the resolve stage; FX half).
//! Codifies the legacy ladder as policy: minor-unit normalization, per-day
//! direct or inverse observation, bidirectional nearest observation (tie →
//! past), then a deterministic fewest-hops path through intermediate
//! currencies. No "latest rate of any date" last resort (EDGE-FX-07).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::model::{FxObservation, Policy};

type Pair = (String, String);

#[derive(Debug, Clone, Default)]
pub struct FxSurface {
    series: BTreeMap<Pair, BTreeMap<NaiveDate, Decimal>>,
    /// Sorted adjacency so path search is order-independent.
    adjacency: BTreeMap<String, BTreeSet<String>>,
}

impl FxSurface {
    /// Builds the surface; every observation also registers its inverse.
    pub fn from_observations(observations: &[FxObservation]) -> Self {
        let mut surface = Self::default();
        for observation in observations {
            let from = observation.from.as_str().to_string();
            let to = observation.to.as_str().to_string();
            if from == to {
                continue;
            }
            surface
                .series
                .entry((from.clone(), to.clone()))
                .or_default()
                .insert(observation.day, observation.rate);
            surface
                .adjacency
                .entry(from.clone())
                .or_default()
                .insert(to.clone());
            if !observation.rate.is_zero() {
                surface
                    .series
                    .entry((to.clone(), from.clone()))
                    .or_default()
                    .insert(observation.day, Decimal::ONE / observation.rate);
                surface.adjacency.entry(to).or_default().insert(from);
            }
        }
        surface
    }

    pub fn is_empty(&self) -> bool {
        self.series.is_empty()
    }

    /// Nearest observation for a direct pair: exact day, else the closer of
    /// the last-before and first-after observations (tie → past).
    fn direct_rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<Decimal> {
        let history = self.series.get(&(from.to_string(), to.to_string()))?;
        let prev = history.range(..=date).next_back();
        let next = history.range(date..).next();
        match (prev, next) {
            (Some((d1, r1)), Some((d2, r2))) => {
                if d1 == d2 {
                    return Some(*r1);
                }
                let dist_prev = (date - *d1).num_days().abs();
                let dist_next = (*d2 - date).num_days().abs();
                Some(if dist_prev <= dist_next { *r1 } else { *r2 })
            }
            (Some((_, rate)), None) | (None, Some((_, rate))) => Some(*rate),
            (None, None) => None,
        }
    }

    /// Rate between major-unit codes: direct pair first, else the fewest-hops
    /// path (neighbors visited in code order, so equal-length paths resolve
    /// deterministically), each hop nearest-neighbour resolved on `date`.
    fn path_rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<Decimal> {
        if from == to {
            return Some(Decimal::ONE);
        }
        let mut queue: VecDeque<(String, Decimal)> = VecDeque::new();
        let mut visited: BTreeSet<String> = BTreeSet::new();
        queue.push_back((from.to_string(), Decimal::ONE));
        visited.insert(from.to_string());
        while let Some((current, accumulated)) = queue.pop_front() {
            if current == to {
                return Some(accumulated);
            }
            let Some(neighbors) = self.adjacency.get(&current) else {
                continue;
            };
            for neighbor in neighbors {
                if visited.contains(neighbor) {
                    continue;
                }
                if let Some(rate) = self.direct_rate(&current, neighbor, date) {
                    visited.insert(neighbor.clone());
                    queue.push_back((neighbor.clone(), accumulated * rate));
                }
            }
        }
        None
    }
}

/// Resolution under a policy: applies the minor-unit table before consulting
/// the surface (legacy `get_exchange_rate_for_date`).
pub struct FxResolver<'a> {
    pub surface: &'a FxSurface,
    pub policy: &'a Policy,
}

impl FxResolver<'_> {
    /// Units of `to` per unit of `from` on `date`, or `None` when unresolvable.
    pub fn rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<Decimal> {
        if from == to {
            return Some(Decimal::ONE);
        }
        if !valid_code(from) || !valid_code(to) {
            return None;
        }
        let (major_from, from_factor) = self.policy.normalize_currency(from);
        let (major_to, to_factor) = self.policy.normalize_currency(to);
        // A minor-unit source scales down into major units; a minor-unit
        // target scales back up.
        let source_multiplier = if major_from == from {
            Decimal::ONE
        } else {
            from_factor
        };
        let target_multiplier = if major_to == to {
            Decimal::ONE
        } else {
            Decimal::ONE / to_factor
        };
        if major_from == major_to {
            return Some(source_multiplier * target_multiplier);
        }
        let base_rate = self.surface.path_rate(major_from, major_to, date)?;
        Some(source_multiplier * base_rate * target_multiplier)
    }

    pub fn convert(
        &self,
        amount: Decimal,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> Option<Decimal> {
        if from == to {
            return Some(amount);
        }
        self.rate(from, to, date).map(|rate| amount * rate)
    }
}

/// Legacy validation: three alphabetic characters.
fn valid_code(code: &str) -> bool {
    code.len() == 3 && code.chars().all(|c| c.is_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Currency;
    use rust_decimal_macros::dec;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2025, 1, d).unwrap()
    }

    fn observation(from: &str, to: &str, d: u32, rate: Decimal) -> FxObservation {
        FxObservation {
            from: Currency::parse(from).unwrap(),
            to: Currency::parse(to).unwrap(),
            day: day(d),
            rate,
        }
    }

    fn policy() -> Policy {
        Policy::new(Currency::parse("USD").unwrap(), chrono_tz::UTC, day(31))
    }

    #[test]
    fn nearest_observation_prefers_past_on_ties_and_looks_forward() {
        let surface = FxSurface::from_observations(&[
            observation("USD", "CAD", 6, dec!(1.30)),
            observation("USD", "CAD", 9, dec!(1.40)),
        ]);
        let policy = policy();
        let fx = FxResolver {
            surface: &surface,
            policy: &policy,
        };
        assert_eq!(fx.rate("USD", "CAD", day(7)), Some(dec!(1.30)));
        assert_eq!(fx.rate("USD", "CAD", day(8)), Some(dec!(1.40)));
        assert_eq!(fx.rate("USD", "CAD", day(20)), Some(dec!(1.40)));
        assert_eq!(fx.rate("USD", "CAD", day(1)), Some(dec!(1.30)));
        assert_eq!(fx.rate("CAD", "USD", day(6)), Some(dec!(1) / dec!(1.30)));
    }

    #[test]
    fn multi_hop_and_minor_units() {
        let surface = FxSurface::from_observations(&[
            observation("EUR", "CHF", 2, dec!(0.95)),
            observation("CHF", "USD", 2, dec!(1.10)),
        ]);
        let policy = policy();
        let fx = FxResolver {
            surface: &surface,
            policy: &policy,
        };
        assert_eq!(fx.rate("EUR", "USD", day(2)), Some(dec!(0.95) * dec!(1.10)));
        assert_eq!(fx.rate("GBp", "GBP", day(2)), Some(dec!(0.01)));
        assert_eq!(fx.rate("GBP", "GBp", day(2)), Some(dec!(100)));
        assert_eq!(fx.rate("XYZ", "USD", day(2)), None);
        assert_eq!(fx.rate("", "USD", day(2)), None);
    }
}

// ------------------------------------------------------------------ quotes

use crate::model::{ActivityKind, AssetId, CanonicalFacts, DateRange, QuoteObservation};

/// Quote observations per asset, sorted by day (the last observation of a
/// day wins).
#[derive(Debug, Clone, Default)]
pub struct QuoteSurface {
    by_asset: BTreeMap<AssetId, Vec<QuoteObservation>>,
}

impl QuoteSurface {
    pub fn from_observations(observations: &[QuoteObservation]) -> Self {
        let mut by_asset: BTreeMap<AssetId, BTreeMap<NaiveDate, QuoteObservation>> =
            BTreeMap::new();
        for observation in observations {
            by_asset
                .entry(observation.asset.clone())
                .or_default()
                .insert(observation.day, observation.clone());
        }
        Self {
            by_asset: by_asset
                .into_iter()
                .map(|(asset, days)| (asset, days.into_values().collect()))
                .collect(),
        }
    }

    pub fn has_quotes(&self, asset: &AssetId) -> bool {
        self.by_asset.contains_key(asset)
    }

    /// Unbounded carry-forward: the latest observation on or before `day`.
    pub fn latest_on_or_before(
        &self,
        asset: &AssetId,
        day: NaiveDate,
    ) -> Option<&QuoteObservation> {
        let series = self.by_asset.get(asset)?;
        let index = series.partition_point(|quote| quote.day <= day);
        (index > 0).then(|| &series[index - 1])
    }

    /// Positive closes by day (split-adjustment heuristic input).
    fn positive_closes(&self, asset: &AssetId) -> BTreeMap<NaiveDate, Decimal> {
        self.by_asset
            .get(asset)
            .map(|series| {
                series
                    .iter()
                    .filter(|quote| quote.close > Decimal::ZERO)
                    .map(|quote| (quote.day, quote.close))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// A split whose quote series is already provider-adjusted, so closes before
/// `split_date` must be multiplied by `ratio` when pricing pre-split holdings.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitEvent {
    pub asset: AssetId,
    pub split_date: NaiveDate,
    pub ratio: Decimal,
}

/// Surfaces resolved ONCE over the full range (architecture §4.3, the resolve stage).
#[derive(Debug, Clone)]
pub struct ResolvedSurfaces {
    pub quotes: QuoteSurface,
    pub fx: FxSurface,
    pub splits: Vec<SplitEvent>,
}

impl ResolvedSurfaces {
    /// Product of the ratios of adjusted splits strictly after `date`.
    pub fn split_price_factor(&self, asset: &AssetId, date: NaiveDate) -> Decimal {
        self.splits
            .iter()
            .filter(|event| event.asset == *asset && date < event.split_date)
            .fold(Decimal::ONE, |factor, event| factor * event.ratio)
    }
}

pub fn resolve_surfaces(facts: &CanonicalFacts, range: DateRange) -> ResolvedSurfaces {
    let quotes = QuoteSurface::from_observations(&facts.quotes);
    let fx = FxSurface::from_observations(&facts.fx_rates);
    let splits = adjusted_split_events(facts, &quotes, range);
    ResolvedSurfaces { quotes, fx, splits }
}

/// Legacy `select_shared_split_activities` + `quotes_appear_split_adjusted`:
/// per asset, split rows within one day of each other form one cluster; the
/// best-ranked row (user-modified / MANUAL / CSV / untagged, then latest
/// update, then id) represents it; the event counts only when the quote
/// series already looks adjusted around the split date.
fn adjusted_split_events(
    facts: &CanonicalFacts,
    quotes: &QuoteSurface,
    range: DateRange,
) -> Vec<SplitEvent> {
    const MERGE_GAP_DAYS: i64 = 1;
    let mut candidates: BTreeMap<&AssetId, Vec<(&crate::model::Activity, Decimal)>> =
        BTreeMap::new();
    for activity in &facts.activities {
        if activity.kind != ActivityKind::Split {
            continue;
        }
        let Some(asset) = &activity.asset else {
            continue;
        };
        let ratio = if activity.amount.is_some_and(|a| a > Decimal::ZERO) {
            activity.amount.unwrap_or_default()
        } else {
            activity.quantity
        };
        if ratio <= Decimal::ZERO {
            continue;
        }
        candidates.entry(asset).or_default().push((activity, ratio));
    }

    let rank = |activity: &crate::model::Activity| -> u8 {
        if activity.is_user_modified {
            return 3;
        }
        match activity.source_system.as_deref() {
            None => 3,
            Some(source)
                if source.eq_ignore_ascii_case("MANUAL") || source.eq_ignore_ascii_case("CSV") =>
            {
                3
            }
            Some(source) if source.eq_ignore_ascii_case("GENERATED") => 1,
            Some(_) => 2,
        }
    };

    let mut events = Vec::new();
    for (asset, mut rows) in candidates {
        rows.sort_by_key(|(activity, _)| activity.date);
        let mut clusters: Vec<Vec<(&crate::model::Activity, Decimal)>> = Vec::new();
        for row in rows {
            match clusters.last_mut() {
                Some(cluster)
                    if cluster.last().is_some_and(|(last, _)| {
                        (row.0.date - last.date).num_days() <= MERGE_GAP_DAYS
                    }) =>
                {
                    cluster.push(row)
                }
                _ => clusters.push(vec![row]),
            }
        }
        for mut cluster in clusters {
            cluster.sort_by(|(left, _), (right, _)| {
                rank(right)
                    .cmp(&rank(left))
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let (selected, ratio) = cluster[0];
            let split_date = selected.date;
            if split_date < range.start || split_date > range.end {
                continue;
            }
            if quotes_appear_split_adjusted(&quotes.positive_closes(asset), split_date, ratio) {
                events.push(SplitEvent {
                    asset: asset.clone(),
                    split_date,
                    ratio,
                });
            }
        }
    }
    events.sort_by(|a, b| {
        a.split_date
            .cmp(&b.split_date)
            .then_with(|| a.asset.cmp(&b.asset))
    });
    events
}

fn relative_distance(value: Decimal, target: Decimal) -> Decimal {
    let denominator = target.abs().max(Decimal::ONE);
    (value - target).abs() / denominator
}

fn quotes_appear_split_adjusted(
    closes: &BTreeMap<NaiveDate, Decimal>,
    split_date: NaiveDate,
    ratio: Decimal,
) -> bool {
    if ratio <= Decimal::ZERO || ratio == Decimal::ONE {
        return false;
    }
    let Some((_, previous)) = closes.range(..split_date).next_back() else {
        return false;
    };
    let Some((_, next)) = closes.range(split_date..).next() else {
        return false;
    };
    if *previous <= Decimal::ZERO || *next <= Decimal::ZERO {
        return false;
    }
    let observed = *previous / *next;
    relative_distance(observed, Decimal::ONE) < relative_distance(observed, ratio)
}
