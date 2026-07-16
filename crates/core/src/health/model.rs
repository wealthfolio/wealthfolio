//! Health Center domain models.
//!
//! This module contains the core data structures for the health diagnostic system:
//! - Severity levels and categories for health issues
//! - Health issue representation with resolution actions
//! - Aggregated health status
//! - Configuration for check thresholds

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

// =============================================================================
// Severity
// =============================================================================

/// Severity levels for health issues.
///
/// Ordered from lowest to highest: Info < Warning < Error < Critical.
/// This ordering is used to determine the overall health status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Default)]
pub enum Severity {
    #[default]
    Info,
    Warning,
    Error,
    Critical,
}

impl Severity {
    /// Returns the string representation of this severity.
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Info => "INFO",
            Severity::Warning => "WARNING",
            Severity::Error => "ERROR",
            Severity::Critical => "CRITICAL",
        }
    }
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// =============================================================================
// Health Category
// =============================================================================

/// Categories of health checks.
///
/// Each category groups related health issues together for filtering
/// and organization in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HealthCategory {
    /// Issues related to stale or missing asset prices
    PriceStaleness,
    /// Issues related to missing or stale FX rates
    FxIntegrity,
    /// Issues related to missing asset classifications
    Classification,
    /// Issues related to data inconsistencies (orphan records, invariant violations)
    DataConsistency,
    /// Issues related to account configuration (tracking mode, etc.)
    AccountConfiguration,
    /// Issues related to application settings configuration (timezone, locale, etc.)
    SettingsConfiguration,
}

impl HealthCategory {
    /// Returns the string representation of this category.
    pub fn as_str(&self) -> &'static str {
        match self {
            HealthCategory::PriceStaleness => "PRICE_STALENESS",
            HealthCategory::FxIntegrity => "FX_INTEGRITY",
            HealthCategory::Classification => "CLASSIFICATION",
            HealthCategory::DataConsistency => "DATA_CONSISTENCY",
            HealthCategory::AccountConfiguration => "ACCOUNT_CONFIGURATION",
            HealthCategory::SettingsConfiguration => "SETTINGS_CONFIGURATION",
        }
    }

    /// Returns a human-friendly label for this category.
    pub fn label(&self) -> &'static str {
        match self {
            HealthCategory::PriceStaleness => "Price Updates",
            HealthCategory::FxIntegrity => "Exchange Rates",
            HealthCategory::Classification => "Classifications",
            HealthCategory::DataConsistency => "Data Consistency",
            HealthCategory::AccountConfiguration => "Account Setup",
            HealthCategory::SettingsConfiguration => "Settings",
        }
    }
}

impl std::fmt::Display for HealthCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.label())
    }
}

// =============================================================================
// Fix Action
// =============================================================================

/// An action that can automatically fix a health issue.
///
/// Fix actions are safe, automated operations like refreshing stale data.
/// The backend handles executing these actions when triggered by the user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FixAction {
    /// Unique identifier for the action type (e.g., "sync_prices", "retry_sync")
    pub id: String,
    /// Human-readable button label (e.g., "Sync Prices")
    pub label: String,
    /// JSON payload containing data needed to execute the action
    pub payload: Value,
}

impl FixAction {
    /// Creates a new fix action for syncing prices.
    pub fn sync_prices(asset_ids: Vec<String>) -> Self {
        Self {
            id: "sync_prices".to_string(),
            label: "Sync Prices".to_string(),
            payload: serde_json::json!(asset_ids),
        }
    }

    /// Creates a new fix action for migrating all legacy classifications.
    pub fn migrate_legacy_classifications() -> Self {
        Self {
            id: "migrate_legacy_classifications".to_string(),
            label: "Migrate Classifications".to_string(),
            payload: serde_json::json!(null),
        }
    }

    /// Creates a new fix action for retrying sync on failed assets.
    pub fn retry_sync(asset_ids: Vec<String>) -> Self {
        Self {
            id: "retry_sync".to_string(),
            label: "Retry Sync".to_string(),
            payload: serde_json::json!(asset_ids),
        }
    }

    /// Creates a new fix action for rebuilding an account's generated history.
    ///
    /// Triggers a full snapshot recalculation scoped to the given accounts.
    pub fn rebuild_account_history(account_ids: Vec<String>) -> Self {
        Self {
            id: "rebuild_account_history".to_string(),
            label: "Rebuild History".to_string(),
            payload: serde_json::json!(account_ids),
        }
    }
}

// =============================================================================
// Navigate Action
// =============================================================================

/// A navigation target for manual issue resolution.
///
/// Navigate actions guide users to the appropriate page where they
/// can manually resolve an issue (e.g., assigning classifications).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavigateAction {
    /// The route path to navigate to (e.g., "/holdings")
    pub route: String,
    /// Optional query parameters for the route
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<Value>,
    /// Human-readable button label (e.g., "Review Holdings")
    pub label: String,
}

// =============================================================================
// Affected Item
// =============================================================================

/// An item affected by a health issue.
///
/// Provides identifying information for display in the UI with optional
/// navigation route to the item's detail page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AffectedItem {
    /// Unique identifier for the item (e.g., asset ID)
    pub id: String,
    /// Display name (e.g., "Apple Inc.")
    pub name: String,
    /// Symbol/ticker for badge display (e.g., "AAPL")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Optional route to navigate to the item's detail page
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

impl AffectedItem {
    /// Creates a new affected item for an asset with name and symbol.
    pub fn asset_with_name(
        id: impl Into<String>,
        symbol: impl Into<String>,
        name: Option<String>,
    ) -> Self {
        let id_str = id.into();
        let symbol_str = symbol.into();
        Self {
            route: Some(format!("/holdings/{}", urlencoding::encode(&id_str))),
            id: id_str,
            name: name.unwrap_or_else(|| symbol_str.clone()),
            symbol: Some(symbol_str),
        }
    }

