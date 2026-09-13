//! Quote sync state models and traits.
//!
//! This module contains the domain models for tracking quote synchronization state,
//! including sync categories, sync plans, and the repository trait for persistence.

use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::errors::Result;

// =============================================================================
// Sync Mode
// =============================================================================

/// Mode for quote synchronization - determines date window calculation.
///
/// This is a per-request parameter, NOT a persisted setting. Each sync call
/// can specify a different mode based on the caller's needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncMode {
    /// Continue from last_quote_date with overlap, fill gaps to activity_min_date.
    /// This is the default mode for regular sync operations.
    /// - Uses last_quote_date - OVERLAP_DAYS as start (to heal provider corrections)
    /// - Falls back to first_activity_date - BUFFER_DAYS if no quotes exist
    #[default]
    Incremental,

    /// Refetch recent window regardless of existing quotes.
    /// Useful for forcing a refresh of recent data without full history rebuild.
    /// - Start: today - days
    /// - End: today
    RefetchRecent {
        /// Number of days to look back from today
        days: i64,
    },

    /// Rebuild full history from activity start.
    /// Used for manual resync or when history needs to be rebuilt.
    /// - Start: first_activity_date - BUFFER_DAYS (or today - days as fallback)
    /// - End: today
    BackfillHistory {
        /// Fallback days if no activity date exists
        days: i64,
    },
}

// =============================================================================
// Market Sync Mode (for portfolio jobs)
// =============================================================================

/// Controls market data sync behavior for portfolio jobs.
///
/// This is a per-job parameter that determines whether and how market data
/// should be synchronized before portfolio recalculation. Non-market changes
/// (goals, limits, manual FX rates) should use `None` to skip market sync.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MarketSyncMode {
    /// No market sync - recalculation only.
    /// Use for changes that don't require fresh market data:
    /// - Goals/limits updates
    /// - Manual exchange rate CRUD
    /// - UI-driven recalculations with existing data
    #[default]
    None,

    /// Incremental sync for specified assets (or all if asset_ids is None).
    /// This is the typical mode for activity changes and manual portfolio updates.
    Incremental {
        /// Optional list of asset IDs to sync. None means sync all relevant assets.
        #[serde(default)]
        asset_ids: Option<Vec<String>>,
    },

    /// Refetch recent history window.
    /// Use for forcing a refresh of recent data without full history rebuild.
    RefetchRecent {
        /// Optional list of asset IDs to sync. None means sync all relevant assets.
        #[serde(default)]
        asset_ids: Option<Vec<String>>,
        /// Number of days to look back from today.
        days: i64,
    },

    /// Full history rebuild from activity start.
    /// Use for manual resync when history needs to be rebuilt.
    BackfillHistory {
        /// Optional list of asset IDs to sync. None means sync all relevant assets.
        #[serde(default)]
        asset_ids: Option<Vec<String>>,
        /// Fallback days if no activity date exists.
        days: i64,
    },
}

impl MarketSyncMode {
    /// Returns true if this mode requires market data synchronization.
    pub fn requires_sync(&self) -> bool {
        !matches!(self, MarketSyncMode::None)
    }

    /// Extracts the asset_ids from this mode, if any.
    pub fn asset_ids(&self) -> Option<&Vec<String>> {
        match self {
            MarketSyncMode::None => None,
            MarketSyncMode::Incremental { asset_ids } => asset_ids.as_ref(),
            MarketSyncMode::RefetchRecent { asset_ids, .. } => asset_ids.as_ref(),
            MarketSyncMode::BackfillHistory { asset_ids, .. } => asset_ids.as_ref(),
        }
    }

    /// Converts this MarketSyncMode to the corresponding SyncMode for the quote service.
    /// Returns None if this mode doesn't require sync.
    pub fn to_sync_mode(&self) -> Option<SyncMode> {
        match self {
            MarketSyncMode::None => None,
            MarketSyncMode::Incremental { .. } => Some(SyncMode::Incremental),
            MarketSyncMode::RefetchRecent { days, .. } => {
                Some(SyncMode::RefetchRecent { days: *days })
            }
            MarketSyncMode::BackfillHistory { days, .. } => {
                Some(SyncMode::BackfillHistory { days: *days })
            }
        }
    }
}

impl std::fmt::Display for SyncMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncMode::Incremental => write!(f, "Incremental"),
            SyncMode::RefetchRecent { days } => write!(f, "RefetchRecent({}d)", days),
            SyncMode::BackfillHistory { days } => write!(f, "BackfillHistory({}d)", days),
        }
    }
}

/// Sync category determines how a symbol should be synced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncCategory {
    /// Active position - sync from last_quote_date to today
    Active,
    /// New symbol - needs full history from first_activity_date - buffer days
    New,
    /// Activity date moved to past - needs quotes before earliest_quote_date
    NeedsBackfill,
    /// Closed within grace period - continue syncing for N days after close
    RecentlyClosed,
    /// Closed beyond grace period - skip syncing
    Closed,
}

