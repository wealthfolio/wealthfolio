//! Provider registry for orchestrating market data providers.
//!
//! The registry manages multiple providers, handling:
//! - Provider selection based on instrument kind, coverage, and capabilities
//! - Fallback to alternative providers on failure
//! - Rate limiting and circuit breaking
//! - Quote validation
//! - Diagnostic tracking for debugging provider selection

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use log::{debug, warn};

use super::{
    CircuitBreaker, FetchDiagnostics, QuoteValidator, RateLimitConfig, RateLimiter, SkipReason,
};
use crate::errors::{MarketDataError, RetryClass};
use crate::models::{
    AssetProfile, DividendEvent, InstrumentId, ProviderId, Quote, QuoteContext, SearchResult,
    SplitEvent,
};
use crate::provider::MarketDataProvider;
use crate::resolver::SymbolResolver;

/// Provider registry for orchestrating market data fetching.
pub struct ProviderRegistry {
    providers: Vec<Arc<dyn MarketDataProvider>>,
    resolver: Arc<dyn SymbolResolver>,
    rate_limiter: RateLimiter,
    circuit_breaker: CircuitBreaker,
    validator: QuoteValidator,
    /// User-configured priorities (provider_id -> priority).
    /// Lower values = higher priority. If not set, falls back to provider's default priority.
    custom_priorities: HashMap<String, i32>,
}

impl ProviderRegistry {
    /// Create a new provider registry.
    ///
    /// Automatically configures rate limits for each provider based on their
    /// declared `rate_limit()` capabilities.
    ///
    /// # Arguments
    ///
    /// * `providers` - List of market data providers
    /// * `resolver` - Symbol resolver for provider-specific symbol mapping
    pub fn new(
        providers: Vec<Arc<dyn MarketDataProvider>>,
        resolver: Arc<dyn SymbolResolver>,
    ) -> Self {
        Self::with_priorities(providers, resolver, HashMap::new())
    }

    /// Create a new provider registry with custom priorities.
    ///
    /// # Arguments
    ///
    /// * `providers` - List of market data providers
    /// * `resolver` - Symbol resolver for provider-specific symbol mapping
    /// * `custom_priorities` - User-configured priorities (provider_id -> priority).
    ///   Lower values = higher priority.
    pub fn with_priorities(
        providers: Vec<Arc<dyn MarketDataProvider>>,
        resolver: Arc<dyn SymbolResolver>,
        custom_priorities: HashMap<String, i32>,
    ) -> Self {
        let rate_limiter = RateLimiter::new();

        // Configure rate limits for each provider
        for provider in &providers {
            let limit = provider.rate_limit();
            let provider_id: ProviderId = Cow::Borrowed(provider.id());
            rate_limiter.configure(
                &provider_id,
                RateLimitConfig {
                    requests_per_minute: limit.requests_per_minute,
                    burst_capacity: limit.max_concurrency as f64,
                },
            );
        }

        Self {
            providers,
            resolver,
            rate_limiter,
            circuit_breaker: CircuitBreaker::new(),
            validator: QuoteValidator::new(),
            custom_priorities,
        }
    }

    /// Create a registry with custom configuration.
    pub fn with_config(
        providers: Vec<Arc<dyn MarketDataProvider>>,
        resolver: Arc<dyn SymbolResolver>,
        rate_limiter: RateLimiter,
        circuit_breaker: CircuitBreaker,
        validator: QuoteValidator,
    ) -> Self {
        Self {
            providers,
            resolver,
            rate_limiter,
            circuit_breaker,
            validator,
            custom_priorities: HashMap::new(),
        }
    }

    /// Fetch quotes for an instrument.
    ///
    /// Tries providers in order:
    /// 1. Filter by asset kind capability
    /// 2. Sort by preferred_provider (if set) then priority
    /// 3. Check circuit breaker for each provider
    /// 4. Resolve symbol for provider
    /// 5. Apply rate limiting
    /// 6. Fetch quotes
    /// 7. Validate quotes
    /// 8. On failure, try next provider based on retry class
    pub async fn fetch_quotes(
        &self,
        context: &QuoteContext,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let providers = self.ordered_providers(context, true); // true = historical

        if providers.is_empty() {
            warn!(
                "No providers available for asset kind: {:?}",
                context.instrument.kind()
            );
            return Err(MarketDataError::NoProvidersAvailable);
        }

        let mut last_error: Option<MarketDataError> = None;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            // Check circuit breaker
            if !self.circuit_breaker.is_allowed(&provider_id) {
                debug!(
                    "Circuit breaker open for provider '{}', skipping",
                    provider_id
                );
                continue;
            }

            // Resolve symbol for this provider
            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(e) => {
                    debug!(
                        "Resolution failed for provider '{}': {:?}, trying next",
                        provider_id, e
                    );
                    continue;
                }
            };

            debug!(
                "Fetching quotes from provider '{}' with {:?} (source: {:?})",
                provider_id, resolved.instrument, resolved.source
            );

            // Rate limit
            self.rate_limiter.acquire(&provider_id).await;