    /// Creates a new affected item for an asset (symbol only).
    pub fn asset(id: impl Into<String>, symbol: impl Into<String>) -> Self {
        let id_str = id.into();
        let symbol_str = symbol.into();
        Self {
            route: Some(format!("/holdings/{}", urlencoding::encode(&id_str))),
            id: id_str,
            name: symbol_str.clone(),
            symbol: Some(symbol_str),
        }
    }

    /// Creates a new affected item for an asset with market data issues.
    /// Links to the asset page's quotes tab (the manual-quote / price editor).
    pub fn asset_market_data(id: impl Into<String>, symbol: impl Into<String>) -> Self {
        let id_str = id.into();
        let symbol_str = symbol.into();
        Self {
            route: Some(format!(
                "/holdings/{}?tab=quotes&healthContext=price",
                urlencoding::encode(&id_str)
            )),
            id: id_str,
            name: symbol_str.clone(),
            symbol: Some(symbol_str),
        }
    }

    /// Creates a new affected item without a route.
    pub fn simple(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            symbol: None,
            route: None,
        }
    }

    /// Creates a new affected item for an account.
    pub fn account(id: impl Into<String>, name: impl Into<String>) -> Self {
        let id_str = id.into();
        Self {
            route: Some(format!("/accounts/{}", urlencoding::encode(&id_str))),
            id: id_str,
            name: name.into(),
            symbol: None,
        }
    }
}

impl NavigateAction {
    /// Creates a navigate action to the holdings page with an optional filter.
    pub fn to_holdings(filter: Option<&str>) -> Self {
        Self {
            route: "/holdings".to_string(),
            query: filter.map(|f| serde_json::json!({ "filter": f, "healthContext": "holding" })),
            label: "Review Holdings".to_string(),
        }
    }

    /// Creates a navigate action to the activities page.
    pub fn to_activities(filter: Option<&str>) -> Self {
        Self {
            route: "/activities".to_string(),
            query: filter.map(|f| serde_json::json!({ "filter": f })),
            label: "Review Transactions".to_string(),
        }
    }

    /// Creates a navigate action to the accounts page.
    pub fn to_accounts() -> Self {
        Self {
            route: "/settings/accounts".to_string(),
            query: None,
            label: "Review Accounts".to_string(),
        }
    }

    /// Creates a navigate action to the taxonomies settings page.
    pub fn to_taxonomies() -> Self {
        Self {
            route: "/settings/taxonomies".to_string(),
            query: Some(serde_json::json!({ "healthContext": "classification" })),
            label: "Review Classifications".to_string(),
        }
    }

    /// Creates a navigate action to the market data settings page.
    pub fn to_market_data() -> Self {
        Self {
            route: "/settings/market-data".to_string(),
            query: Some(serde_json::json!({ "healthContext": "marketData" })),
            label: "Review Market Data".to_string(),
        }
    }

    /// Creates a navigate action to the general settings page.
    pub fn to_general_settings() -> Self {
        Self {
            route: "/settings/general".to_string(),
            query: None,
            label: "Open General Settings".to_string(),
        }
    }

    /// Creates a navigate action to the connect page.
    pub fn to_connect() -> Self {
        Self {
            route: "/connect".to_string(),
            query: None,
            label: "Configure Accounts".to_string(),
        }
    }

    /// Creates a navigate action to an asset's manual-quote editor (quotes tab).
    pub fn to_asset_manual_quote(asset_id: impl Into<String>) -> Self {
        let id = asset_id.into();
        Self {
            route: format!("/holdings/{}", urlencoding::encode(&id)),
            query: Some(serde_json::json!({ "tab": "quotes", "healthContext": "price" })),
            label: "Add Price".to_string(),
        }
    }

    /// Creates a navigate action to an asset's holdings-snapshot editor
    /// (snapshots tab), where cost basis is set for HOLDINGS-tracked accounts.
    pub fn to_asset_snapshots(asset_id: impl Into<String>) -> Self {
        let id = asset_id.into();
        Self {
            route: format!("/holdings/{}", urlencoding::encode(&id)),
            query: Some(serde_json::json!({ "tab": "snapshots", "healthContext": "basis" })),
            label: "Update Cost Basis".to_string(),
        }
    }

    /// Creates a navigate action to an asset's activities tab — the asset-scoped
    /// transaction list (the activities page itself cannot filter by asset).
    pub fn to_asset_activities(asset_id: impl Into<String>) -> Self {
        let id = asset_id.into();
        Self {
            route: format!("/holdings/{}", urlencoding::encode(&id)),
            query: Some(serde_json::json!({ "tab": "activities", "healthContext": "activity" })),
            label: "Review Transactions".to_string(),
        }
    }

    /// Creates a navigate action to a single activity on the activities page.
    /// The activities search filters by activity id server-side, so this pins the
    /// list to exactly that transaction regardless of paging.
    pub fn to_activity(activity_id: impl Into<String>) -> Self {
        Self {
            route: "/activities".to_string(),
            query: Some(serde_json::json!({
                "activity": activity_id.into(),
                "healthContext": "activity"
            })),
            label: "Review Transaction".to_string(),
        }
    }
}

// =============================================================================
// Diagnostics (root cause, evidence, ordered actions)
// =============================================================================

/// A wrapped fix or navigation action, tagged so the frontend can branch on `kind`.
///
/// Serializes flat with a `kind` discriminator, e.g.
/// `{ "kind": "fix", "id": "sync_prices", "label": "Sync Prices", "payload": [...] }`
/// or `{ "kind": "navigate", "route": "/settings/market-data", "label": "..." }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ActionRef {
    /// An automated fix action.
    Fix {
        #[serde(flatten)]
        action: FixAction,
    },
    /// A manual navigation action.
    Navigate {
        #[serde(flatten)]
        action: NavigateAction,
    },
}

/// A single ordered action attached to a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticAction {
    /// Whether this is the primary recommended action (styled prominently).
    pub primary: bool,
    /// The wrapped fix or navigate action (flattened with a `kind` discriminator).
    #[serde(flatten)]
    pub action: ActionRef,
}