impl SyncCategory {
    /// Get the default priority for this category.
    pub fn default_priority(&self) -> i32 {
        match self {
            SyncCategory::Active => 100,
            SyncCategory::NeedsBackfill => 90,
            SyncCategory::New => 80,
            SyncCategory::RecentlyClosed => 50,
            SyncCategory::Closed => 0,
        }
    }
}

// =============================================================================
// Sync Planning (Explicit Inputs)
// =============================================================================

use super::constants::{
    BACKFILL_SAFETY_MARGIN_DAYS, MIN_SYNC_LOOKBACK_DAYS, OVERLAP_DAYS, QUOTE_HISTORY_BUFFER_DAYS,
};

/// Inputs for sync planning, computed on-the-fly from operational tables.
///
/// These values are NOT cached in the sync_state table. They are computed
/// fresh at plan time to ensure correctness.
#[derive(Debug, Clone)]
pub struct SyncPlanningInputs {
    /// Is this an active position (has open holdings)?
    pub is_active: bool,
    /// When the position was closed (if applicable)
    pub position_closed_date: Option<NaiveDate>,
    /// Earliest activity date for this asset (computed from activities table)
    pub activity_min: Option<NaiveDate>,
    /// Latest activity date for this asset (computed from activities table)
    pub activity_max: Option<NaiveDate>,
    /// Earliest quote date for this asset+provider (computed from quotes table)
    pub quote_min: Option<NaiveDate>,
    /// Latest quote date for this asset+provider (computed from quotes table)
    pub quote_max: Option<NaiveDate>,
}

/// Determines the sync category based on explicit planning inputs.
///
/// This is a pure function that takes all required inputs explicitly,
/// making it easy to test and reason about.
pub fn determine_sync_category(
    inputs: &SyncPlanningInputs,
    grace_period_days: i64,
    today: NaiveDate,
) -> SyncCategory {
    // FIRST: Check for NEW assets - has activities but no quotes yet
    if inputs.activity_min.is_some() && inputs.quote_min.is_none() {
        return SyncCategory::New;
    }

    // Check if needs backfill (activity date - buffer - margin before earliest quote)
    if let (Some(activity_min), Some(quote_min)) = (inputs.activity_min, inputs.quote_min) {
        let required_start =
            activity_min - Duration::days(QUOTE_HISTORY_BUFFER_DAYS + BACKFILL_SAFETY_MARGIN_DAYS);
        if required_start < quote_min {
            return SyncCategory::NeedsBackfill;
        }
    }

    // Check if symbol has open position
    if inputs.is_active {
        return SyncCategory::Active;
    }

    // Position is closed - check grace period
    if let Some(closed_date) = inputs.position_closed_date {
        let days_since_close = (today - closed_date).num_days();
        if days_since_close <= grace_period_days {
            return SyncCategory::RecentlyClosed;
        }
    }

    // Fallback: check activity_max for recently closed without explicit closed_date
    if let Some(activity_max) = inputs.activity_max {
        let days_since_activity = (today - activity_max).num_days();
        if days_since_activity <= grace_period_days {
            return SyncCategory::RecentlyClosed;
        }
    }

    SyncCategory::Closed
}

/// Calculates the sync date window based on category and inputs.
///
/// Returns (start_date, end_date) for the sync operation.
/// Returns None if the asset should not be synced.
pub fn calculate_sync_window(
    category: &SyncCategory,
    inputs: &SyncPlanningInputs,
    today: NaiveDate,
) -> Option<(NaiveDate, NaiveDate)> {
    match category {
        SyncCategory::Closed => None,

        SyncCategory::Active | SyncCategory::RecentlyClosed => {
            // Continue from last quote with overlap, or start from activity if no quotes
            let start = inputs
                .quote_max
                .map(|d| d - Duration::days(OVERLAP_DAYS))
                .or_else(|| {
                    inputs
                        .activity_min
                        .map(|d| d - Duration::days(QUOTE_HISTORY_BUFFER_DAYS))
                })
                .unwrap_or_else(|| today - Duration::days(QUOTE_HISTORY_BUFFER_DAYS));

            // Ensure minimum lookback
            let start = if start >= today {
                today - Duration::days(MIN_SYNC_LOOKBACK_DAYS)
            } else {
                start
            };

            Some((start, today))
        }

        SyncCategory::New => {
            // Full history from activity start
            let start = inputs
                .activity_min
                .map(|d| d - Duration::days(QUOTE_HISTORY_BUFFER_DAYS))
                .unwrap_or_else(|| today - Duration::days(QUOTE_HISTORY_BUFFER_DAYS));

            Some((start, today))
        }

        SyncCategory::NeedsBackfill => {
            // Fill gap before earliest quote
            // Use same buffer as detection to ensure we cover the required range
            let start = inputs
                .activity_min
                .map(|d| {
                    d - Duration::days(QUOTE_HISTORY_BUFFER_DAYS + BACKFILL_SAFETY_MARGIN_DAYS)
                })
                .unwrap_or(today);

            // End at quote_min - 1 to avoid refetching existing data
            let initial_end = inputs
                .quote_min
                .map(|d| d - Duration::days(1))
                .unwrap_or(today);

            // Ensure minimum window size to avoid single-day fetch failures
            // (e.g., weekends, holidays). Expand end forward if needed.
            let window_size = (initial_end - start).num_days().max(0);
            let end = if window_size < MIN_SYNC_LOOKBACK_DAYS {
                start + Duration::days(MIN_SYNC_LOOKBACK_DAYS)
            } else {
                initial_end
            };

            if start > end {
                None
            } else {
                Some((start, end))
            }
        }
    }
}