            // Fetch quotes
            match provider
                .get_historical_quotes(context, resolved.instrument, start, end)
                .await
            {
                Ok(mut quotes) => {
                    self.circuit_breaker.record_success(&provider_id);

                    // Validate quotes - store original count before drain
                    // Pass instrument context to skip volume validation for FX
                    let original_count = quotes.len();
                    let mut valid_quotes = Vec::with_capacity(original_count);
                    for quote in quotes.drain(..) {
                        match self
                            .validator
                            .validate_for_instrument(&quote, Some(&context.instrument))
                        {
                            Ok(()) => valid_quotes.push(quote),
                            Err(e) => {
                                warn!("Quote validation failed for {:?}: {:?}", quote.timestamp, e);
                            }
                        }
                    }

                    if valid_quotes.is_empty() && original_count > 0 {
                        warn!(
                            "All {} quotes from '{}' failed validation",
                            original_count, provider_id
                        );
                        last_error = Some(MarketDataError::ValidationFailed {
                            message: "All quotes failed validation".to_string(),
                        });
                        continue;
                    }

                    debug!(
                        "Successfully fetched {} valid quotes from '{}'",
                        valid_quotes.len(),
                        provider_id
                    );
                    return Ok(valid_quotes);
                }
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(e) => {
                    let retry_class = e.retry_class();

                    match retry_class {
                        RetryClass::Never => {
                            // Terminal error - don't try other providers
                            debug!(
                                "Terminal error from '{}': {:?}, not retrying",
                                provider_id, e
                            );
                            return Err(e);
                        }
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen => {
                            // Record failure for circuit breaker
                            self.circuit_breaker.record_failure(&provider_id);
                            debug!(
                                "Provider '{}' failed with {:?}, recorded circuit breaker failure",
                                provider_id, e
                            );
                        }
                        RetryClass::NextProvider => {
                            debug!(
                                "Provider '{}' failed with {:?}, trying next provider",
                                provider_id, e
                            );
                        }
                    }

                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or(MarketDataError::AllProvidersFailed))
    }

    /// Fetch the latest quote for an instrument.
    pub async fn fetch_latest_quote(
        &self,
        context: &QuoteContext,
    ) -> Result<Quote, MarketDataError> {
        let providers = self.ordered_providers(context, false); // false = latest

        if providers.is_empty() {
            return Err(MarketDataError::NoProvidersAvailable);
        }

        let mut last_error: Option<MarketDataError> = None;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            if !self.circuit_breaker.is_allowed(&provider_id) {
                continue;
            }

            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(_) => continue,
            };

            self.rate_limiter.acquire(&provider_id).await;

            match provider
                .get_latest_quote(context, resolved.instrument)
                .await
            {
                Ok(quote) => {
                    self.circuit_breaker.record_success(&provider_id);

                    if let Err(e) = self
                        .validator
                        .validate_for_instrument(&quote, Some(&context.instrument))
                    {
                        warn!("Latest quote validation failed: {:?}", e);
                        last_error = Some(e);
                        continue;
                    }

                    return Ok(quote);
                }
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(e) => {
                    let retry_class = e.retry_class();

                    if retry_class == RetryClass::Never {
                        return Err(e);
                    }

                    if matches!(
                        retry_class,
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen
                    ) {
                        self.circuit_breaker.record_failure(&provider_id);
                    }

                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or(MarketDataError::AllProvidersFailed))
    }

    /// Fetch split history for an instrument.
    ///
    /// Tries providers in order. Returns empty vec (not error) if no provider supports splits.
    pub async fn fetch_splits(
        &self,
        context: &QuoteContext,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Vec<SplitEvent> {
        let providers = self.ordered_providers(context, true);

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(_) => continue,
            };

            self.rate_limiter.acquire(&provider_id).await;

            match provider
                .get_splits(context, resolved.instrument, start, end)
                .await
            {
                Ok(splits) => return splits,
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(e) => {
                    warn!("Split fetch failed for provider '{}': {:?}", provider_id, e);
                    continue;
                }
            }
        }