/// A single supporting-evidence row for a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// Short label (e.g., "Asset", "Date", "Last quote", "Currency pair").
    pub label: String,
    /// The evidence value (e.g., "AAPL — Apple Inc.", "2025-11-05").
    pub value: String,
    /// Optional deep-link route for this evidence row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

impl Evidence {
    /// Creates an evidence row without a deep-link.
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
            route: None,
        }
    }

    /// Attaches a deep-link route to this evidence row.
    pub fn with_route(mut self, route: impl Into<String>) -> Self {
        self.route = Some(route.into());
        self
    }
}

// =============================================================================
// Diagnostic metadata
// =============================================================================

/// Functional area that owns or best explains a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticDomain {
    #[default]
    Unknown,
    AccountSetup,
    Ledger,
    MarketData,
    Fx,
    Classification,
    GeneratedData,
    PerformanceInputs,
}

impl DiagnosticDomain {
    fn as_fingerprint_part(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::AccountSetup => "accountSetup",
            Self::Ledger => "ledger",
            Self::MarketData => "marketData",
            Self::Fx => "fx",
            Self::Classification => "classification",
            Self::GeneratedData => "generatedData",
            Self::PerformanceInputs => "performanceInputs",
        }
    }

    fn from_category(category: HealthCategory) -> Self {
        match category {
            HealthCategory::PriceStaleness => Self::MarketData,
            HealthCategory::FxIntegrity => Self::Fx,
            HealthCategory::Classification => Self::Classification,
            HealthCategory::DataConsistency => Self::Ledger,
            HealthCategory::AccountConfiguration => Self::AccountSetup,
            HealthCategory::SettingsConfiguration => Self::AccountSetup,
        }
    }
}

/// Whether the diagnostic points at user-entered source data, generated data, or
/// a workflow/configuration state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    #[default]
    Source,
    Generated,
    Workflow,
}

impl DiagnosticLevel {
    fn as_fingerprint_part(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Generated => "generated",
            Self::Workflow => "workflow",
        }
    }
}

/// User-visible impact attached to a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthImpact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_mv_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl HealthImpact {
    pub fn from_issue(affected_count: u32, affected_mv_pct: Option<f64>) -> Option<Self> {
        if affected_count == 0 && affected_mv_pct.unwrap_or_default() <= 0.0 {
            return None;
        }
        Some(Self {
            affected_count: (affected_count > 0).then_some(affected_count),
            affected_mv_pct,
            amount: None,
            currency: None,
            description: None,
        })
    }
}

/// A typed entity reference used to build stable diagnostic fingerprints and
/// precise UI evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct HealthEntityRef {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

impl HealthEntityRef {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
            label: None,
            route: None,
        }
    }

    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn route(mut self, route: impl Into<String>) -> Self {
        self.route = Some(route.into());
        self
    }
}

/// Inclusive date range associated with a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct HealthDateRange {
    pub start: String,
    pub end: String,
}

impl HealthDateRange {
    pub fn new(start: impl Into<String>, end: impl Into<String>) -> Self {
        Self {
            start: start.into(),
            end: end.into(),
        }
    }
}

/// A structured diagnostic explaining the root cause of (part of) a health issue,
/// with supporting evidence and ordered remediation actions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthDiagnostic {
    /// Stable identity for this concrete cause/scope.
    #[serde(default)]
    pub fingerprint: String,
    /// Functional area that owns or best explains this diagnostic.
    #[serde(default)]
    pub domain: DiagnosticDomain,
    /// Whether the cause is source data, generated data, or workflow state.
    #[serde(default)]
    pub level: DiagnosticLevel,
    /// Severity for this specific cause.
    #[serde(default)]
    pub severity: Severity,
    /// Stable machine code for the root cause (e.g., "MISSING_MARKET_QUOTE").
    pub code: String,
    /// Short human-friendly title for this root cause.
    pub title: String,
    /// Longer explanation of why this happened and its impact.
    pub explanation: String,
    /// Optional user-visible impact for this specific cause.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<HealthImpact>,
    /// Typed entities used by the UI and fingerprinting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<HealthEntityRef>,
    /// Optional primary date for this diagnostic (YYYY-MM-DD).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Optional inclusive date range for this diagnostic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_range: Option<HealthDateRange>,
    /// Supporting evidence rows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<Evidence>,
    /// Ordered remediation actions (primary first by convention).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<DiagnosticAction>,
}

impl HealthDiagnostic {
    /// Creates a new diagnostic with no evidence or actions yet.
    pub fn new(
        code: impl Into<String>,
        title: impl Into<String>,
        explanation: impl Into<String>,
    ) -> Self {
        Self {
            fingerprint: String::new(),
            domain: DiagnosticDomain::Unknown,
            level: DiagnosticLevel::Source,
            severity: Severity::Info,
            code: code.into(),
            title: title.into(),
            explanation: explanation.into(),
            impact: None,
            entities: Vec::new(),
            date: None,
            date_range: None,
            evidence: Vec::new(),
            actions: Vec::new(),
        }
    }

    pub fn domain(mut self, domain: DiagnosticDomain) -> Self {
        self.domain = domain;
        self
    }

    pub fn level(mut self, level: DiagnosticLevel) -> Self {
        self.level = level;
        self
    }

    pub fn severity(mut self, severity: Severity) -> Self {
        self.severity = severity;
        self
    }

    pub fn impact(mut self, impact: HealthImpact) -> Self {
        self.impact = Some(impact);
        self
    }

    pub fn entity(mut self, entity: HealthEntityRef) -> Self {
        self.entities.push(entity);
        self
    }

    pub fn date(mut self, date: impl Into<String>) -> Self {
        self.date = Some(date.into());
        self
    }

    pub fn date_range(mut self, start: impl Into<String>, end: impl Into<String>) -> Self {
        self.date_range = Some(HealthDateRange::new(start, end));
        self
    }

