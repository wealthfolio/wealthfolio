//! Stage 3: quote and FX surfaces resolved over an observation set.
//! Codifies the legacy ladder as policy: minor-unit normalization, per-day
//! direct or inverse observation, bidirectional nearest observation (tie →
//! past), then a deterministic fewest-hops path through intermediate
//! currencies. No "latest rate of any date" last resort (EDGE-FX-07).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::arith;
use crate::model::{FxObservation, Policy};

type Pair = (String, String);

#[derive(Debug, Clone, Default)]
pub struct FxSurface {
    series: BTreeMap<Pair, BTreeMap<NaiveDate, Decimal>>,
    /// Sorted adjacency so path search is order-independent.
    adjacency: BTreeMap<String, BTreeSet<String>>,
}

impl FxSurface {
    /// Builds the surface; every observation also registers its inverse,
    /// which fills only the days the opposite pair has no direct
    /// observation of its own: a quoted rate is never replaced by the
    /// inverse of another row.
    pub fn from_observations(observations: &[FxObservation]) -> Self {
        let mut surface = Self::default();
        let pairs = || {
            observations
                .iter()
                .map(|o| (o.from.as_str(), o.to.as_str(), o))
                .filter(|(from, to, _)| from != to)
        };
        for (from, to, observation) in pairs() {
            surface
                .series
                .entry((from.to_string(), to.to_string()))
                .or_default()
                .insert(observation.day, observation.rate);
            surface
                .adjacency
                .entry(from.to_string())
                .or_default()
                .insert(to.to_string());
        }
        for (from, to, observation) in pairs() {
            let Some(inverse) = arith::div(Decimal::ONE, observation.rate) else {
                continue;
            };
            surface
                .series
                .entry((to.to_string(), from.to_string()))
                .or_default()
                .entry(observation.day)
                .or_insert(inverse);
            surface
                .adjacency
                .entry(to.to_string())
                .or_default()
                .insert(from.to_string());
        }
        surface
    }

    pub fn is_empty(&self) -> bool {
        self.series.is_empty()
    }

    /// The last observation day of the pair before `before`, from either
    /// direction (an observation also registers its inverse).
    pub(crate) fn previous_observation(
        &self,
        from: &str,
        to: &str,
        before: NaiveDate,
    ) -> Option<NaiveDate> {
        self.series
            .get(&(from.to_string(), to.to_string()))
            .and_then(|days| days.range(..before).next_back())
            .map(|(day, _)| *day)
    }

    /// Nearest observation for a direct pair: exact day, else the closer of
    /// the last-before and first-after observations (tie → past), with its
    /// distance in days from `date`.
    fn direct_rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<(Decimal, i64)> {
        let history = self.series.get(&(from.to_string(), to.to_string()))?;
        let prev = history.range(..=date).next_back();
        let next = history.range(date..).next();
        let distance = |day: &NaiveDate| (date - *day).num_days().abs();
        match (prev, next) {
            (Some((d1, r1)), Some((d2, r2))) => {
                if d1 == d2 {
                    return Some((*r1, 0));
                }
                Some(if distance(d1) <= distance(d2) {
                    (*r1, distance(d1))
                } else {
                    (*r2, distance(d2))
                })
            }
            (Some((day, rate)), None) | (None, Some((day, rate))) => Some((*rate, distance(day))),
            (None, None) => None,
        }
    }

