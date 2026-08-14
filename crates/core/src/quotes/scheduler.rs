use std::sync::Arc;
use std::time::Duration;

use log::{error, info, warn};

use super::service::QuoteServiceTrait;
use super::sync_state::{
    profile_enrichment_ttl, set_profile_enrichment_ttl, SyncMode,
    DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS,
};
use crate::assets::AssetServiceTrait;

/// Assets enriched per provider round, matching the queue worker's treatment of
/// the same call (`apps/server/src/domain_events/queue_worker.rs`).
const ENRICHMENT_CHUNK_SIZE: usize = 5;

/// Timeout for one enrichment chunk, matching the queue worker.
const ENRICHMENT_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);

/// Default gap between enrichment sweeps, in hours. The sweep is cheap when
/// nothing is stale, so it runs more often than the TTL and spreads refreshes out
/// rather than refreshing the whole portfolio in one burst.
const DEFAULT_PROFILE_ENRICHMENT_INTERVAL_HOURS: u64 = 24;

/// Delay before the first enrichment sweep. Longer than the quote sync's, so
/// startup work (and any creation-triggered enrichment) settles first.
const PROFILE_ENRICHMENT_INITIAL_DELAY: Duration = Duration::from_secs(300);

/// How often profiles are refreshed, and how stale one must be to qualify.
///
/// Read from the environment so an operator can tune or disable the behaviour
/// without a rebuild — both the server and Tauri startup paths use this, so the
/// two stay in step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileEnrichmentConfig {
    /// Gap between sweeps.
    pub interval: Duration,
    /// Age at which a profile is refetched. `None` disables periodic enrichment,
    /// leaving the legacy behaviour: enrich once at asset creation, never again.
    pub ttl: Option<chrono::Duration>,
}

impl Default for ProfileEnrichmentConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(DEFAULT_PROFILE_ENRICHMENT_INTERVAL_HOURS * 3600),
            ttl: Some(chrono::Duration::days(DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS)),
        }
    }
}

impl ProfileEnrichmentConfig {
    /// Build from `WF_PROFILE_ENRICHMENT_TTL_DAYS` and
    /// `WF_PROFILE_ENRICHMENT_INTERVAL_HOURS`.
    ///
    /// A TTL of `0` disables periodic enrichment. Unparseable or negative values
    /// fall back to the defaults with a warning rather than failing startup.
    pub fn from_env() -> Self {
        let defaults = Self::default();

        let ttl = match std::env::var("WF_PROFILE_ENRICHMENT_TTL_DAYS") {
            Err(_) => defaults.ttl,
            Ok(raw) => match raw.trim().parse::<i64>() {
                Ok(0) => None,
                Ok(days) if days > 0 => Some(chrono::Duration::days(days)),
                _ => {
                    warn!(
                        "Ignoring invalid WF_PROFILE_ENRICHMENT_TTL_DAYS='{}'; using {} days",
                        raw, DEFAULT_PROFILE_ENRICHMENT_TTL_DAYS
                    );
                    defaults.ttl
                }
            },
        };

        let interval = match std::env::var("WF_PROFILE_ENRICHMENT_INTERVAL_HOURS") {
            Err(_) => defaults.interval,
            Ok(raw) => match raw.trim().parse::<u64>() {
                Ok(hours) if hours > 0 => Duration::from_secs(hours * 3600),
                _ => {
                    warn!(
                        "Ignoring invalid WF_PROFILE_ENRICHMENT_INTERVAL_HOURS='{}'; using {}h",
                        raw, DEFAULT_PROFILE_ENRICHMENT_INTERVAL_HOURS
                    );
                    defaults.interval
                }
            },
        };

        Self { interval, ttl }
    }

    /// Publish the TTL process-wide, so the freshness predicate and the repository
    /// query both see it. Returns the TTL actually in force.
    ///
    /// Call this **before** building services: the domain-event queue worker can
    /// reach `needs_profile_enrichment` as soon as it starts, and the first reader
    /// fixes the TTL for the process. Losing that race would silently ignore the
    /// operator's setting, so a mismatch is warned about rather than swallowed.
    pub fn apply(&self) -> Option<chrono::Duration> {
        if set_profile_enrichment_ttl(self.ttl) {
            return self.ttl;
        }

        let effective = profile_enrichment_ttl();
        if effective != self.ttl {
            warn!(
                "Profile enrichment TTL was already fixed at {:?} before configuration \
                 was applied; ignoring the configured {:?}",
                effective, self.ttl
            );
        }
        effective
    }
}

/// Runs periodic market data sync on a fixed interval.
///
/// Sleeps for `initial_delay`, then loops: sync → sleep `interval`.
/// Never panics — errors are logged and the loop continues.
pub async fn run_periodic_sync(
    quote_service: Arc<dyn QuoteServiceTrait>,
    initial_delay: Duration,
    interval: Duration,
) {
    tokio::time::sleep(initial_delay).await;
    info!(
        "Periodic market data sync started (interval: {}h)",
        interval.as_secs() / 3600
    );

    loop {
        info!("Periodic market data sync: starting incremental sync");
        match quote_service.sync(SyncMode::Incremental, None).await {
            Ok(result) => {
                info!(
                    "Periodic market data sync completed: {} synced, {} skipped, {} failed",
                    result.synced, result.skipped, result.failed
                );
            }
            Err(e) => {
                error!("Periodic market data sync failed: {}", e);
            }
        }
        tokio::time::sleep(interval).await;
    }
}

/// Read the enrichment cadence from the environment and publish the TTL, before any
/// service exists that could read it first.
///
/// Both startup paths call this as one of their first actions, then hand the result
/// to [`start_periodic_profile_enrichment`] once services are built — so the two
/// binaries cannot drift apart in cadence or in how the environment is read.
pub fn configure_profile_enrichment() -> ProfileEnrichmentConfig {
    let config = ProfileEnrichmentConfig::from_env();
    let effective = config.apply();
    ProfileEnrichmentConfig {
        interval: config.interval,
        ttl: effective,
    }
}