    pub fn fingerprint(mut self, fingerprint: impl Into<String>) -> Self {
        self.fingerprint = fingerprint.into();
        self
    }

    /// Appends an evidence row.
    pub fn evidence(mut self, evidence: Evidence) -> Self {
        self.evidence.push(evidence);
        self
    }

    /// Appends a fix action.
    pub fn fix(mut self, primary: bool, action: FixAction) -> Self {
        self.actions.push(DiagnosticAction {
            primary,
            action: ActionRef::Fix { action },
        });
        self
    }

    /// Appends a navigation action.
    pub fn navigate(mut self, primary: bool, action: NavigateAction) -> Self {
        self.actions.push(DiagnosticAction {
            primary,
            action: ActionRef::Navigate { action },
        });
        self
    }

    fn normalize_for_issue(
        &mut self,
        fallback_domain: DiagnosticDomain,
        fallback_severity: Severity,
        fallback_impact: Option<&HealthImpact>,
    ) {
        if self.domain == DiagnosticDomain::Unknown {
            self.domain = fallback_domain;
        }
        if self.severity == Severity::Info && fallback_severity > Severity::Info {
            self.severity = fallback_severity;
        }
        if self.impact.is_none() {
            self.impact = fallback_impact.cloned();
        }
        if self.fingerprint.trim().is_empty() {
            self.fingerprint = self.computed_fingerprint();
        }
    }

    pub fn computed_fingerprint(&self) -> String {
        let mut parts = vec![
            format!("code={}", self.code),
            format!("domain={}", self.domain.as_fingerprint_part()),
            format!("level={}", self.level.as_fingerprint_part()),
            format!("severity={}", self.severity.as_str()),
        ];
        if let Some(date) = &self.date {
            parts.push(format!("date={date}"));
        }
        if let Some(range) = &self.date_range {
            parts.push(format!("range={}:{}", range.start, range.end));
        }
        let mut entities: Vec<String> = self
            .entities
            .iter()
            .map(|entity| format!("{}:{}", entity.kind, entity.id))
            .collect();
        entities.sort();
        parts.extend(entities.into_iter().map(|value| format!("entity={value}")));

        stable_hash(&parts.join("\n"))
    }
}

fn stable_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..8])
}

fn aggregate_diagnostic_hash(grouping_key: &str, diagnostics: &[HealthDiagnostic]) -> String {
    let mut fingerprints: Vec<String> = diagnostics
        .iter()
        .map(|diagnostic| diagnostic.fingerprint.clone())
        .collect();
    fingerprints.sort();
    stable_hash(&format!("{grouping_key}\n{}", fingerprints.join("\n")))
}

fn issue_grouping_key(id: &str) -> String {
    id.rsplit_once(':')
        .map(|(prefix, _)| prefix.to_string())
        .unwrap_or_else(|| id.to_string())
}

fn diagnostic_code_from_grouping_key(grouping_key: &str) -> String {
    grouping_key
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn default_level_for_category(category: HealthCategory, grouping_key: &str) -> DiagnosticLevel {
    if grouping_key.contains("generated") || grouping_key.contains("valuation") {
        return DiagnosticLevel::Generated;
    }
    match category {
        HealthCategory::AccountConfiguration | HealthCategory::SettingsConfiguration => {
            DiagnosticLevel::Workflow
        }
        _ => DiagnosticLevel::Source,
    }
}

// =============================================================================
// Health Issue
// =============================================================================

/// A health issue detected by a diagnostic check.
///
/// Health issues are structured diagnostic results that provide:
/// - Clear identification of the problem
/// - Impact assessment (affected count, % of portfolio)
/// - Resolution path (fix action or navigation)
/// - Data hash for change detection (to restore dismissed issues when data changes)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    /// Stable unique identifier for this issue type and affected items.
    /// Format varies by category (e.g., "price_stale:AAPL", "fx_missing:EUR:USD")
    pub id: String,

    /// Severity level of the issue
    pub severity: Severity,

    /// Category this issue belongs to
    pub category: HealthCategory,

    /// Short, user-friendly title (max 40 chars)
    /// Example: "Outdated prices for 5 holdings"
    pub title: String,

    /// Longer explanation of the issue and its impact (max 150 chars)
    /// Example: "Your holdings haven't had prices updated recently."
    pub message: String,

    /// Stable message code for frontend translation. When set, the frontend
    /// renders `health:issues.<code>.{title,message}` with `params`, falling
    /// back to `title`/`message` above. `None` means use title/message as-is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    /// Interpolation values for the translated message (e.g. count, symbol, dates).
    #[serde(skip_serializing_if = "HashMap::is_empty", default)]
    pub params: HashMap<String, Value>,

    /// Number of items affected by this issue
    pub affected_count: u32,

    /// Percentage of total portfolio market value affected (0.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_mv_pct: Option<f64>,

    /// Optional automated fix action
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_action: Option<FixAction>,

    /// Optional navigation action for manual resolution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigate_action: Option<NavigateAction>,

    /// Additional details for the issue drawer (can be longer text)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,

    /// List of affected items (e.g., assets, accounts) for display in detail view
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected_items: Option<Vec<AffectedItem>>,

    /// Structured diagnostics (root cause, evidence, ordered actions).
    /// When present, the UI renders these instead of the flat `details` string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<HealthDiagnostic>>,

    /// Hash of the underlying data that caused this issue.
    /// Used to detect when data changes after dismissal.
    pub data_hash: String,

    /// When this issue was detected
    pub timestamp: DateTime<Utc>,
}

impl HealthIssue {
    /// Creates a new health issue builder.
    pub fn builder() -> HealthIssueBuilder {
        HealthIssueBuilder::default()
    }
}

/// Builder for constructing HealthIssue instances.
#[derive(Debug, Default)]
pub struct HealthIssueBuilder {
    id: Option<String>,
    severity: Severity,
    category: Option<HealthCategory>,
    title: Option<String>,
    message: Option<String>,
    code: Option<String>,
    params: HashMap<String, Value>,
    affected_count: u32,
    affected_mv_pct: Option<f64>,
    fix_action: Option<FixAction>,
    navigate_action: Option<NavigateAction>,
    details: Option<String>,
    affected_items: Option<Vec<AffectedItem>>,
    diagnostics: Option<Vec<HealthDiagnostic>>,
    data_hash: Option<String>,
}