    /// Rate between major-unit codes: direct pair first, else the fewest-hops
    /// path (neighbors visited in code order, so equal-length paths resolve
    /// deterministically), each hop nearest-neighbour resolved on `date`.
    /// Also returns the largest distance of any hop's observation from `date`.
    fn path_rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<(Decimal, i64)> {
        if from == to {
            return Some((Decimal::ONE, 0));
        }
        let mut queue: VecDeque<(String, Decimal, i64)> = VecDeque::new();
        let mut visited: BTreeSet<String> = BTreeSet::new();
        queue.push_back((from.to_string(), Decimal::ONE, 0));
        visited.insert(from.to_string());
        while let Some((current, accumulated, age)) = queue.pop_front() {
            if current == to {
                return Some((accumulated, age));
            }
            let Some(neighbors) = self.adjacency.get(&current) else {
                continue;
            };
            for neighbor in neighbors {
                if visited.contains(neighbor) {
                    continue;
                }
                if let Some((rate, hop_age)) = self
                    .direct_rate(&current, neighbor, date)
                    .and_then(|(rate, hop_age)| Some((arith::mul(accumulated, rate)?, hop_age)))
                {
                    visited.insert(neighbor.clone());
                    queue.push_back((neighbor.clone(), rate, age.max(hop_age)));
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
    /// Units of `to` per unit of `from` on `date`, or `None` when unresolvable
    /// (no observation path, or a rate outside the kernel range).
    pub fn rate(&self, from: &str, to: &str, date: NaiveDate) -> Option<Decimal> {
        self.rate_with_age(from, to, date).map(|(rate, _)| rate)
    }

    /// [`Self::rate`] plus how many days the furthest observation it used lies
    /// from `date` (0 when every hop was observed that day).
    pub fn rate_with_age(&self, from: &str, to: &str, date: NaiveDate) -> Option<(Decimal, i64)> {
        if from == to {
            return Some((Decimal::ONE, 0));
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
            return arith::mul(source_multiplier, target_multiplier).map(|rate| (rate, 0));
        }
        let (base_rate, age) = self.surface.path_rate(major_from, major_to, date)?;
        arith::product(&[source_multiplier, base_rate, target_multiplier]).map(|rate| (rate, age))
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
        self.rate(from, to, date)
            .and_then(|rate| arith::mul(amount, rate))
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
    fn a_direct_observation_beats_the_inverse_of_the_opposite_pair() {
        let surface = FxSurface::from_observations(&[
            observation("CAD", "USD", 2, dec!(0.70)),
            observation("USD", "CAD", 2, dec!(1.30)),
            observation("USD", "CAD", 3, dec!(1.25)),
        ]);
        let policy = policy();
        let fx = FxResolver {
            surface: &surface,
            policy: &policy,
        };
        assert_eq!(fx.rate("CAD", "USD", day(2)), Some(dec!(0.70)));
        assert_eq!(fx.rate("USD", "CAD", day(2)), Some(dec!(1.30)));
        // No direct CAD->USD row on day 3: the inverse fills it.
        assert_eq!(fx.rate("CAD", "USD", day(3)), Some(dec!(1) / dec!(1.25)));
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

use crate::model::{
    Activity, ActivityKind, AssetId, CanonicalFacts, DateRange, QuoteObservation, RawActivity,
};
use crate::normalize::{activity_out_of_range, effective_type, is_posted, local_date};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;

/// Quote observations per asset, sorted by day (`normalize` keeps one per
/// asset and day).
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
    pub(crate) fn positive_closes(&self, asset: &AssetId) -> BTreeMap<NaiveDate, Decimal> {
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

/// A split of an asset: from `split_date`, each earlier unit is `ratio`
/// units.
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
    /// Splits whose quote series is already provider-adjusted, so closes
    /// before the split are multiplied by its ratio to price pre-split units.
    pub splits: Vec<SplitEvent>,
    /// Every split, whichever account recorded it and whether or not the
    /// provider adjusted its prices: what a holdings snapshot's quantities
    /// are carried across (rules R1.5).
    pub recorded_splits: Vec<SplitEvent>,
}

impl ResolvedSurfaces {
    /// Product of the ratios of adjusted splits strictly after `date`;
    /// `None` when the product leaves the kernel range.
    pub fn split_price_factor(&self, asset: &AssetId, date: NaiveDate) -> Option<Decimal> {
        self.splits
            .iter()
            .filter(|event| event.asset == *asset && date < event.split_date)
            .try_fold(Decimal::ONE, |factor, event| {
                arith::mul(factor, event.ratio)
            })
    }

    /// Product of the ratios of recorded splits after `from` up to `to`:
    /// what quantities held on `from` are on `to`; `None` when the product
    /// leaves the kernel range.
    pub fn split_quantity_factor(
        &self,
        asset: &AssetId,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Option<Decimal> {
        split_quantity_factor(&self.recorded_splits, asset, from, to)
    }
}

pub fn resolve_surfaces(facts: &CanonicalFacts, range: DateRange) -> ResolvedSurfaces {
    let quotes = QuoteSurface::from_observations(&facts.quotes);
    let fx = FxSurface::from_observations(&facts.fx_rates);
    let recorded_splits = split_events(facts, range);
    let splits = recorded_splits
        .iter()
        .filter(|event| {
            quotes_appear_split_adjusted(
                &quotes.positive_closes(&event.asset),
                event.split_date,
                event.ratio,
            )
        })
        .cloned()
        .collect();
    ResolvedSurfaces {
        quotes,
        fx,
        splits,
        recorded_splits,
    }
}

/// A row recording a split, as split grouping reads it.
#[derive(Debug, Clone)]
pub struct SplitRow {
    pub id: String,
    pub asset: AssetId,
    /// Its business date.
    pub date: NaiveDate,
    pub ratio: Decimal,
    pub is_user_modified: bool,
    pub source_system: Option<String>,
    pub updated_at: DateTime<Utc>,
}

impl SplitRow {
    /// A stored activity read as `normalize` reads it, when it is a posted
    /// split of an asset with a positive ratio and every value in range:
    /// dated in `timezone`, its ratio its amount, else its quantity.
    pub fn from_raw(raw: &RawActivity, timezone: &Tz) -> Option<Self> {
        if !is_posted(&raw.status)
            || activity_out_of_range(raw).is_some()
            || ActivityKind::parse(effective_type(raw)) != Some(ActivityKind::Split)
        {
            return None;
        }
        let asset = raw
            .asset_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        Self::new(
            raw.id.clone(),
            AssetId::new(asset),
            local_date(raw.timestamp, timezone),
            raw.amount.map(|amount| amount.abs()),
            raw.quantity.unwrap_or_default().abs(),
            raw.is_user_modified,
            raw.source_system
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            raw.updated_at,
        )
    }

    fn from_activity(activity: &Activity) -> Option<Self> {
        if activity.kind != ActivityKind::Split {
            return None;
        }
        Self::new(
            activity.id.as_str().to_string(),
            activity.asset.clone()?,
            activity.date,
            activity.amount,
            activity.quantity,
            activity.is_user_modified,
            activity.source_system.clone(),
            activity.updated_at,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        id: String,
        asset: AssetId,
        date: NaiveDate,
        amount: Option<Decimal>,
        quantity: Decimal,
        is_user_modified: bool,
        source_system: Option<String>,
        updated_at: DateTime<Utc>,
    ) -> Option<Self> {
        let ratio = amount
            .filter(|amount| *amount > Decimal::ZERO)
            .unwrap_or(quantity);
        (ratio > Decimal::ZERO).then_some(Self {
            id,
            asset,
            date,
            ratio,
            is_user_modified,
            source_system,
            updated_at,
        })
    }

    /// Legacy source ranking: user-modified / MANUAL / CSV / untagged first,
    /// then other sources, then GENERATED.
    fn rank(&self) -> u8 {
        if self.is_user_modified {
            return 3;
        }
        match self.source_system.as_deref() {
            None => 3,
            Some(source)
                if source.eq_ignore_ascii_case("MANUAL") || source.eq_ignore_ascii_case("CSV") =>
            {
                3
            }
            Some(source) if source.eq_ignore_ascii_case("GENERATED") => 1,
            Some(_) => 2,
        }
    }
}

/// One event per split the rows record (rules R1.5; legacy
/// `select_shared_split_activities`): rows of one asset within a day of
/// each other are one split, and its best-ranked row (then the latest
/// updated, then the id) gives its day and ratio. Sorted by day, then asset.
pub fn group_splits(rows: impl IntoIterator<Item = SplitRow>) -> Vec<SplitEvent> {
    const MERGE_GAP_DAYS: i64 = 1;
    let mut by_asset: BTreeMap<AssetId, Vec<SplitRow>> = BTreeMap::new();
    for row in rows {
        by_asset.entry(row.asset.clone()).or_default().push(row);
    }
    let mut events = Vec::new();
    for (asset, mut rows) in by_asset {
        rows.sort_by_key(|row| row.date);
        let mut clusters: Vec<Vec<SplitRow>> = Vec::new();
        for row in rows {
            match clusters.last_mut() {
                Some(cluster)
                    if cluster.last().is_some_and(|last| {
                        (row.date - last.date).num_days() <= MERGE_GAP_DAYS
                    }) =>
                {
                    cluster.push(row)
                }
                _ => clusters.push(vec![row]),
            }
        }
        for cluster in clusters {
            let Some(selected) = cluster.iter().min_by(|left, right| {
                right
                    .rank()
                    .cmp(&left.rank())
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
                    .then_with(|| left.id.cmp(&right.id))
            }) else {
                continue;
            };
            events.push(SplitEvent {
                asset: asset.clone(),
                split_date: selected.date,
                ratio: selected.ratio,
            });
        }
    }
    events.sort_by(|a, b| {
        a.split_date
            .cmp(&b.split_date)
            .then_with(|| a.asset.cmp(&b.asset))
    });
    events
}

/// Product of the ratios of `splits` of `asset` after `from` up to `to`:
/// what units held on `from` are on `to` (rules R1.5); `None` when the
/// product leaves the kernel range.
pub fn split_quantity_factor(
    splits: &[SplitEvent],
    asset: &AssetId,
    from: NaiveDate,
    to: NaiveDate,
) -> Option<Decimal> {
    splits
        .iter()
        .filter(|event| event.asset == *asset && from < event.split_date && event.split_date <= to)
        .try_fold(Decimal::ONE, |factor, event| {
            arith::mul(factor, event.ratio)
        })
}

/// Every split the facts record inside `range`; `resolve_surfaces` keeps as
/// adjusted those whose quote series already looks adjusted around them
/// (legacy `quotes_appear_split_adjusted`).
fn split_events(facts: &CanonicalFacts, range: DateRange) -> Vec<SplitEvent> {
    group_splits(facts.activities.iter().filter_map(SplitRow::from_activity))
        .into_iter()
        .filter(|event| range.start <= event.split_date && event.split_date <= range.end)
        .collect()
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
    let Some(observed) = arith::div(*previous, *next) else {
        return false;
    };
    relative_distance(observed, Decimal::ONE) < relative_distance(observed, ratio)
}