/// Plan for syncing a specific asset.
#[derive(Debug, Clone)]
pub struct SymbolSyncPlan {
    pub asset_id: String,
    pub category: SyncCategory,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub priority: i32,
    pub data_source: String,
    /// Provider-specific symbol for quote fetching (may differ from canonical symbol).
    pub quote_symbol: Option<String>,
    pub currency: String,
    /// When true, delete all non-manual quotes before upserting fresh data.
    /// Set for BackfillHistory mode to remove stale/wrong dates.
    pub purge_provider_quotes: bool,
    /// When true, tolerate provider "no data" style failures for closed positions.
    /// Broad history jobs use this to keep old closed/delisted assets best-effort;
    /// targeted user requests keep errors visible.
    pub suppress_closed_fetch_errors: bool,
}

// =============================================================================
// Profile Enrichment Freshness
// =============================================================================

/// Default maximum age of an asset profile before it is re-enriched, in days.
///
/// Fundamentals (P/E, dividend yield, 52-week range) move on quarterly earnings
/// cycles, so a weekly refresh keeps them current at negligible provider cost.
pub const DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS: i64 = 7;

static PROFILE_ENRICHMENT_TTL: OnceLock<Option<Duration>> = OnceLock::new();

/// Set the process-wide profile-enrichment TTL. `None` disables periodic
/// re-enrichment, leaving profiles enriched exactly once at asset creation.
///
/// Call once during startup, before any sync work begins. Later calls are ignored
/// (returns `false`) so the value cannot change under a running scheduler.
pub fn set_profile_enrichment_ttl(ttl: Option<Duration>) -> bool {
    PROFILE_ENRICHMENT_TTL.set(ttl).is_ok()
}

/// The process-wide profile-enrichment TTL, defaulting to
/// [`DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS`] if startup never set one.
pub fn profile_enrichment_ttl() -> Option<Duration> {
    *PROFILE_ENRICHMENT_TTL
        .get_or_init(|| Some(Duration::days(DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS)))
}

/// The timestamp at or before which a profile counts as stale, or `None` when the
/// TTL is disabled.
///
/// This is the SQL-side half of [`QuoteSyncState::needs_profile_enrichment_at`]:
/// the repository selects `profile_enriched_at IS NULL OR profile_enriched_at <= cutoff`.
/// The two must agree, or the scheduler selects assets that `enrich_assets` then
/// skips and nothing ever refreshes.
pub fn profile_enrichment_cutoff(
    now: DateTime<Utc>,
    max_age: Option<Duration>,
) -> Option<DateTime<Utc>> {
    max_age.map(|max_age| now - max_age)
}