impl HealthIssueBuilder {
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn severity(mut self, severity: Severity) -> Self {
        self.severity = severity;
        self
    }

    pub fn category(mut self, category: HealthCategory) -> Self {
        self.category = Some(category);
        self
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    /// Sets the stable message code used for frontend translation.
    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    /// Adds an interpolation parameter for the translated message.
    pub fn param(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn affected_count(mut self, count: u32) -> Self {
        self.affected_count = count;
        self
    }

    pub fn affected_mv_pct(mut self, pct: f64) -> Self {
        self.affected_mv_pct = Some(pct);
        self
    }

    pub fn fix_action(mut self, action: FixAction) -> Self {
        self.fix_action = Some(action);
        self
    }

    pub fn navigate_action(mut self, action: NavigateAction) -> Self {
        self.navigate_action = Some(action);
        self
    }

    pub fn details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    pub fn affected_items(mut self, items: Vec<AffectedItem>) -> Self {
        self.affected_items = Some(items);
        self
    }

    pub fn diagnostics(mut self, diagnostics: Vec<HealthDiagnostic>) -> Self {
        self.diagnostics = Some(diagnostics);
        self
    }

    pub fn data_hash(mut self, hash: impl Into<String>) -> Self {
        self.data_hash = Some(hash.into());
        self
    }

    /// Builds the HealthIssue.
    ///
    /// # Panics
    ///
    /// Panics if required fields (id, category, title, message, data_hash) are not set.
    pub fn build(self) -> HealthIssue {
        let category = self.category.expect("category is required");
        let raw_id = self.id.expect("id is required");
        let grouping_key = issue_grouping_key(&raw_id);
        let title = self.title.expect("title is required");
        let message = self.message.expect("message is required");
        let mut fix_action = self.fix_action;
        let mut navigate_action = self.navigate_action;
        let details = self.details;
        let affected_items = self.affected_items;
        let provided_data_hash = self.data_hash;

        let fallback_domain = DiagnosticDomain::from_category(category);
        let fallback_impact = HealthImpact::from_issue(self.affected_count, self.affected_mv_pct);
        let mut diagnostics = self.diagnostics;
        if diagnostics.is_none() {
            let mut diagnostic = HealthDiagnostic::new(
                diagnostic_code_from_grouping_key(&grouping_key),
                title.clone(),
                message.clone(),
            )
            .domain(fallback_domain)
            .level(default_level_for_category(category, &grouping_key))
            .severity(self.severity);

            if let Some(impact) = fallback_impact.clone() {
                diagnostic = diagnostic.impact(impact);
            }
            if let Some(hash) = provided_data_hash.as_ref() {
                diagnostic =
                    diagnostic.fingerprint(stable_hash(&format!("fallback:{grouping_key}:{hash}")));
            }
            if let Some(items) = affected_items.as_ref() {
                for item in items {
                    let mut entity = HealthEntityRef::new("affectedItem", item.id.clone())
                        .label(item.name.clone());
                    if let Some(route) = item.route.clone() {
                        entity = entity.route(route.clone());
                    }
                    diagnostic = diagnostic.entity(entity);

                    let value = item
                        .symbol
                        .as_ref()
                        .map(|symbol| format!("{symbol} — {}", item.name))
                        .unwrap_or_else(|| item.name.clone());
                    let evidence = Evidence {
                        label: "Item".to_string(),
                        value,
                        route: item.route.clone(),
                    };
                    diagnostic = diagnostic.evidence(evidence);
                }
            }
            if let Some(action) = fix_action.clone() {
                diagnostic = diagnostic.fix(true, action);
            }
            if let Some(action) = navigate_action.clone() {
                diagnostic = diagnostic.navigate(fix_action.is_none(), action);
            }
            diagnostics = Some(vec![diagnostic]);
        }
        if let Some(diagnostics) = diagnostics.as_mut() {
            for diagnostic in diagnostics.iter_mut() {
                diagnostic.normalize_for_issue(
                    fallback_domain,
                    self.severity,
                    fallback_impact.as_ref(),
                );
            }
        }

        let (id, data_hash) = if let Some(diagnostics) = diagnostics.as_ref() {
            if diagnostics.is_empty() {
                (raw_id, provided_data_hash.expect("data_hash is required"))
            } else {
                let aggregate_hash = aggregate_diagnostic_hash(&grouping_key, diagnostics);
                (format!("{grouping_key}:{aggregate_hash}"), aggregate_hash)
            }
        } else {
            (raw_id, provided_data_hash.expect("data_hash is required"))
        };

        if let Some(diagnostics) = diagnostics.as_ref().filter(|items| !items.is_empty()) {
            let diagnostic_actions: Vec<&DiagnosticAction> = diagnostics
                .iter()
                .flat_map(|diagnostic| diagnostic.actions.iter())
                .collect();
            let primary_fix = diagnostic_actions
                .iter()
                .copied()
                .filter(|action| action.primary)
                .find_map(|action| match &action.action {
                    ActionRef::Fix { action } => Some(action.clone()),
                    _ => None,
                })
                .or_else(|| {
                    diagnostic_actions
                        .iter()
                        .copied()
                        .find_map(|action| match &action.action {
                            ActionRef::Fix { action } => Some(action.clone()),
                            _ => None,
                        })
                });
            let primary_navigation = diagnostic_actions
                .iter()
                .copied()
                .filter(|action| action.primary)
                .find_map(|action| match &action.action {
                    ActionRef::Navigate { action } => Some(action.clone()),
                    _ => None,
                })
                .or_else(|| {
                    diagnostic_actions
                        .iter()
                        .copied()
                        .find_map(|action| match &action.action {
                            ActionRef::Navigate { action } => Some(action.clone()),
                            _ => None,
                        })
                });

            if let Some(action) = primary_fix {
                fix_action = Some(action);
            }
            if let Some(action) = primary_navigation {
                navigate_action = Some(action);
            }
        }

        let severity = diagnostics
            .as_ref()
            .and_then(|diagnostics| diagnostics.iter().map(|d| d.severity).max())
            .filter(|diagnostic_severity| *diagnostic_severity > self.severity)
            .unwrap_or(self.severity);

        HealthIssue {
            id,
            severity,
            category,
            title,
            message,
            code: self.code,
            params: self.params,
            affected_count: self.affected_count,
            affected_mv_pct: self.affected_mv_pct,
            fix_action,
            navigate_action,
            details,
            affected_items,
            diagnostics,
            data_hash,
            timestamp: Utc::now(),
        }
    }
}

// =============================================================================
// Health Status
// =============================================================================

/// Aggregated health status for the portfolio.
///
/// This is the top-level structure returned by health checks,
/// containing the overall severity, counts, and list of issues.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    /// The highest severity level across all issues
    pub overall_severity: Severity,

    /// Count of issues at each severity level
    pub issue_counts: HashMap<Severity, u32>,

    /// All detected issues
    pub issues: Vec<HealthIssue>,

    /// When the checks were last run
    pub checked_at: DateTime<Utc>,

    /// True if the cached results are older than 5 minutes
    pub is_stale: bool,
}

impl HealthStatus {
    /// Creates an empty health status (no issues).
    pub fn healthy() -> Self {
        Self {
            overall_severity: Severity::Info,
            issue_counts: HashMap::new(),
            issues: Vec::new(),
            checked_at: Utc::now(),
            is_stale: false,
        }
    }