/// Spawn periodic profile enrichment, or log why it is off.
pub fn start_periodic_profile_enrichment(
    quote_service: Arc<dyn QuoteServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    config: ProfileEnrichmentConfig,
) {
    let Some(ttl) = config.ttl else {
        info!(
            "Periodic asset profile enrichment disabled (WF_PROFILE_ENRICHMENT_TTL_DAYS=0); \
             profiles will be enriched once at asset creation only"
        );
        return;
    };

    info!(
        "Scheduling asset profile enrichment: refreshing profiles older than {}d, sweeping every {}h",
        ttl.num_days(),
        config.interval.as_secs() / 3600
    );

    tokio::spawn(run_periodic_profile_enrichment(
        quote_service,
        asset_service,
        PROFILE_ENRICHMENT_INITIAL_DELAY,
        config.interval,
    ));
}

/// Runs periodic asset-profile enrichment on a fixed interval.
///
/// Without this, `plan_asset_enrichment` only reacts to `DomainEvent::AssetsCreated`,
/// so `peRatio`, `dividendYield` and the 52-week range are captured once when an
/// asset is first added and never refreshed again.
///
/// Same shape as [`run_periodic_sync`]: sleep, then loop, logging errors and
/// continuing. Never panics.
pub async fn run_periodic_profile_enrichment(
    quote_service: Arc<dyn QuoteServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    initial_delay: Duration,
    interval: Duration,
) {
    tokio::time::sleep(initial_delay).await;
    info!(
        "Periodic asset profile enrichment started (interval: {}h)",
        interval.as_secs() / 3600
    );

    loop {
        enrich_stale_profiles_once(&*quote_service, &*asset_service).await;
        tokio::time::sleep(interval).await;
    }
}

/// One enrichment sweep. Separated from the loop so the body stays readable and
/// errors are contained to a single pass.
async fn enrich_stale_profiles_once(
    quote_service: &dyn QuoteServiceTrait,
    asset_service: &dyn AssetServiceTrait,
) {
    let stale = match quote_service.get_assets_needing_profile_enrichment() {
        Ok(stale) => stale,
        Err(e) => {
            error!("Periodic profile enrichment: failed to list stale profiles: {e}");
            return;
        }
    };

    let asset_ids: Vec<String> = stale.into_iter().map(|state| state.asset_id).collect();
    if asset_ids.is_empty() {
        info!("Periodic profile enrichment: no stale profiles, nothing to do");
        return;
    }

    info!(
        "Periodic profile enrichment: {} stale profile(s) to refresh",
        asset_ids.len()
    );

    let (mut enriched, mut skipped, mut failed) = (0usize, 0usize, 0usize);

    for chunk in asset_ids.chunks(ENRICHMENT_CHUNK_SIZE) {
        match tokio::time::timeout(
            ENRICHMENT_CHUNK_TIMEOUT,
            asset_service.enrich_assets(chunk.to_vec()),
        )
        .await
        {
            Ok(Ok((chunk_enriched, chunk_skipped, chunk_failed))) => {
                enriched += chunk_enriched;
                skipped += chunk_skipped;
                failed += chunk_failed;
            }
            Ok(Err(e)) => {
                warn!("Periodic profile enrichment: chunk failed: {e}");
                failed += chunk.len();
            }
            Err(_) => {
                warn!(
                    "Periodic profile enrichment: chunk timed out ({} asset(s))",
                    chunk.len()
                );
                failed += chunk.len();
            }
        }
    }

    info!(
        "Periodic profile enrichment completed: {enriched} enriched, {skipped} skipped, {failed} failed"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_enriches_weekly_and_sweeps_daily() {
        let config = ProfileEnrichmentConfig::default();
        assert_eq!(config.ttl, Some(chrono::Duration::days(7)));
        assert_eq!(config.interval, Duration::from_secs(24 * 3600));
    }

    /// The sweep runs more often than the TTL on purpose: refreshes then spread
    /// across days instead of arriving as one burst every TTL.
    #[test]
    fn sweep_interval_is_shorter_than_the_ttl() {
        let config = ProfileEnrichmentConfig::default();
        let ttl = config.ttl.expect("default ttl is enabled");
        assert!(config.interval.as_secs() < ttl.num_seconds() as u64);
    }

    #[test]
    fn enrichment_chunking_matches_the_queue_worker() {
        assert_eq!(ENRICHMENT_CHUNK_SIZE, 5);
        assert_eq!(ENRICHMENT_CHUNK_TIMEOUT, Duration::from_secs(30));
    }

    /// `apply` reports the TTL actually in force, not the one requested. Startup
    /// calls it before services exist so the two always match; if something read the
    /// TTL first, the caller must see the effective value rather than assume its own.
    #[test]
    fn apply_returns_the_ttl_actually_in_force() {
        let config = ProfileEnrichmentConfig::default();
        let effective = config.apply();

        assert_eq!(
            effective,
            profile_enrichment_ttl(),
            "apply must report what the predicate and the repository query will see"
        );

        // Idempotent: a second apply of the same config agrees with the first.
        assert_eq!(config.apply(), effective);
    }

    /// Both startup paths route through this, so neither can invent its own cadence.
    #[test]
    fn configure_reports_the_effective_ttl_with_the_configured_interval() {
        let configured = configure_profile_enrichment();

        assert_eq!(configured.ttl, profile_enrichment_ttl());
        assert_eq!(
            configured.interval,
            ProfileEnrichmentConfig::from_env().interval
        );
    }
}