/// Domain model for quote sync state.
///
/// This table tracks sync coordination state per asset. It is NOT a cache of
/// operational data. Activity dates and quote bounds are computed on-the-fly
/// from the activities and quotes tables at sync planning time.
///
/// Note: `is_active` is derived from `position_closed_date`:
/// - `position_closed_date IS NULL` → active position
/// - `position_closed_date IS NOT NULL` → closed position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteSyncState {
    pub asset_id: String,
    /// Whether this asset has an open position.
    /// DERIVED: true if position_closed_date is None, false otherwise.
    /// Not stored in database - computed on read.
    pub is_active: bool,
    /// When the position was closed (if applicable).
    /// NULL = active position, NOT NULL = closed position.
    pub position_closed_date: Option<NaiveDate>,
    /// When the last sync was attempted
    pub last_synced_at: Option<DateTime<Utc>>,
    /// Which provider to use for this asset
    pub data_source: String,
    /// Priority for sync ordering
    pub sync_priority: i32,
    /// Number of consecutive sync failures
    pub error_count: i32,
    /// Last sync error message
    pub last_error: Option<String>,
    /// Timestamp when asset profile was last enriched from provider.
    /// NULL means the asset needs profile enrichment.
    pub profile_enriched_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl QuoteSyncState {
    /// Create a new sync state for an asset.
    pub fn new(asset_id: String, data_source: String) -> Self {
        let now = Utc::now();
        QuoteSyncState {
            asset_id,
            is_active: true,
            position_closed_date: None,
            last_synced_at: None,
            data_source,
            sync_priority: SyncCategory::New.default_priority(),
            error_count: 0,
            last_error: None,
            profile_enriched_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Returns true if the asset profile needs enrichment, using the process-wide
    /// TTL (see [`profile_enrichment_ttl`]).
    pub fn needs_profile_enrichment(&self) -> bool {
        self.needs_profile_enrichment_at(Utc::now(), profile_enrichment_ttl())
    }

    /// Freshness predicate, with `now` and the TTL injected so it is deterministic.
    ///
    /// A profile is stale when it has never been enriched, or when the last
    /// enrichment is at least `max_age` old. `max_age` of `None` disables periodic
    /// re-enrichment, restoring the legacy one-shot behaviour.
    ///
    /// An enrichment timestamp in the future (clock skew, restored backup) reads as
    /// fresh rather than infinitely stale.
    pub fn needs_profile_enrichment_at(
        &self,
        now: DateTime<Utc>,
        max_age: Option<Duration>,
    ) -> bool {
        match (self.profile_enriched_at, max_age) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(enriched_at), Some(max_age)) => now.signed_duration_since(enriched_at) >= max_age,
        }
    }

    /// Mark profile as enriched.
    pub fn mark_profile_enriched(&mut self) {
        self.profile_enriched_at = Some(Utc::now());
        self.updated_at = Utc::now();
    }

    /// Mark as synced successfully.
    pub fn mark_synced(&mut self) {
        self.last_synced_at = Some(Utc::now());
        self.error_count = 0;
        self.last_error = None;
        self.updated_at = Utc::now();
    }

    /// Mark sync as failed.
    pub fn mark_sync_failed(&mut self, error: String) {
        self.error_count += 1;
        self.last_error = Some(error);
        self.updated_at = Utc::now();
    }

    /// Mark position as closed.
    /// Sets position_closed_date which derives is_active = false.
    pub fn mark_closed(&mut self, closed_date: NaiveDate) {
        self.position_closed_date = Some(closed_date);
        self.is_active = false; // Derived from position_closed_date
        self.sync_priority = SyncCategory::RecentlyClosed.default_priority();
        self.updated_at = Utc::now();
    }

    /// Mark position as active (reopened or new).
    /// Clears position_closed_date which derives is_active = true.
    pub fn mark_active(&mut self) {
        self.position_closed_date = None;
        self.is_active = true; // Derived from position_closed_date
        self.sync_priority = SyncCategory::Active.default_priority();
        self.updated_at = Utc::now();
    }
}

/// Update payload for partial updates to sync state.
/// Note: is_active is derived from position_closed_date, not directly settable.
#[derive(Debug, Clone, Default)]
pub struct QuoteSyncStateUpdate {
    pub position_closed_date: Option<Option<NaiveDate>>,
    pub last_synced_at: Option<Option<DateTime<Utc>>>,
    pub sync_priority: Option<i32>,
    pub error_count: Option<i32>,
    pub last_error: Option<Option<String>>,
    pub profile_enriched_at: Option<Option<DateTime<Utc>>>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// Aggregated sync statistics for a data provider.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSyncStats {
    /// Provider ID (data_source)
    pub provider_id: String,
    /// Number of assets synced by this provider
    pub asset_count: i64,
    /// Number of assets with errors
    pub error_count: i64,
    /// Most recent sync timestamp
    pub last_synced_at: Option<DateTime<Utc>>,
    /// Most recent error message (if any)
    pub last_error: Option<String>,
    /// All unique error messages for this provider
    pub unique_errors: Vec<String>,
}

/// Trait for quote sync state storage operations.
#[async_trait]
pub trait SyncStateStore: Send + Sync {
    /// Get sync statistics aggregated by provider (data_source).
    fn get_provider_sync_stats(&self) -> Result<Vec<ProviderSyncStats>>;

    /// Get all sync states.
    fn get_all(&self) -> Result<Vec<QuoteSyncState>>;

    /// Get sync state by asset ID.
    fn get_by_asset_id(&self, asset_id: &str) -> Result<Option<QuoteSyncState>>;

    /// Get sync states for multiple asset IDs.
    fn get_by_asset_ids(&self, asset_ids: &[String]) -> Result<HashMap<String, QuoteSyncState>>;

    /// Get all active assets (is_active = true).
    fn get_active_assets(&self) -> Result<Vec<QuoteSyncState>>;

    /// Get assets that need syncing (active or recently closed).
    fn get_assets_needing_sync(&self, grace_period_days: i64) -> Result<Vec<QuoteSyncState>>;

    /// Upsert a sync state (insert or update).
    async fn upsert(&self, state: &QuoteSyncState) -> Result<QuoteSyncState>;

    /// Upsert multiple sync states.
    async fn upsert_batch(&self, states: &[QuoteSyncState]) -> Result<usize>;