    /// Creates a health status from a list of issues.
    pub fn from_issues(issues: Vec<HealthIssue>) -> Self {
        let mut issue_counts: HashMap<Severity, u32> = HashMap::new();
        let mut overall_severity = Severity::Info;

        for issue in &issues {
            *issue_counts.entry(issue.severity).or_insert(0) += 1;
            if issue.severity > overall_severity {
                overall_severity = issue.severity;
            }
        }

        Self {
            overall_severity,
            issue_counts,
            issues,
            checked_at: Utc::now(),
            is_stale: false,
        }
    }

    /// Returns the total number of issues.
    pub fn total_count(&self) -> u32 {
        self.issues.len() as u32
    }

    /// Returns issues filtered by severity.
    pub fn issues_by_severity(&self, severity: Severity) -> Vec<&HealthIssue> {
        self.issues
            .iter()
            .filter(|i| i.severity == severity)
            .collect()
    }

    /// Returns issues filtered by category.
    pub fn issues_by_category(&self, category: HealthCategory) -> Vec<&HealthIssue> {
        self.issues
            .iter()
            .filter(|i| i.category == category)
            .collect()
    }

    /// Marks the status as stale.
    pub fn mark_stale(&mut self) {
        self.is_stale = true;
    }
}

impl Default for HealthStatus {
    fn default() -> Self {
        Self::healthy()
    }
}

// =============================================================================
// Health Config
// =============================================================================

/// Configuration for health check thresholds.
///
/// These settings control when issues are raised and at what severity.
/// All thresholds are configurable to allow users to adjust sensitivity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthConfig {
    /// Hours after which a stale price triggers a Warning (default: 48)
    pub price_stale_warning_hours: u32,

    /// Hours after which a stale price triggers an Error (default: 72)
    pub price_stale_critical_hours: u32,

    /// Hours after which a stale FX rate triggers a Warning (default: 24)
    pub fx_stale_warning_hours: u32,

    /// Hours after which a stale FX rate triggers an Error (default: 72)
    pub fx_stale_critical_hours: u32,

    /// MV percentage threshold for escalating to Critical (default: 0.30 = 30%)
    pub mv_escalation_threshold: f64,

    /// MV percentage threshold for classification Warning → Error (default: 0.05 = 5%)
    pub classification_warn_threshold: f64,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            price_stale_warning_hours: 48,
            price_stale_critical_hours: 72,
            fx_stale_warning_hours: 24,
            fx_stale_critical_hours: 72,
            mv_escalation_threshold: 0.30,
            classification_warn_threshold: 0.05,
        }
    }
}

// =============================================================================
// Issue Dismissal
// =============================================================================

/// Record of a dismissed health issue.
///
/// Stores the data_hash at dismissal time to detect when underlying
/// data changes (which should restore the issue to active status).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueDismissal {
    /// The issue ID that was dismissed
    pub issue_id: String,

    /// When the issue was dismissed
    pub dismissed_at: DateTime<Utc>,

    /// The data_hash of the issue at dismissal time
    pub data_hash: String,
}