        vec![]
    }

    /// Fetch cash dividend history for an instrument.
    ///
    /// Tries dividend-capable providers in order, using provider fallback semantics
    /// similar to quote fetching.
    pub async fn fetch_dividends(
        &self,
        context: &QuoteContext,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<DividendEvent>, MarketDataError> {
        let mut providers: Vec<_> = self
            .providers
            .iter()
            .filter(|p| {
                let caps = p.capabilities();
                caps.supports_dividends && caps.supports_instrument(&context.instrument)
            })
            .collect();

        self.sort_by_preference(&mut providers, context);

        if providers.is_empty() {
            return Err(MarketDataError::NoProvidersAvailable);
        }

        let mut last_error: Option<MarketDataError> = None;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            if !self.circuit_breaker.is_allowed(&provider_id) {
                continue;
            }

            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(e) => {
                    debug!(
                        "Dividend resolution failed for provider '{}': {:?}",
                        provider_id, e
                    );
                    continue;
                }
            };

            self.rate_limiter.acquire(&provider_id).await;

            match provider
                .get_dividends(context, resolved.instrument, start, end)
                .await
            {
                Ok(mut dividends) => {
                    self.circuit_breaker.record_success(&provider_id);
                    dividends.sort_by_key(|d| d.date);
                    return Ok(dividends);
                }
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(e) => {
                    let retry_class = e.retry_class();

                    if retry_class == RetryClass::Never {
                        return Err(e);
                    }

                    if matches!(
                        retry_class,
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen
                    ) {
                        self.circuit_breaker.record_failure(&provider_id);
                    }

                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or(MarketDataError::AllProvidersFailed))
    }

    /// Get providers ordered by preference for the given context.
    ///
    /// Orders providers by:
    /// 1. Filter to providers that support the instrument (kind + coverage)
    /// 2. Filter by operation capability (historical or latest)
    /// 3. Preferred provider first (if set and available)
    /// 4. Then by priority (lower is higher priority)
    ///
    /// # Arguments
    /// * `context` - The quote context with instrument info
    /// * `for_historical` - If true, filter by `supports_historical`; if false, by `supports_latest`
    fn ordered_providers(
        &self,
        context: &QuoteContext,
        for_historical: bool,
    ) -> Vec<&Arc<dyn MarketDataProvider>> {
        let mut providers: Vec<_> = self
            .providers
            .iter()
            .filter(|p| {
                let caps = p.capabilities();
                // Check instrument support
                if !caps.supports_instrument(&context.instrument) {
                    return false;
                }
                // Check operation capability
                if for_historical {
                    caps.supports_historical
                } else {
                    caps.supports_latest
                }
            })
            .collect();

        self.sort_by_preference(&mut providers, context);
        providers
    }

    /// Get profile-capable providers ordered by preference for the given context.
    fn ordered_profile_providers(
        &self,
        context: &QuoteContext,
    ) -> Vec<&Arc<dyn MarketDataProvider>> {
        let mut providers: Vec<_> = self
            .providers
            .iter()
            .filter(|p| {
                let caps = p.capabilities();
                caps.supports_profile && caps.supports_instrument(&context.instrument)
            })
            .collect();

        self.sort_by_preference(&mut providers, context);
        providers
    }

    /// Filter providers for a fetch operation, recording skip reasons.
    fn filter_providers(
        &self,
        context: &QuoteContext,
        for_historical: bool,
        diagnostics: &mut FetchDiagnostics,
    ) -> Vec<&Arc<dyn MarketDataProvider>> {
        let mut eligible = Vec::new();

        for provider in &self.providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());
            let caps = provider.capabilities();

            // Check capability for fetch type
            if for_historical {
                if !caps.supports_historical {
                    diagnostics
                        .record_skip(provider_id.clone(), SkipReason::HistoricalNotSupported);
                    continue;
                }
            } else if !caps.supports_latest {
                diagnostics.record_skip(provider_id.clone(), SkipReason::LatestNotSupported);
                continue;
            }

            // Check instrument kind
            if !caps
                .instrument_kinds
                .contains(&context.instrument.instrument_kind())
            {
                diagnostics.record_skip(provider_id.clone(), SkipReason::InstrumentKindMismatch);
                continue;
            }

            // Check coverage
            if !caps.coverage.supports(&context.instrument) {
                let skip_reason = match &context.instrument {
                    InstrumentId::Equity { mic, .. } => {
                        if mic.is_none() && !caps.coverage.allow_unknown_mic {
                            SkipReason::UnknownMicRejected
                        } else {
                            SkipReason::MicNotCovered {
                                mic: mic.as_ref().map(|m| m.to_string()),
                            }
                        }
                    }
                    InstrumentId::Metal { quote, .. } => SkipReason::QuoteCurrencyMismatch {
                        expected: quote.to_string(),
                    },
                    _ => SkipReason::InstrumentKindMismatch,
                };
                diagnostics.record_skip(provider_id.clone(), skip_reason);
                continue;
            }

            // Check circuit breaker
            if !self.circuit_breaker.is_allowed(&provider_id) {
                diagnostics.record_skip(provider_id, SkipReason::CircuitBreakerOpen);
                continue;
            }

            eligible.push(provider);
        }

        self.sort_by_preference(&mut eligible, context);
        eligible
    }

    /// Sort providers by preference.
    ///
    /// Priority order:
    /// 1. Preferred provider (from context) always first
    /// 2. Custom user priorities (from settings) if configured
    /// 3. Provider's default priority as fallback
    fn sort_by_preference(
        &self,
        providers: &mut Vec<&Arc<dyn MarketDataProvider>>,
        context: &QuoteContext,
    ) {
        providers.sort_by_key(|p| {
            // Preferred provider always comes first
            if let Some(preferred) = &context.preferred_provider {
                if p.id() == preferred.as_ref() {
                    return i32::MIN;
                }
            }

            // Use custom priority if configured, otherwise use provider's default
            self.custom_priorities
                .get(p.id())
                .copied()
                .unwrap_or_else(|| p.priority() as i32)
        });
    }

    /// Get the list of registered providers.
    pub fn providers(&self) -> &[Arc<dyn MarketDataProvider>] {
        &self.providers
    }

    /// Check if a provider's circuit is open.
    pub fn is_circuit_open(&self, provider_id: &ProviderId) -> bool {
        !self.circuit_breaker.is_allowed(provider_id)
    }

    /// Reset a provider's circuit breaker.
    pub fn reset_circuit(&self, provider_id: &ProviderId) {
        self.circuit_breaker.reset(provider_id);
    }

    /// Search for symbols matching the query.
    ///
    /// Tries providers that support search until one succeeds.
    pub async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let mut providers: Vec<_> = self
            .providers
            .iter()
            .filter(|p| p.capabilities().supports_search)
            .collect();
        providers.sort_by_key(|p| {
            self.custom_priorities
                .get(p.id())
                .copied()
                .unwrap_or_else(|| p.priority() as i32)
        });

        if providers.is_empty() {
            return Err(MarketDataError::NotSupported {
                operation: "search".to_string(),
                provider: "all".to_string(),
            });
        }

        let mut last_error: Option<MarketDataError> = None;
        let mut fallback_results: Option<Vec<SearchResult>> = None;

        for (i, provider) in providers.iter().enumerate() {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            if !self.circuit_breaker.is_allowed(&provider_id) {
                warn!("Search: skipping '{}' — circuit breaker open", provider_id);
                continue;
            }

            // Primary provider: wait for rate limit token.
            // Fallback providers: skip if rate-limited (avoids multi-second stalls
            // when the primary returns empty for a speculative candidate).
            if i == 0 {
                self.rate_limiter.acquire(&provider_id).await;
            } else if !self.rate_limiter.try_acquire(&provider_id) {
                debug!(
                    "Search: skipping '{}' for '{}' — rate limited",
                    provider_id, query
                );
                continue;
            }

            match provider.search(query).await {
                Ok(results) if !results.is_empty() => {
                    self.circuit_breaker.record_success(&provider_id);
                    // If any result has MIC, return immediately
                    if results.iter().any(|r| r.exchange_mic.is_some())
                        || fallback_results.is_some()
                    {
                        return Ok(results);
                    }
                    // Save as fallback, try next provider for MIC-enriched results
                    fallback_results = Some(results);
                }
                Ok(_) => {
                    debug!(
                        "Provider '{}' returned no search results for '{}'",
                        provider_id, query
                    );
                }
                Err(MarketDataError::NotSupported { .. }) => {
                    continue;
                }
                Err(e) => {
                    warn!(
                        "Search: provider '{}' failed for '{}': {}",
                        provider_id, query, e
                    );
                    let retry_class = e.retry_class();
                    if matches!(
                        retry_class,
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen
                    ) {
                        self.circuit_breaker.record_failure(&provider_id);
                    }
                    last_error = Some(e);
                }
            }
        }

        if let Some(results) = fallback_results {
            return Ok(results);
        }

        Err(last_error.unwrap_or(MarketDataError::AllProvidersFailed))
    }

    /// Get asset profile for an instrument.
    ///
    /// Uses the same resolver as quote fetching to build provider-specific symbols
    /// (e.g., "VFV.TO" for Yahoo when the MIC is XTSE).
    ///
    /// Tries providers that support profiles until one succeeds.
    pub async fn get_profile(
        &self,
        context: &QuoteContext,
    ) -> Result<AssetProfile, MarketDataError> {
        let providers = self.ordered_profile_providers(context);

        if providers.is_empty() {
            return Err(MarketDataError::NotSupported {
                operation: "profile".to_string(),
                provider: "all".to_string(),
            });
        }

        let mut last_error: Option<MarketDataError> = None;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            if !self.circuit_breaker.is_allowed(&provider_id) {
                continue;
            }

            // Resolve the provider-specific symbol
            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(_) => continue, // Provider can't handle this instrument
            };

            let symbol = resolved.instrument.to_symbol_string();

            self.rate_limiter.acquire(&provider_id).await;

            match provider.get_profile(&symbol).await {
                Ok(profile) => {
                    self.circuit_breaker.record_success(&provider_id);
                    return Ok(profile);
                }
                Err(MarketDataError::NotSupported { .. }) => {
                    continue;
                }
                Err(MarketDataError::SymbolNotFound(_)) => {
                    // Terminal for this provider, try next
                    continue;
                }
                Err(e) => {
                    let retry_class = e.retry_class();
                    if matches!(
                        retry_class,
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen
                    ) {
                        self.circuit_breaker.record_failure(&provider_id);
                    }
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            MarketDataError::SymbolNotFound(format!("{:?}", context.instrument))
        }))
    }

    /// Fetch quotes for an instrument with diagnostics.
    ///
    /// Returns both the result and detailed diagnostics about which providers
    /// were tried, skipped, or failed. Useful for debugging provider selection.
    pub async fn fetch_quotes_with_diagnostics(
        &self,
        context: &QuoteContext,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> (Result<Vec<Quote>, MarketDataError>, FetchDiagnostics) {
        let mut diagnostics = FetchDiagnostics::new();
        let providers = self.filter_providers(context, true, &mut diagnostics);

        if providers.is_empty() {
            warn!(
                "No providers available for instrument: {:?}. Diagnostics: {}",
                context.instrument,
                diagnostics.summary()
            );
            return (Err(MarketDataError::NoProvidersAvailable), diagnostics);
        }

        let mut last_error: Option<MarketDataError> = None;
        let mut saw_no_data = false;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            // Resolve symbol for this provider
            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(e) => {
                    diagnostics.record_skip(
                        provider_id.clone(),
                        SkipReason::ResolutionFailed {
                            message: format!("{:?}", e),
                        },
                    );
                    continue;
                }
            };

            debug!(
                "Fetching quotes from provider '{}' with {:?} (source: {:?})",
                provider_id, resolved.instrument, resolved.source
            );

            self.rate_limiter.acquire(&provider_id).await;

            match provider
                .get_historical_quotes(context, resolved.instrument, start, end)
                .await
            {
                Ok(mut quotes) => {
                    let original_count = quotes.len();
                    if original_count == 0 {
                        diagnostics.record_error(
                            provider_id.clone(),
                            "No data returned for requested range".to_string(),
                        );
                        saw_no_data = true;
                        continue;
                    }

                    let mut valid_quotes = Vec::with_capacity(original_count);
                    for quote in quotes.drain(..) {
                        match self
                            .validator
                            .validate_for_instrument(&quote, Some(&context.instrument))
                        {
                            Ok(()) => valid_quotes.push(quote),
                            Err(e) => {
                                warn!("Quote validation failed for {:?}: {:?}", quote.timestamp, e);
                            }
                        }
                    }

                    if valid_quotes.is_empty() {
                        diagnostics.record_error(
                            provider_id.clone(),
                            "All quotes failed validation".to_string(),
                        );
                        last_error = Some(MarketDataError::ValidationFailed {
                            message: "All quotes failed validation".to_string(),
                        });
                        continue;
                    }

                    self.circuit_breaker.record_success(&provider_id);
                    diagnostics.record_success(provider_id);
                    return (Ok(valid_quotes), diagnostics);
                }
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(MarketDataError::NoDataForRange) => {
                    diagnostics.record_error(
                        provider_id,
                        "No data returned for requested range".to_string(),
                    );
                    saw_no_data = true;
                    continue;
                }
                Err(e) => {
                    let retry_class = e.retry_class();
                    diagnostics.record_error(provider_id.clone(), format!("{:?}", e));

                    match retry_class {
                        RetryClass::Never => {
                            return (Err(e), diagnostics);
                        }
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen => {
                            self.circuit_breaker.record_failure(&provider_id);
                        }
                        RetryClass::NextProvider => {}
                    }

                    last_error = Some(e);
                }
            }
        }

        warn!(
            "All providers failed. Diagnostics: {}",
            diagnostics.summary()
        );
        let error = last_error.unwrap_or_else(|| {
            if saw_no_data {
                MarketDataError::NoDataForRange
            } else {
                MarketDataError::AllProvidersFailed
            }
        });
        (Err(error), diagnostics)
    }

    /// Fetch latest quote for an instrument with diagnostics.
    pub async fn fetch_latest_quote_with_diagnostics(
        &self,
        context: &QuoteContext,
    ) -> (Result<Quote, MarketDataError>, FetchDiagnostics) {
        let mut diagnostics = FetchDiagnostics::new();
        let providers = self.filter_providers(context, false, &mut diagnostics);

        if providers.is_empty() {
            return (Err(MarketDataError::NoProvidersAvailable), diagnostics);
        }

        let mut last_error: Option<MarketDataError> = None;

        for provider in providers {
            let provider_id: ProviderId = Cow::Borrowed(provider.id());

            let resolved = match self.resolver.resolve(&provider_id, context) {
                Ok(r) => r,
                Err(e) => {
                    diagnostics.record_skip(
                        provider_id.clone(),
                        SkipReason::ResolutionFailed {
                            message: format!("{:?}", e),
                        },
                    );
                    continue;
                }
            };

            self.rate_limiter.acquire(&provider_id).await;

            match provider
                .get_latest_quote(context, resolved.instrument)
                .await
            {
                Ok(quote) => {
                    self.circuit_breaker.record_success(&provider_id);

                    if let Err(e) = self
                        .validator
                        .validate_for_instrument(&quote, Some(&context.instrument))
                    {
                        diagnostics.record_error(provider_id.clone(), format!("{:?}", e));
                        last_error = Some(e);
                        continue;
                    }

                    diagnostics.record_success(provider_id);
                    return (Ok(quote), diagnostics);
                }
                Err(MarketDataError::NotSupported { .. }) => continue,
                Err(e) => {
                    let retry_class = e.retry_class();
                    diagnostics.record_error(provider_id.clone(), format!("{:?}", e));

                    if retry_class == RetryClass::Never {
                        return (Err(e), diagnostics);
                    }

                    if matches!(
                        retry_class,
                        RetryClass::FailoverWithPenalty | RetryClass::CircuitOpen
                    ) {
                        self.circuit_breaker.record_failure(&provider_id);
                    }

                    last_error = Some(e);
                }
            }
        }

        (
            Err(last_error.unwrap_or(MarketDataError::AllProvidersFailed)),
            diagnostics,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Coverage, Currency, InstrumentKind, ProviderInstrument};
    use crate::provider::{ProviderCapabilities, RateLimit};
    use crate::resolver::{ResolutionSource, ResolvedInstrument};
    use rust_decimal_macros::dec;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct MockProvider {
        id: &'static str,
        priority: u8,
        call_count: AtomicUsize,
        should_fail: bool,
    }

    impl MockProvider {
        fn new(id: &'static str, priority: u8, should_fail: bool) -> Self {
            Self {
                id,
                priority,
                call_count: AtomicUsize::new(0),
                should_fail,
            }
        }
    }

    #[async_trait::async_trait]
    impl MarketDataProvider for MockProvider {
        fn id(&self) -> &'static str {
            self.id
        }

        fn priority(&self) -> u8 {
            self.priority
        }

        fn capabilities(&self) -> ProviderCapabilities {
            ProviderCapabilities {
                instrument_kinds: &[InstrumentKind::Equity, InstrumentKind::Fx],
                coverage: Coverage::global_best_effort(),
                supports_latest: true,
                supports_historical: true,
                supports_search: false,
                supports_profile: false,
                supports_dividends: false,
            }
        }

        fn rate_limit(&self) -> RateLimit {
            RateLimit {
                requests_per_minute: 100,
                max_concurrency: 10,
                min_delay: Duration::ZERO,
            }
        }

        async fn get_latest_quote(
            &self,
            _context: &QuoteContext,
            _instrument: ProviderInstrument,
        ) -> Result<Quote, MarketDataError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);

            if self.should_fail {
                Err(MarketDataError::ProviderError {
                    provider: self.id.to_string(),
                    message: "Mock failure".to_string(),
                })
            } else {
                Ok(Quote {
                    timestamp: Utc::now(),
                    open: Some(dec!(100)),
                    high: Some(dec!(105)),
                    low: Some(dec!(95)),
                    close: dec!(102),
                    volume: Some(dec!(1000)),
                    currency: "USD".to_string(),
                    source: self.id.to_string(),
                })
            }
        }

        async fn get_historical_quotes(
            &self,
            _context: &QuoteContext,
            _instrument: ProviderInstrument,
            _start: DateTime<Utc>,
            _end: DateTime<Utc>,
        ) -> Result<Vec<Quote>, MarketDataError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);

            if self.should_fail {
                Err(MarketDataError::ProviderError {
                    provider: self.id.to_string(),
                    message: "Mock failure".to_string(),
                })
            } else {
                Ok(vec![Quote {
                    timestamp: Utc::now(),
                    open: Some(dec!(100)),
                    high: Some(dec!(105)),
                    low: Some(dec!(95)),
                    close: dec!(102),
                    volume: Some(dec!(1000)),
                    currency: "USD".to_string(),
                    source: self.id.to_string(),
                }])
            }
        }
    }

    struct MockResolver;

    impl SymbolResolver for MockResolver {
        fn resolve(
            &self,
            _provider: &ProviderId,
            _context: &QuoteContext,
        ) -> Result<ResolvedInstrument, MarketDataError> {
            Ok(ResolvedInstrument {
                instrument: ProviderInstrument::EquitySymbol {
                    symbol: Arc::from("TEST"),
                },
                source: ResolutionSource::Rules,
            })
        }

        fn get_currency(
            &self,
            _provider: &ProviderId,
            _context: &QuoteContext,
        ) -> Option<Currency> {
            Some(Cow::Borrowed("USD"))
        }
    }

    struct EmptyHistoricalProvider {
        call_count: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl MarketDataProvider for EmptyHistoricalProvider {
        fn id(&self) -> &'static str {
            "EMPTY"
        }

        fn priority(&self) -> u8 {
            1
        }

        fn capabilities(&self) -> ProviderCapabilities {
            ProviderCapabilities {
                instrument_kinds: &[InstrumentKind::Equity],
                coverage: Coverage::global_best_effort(),
                supports_latest: false,
                supports_historical: true,
                supports_search: false,
                supports_profile: false,
                supports_dividends: false,
            }
        }

        fn rate_limit(&self) -> RateLimit {
            RateLimit::default()
        }

        async fn get_latest_quote(
            &self,
            _: &QuoteContext,
            _: ProviderInstrument,
        ) -> Result<Quote, MarketDataError> {
            unreachable!()
        }

        async fn get_historical_quotes(
            &self,
            _: &QuoteContext,
            _: ProviderInstrument,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<Vec<Quote>, MarketDataError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn test_empty_historical_result_falls_back_to_next_provider() {
        let empty_calls = Arc::new(AtomicUsize::new(0));
        let fallback = Arc::new(MockProvider::new("FALLBACK", 10, false));
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(EmptyHistoricalProvider {
                call_count: empty_calls.clone(),
            }),
            fallback.clone(),
        ];
        let registry = ProviderRegistry::new(providers, Arc::new(MockResolver));
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let (result, _) = registry
            .fetch_quotes_with_diagnostics(&context, Utc::now(), Utc::now())
            .await;
        let quotes = result.unwrap();

        assert_eq!(empty_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fallback.call_count.load(Ordering::SeqCst), 1);
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0].source, "FALLBACK");
    }

    #[tokio::test]
    async fn test_empty_historical_result_returns_no_data_without_fallback() {
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![Arc::new(EmptyHistoricalProvider {
            call_count: Arc::new(AtomicUsize::new(0)),
        })];
        let registry = ProviderRegistry::new(providers, Arc::new(MockResolver));
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let (result, _) = registry
            .fetch_quotes_with_diagnostics(&context, Utc::now(), Utc::now())
            .await;

        assert!(matches!(result, Err(MarketDataError::NoDataForRange)));
    }

    #[tokio::test]
    async fn test_empty_result_does_not_mask_provider_error() {
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("FAILING", 0, true)),
            Arc::new(EmptyHistoricalProvider {
                call_count: Arc::new(AtomicUsize::new(0)),
            }),
        ];
        let registry = ProviderRegistry::new(providers, Arc::new(MockResolver));
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let (result, _) = registry
            .fetch_quotes_with_diagnostics(&context, Utc::now(), Utc::now())
            .await;

        assert!(matches!(
            result,
            Err(MarketDataError::ProviderError { provider, .. }) if provider == "FAILING"
        ));
    }

    #[test]
    fn test_provider_ordering_by_priority() {
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("LOW_PRIORITY", 20, false)),
            Arc::new(MockProvider::new("HIGH_PRIORITY", 5, false)),
            Arc::new(MockProvider::new("MED_PRIORITY", 10, false)),
        ];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);

        // Use a known MIC so coverage check passes
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let ordered = registry.ordered_providers(&context, true);

        assert_eq!(ordered[0].id(), "HIGH_PRIORITY");
        assert_eq!(ordered[1].id(), "MED_PRIORITY");
        assert_eq!(ordered[2].id(), "LOW_PRIORITY");
    }

    #[test]
    fn test_preferred_provider_first() {
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("PROVIDER_A", 5, false)),
            Arc::new(MockProvider::new("PROVIDER_B", 10, false)),
            Arc::new(MockProvider::new("PROVIDER_C", 15, false)),
        ];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: Some(Cow::Borrowed("PROVIDER_C")),
            bond_metadata: None,
            custom_provider_code: None,
        };

        let ordered = registry.ordered_providers(&context, true);

        // PROVIDER_C should be first despite having lowest priority
        assert_eq!(ordered[0].id(), "PROVIDER_C");
        assert_eq!(ordered[1].id(), "PROVIDER_A");
        assert_eq!(ordered[2].id(), "PROVIDER_B");
    }

    #[test]
    fn test_filter_by_instrument_kind() {
        struct CryptoOnlyProvider;

        #[async_trait::async_trait]
        impl MarketDataProvider for CryptoOnlyProvider {
            fn id(&self) -> &'static str {
                "CRYPTO_ONLY"
            }
            fn capabilities(&self) -> ProviderCapabilities {
                ProviderCapabilities {
                    instrument_kinds: &[InstrumentKind::Crypto],
                    coverage: Coverage::global_best_effort(),
                    supports_latest: true,
                    supports_historical: true,
                    supports_search: false,
                    supports_profile: false,
                    supports_dividends: false,
                }
            }
            fn rate_limit(&self) -> RateLimit {
                RateLimit {
                    requests_per_minute: 100,
                    max_concurrency: 10,
                    min_delay: Duration::ZERO,
                }
            }
            async fn get_latest_quote(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
            ) -> Result<Quote, MarketDataError> {
                unimplemented!()
            }
            async fn get_historical_quotes(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
                _: DateTime<Utc>,
                _: DateTime<Utc>,
            ) -> Result<Vec<Quote>, MarketDataError> {
                unimplemented!()
            }
        }

        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("EQUITY_PROVIDER", 5, false)),
            Arc::new(CryptoOnlyProvider),
        ];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);

        // Equity context should only include EQUITY_PROVIDER
        let equity_context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let equity_providers = registry.ordered_providers(&equity_context, true);
        assert_eq!(equity_providers.len(), 1);
        assert_eq!(equity_providers[0].id(), "EQUITY_PROVIDER");

        // Crypto context should only include CRYPTO_ONLY
        let crypto_context = QuoteContext {
            instrument: InstrumentId::Crypto {
                base: Arc::from("BTC"),
                quote: Cow::Borrowed("USD"),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let crypto_providers = registry.ordered_providers(&crypto_context, true);
        assert_eq!(crypto_providers.len(), 1);
        assert_eq!(crypto_providers[0].id(), "CRYPTO_ONLY");
    }

    #[test]
    fn test_filter_by_coverage() {
        struct UsOnlyProvider;

        #[async_trait::async_trait]
        impl MarketDataProvider for UsOnlyProvider {
            fn id(&self) -> &'static str {
                "US_ONLY"
            }
            fn capabilities(&self) -> ProviderCapabilities {
                ProviderCapabilities {
                    instrument_kinds: &[InstrumentKind::Equity],
                    coverage: Coverage::us_only_strict(),
                    supports_latest: true,
                    supports_historical: true,
                    supports_search: false,
                    supports_profile: false,
                    supports_dividends: false,
                }
            }
            fn rate_limit(&self) -> RateLimit {
                RateLimit::default()
            }
            async fn get_latest_quote(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
            ) -> Result<Quote, MarketDataError> {
                unimplemented!()
            }
            async fn get_historical_quotes(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
                _: DateTime<Utc>,
                _: DateTime<Utc>,
            ) -> Result<Vec<Quote>, MarketDataError> {
                unimplemented!()
            }
        }

        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![Arc::new(UsOnlyProvider)];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);

        // US equity should be supported
        let us_context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AAPL"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        assert_eq!(registry.ordered_providers(&us_context, true).len(), 1);

        // Canadian equity should be filtered out
        let ca_context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some(Cow::Borrowed("XTSE")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        assert_eq!(registry.ordered_providers(&ca_context, true).len(), 0);

        // Unknown MIC should be filtered out (strict mode)
        let unknown_context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AAPL"),
                mic: None,
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };
        assert_eq!(registry.ordered_providers(&unknown_context, true).len(), 0);
    }

    #[test]
    fn test_custom_priorities_override_defaults() {
        // Providers with hardcoded priorities: 5, 10, 20
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("PROVIDER_A", 5, false)), // Default priority 5
            Arc::new(MockProvider::new("PROVIDER_B", 10, false)), // Default priority 10
            Arc::new(MockProvider::new("PROVIDER_C", 20, false)), // Default priority 20
        ];

        // Custom priorities: C=1 (highest), A=50 (lowest), B not set (uses default 10)
        let mut custom_priorities = HashMap::new();
        custom_priorities.insert("PROVIDER_C".to_string(), 1); // Override to highest priority
        custom_priorities.insert("PROVIDER_A".to_string(), 50); // Override to lowest priority

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::with_priorities(providers, resolver, custom_priorities);

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let ordered = registry.ordered_providers(&context, true);

        // Order should be: C (priority 1), B (priority 10 default), A (priority 50)
        assert_eq!(ordered[0].id(), "PROVIDER_C");
        assert_eq!(ordered[1].id(), "PROVIDER_B");
        assert_eq!(ordered[2].id(), "PROVIDER_A");
    }

    #[test]
    fn test_preferred_provider_overrides_custom_priorities() {
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(MockProvider::new("PROVIDER_A", 5, false)),
            Arc::new(MockProvider::new("PROVIDER_B", 10, false)),
            Arc::new(MockProvider::new("PROVIDER_C", 20, false)),
        ];

        // Custom priorities: A=1 (highest)
        let mut custom_priorities = HashMap::new();
        custom_priorities.insert("PROVIDER_A".to_string(), 1);
        custom_priorities.insert("PROVIDER_B".to_string(), 2);
        custom_priorities.insert("PROVIDER_C".to_string(), 3);

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::with_priorities(providers, resolver, custom_priorities);

        // Request with preferred_provider = PROVIDER_C (lowest custom priority)
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: Some(Cow::Borrowed("PROVIDER_C")),
            bond_metadata: None,
            custom_provider_code: None,
        };

        let ordered = registry.ordered_providers(&context, true);

        // Preferred provider should still come first
        assert_eq!(ordered[0].id(), "PROVIDER_C");
        assert_eq!(ordered[1].id(), "PROVIDER_A");
        assert_eq!(ordered[2].id(), "PROVIDER_B");
    }

    #[tokio::test]
    async fn test_get_profile_respects_coverage_and_preference() {
        struct ProfileProvider {
            id: &'static str,
            coverage: Coverage,
            call_count: Arc<AtomicUsize>,
        }

        #[async_trait::async_trait]
        impl MarketDataProvider for ProfileProvider {
            fn id(&self) -> &'static str {
                self.id
            }

            fn priority(&self) -> u8 {
                10
            }

            fn capabilities(&self) -> ProviderCapabilities {
                ProviderCapabilities {
                    instrument_kinds: &[InstrumentKind::Equity],
                    coverage: self.coverage,
                    supports_latest: false,
                    supports_historical: false,
                    supports_search: false,
                    supports_profile: true,
                    supports_dividends: false,
                }
            }

            fn rate_limit(&self) -> RateLimit {
                RateLimit::default()
            }

            async fn get_latest_quote(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
            ) -> Result<Quote, MarketDataError> {
                unreachable!()
            }

            async fn get_historical_quotes(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
                _: DateTime<Utc>,
                _: DateTime<Utc>,
            ) -> Result<Vec<Quote>, MarketDataError> {
                unreachable!()
            }

            async fn get_profile(&self, _: &str) -> Result<AssetProfile, MarketDataError> {
                self.call_count.fetch_add(1, Ordering::SeqCst);
                Ok(AssetProfile::with_name(self.id))
            }
        }

        let us_calls = Arc::new(AtomicUsize::new(0));
        let global_calls = Arc::new(AtomicUsize::new(0));
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(ProfileProvider {
                id: "US_ONLY_PROFILE",
                coverage: Coverage::us_only_strict(),
                call_count: us_calls.clone(),
            }),
            Arc::new(ProfileProvider {
                id: "GLOBAL_PROFILE",
                coverage: Coverage::global_best_effort(),
                call_count: global_calls.clone(),
            }),
        ];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);

        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("SHOP"),
                mic: Some(Cow::Borrowed("XTSE")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: Some(Cow::Borrowed("US_ONLY_PROFILE")),
            bond_metadata: None,
            custom_provider_code: None,
        };

        let profile = registry.get_profile(&context).await.unwrap();
        assert_eq!(profile.name.as_deref(), Some("GLOBAL_PROFILE"));
        assert_eq!(us_calls.load(Ordering::SeqCst), 0);
        assert_eq!(global_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_fetch_dividends_falls_back_and_sorts() {
        struct DividendProvider {
            id: &'static str,
            priority: u8,
            call_count: Arc<AtomicUsize>,
            should_fail: bool,
        }

        #[async_trait::async_trait]
        impl MarketDataProvider for DividendProvider {
            fn id(&self) -> &'static str {
                self.id
            }

            fn priority(&self) -> u8 {
                self.priority
            }

            fn capabilities(&self) -> ProviderCapabilities {
                ProviderCapabilities {
                    instrument_kinds: &[InstrumentKind::Equity],
                    coverage: Coverage::global_best_effort(),
                    supports_latest: false,
                    supports_historical: false,
                    supports_search: false,
                    supports_profile: false,
                    supports_dividends: true,
                }
            }

            fn rate_limit(&self) -> RateLimit {
                RateLimit::default()
            }

            async fn get_latest_quote(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
            ) -> Result<Quote, MarketDataError> {
                unreachable!()
            }

            async fn get_historical_quotes(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
                _: DateTime<Utc>,
                _: DateTime<Utc>,
            ) -> Result<Vec<Quote>, MarketDataError> {
                unreachable!()
            }

            async fn get_dividends(
                &self,
                _: &QuoteContext,
                _: ProviderInstrument,
                _: DateTime<Utc>,
                _: DateTime<Utc>,
            ) -> Result<Vec<DividendEvent>, MarketDataError> {
                self.call_count.fetch_add(1, Ordering::SeqCst);

                if self.should_fail {
                    return Err(MarketDataError::ProviderError {
                        provider: self.id.to_string(),
                        message: "Mock failure".to_string(),
                    });
                }

                Ok(vec![
                    DividendEvent {
                        amount: 0.3,
                        date: 2,
                    },
                    DividendEvent {
                        amount: 0.2,
                        date: 1,
                    },
                ])
            }
        }

        let first_calls = Arc::new(AtomicUsize::new(0));
        let fallback_calls = Arc::new(AtomicUsize::new(0));
        let providers: Vec<Arc<dyn MarketDataProvider>> = vec![
            Arc::new(DividendProvider {
                id: "FIRST",
                priority: 5,
                call_count: first_calls.clone(),
                should_fail: true,
            }),
            Arc::new(DividendProvider {
                id: "FALLBACK",
                priority: 10,
                call_count: fallback_calls.clone(),
                should_fail: false,
            }),
        ];

        let resolver = Arc::new(MockResolver);
        let registry = ProviderRegistry::new(providers, resolver);
        let context = QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("TEST"),
                mic: Some(Cow::Borrowed("XNAS")),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: None,
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        };

        let dividends = registry
            .fetch_dividends(&context, Utc::now(), Utc::now())
            .await
            .unwrap();

        assert_eq!(first_calls.load(Ordering::SeqCst), 1);
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            dividends.iter().map(|d| d.date).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