    /// Update sync state after successful sync.
    async fn update_after_sync(&self, asset_id: &str) -> Result<()>;

    /// Update sync state after sync failure.
    async fn update_after_failure(&self, asset_id: &str, error: &str) -> Result<()>;

    /// Mark asset as inactive (position closed).
    async fn mark_inactive(&self, asset_id: &str, closed_date: NaiveDate) -> Result<()>;

    /// Mark multiple assets as inactive (position closed).
    async fn mark_inactive_batch(
        &self,
        asset_ids: &[String],
        closed_date: NaiveDate,
    ) -> Result<()> {
        for asset_id in asset_ids {
            self.mark_inactive(asset_id, closed_date).await?;
        }
        Ok(())
    }

    /// Mark asset as active.
    async fn mark_active(&self, asset_id: &str) -> Result<()>;

    /// Mark multiple assets as active.
    async fn mark_active_batch(&self, asset_ids: &[String]) -> Result<()> {
        for asset_id in asset_ids {
            self.mark_active(asset_id).await?;
        }
        Ok(())
    }

    /// Delete sync state for an asset.
    async fn delete(&self, asset_id: &str) -> Result<()>;

    /// Delete all sync states (used for reset).
    async fn delete_all(&self) -> Result<usize>;

    /// Mark asset profile as enriched (sets profile_enriched_at timestamp).
    async fn mark_profile_enriched(&self, asset_id: &str) -> Result<()>;

    /// Get assets that need profile enrichment (profile_enriched_at is NULL).
    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>>;

    /// Get sync states with errors (error_count > 0).
    fn get_with_errors(&self) -> Result<Vec<QuoteSyncState>>;
}

#[cfg(test)]
mod profile_enrichment_tests {
    use super::*;

    fn state_enriched_at(at: Option<DateTime<Utc>>) -> QuoteSyncState {
        let mut state = QuoteSyncState::new("AAPL".to_string(), "YAHOO".to_string());
        state.profile_enriched_at = at;
        state
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn never_enriched_needs_enrichment() {
        let state = state_enriched_at(None);
        assert!(state.needs_profile_enrichment_at(now(), Some(Duration::days(7))));
    }

    #[test]
    fn never_enriched_needs_enrichment_even_when_ttl_disabled() {
        let state = state_enriched_at(None);
        assert!(
            state.needs_profile_enrichment_at(now(), None),
            "a profile that was never enriched must be enriched once regardless of TTL"
        );
    }

    #[test]
    fn enriched_older_than_ttl_needs_enrichment() {
        let now = now();
        let state = state_enriched_at(Some(now - Duration::days(8)));
        assert!(state.needs_profile_enrichment_at(now, Some(Duration::days(7))));
    }

    #[test]
    fn enriched_within_ttl_does_not_need_enrichment() {
        let now = now();
        let state = state_enriched_at(Some(now - Duration::days(3)));
        assert!(!state.needs_profile_enrichment_at(now, Some(Duration::days(7))));
    }

    /// Boundary direction is documented, not incidental: an age of exactly the TTL
    /// counts as stale, so a daily loop with a 7-day TTL refreshes on day 7, not day 8.
    #[test]
    fn enriched_exactly_at_ttl_boundary_needs_enrichment() {
        let now = now();
        let state = state_enriched_at(Some(now - Duration::days(7)));
        assert!(state.needs_profile_enrichment_at(now, Some(Duration::days(7))));
    }

    #[test]
    fn enriched_one_second_inside_ttl_does_not_need_enrichment() {
        let now = now();
        let state = state_enriched_at(Some(now - Duration::days(7) + Duration::seconds(1)));
        assert!(!state.needs_profile_enrichment_at(now, Some(Duration::days(7))));
    }

    /// Clock skew (or a restored backup) can leave a timestamp in the future.
    /// That must not panic and must not be read as "infinitely stale".
    #[test]
    fn enriched_in_the_future_does_not_need_enrichment() {
        let now = now();
        let state = state_enriched_at(Some(now + Duration::days(30)));
        assert!(!state.needs_profile_enrichment_at(now, Some(Duration::days(7))));
    }

    #[test]
    fn ttl_none_restores_legacy_one_shot_behaviour() {
        let now = now();
        let state = state_enriched_at(Some(now - Duration::days(3650)));
        assert!(
            !state.needs_profile_enrichment_at(now, None),
            "a disabled TTL must never re-enrich an already-enriched profile"
        );
    }

    #[test]
    fn cutoff_is_none_when_ttl_disabled() {
        assert!(profile_enrichment_cutoff(now(), None).is_none());
    }

    #[test]
    fn cutoff_is_ttl_before_now() {
        let now = now();
        assert_eq!(
            profile_enrichment_cutoff(now, Some(Duration::days(7))),
            Some(now - Duration::days(7))
        );
    }

    /// The regression this unit exists to prevent, in the form it can actually take:
    /// the scheduler selects stale assets with the SQL cutoff
    /// (`profile_enriched_at IS NULL OR profile_enriched_at <= cutoff`), and
    /// `enrich_assets` then re-checks each one with `needs_profile_enrichment`.
    /// If the two disagree, the loop selects assets that are immediately skipped and
    /// nothing ever refreshes — silently, exactly like today's bug.
    #[test]
    fn sql_cutoff_and_in_memory_predicate_agree() {
        let now = now();
        let ttl = Duration::days(7);
        let cutoff = profile_enrichment_cutoff(now, Some(ttl)).expect("ttl enabled");

        let ages_in_hours = [0, 1, 24, 167, 168, 169, 24 * 30, -24];
        for hours in ages_in_hours {
            let enriched_at = now - Duration::hours(hours);
            let state = state_enriched_at(Some(enriched_at));

            let selected_by_sql = enriched_at <= cutoff;
            let accepted_by_predicate = state.needs_profile_enrichment_at(now, Some(ttl));

            assert_eq!(
                selected_by_sql, accepted_by_predicate,
                "SQL cutoff and in-memory predicate disagree for a profile enriched {hours}h ago"
            );
        }
    }

    /// An asset enriched now, then aged past the TTL, becomes selectable again.
    #[test]
    fn enriched_asset_becomes_stale_again_after_the_ttl() {
        let enriched_at = Utc::now();
        let state = state_enriched_at(Some(enriched_at));
        let ttl = Duration::days(7);

        assert!(
            !state.needs_profile_enrichment_at(enriched_at, Some(ttl)),
            "freshly enriched profile must not be re-enriched immediately"
        );

        let later = enriched_at + Duration::days(8);
        assert!(
            state.needs_profile_enrichment_at(later, Some(ttl)),
            "profile aged past the TTL must be enriched again \
             — this is the permanent-staleness bug the unit fixes"
        );
        assert!(
            profile_enrichment_cutoff(later, Some(ttl)).is_some_and(|cutoff| enriched_at <= cutoff),
            "the repository query must select it too"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_inputs(
        is_active: bool,
        position_closed_date: Option<NaiveDate>,
        activity_min: Option<NaiveDate>,
        activity_max: Option<NaiveDate>,
        quote_min: Option<NaiveDate>,
        quote_max: Option<NaiveDate>,
    ) -> SyncPlanningInputs {
        SyncPlanningInputs {
            is_active,
            position_closed_date,
            activity_min,
            activity_max,
            quote_min,
            quote_max,
        }
    }

    #[test]
    fn test_new_asset_with_activity_but_no_quotes() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            false,
            None,
            Some(today), // has activity
            Some(today),
            None, // no quotes
            None,
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::New,
            "Asset with activities but no quotes should be categorized as New"
        );
    }

    #[test]
    fn test_active_position_with_quotes() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            true,
            None,
            Some(today - Duration::days(10)),
            Some(today - Duration::days(1)),
            // quote_min must be at least (10 + buffer + margin) = 62 days before activity_min
            Some(today - Duration::days(70)),
            Some(today - Duration::days(1)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::Active);
    }