impl IssueDismissal {
    /// Creates a new dismissal record.
    pub fn new(issue_id: impl Into<String>, data_hash: impl Into<String>) -> Self {
        Self {
            issue_id: issue_id.into(),
            dismissed_at: Utc::now(),
            data_hash: data_hash.into(),
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_severity_ordering() {
        assert!(Severity::Info < Severity::Warning);
        assert!(Severity::Warning < Severity::Error);
        assert!(Severity::Error < Severity::Critical);

        // Max of severities should return Critical
        let severities = vec![Severity::Warning, Severity::Critical, Severity::Error];
        let max = severities.into_iter().max().unwrap();
        assert_eq!(max, Severity::Critical);
    }

    #[test]
    fn test_severity_serialization() {
        assert_eq!(
            serde_json::to_string(&Severity::Warning).unwrap(),
            "\"WARNING\""
        );
        assert_eq!(
            serde_json::from_str::<Severity>("\"CRITICAL\"").unwrap(),
            Severity::Critical
        );
    }

    #[test]
    fn test_category_serialization() {
        assert_eq!(
            serde_json::to_string(&HealthCategory::PriceStaleness).unwrap(),
            "\"PRICE_STALENESS\""
        );
        assert_eq!(
            serde_json::from_str::<HealthCategory>("\"FX_INTEGRITY\"").unwrap(),
            HealthCategory::FxIntegrity
        );
    }

    #[test]
    fn test_health_status_from_issues() {
        let issues = vec![
            HealthIssue::builder()
                .id("test1")
                .severity(Severity::Warning)
                .category(HealthCategory::PriceStaleness)
                .title("Test 1")
                .message("Message 1")
                .data_hash("hash1")
                .build(),
            HealthIssue::builder()
                .id("test2")
                .severity(Severity::Error)
                .category(HealthCategory::FxIntegrity)
                .title("Test 2")
                .message("Message 2")
                .data_hash("hash2")
                .build(),
            HealthIssue::builder()
                .id("test3")
                .severity(Severity::Warning)
                .category(HealthCategory::Classification)
                .title("Test 3")
                .message("Message 3")
                .data_hash("hash3")
                .build(),
        ];

        let status = HealthStatus::from_issues(issues);

        assert_eq!(status.overall_severity, Severity::Error);
        assert_eq!(status.issue_counts.get(&Severity::Warning), Some(&2));
        assert_eq!(status.issue_counts.get(&Severity::Error), Some(&1));
        assert_eq!(status.issue_counts.get(&Severity::Critical), None);
        assert_eq!(status.total_count(), 3);
    }

    #[test]
    fn test_health_status_healthy() {
        let status = HealthStatus::healthy();
        assert_eq!(status.overall_severity, Severity::Info);
        assert_eq!(status.total_count(), 0);
        assert!(!status.is_stale);
    }

    #[test]
    fn test_fix_action_constructors() {
        let sync = FixAction::sync_prices(vec!["AAPL".to_string()]);
        assert_eq!(sync.id, "sync_prices");
        assert_eq!(sync.label, "Sync Prices");

        let retry = FixAction::retry_sync(vec!["AAPL".to_string()]);
        assert_eq!(retry.id, "retry_sync");

        let rebuild = FixAction::rebuild_account_history(vec!["acc_1".to_string()]);
        assert_eq!(rebuild.id, "rebuild_account_history");
    }

    #[test]
    fn test_navigate_action_constructors() {
        let holdings = NavigateAction::to_holdings(Some("unclassified"));
        assert_eq!(holdings.route, "/holdings");
        assert!(holdings.query.is_some());

        let accounts = NavigateAction::to_accounts();
        assert_eq!(accounts.route, "/settings/accounts");
        assert!(accounts.query.is_none());
    }

    #[test]
    fn test_health_config_defaults() {
        let config = HealthConfig::default();
        assert_eq!(config.price_stale_warning_hours, 48);
        assert_eq!(config.price_stale_critical_hours, 72);
        assert_eq!(config.mv_escalation_threshold, 0.30);
    }

    #[test]
    fn test_issue_dismissal() {
        let dismissal = IssueDismissal::new("price_stale:AAPL", "abc123");
        assert_eq!(dismissal.issue_id, "price_stale:AAPL");
        assert_eq!(dismissal.data_hash, "abc123");
    }

    #[test]
    fn test_diagnostic_action_serialization_tagging() {
        let fix = DiagnosticAction {
            primary: true,
            action: ActionRef::Fix {
                action: FixAction::sync_prices(vec!["AAPL".to_string()]),
            },
        };
        let json = serde_json::to_value(&fix).unwrap();
        assert_eq!(json["kind"], "fix");
        assert_eq!(json["primary"], true);
        assert_eq!(json["id"], "sync_prices");

        let nav = DiagnosticAction {
            primary: false,
            action: ActionRef::Navigate {
                action: NavigateAction::to_market_data(),
            },
        };
        let json = serde_json::to_value(&nav).unwrap();
        assert_eq!(json["kind"], "navigate");
        assert_eq!(json["route"], "/settings/market-data");

        // Round-trips back to the same enum variant.
        let parsed: DiagnosticAction = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, nav);
    }

    #[test]
    fn test_diagnostic_builder_and_issue_roundtrip() {
        let diagnostic = HealthDiagnostic::new(
            "MISSING_MARKET_QUOTE",
            "No market price",
            "AAPL has no quote on the affected dates, so returns are unavailable.",
        )
        .evidence(Evidence::new("Asset", "AAPL — Apple Inc.").with_route("/holdings/asset-1"))
        .evidence(Evidence::new("Date", "2025-11-05"))
        .fix(true, FixAction::sync_prices(vec!["asset-1".to_string()]))
        .navigate(false, NavigateAction::to_asset_manual_quote("asset-1"));

        assert_eq!(diagnostic.evidence.len(), 2);
        assert_eq!(diagnostic.actions.len(), 2);
        assert!(diagnostic.actions[0].primary);

        let issue = HealthIssue::builder()
            .id("incomplete_valuation_value:hash")
            .severity(Severity::Warning)
            .category(HealthCategory::DataConsistency)
            .title("Valuation coverage is incomplete")
            .message("msg")
            .diagnostics(vec![diagnostic])
            .data_hash("hash")
            .build();

        let json = serde_json::to_string(&issue).unwrap();
        let parsed: HealthIssue = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.diagnostics.as_ref().unwrap().len(), 1);
        assert_eq!(parsed.diagnostics.unwrap()[0].code, "MISSING_MARKET_QUOTE");
    }

    #[test]
    fn test_diagnostic_fingerprint_ignores_copy_but_tracks_scope() {
        let diagnostic = HealthDiagnostic::new(
            "MISSING_MARKET_QUOTE",
            "No market price",
            "Original explanation.",
        )
        .domain(DiagnosticDomain::MarketData)
        .entity(HealthEntityRef::new("asset", "asset-1").route("/holdings/asset-1"))
        .evidence(Evidence::new("Asset", "AAPL — Apple Inc."));

        let wording_changed = HealthDiagnostic::new(
            "MISSING_MARKET_QUOTE",
            "No price available",
            "Reworded explanation.",
        )
        .domain(DiagnosticDomain::MarketData)
        .entity(HealthEntityRef::new("asset", "asset-1").route("/new-route/asset-1"))
        .evidence(Evidence::new("Holding", "Apple Inc."))
        .navigate(
            true,
            NavigateAction {
                route: "/new-route".to_string(),
                query: Some(serde_json::json!({ "tab": "prices" })),
                label: "Open".to_string(),
            },
        );

        let scope_changed = HealthDiagnostic::new(
            "MISSING_MARKET_QUOTE",
            "No market price",
            "Original explanation.",
        )
        .domain(DiagnosticDomain::MarketData)
        .entity(HealthEntityRef::new("asset", "asset-2").route("/holdings/asset-2"));

        assert_eq!(
            diagnostic.computed_fingerprint(),
            wording_changed.computed_fingerprint()
        );
        assert_ne!(
            diagnostic.computed_fingerprint(),
            scope_changed.computed_fingerprint()
        );
    }

    #[test]
    fn test_diagnostic_fingerprint_ignores_action_wiring() {
        let first = HealthDiagnostic::new("MISSING_MARKET_QUOTE", "No price", "Missing quote")
            .domain(DiagnosticDomain::MarketData)
            .entity(HealthEntityRef::new("asset", "asset-1"))
            .fix(true, FixAction::sync_prices(vec!["asset-a".to_string()]));
        let second = HealthDiagnostic::new("MISSING_MARKET_QUOTE", "No price", "Missing quote")
            .domain(DiagnosticDomain::MarketData)
            .entity(HealthEntityRef::new("asset", "asset-1"))
            .fix(true, FixAction::sync_prices(vec!["asset-b".to_string()]));

        assert_eq!(first.computed_fingerprint(), second.computed_fingerprint());
    }

    #[test]
    fn test_issue_identity_uses_sorted_diagnostic_fingerprints() {
        let first = HealthDiagnostic::new("MISSING_MARKET_QUOTE", "No price", "Missing quote")
            .fingerprint("fingerprint-a");
        let second = HealthDiagnostic::new("MISSING_FX_RATE", "No FX", "Missing rate")
            .fingerprint("fingerprint-b");

        let issue_a = HealthIssue::builder()
            .id("incomplete_valuation_value:old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::DataConsistency)
            .title("Valuation coverage is incomplete")
            .message("msg")
            .diagnostics(vec![first.clone(), second.clone()])
            .data_hash("old-hash")
            .build();
        let issue_b = HealthIssue::builder()
            .id("incomplete_valuation_value:different-old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::DataConsistency)
            .title("Valuation coverage wording changed")
            .message("copy changed")
            .diagnostics(vec![second, first])
            .data_hash("different-old-hash")
            .build();

        assert_eq!(issue_a.id, issue_b.id);
        assert_eq!(issue_a.data_hash, issue_b.data_hash);
        assert!(issue_a.id.starts_with("incomplete_valuation_value:"));
    }

    #[test]
    fn test_fallback_diagnostics_preserve_source_data_hash_identity() {
        let unchanged_copy = HealthIssue::builder()
            .id("timezone_invalid:old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::SettingsConfiguration)
            .title("Configured timezone is invalid")
            .message("Original copy")
            .data_hash("source-hash")
            .build();
        let reworded = HealthIssue::builder()
            .id("timezone_invalid:different-old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::SettingsConfiguration)
            .title("Timezone setting needs review")
            .message("Reworded copy")
            .data_hash("source-hash")
            .build();
        let changed_source = HealthIssue::builder()
            .id("timezone_invalid:new-old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::SettingsConfiguration)
            .title("Configured timezone is invalid")
            .message("Original copy")
            .data_hash("changed-source-hash")
            .build();

        assert_eq!(unchanged_copy.id, reworded.id);
        assert_ne!(unchanged_copy.id, changed_source.id);
    }

    #[test]
    fn test_issue_actions_prefer_primary_diagnostic_actions() {
        let diagnostic = HealthDiagnostic::new(
            "INCOMPLETE_BASIS_ACTIVITY",
            "Missing purchase price",
            "A transaction is missing cost basis.",
        )
        .navigate(true, NavigateAction::to_activity("activity-1"));

        let issue = HealthIssue::builder()
            .id("incomplete_valuation_basis:old-hash")
            .severity(Severity::Warning)
            .category(HealthCategory::DataConsistency)
            .title("Valuation basis is incomplete")
            .message("msg")
            .navigate_action(NavigateAction::to_activities(None))
            .diagnostics(vec![diagnostic])
            .data_hash("old-hash")
            .build();

        let navigate = issue.navigate_action.expect("navigate action");
        assert_eq!(navigate.route, "/activities");
        assert_eq!(navigate.label, "Review Transaction");
        assert_eq!(navigate.query.unwrap()["activity"], "activity-1");
    }

    #[test]
    fn test_manual_quote_navigate_action() {
        let nav = NavigateAction::to_asset_manual_quote("asset-1");
        assert_eq!(nav.route, "/holdings/asset-1");
        assert_eq!(nav.query.unwrap()["tab"], "quotes");
    }

    #[test]
    fn test_health_issue_json_roundtrip() {
        let issue = HealthIssue::builder()
            .id("test_issue")
            .severity(Severity::Warning)
            .category(HealthCategory::PriceStaleness)
            .title("Test Issue")
            .message("This is a test")
            .affected_count(5)
            .affected_mv_pct(0.15)
            .fix_action(FixAction::sync_prices(vec!["AAPL".to_string()]))
            .data_hash("testhash")
            .build();

        let json = serde_json::to_string(&issue).unwrap();
        let parsed: HealthIssue = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, issue.id);
        assert_eq!(parsed.severity, issue.severity);
        assert_eq!(parsed.category, issue.category);
        assert_eq!(parsed.affected_count, 5);
        assert_eq!(parsed.affected_mv_pct, Some(0.15));
    }
}