    #[test]
    fn test_needs_backfill_activity_before_quotes() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            true,
            None,
            Some(today - Duration::days(60)), // activity started 60 days ago
            Some(today - Duration::days(1)),
            Some(today - Duration::days(20)), // but quotes only go back 20 days
            Some(today - Duration::days(1)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::NeedsBackfill,
            "Should need backfill when activity_min - buffer < quote_min"
        );
    }

    #[test]
    fn test_recently_closed_within_grace_period() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            false,
            Some(today - Duration::days(5)), // closed 5 days ago
            Some(today - Duration::days(100)),
            Some(today - Duration::days(5)),
            Some(today - Duration::days(160)), // enough history to avoid NeedsBackfill
            Some(today - Duration::days(5)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::RecentlyClosed,
            "Position closed 5 days ago should be RecentlyClosed (within 30 day grace)"
        );
    }

    #[test]
    fn test_recently_closed_fallback_to_last_activity() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            false,
            None, // no explicit closed date
            Some(today - Duration::days(100)),
            Some(today - Duration::days(10)), // last activity 10 days ago
            Some(today - Duration::days(160)),
            Some(today - Duration::days(10)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::RecentlyClosed,
            "Should fallback to activity_max when position_closed_date is None"
        );
    }

    #[test]
    fn test_closed_beyond_grace_period() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            false,
            Some(today - Duration::days(50)), // closed 50 days ago
            Some(today - Duration::days(100)),
            Some(today - Duration::days(50)),
            Some(today - Duration::days(160)),
            Some(today - Duration::days(50)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::Closed,
            "Position closed 50 days ago should be Closed (beyond 30 day grace)"
        );
    }

    #[test]
    fn test_needs_backfill_even_when_not_active() {
        let today = Utc::now().date_naive();
        let inputs = create_inputs(
            false,
            None,
            Some(today - Duration::days(100)), // activity started 100 days ago
            Some(today - Duration::days(50)),
            Some(today - Duration::days(50)), // quotes only go back 50 days
            Some(today - Duration::days(1)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::NeedsBackfill,
            "Should detect backfill need regardless of is_active status"
        );
    }

    #[test]
    fn test_category_priorities() {
        assert!(
            SyncCategory::Active.default_priority()
                > SyncCategory::NeedsBackfill.default_priority()
        );
        assert!(
            SyncCategory::NeedsBackfill.default_priority() > SyncCategory::New.default_priority()
        );
        assert!(
            SyncCategory::New.default_priority() > SyncCategory::RecentlyClosed.default_priority()
        );
        assert!(
            SyncCategory::RecentlyClosed.default_priority()
                > SyncCategory::Closed.default_priority()
        );
    }

    #[test]
    fn test_mark_synced() {
        let mut state = QuoteSyncState::new("TEST".to_string(), "YAHOO".to_string());
        state.error_count = 3;
        state.last_error = Some("Previous error".to_string());

        state.mark_synced();

        assert!(state.last_synced_at.is_some());
        assert_eq!(state.error_count, 0);
        assert!(state.last_error.is_none());
    }

    #[test]
    fn test_mark_sync_failed() {
        let mut state = QuoteSyncState::new("TEST".to_string(), "YAHOO".to_string());
        assert_eq!(state.error_count, 0);

        state.mark_sync_failed("Connection timeout".to_string());
        assert_eq!(state.error_count, 1);
        assert_eq!(state.last_error, Some("Connection timeout".to_string()));

        state.mark_sync_failed("Rate limited".to_string());
        assert_eq!(state.error_count, 2);
        assert_eq!(state.last_error, Some("Rate limited".to_string()));
    }

    // =========================================================================
    // calculate_sync_window Tests for NeedsBackfill
    // =========================================================================

    #[test]
    fn test_backfill_window_tiny_gap_expands_to_minimum() {
        // Bug fix: 1-day gap (e.g., weekend) should expand to MIN_SYNC_LOOKBACK_DAYS
        let today = Utc::now().date_naive();

        // Simulate: activity on Jan 7, quotes from Nov 17, required_start = Nov 16
        // This creates a 1-day gap (Nov 16) which might be a weekend
        let activity_min = today - Duration::days(22); // ~Jan 7 relative
        let quote_min = today - Duration::days(73); // ~Nov 17 relative
        let quote_max = today;

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(quote_max),
        );

        // Verify it's categorized as NeedsBackfill
        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::NeedsBackfill);

        // Calculate window
        let window = calculate_sync_window(&category, &inputs, today);
        assert!(window.is_some(), "Should return a valid window");

        let (start, end) = window.unwrap();
        let window_size = (end - start).num_days();

        // Window should be at least MIN_SYNC_LOOKBACK_DAYS
        assert!(
            window_size >= MIN_SYNC_LOOKBACK_DAYS,
            "Backfill window should be at least {} days, got {} days",
            MIN_SYNC_LOOKBACK_DAYS,
            window_size
        );
    }

    #[test]
    fn test_backfill_window_large_gap_unchanged() {
        // Large gaps should not be affected by the minimum window expansion
        let today = Utc::now().date_naive();

        let activity_min = today - Duration::days(100);
        let quote_min = today - Duration::days(30); // Large gap: ~70 days of backfill needed

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(today),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::NeedsBackfill);

        let window = calculate_sync_window(&category, &inputs, today);
        assert!(window.is_some());

        let (start, end) = window.unwrap();

        // End should be quote_min - 1 (not expanded)
        let expected_end = quote_min - Duration::days(1);
        assert_eq!(
            end, expected_end,
            "Large backfill window should end at quote_min - 1"
        );

        // Start should be activity_min - buffer
        let expected_start =
            activity_min - Duration::days(QUOTE_HISTORY_BUFFER_DAYS + BACKFILL_SAFETY_MARGIN_DAYS);
        assert_eq!(start, expected_start);
    }

    #[test]
    fn test_issue_586_repro_backfill_start_can_precede_asset_inception() {
        // Reproduces GH-586:
        // For newer assets, NEEDS_BACKFILL may request a start date earlier than
        // the first available market date (asset inception), causing provider errors.
        let today = NaiveDate::from_ymd_opt(2026, 2, 14).unwrap();

        // Example from issue description shape:
        // - activity_min near inception (buy happened shortly after listing)
        // - earliest available quote (quote_min) effectively represents inception
        let activity_min = NaiveDate::from_ymd_opt(2025, 7, 4).unwrap();
        let quote_min = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(today),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::NeedsBackfill);

        let (start, _end) = calculate_sync_window(&category, &inputs, today).unwrap();

        // Repro detail: planner can request start before quote_min/inception proxy.
        // Runtime sync layer now handles resulting provider boundary errors as non-fatal.
        assert!(
            start < quote_min,
            "expected start ({}) to be before quote_min/inception ({}) for repro",
            start,
            quote_min
        );
    }

    #[test]
    fn test_backfill_window_exactly_minimum_size() {
        // Window exactly at MIN_SYNC_LOOKBACK_DAYS should not expand
        let today = Utc::now().date_naive();

        // Create inputs where gap is exactly MIN_SYNC_LOOKBACK_DAYS
        let buffer = QUOTE_HISTORY_BUFFER_DAYS + BACKFILL_SAFETY_MARGIN_DAYS;
        let activity_min = today - Duration::days(50);
        // quote_min such that (quote_min - 1) - (activity_min - buffer) = MIN_SYNC_LOOKBACK_DAYS
        // quote_min - 1 = activity_min - buffer + MIN_SYNC_LOOKBACK_DAYS
        // quote_min = activity_min - buffer + MIN_SYNC_LOOKBACK_DAYS + 1
        let quote_min =
            activity_min - Duration::days(buffer) + Duration::days(MIN_SYNC_LOOKBACK_DAYS + 1);

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(today),
        );

        let category = determine_sync_category(&inputs, 30, today);
        // This might be Active if quote coverage is sufficient, check either way
        if category == SyncCategory::NeedsBackfill {
            let window = calculate_sync_window(&category, &inputs, today);
            assert!(window.is_some());

            let (start, end) = window.unwrap();
            let window_size = (end - start).num_days();

            // Should be exactly MIN_SYNC_LOOKBACK_DAYS (no expansion needed)
            assert_eq!(window_size, MIN_SYNC_LOOKBACK_DAYS);
        }
    }

    #[test]
    fn test_backfill_window_zero_day_gap() {
        // Edge case: start == initial_end (0-day window)
        let today = Utc::now().date_naive();

        // Create a scenario where required_start == quote_min - 1
        let buffer = QUOTE_HISTORY_BUFFER_DAYS + BACKFILL_SAFETY_MARGIN_DAYS;
        let activity_min = today - Duration::days(30);
        let required_start = activity_min - Duration::days(buffer);
        // quote_min = required_start + 1, so initial_end = quote_min - 1 = required_start
        let quote_min = required_start + Duration::days(1);

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(today),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(
            category,
            SyncCategory::NeedsBackfill,
            "Should be NeedsBackfill when required_start < quote_min"
        );

        let window = calculate_sync_window(&category, &inputs, today);
        assert!(
            window.is_some(),
            "Should return valid window even for 0-day gap"
        );

        let (start, end) = window.unwrap();
        let window_size = (end - start).num_days();

        assert!(
            window_size >= MIN_SYNC_LOOKBACK_DAYS,
            "0-day gap should expand to at least {} days, got {}",
            MIN_SYNC_LOOKBACK_DAYS,
            window_size
        );
    }

    #[test]
    fn test_backfill_window_expansion_overlaps_existing_quotes() {
        // When expanding a tiny window, end may overlap with existing quotes
        // This is acceptable - quotes will be upserted
        let today = Utc::now().date_naive();

        let activity_min = today - Duration::days(22);
        let quote_min = today - Duration::days(73);
        let quote_max = today;

        let inputs = create_inputs(
            true,
            None,
            Some(activity_min),
            Some(activity_min),
            Some(quote_min),
            Some(quote_max),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::NeedsBackfill);

        let window = calculate_sync_window(&category, &inputs, today);
        let (start, end) = window.unwrap();

        // Expanded end may be >= quote_min (overlapping existing quotes)
        // This is fine - just verify the window is valid
        assert!(start <= end, "Start should be <= end");
        assert!(
            (end - start).num_days() >= MIN_SYNC_LOOKBACK_DAYS,
            "Window should be at least MIN_SYNC_LOOKBACK_DAYS"
        );
    }

    #[test]
    fn test_active_category_window_always_ends_at_today() {
        // Active assets should always sync to today
        let today = Utc::now().date_naive();

        let inputs = create_inputs(
            true,
            None,
            Some(today - Duration::days(30)),
            Some(today - Duration::days(1)),
            Some(today - Duration::days(100)),
            Some(today - Duration::days(5)),
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::Active);

        let window = calculate_sync_window(&category, &inputs, today);
        let (_, end) = window.unwrap();

        assert_eq!(end, today, "Active category should always end at today");
    }

    #[test]
    fn test_new_category_window_always_ends_at_today() {
        // New assets (no quotes) should sync to today
        let today = Utc::now().date_naive();

        let inputs = create_inputs(
            true,
            None,
            Some(today - Duration::days(30)),
            Some(today - Duration::days(1)),
            None, // No quotes
            None,
        );

        let category = determine_sync_category(&inputs, 30, today);
        assert_eq!(category, SyncCategory::New);

        let window = calculate_sync_window(&category, &inputs, today);
        let (_, end) = window.unwrap();

        assert_eq!(end, today, "New category should always end at today");
    }
}
