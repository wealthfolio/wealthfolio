//! Models representing broker data from the cloud API.
//! These models mirror Wealthfolio Connect API response structures.

use serde::{Deserialize, Serialize};

/// Broker account balance total (amount + currency)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerBalanceTotal {
    /// Balance amount
    pub amount: Option<f64>,
    /// Currency code (e.g., "USD", "CAD")
    pub currency: Option<String>,
}

/// Broker account balance information (new API format)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerAccountBalance {
    /// Total balance with currency
    pub total: Option<BrokerBalanceTotal>,
}

/// Account owner information from the API
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountOwner {
    /// User ID (UUID)
    pub user_id: Option<String>,
    /// Full name of the account owner
    #[serde(alias = "user_full_name")]
    pub full_name: Option<String>,
    /// Email address
    pub email: Option<String>,
    /// Avatar URL
    pub avatar_url: Option<String>,
    /// Whether this is the current user's own account
    #[serde(default)]
    pub is_own_account: bool,
}

/// Sync status for a broker account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerAccountSyncStatus {
    pub transactions: Option<BrokerSyncStatusDetail>,
    pub holdings: Option<BrokerSyncStatusDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerSyncStatusDetail {
    pub initial_sync_completed: Option<bool>,
    pub last_successful_sync: Option<String>,
    pub first_transaction_date: Option<String>,
}

/// A broker account from the cloud API (new REST API format)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerAccount {
    /// Unique identifier for the connected brokerage account (UUID) - NOW NULLABLE
    pub id: Option<String>,

    /// Display name for the account
    pub name: Option<String>,

    /// Account number from the broker (may be masked) - NOW NULLABLE
    #[serde(alias = "number")]
    pub account_number: Option<String>,

    /// Account type from the API (e.g., "TFSA", "RRSP", "MARGIN")
    #[serde(rename = "type")]
    pub account_type: Option<String>,

    /// Account currency
    pub currency: Option<String>,

    /// Account balance information
    pub balance: Option<BrokerAccountBalance>,

    /// Additional metadata from the API
    pub meta: Option<serde_json::Value>,

    /// Account owner information (for shared/team accounts)
    pub owner: Option<AccountOwner>,

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy fields for backward compatibility with existing sync code
    // These may not be present in the new API response
    // ─────────────────────────────────────────────────────────────────────────
    /// Unique identifier for the connection (brokerage authorization UUID)
    #[serde(default)]
    pub brokerage_authorization: Option<String>,

    /// Name of the brokerage institution (legacy, may be in meta now)
    #[serde(default)]
    pub institution_name: Option<String>,

    /// When the account was created in the broker system
    #[serde(default)]
    pub created_date: Option<String>,

    /// Sync status information (not in new API)
    #[serde(default)]
    pub sync_status: Option<BrokerAccountSyncStatus>,

    /// Account status: "open", "closed", "archived", "unavailable"
    #[serde(default)]
    pub status: Option<String>,

    /// The account type as provided by the brokerage (legacy, use account_type)
    #[serde(default)]
    pub raw_type: Option<String>,

    /// Whether this is a paper (simulated) trading account
    #[serde(default)]
    pub is_paper: bool,

    /// Whether sync is enabled for this account
    #[serde(default = "default_sync_enabled")]
    pub sync_enabled: bool,

    /// Whether this account is shared with the household
    #[serde(default)]
    pub shared_with_household: bool,
}

fn default_sync_enabled() -> bool {
    true
}

/// A brokerage/institution from the cloud API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrokerage {
    /// Unique identifier for the brokerage (UUID)
    pub id: Option<String>,

    /// Short, unique identifier (slug) - e.g., "QUESTRADE", "INTERACTIVE_BROKERS"
    pub slug: Option<String>,

    /// Full name of the brokerage
    pub name: Option<String>,

    /// Display-friendly name
    pub display_name: Option<String>,

    /// URL to the brokerage's website
    pub url: Option<String>,

    /// Whether the brokerage is enabled
    #[serde(default)]
    pub enabled: bool,
}

/// A brokerage connection/authorization from the cloud API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerConnection {
    /// Unique identifier for the authorization (UUID)
    pub id: String,

    /// The brokerage information
    pub brokerage: Option<BrokerConnectionBrokerage>,

    /// Connection type (e.g., "read", "trade")
    #[serde(rename = "type")]
    pub connection_type: Option<String>,

    /// Connection status (e.g., "connected", "disconnected")
    pub status: Option<String>,

    /// Whether the connection is disabled
    #[serde(default)]
    pub disabled: bool,

    /// When the connection was disabled
    pub disabled_date: Option<String>,

    /// When the connection was last updated
    pub updated_at: Option<String>,

    /// Connection name (user-assigned)
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerConnectionBrokerage {
    pub id: Option<String>,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub aws_s3_logo_url: Option<String>,
    pub aws_s3_square_logo_url: Option<String>,
}

/// Response from syncing accounts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccountsResponse {
    pub synced: usize,
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    /// List of (account_id, currency) for newly created accounts
    /// Used to trigger FX rate registration
    #[serde(default)]
    pub created_accounts: Vec<(String, String)>,
    /// Detailed info about newly created accounts (for tracking mode configuration)
    #[serde(default)]
    pub new_accounts_info: Vec<NewAccountInfo>,
}

/// Response from syncing connections/platforms
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionsResponse {
    pub synced: usize,
    pub platforms_created: usize,
    pub platforms_updated: usize,
}

/// Pagination details from the broker API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaginationDetails {
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub total: Option<i64>,
    /// Whether there are more results available (new API)
    #[serde(default)]
    pub has_more: Option<bool>,
}

/// A paginated list of universal activity objects.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaginatedUniversalActivity {
    #[serde(default)]
    #[serde(
        alias = "activities",
        alias = "universalActivities",
        alias = "universal_activities"
    )]
    pub data: Vec<AccountUniversalActivity>,
    #[serde(default)]
    #[serde(alias = "paginationDetails", alias = "page")]
    pub pagination: Option<PaginationDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivityCurrency {
    pub id: Option<String>,
    pub code: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivityExchange {
    pub id: Option<String>,
    pub code: Option<String>,
    /// MIC (Market Identifier Code) - prefer this over code for exchange_mic field
    pub mic_code: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivitySymbol {
    pub id: Option<String>,
    pub symbol: Option<String>,
    pub raw_symbol: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub symbol_type: Option<AccountUniversalActivitySymbolType>,
    /// Exchange information for the symbol
    pub exchange: Option<AccountUniversalActivityExchange>,
    /// Symbol's native currency
    pub currency: Option<AccountUniversalActivityCurrency>,
    /// FIGI identifier
    pub figi_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivitySymbolType {
    pub id: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub is_supported: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivityUnderlyingSymbol {
    pub id: Option<String>,
    pub symbol: Option<String>,
    pub raw_symbol: Option<String>,
    pub description: Option<String>,
    pub currency: Option<AccountUniversalActivityCurrency>,
    pub exchange: Option<AccountUniversalActivityExchange>,
    #[serde(rename = "type")]
    pub symbol_type: Option<AccountUniversalActivitySymbolType>,
    pub figi_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivityOptionSymbol {
    pub id: Option<String>,
    pub ticker: Option<String>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<String>,
    pub is_mini_option: Option<bool>,
    pub underlying_symbol: Option<AccountUniversalActivityUnderlyingSymbol>,
}

/// Flow metadata for transfer activities
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FlowMetadata {
    /// Whether the transfer is external (to/from outside the brokerage)
    #[serde(default)]
    pub is_external: bool,
}

/// Mapping metadata from the API describing how the activity was classified
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MappingMetadata {
    /// Flow information for transfer activities
    pub flow: Option<FlowMetadata>,
    /// Reasons/warnings from the mapping process
    #[serde(default)]
    pub reasons: Vec<String>,
    /// Confidence score of the mapping (0.0 to 1.0)
    pub confidence: Option<f64>,
}

/// A transaction or activity from an institution.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountUniversalActivity {
    /// Unique identifier for this activity from the API
    pub id: Option<String>,

    /// Symbol information for the security
    pub symbol: Option<AccountUniversalActivitySymbol>,

    /// Option symbol information (for options trades)
    #[serde(rename = "option_symbol")]
    pub option_symbol: Option<AccountUniversalActivityOptionSymbol>,

    /// Price per unit
    pub price: Option<f64>,

    /// Number of units/shares
    pub units: Option<f64>,

    /// Total amount of the transaction
    pub amount: Option<f64>,

    /// Currency of the transaction
    pub currency: Option<AccountUniversalActivityCurrency>,

    /// Canonical activity type (BUY, SELL, DIVIDEND, etc.)
    #[serde(rename = "type")]
    pub activity_type: Option<String>,

    /// Subtype for semantic variations (DRIP, STAKING_REWARD, etc.)
    pub subtype: Option<String>,

    /// Provider's original activity type before mapping
    pub raw_type: Option<String>,

    /// Option type (CALL, PUT) for options trades
    #[serde(rename = "option_type")]
    pub option_type: Option<String>,

    /// Description of the activity
    pub description: Option<String>,

    /// Trade date (when the trade was executed)
    #[serde(rename = "trade_date")]
    pub trade_date: Option<String>,

    /// Settlement date (when the trade settles)
    #[serde(rename = "settlement_date")]
    pub settlement_date: Option<String>,

    /// Transaction fee
    pub fee: Option<f64>,

    /// Foreign exchange rate (if applicable)
    pub fx_rate: Option<f64>,

    /// Institution/brokerage name
    pub institution: Option<String>,

    /// External reference ID from the provider
    #[serde(rename = "external_reference_id")]
    pub external_reference_id: Option<String>,

    /// Provider type (e.g., "SNAPTRADE")
    #[serde(rename = "provider_type")]
    pub provider_type: Option<String>,

    // ─────────────────────────────────────────────────────────────────────────
    // New fields for sync system
    // ─────────────────────────────────────────────────────────────────────────
    /// Source system that generated this activity (SNAPTRADE, MANUAL, CSV)
    pub source_system: Option<String>,

    /// Provider's unique ID for this record (for deduplication)
    pub source_record_id: Option<String>,

    /// Group ID for multi-leg transactions (e.g., options spreads)
    pub source_group_id: Option<String>,

    /// Mapping metadata with flow info, confidence, and reasons
    pub mapping_metadata: Option<MappingMetadata>,

    /// Whether this activity needs user review
    #[serde(default)]
    pub needs_review: bool,
}

/// Response from syncing activities.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncActivitiesResponse {
    pub accounts_synced: usize,
    pub activities_upserted: usize,
    pub assets_inserted: usize,
    pub accounts_failed: usize,
    /// Accounts with soft warnings (e.g., reference-only activity sync issues).
    #[serde(default)]
    pub accounts_warned: usize,
    /// IDs of newly created assets (for background enrichment)
    #[serde(default)]
    pub new_asset_ids: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker Holdings API Types
// ─────────────────────────────────────────────────────────────────────────────

/// Currency information from the holdings API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsCurrency {
    pub id: Option<String>,
    pub code: Option<String>,
    pub name: Option<String>,
}

/// Cash balance from the holdings API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsBalance {
    pub currency: Option<HoldingsCurrency>,
    pub cash: Option<f64>,
    pub buying_power: Option<f64>,
}

/// Symbol type information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsSymbolType {
    pub id: Option<String>,
    pub code: Option<String>,
    pub description: Option<String>,
}

/// Exchange information from the holdings API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsExchange {
    pub id: Option<String>,
    pub code: Option<String>,
    pub mic_code: Option<String>,
    pub name: Option<String>,
    pub suffix: Option<String>,
}

/// Inner symbol information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsInnerSymbol {
    pub id: Option<String>,
    pub symbol: Option<String>,
    pub raw_symbol: Option<String>,
    pub description: Option<String>,
    pub name: Option<String>,
    pub currency: Option<HoldingsCurrency>,
    #[serde(rename = "type")]
    pub symbol_type: Option<HoldingsSymbolType>,
    pub exchange: Option<HoldingsExchange>,
}

/// Symbol wrapper from the holdings API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsSymbol {
    pub symbol: Option<HoldingsInnerSymbol>,
    pub id: Option<String>,
    pub description: Option<String>,
}

/// A position (stock/ETF/mutual fund) from the holdings API.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsPosition {
    pub symbol: Option<HoldingsSymbol>,
    pub units: Option<f64>,
    pub price: Option<f64>,
    pub open_pnl: Option<f64>,
    pub average_purchase_price: Option<f64>,
    pub currency: Option<HoldingsCurrency>,
    #[serde(default)]
    pub cash_equivalent: Option<bool>,
}

/// Underlying symbol for options.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsUnderlyingSymbol {
    pub id: Option<String>,
    pub symbol: Option<String>,
    pub description: Option<String>,
}

/// Option symbol information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsOptionSymbol {
    pub id: Option<String>,
    pub ticker: Option<String>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<String>,
    #[serde(default)]
    pub is_mini_option: Option<bool>,
    pub underlying_symbol: Option<HoldingsUnderlyingSymbol>,
}

/// An option position from the holdings API.
///
/// The API provides option contract details in both `option_symbol` (recommended)
/// and nested inside the deprecated `symbol.option_symbol` wrapper.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsOptionPosition {
    /// Top-level option contract details (recommended field).
    pub option_symbol: Option<HoldingsOptionSymbol>,
    /// Deprecated account-scoped wrapper (contains `option_symbol` nested inside).
    pub symbol: Option<HoldingsOptionSymbolWrapper>,
    pub units: Option<f64>,
    pub price: Option<f64>,
    pub average_purchase_price: Option<f64>,
    pub currency: Option<HoldingsCurrency>,
}

/// Deprecated wrapper around option symbol from the holdings API.
/// Contains the actual `HoldingsOptionSymbol` nested inside.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsOptionSymbolWrapper {
    pub option_symbol: Option<HoldingsOptionSymbol>,
    pub id: Option<String>,
    pub description: Option<String>,
}

impl HoldingsOptionPosition {
    /// Returns the option symbol, preferring the top-level `option_symbol` field
    /// and falling back to the deprecated `symbol.option_symbol` wrapper.
    pub fn resolved_option_symbol(&self) -> Option<&HoldingsOptionSymbol> {
        self.option_symbol
            .as_ref()
            .or_else(|| self.symbol.as_ref().and_then(|s| s.option_symbol.as_ref()))
    }
}

/// Account info from holdings response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HoldingsAccount {
    pub id: Option<String>,
    pub name: Option<String>,
    pub number: Option<String>,
    pub raw_type: Option<String>,
}

/// Response from the broker holdings API endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrokerHoldingsResponse {
    pub account: Option<HoldingsAccount>,
    #[serde(default)]
    pub balances: Option<Vec<HoldingsBalance>>,
    #[serde(default)]
    pub positions: Option<Vec<HoldingsPosition>>,
    #[serde(default)]
    pub option_positions: Option<Vec<HoldingsOptionPosition>>,
}

/// Response from syncing holdings.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncHoldingsResponse {
    pub accounts_synced: usize,
    pub snapshots_upserted: usize,
    pub positions_upserted: usize,
    pub assets_inserted: usize,
    pub accounts_failed: usize,
    /// IDs of newly created assets (for background enrichment)
    #[serde(default)]
    pub new_asset_ids: Vec<String>,
}

/// Position-level diff for a holdings sync, compared to the latest snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsDiff {
    pub total_positions: usize,
    pub added_positions: usize,
    pub updated_positions: usize,
    pub removed_positions: usize,
    pub unchanged_positions: usize,
    pub snapshot_saved: bool,
}

impl HoldingsDiff {
    /// Returns true if no positions were added, updated, or removed.
    pub fn is_unchanged(&self) -> bool {
        self.added_positions == 0 && self.updated_positions == 0 && self.removed_positions == 0
    }
}

/// Information about a newly created account that needs user configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccountInfo {
    /// Local account ID in wealthfolio
    pub local_account_id: String,
    /// Provider's account ID (e.g., from SnapTrade)
    pub provider_account_id: String,
    /// Default display name from the broker
    pub default_name: String,
    /// Currency of the account
    pub currency: String,
    /// Name of the brokerage institution
    pub institution_name: Option<String>,
}

/// Combined result from a full broker sync operation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// Whether the sync completed successfully (no errors)
    pub success: bool,
    /// Human-readable summary message
    pub message: String,
    /// Result of syncing connections/platforms
    pub connections_synced: Option<SyncConnectionsResponse>,
    /// Result of syncing accounts
    pub accounts_synced: Option<SyncAccountsResponse>,
    /// Result of syncing activities (for TRANSACTIONS mode accounts)
    pub activities_synced: Option<SyncActivitiesResponse>,
    /// Result of syncing holdings (for HOLDINGS mode accounts)
    pub holdings_synced: Option<SyncHoldingsResponse>,
    /// List of newly created accounts that need tracking mode configuration
    pub new_accounts: Option<Vec<NewAccountInfo>>,
}

impl BrokerAccount {
    /// Get the currency, preferring the direct currency field, then balance currency,
    /// then base currency if provided, defaulting to USD.
    pub fn get_currency(&self, base_currency: Option<&str>) -> String {
        // First try the direct currency field (new API)
        if let Some(ref currency) = self.currency {
            if !currency.is_empty() {
                return currency.clone();
            }
        }
        // Fall back to balance.total.currency
        self.balance
            .as_ref()
            .and_then(|b| b.total.as_ref())
            .and_then(|t| t.currency.clone())
            .or_else(|| {
                base_currency
                    .filter(|c| !c.is_empty())
                    .map(|c| c.to_string())
            })
            .unwrap_or_else(|| "USD".to_string())
    }

    /// Get the account type, preferring the direct account_type field, then mapping raw_type
    pub fn get_account_type(&self) -> String {
        // First try the direct account_type field (new API)
        if let Some(ref account_type) = self.account_type {
            if !account_type.is_empty() {
                return account_type.clone();
            }
        }
        // Fall back to mapping raw_type (legacy)
        let raw = self.raw_type.as_deref().unwrap_or("").to_uppercase();

        // Map common broker account types to standardized types
        match raw.as_str() {
            // Tax-advantaged accounts
            "RRSP" | "RSP" => "RRSP".to_string(),
            "TFSA" => "TFSA".to_string(),
            "FHSA" => "FHSA".to_string(),
            "RESP" => "RESP".to_string(),
            "LIRA" | "LRSP" => "LIRA".to_string(),
            "RRIF" => "RRIF".to_string(),
            "LIF" => "LIF".to_string(),
            "DPSP" => "DPSP".to_string(),

            // US retirement accounts
            "IRA" | "TRADITIONAL_IRA" | "TRADITIONAL IRA" => "IRA".to_string(),
            "ROTH_IRA" | "ROTH IRA" | "ROTH" => "ROTH_IRA".to_string(),
            "401K" | "401(K)" => "401K".to_string(),
            "403B" | "403(B)" => "403B".to_string(),
            "SEP_IRA" | "SEP IRA" | "SEP" => "SEP_IRA".to_string(),
            "SIMPLE_IRA" | "SIMPLE IRA" => "SIMPLE_IRA".to_string(),
            "529" => "529".to_string(),
            "HSA" => "HSA".to_string(),

            // Standard accounts
            "MARGIN" | "MARGIN_ACCOUNT" => "MARGIN".to_string(),
            "CASH" | "CASH_ACCOUNT" => "CASH".to_string(),
            "INVESTMENT" | "BROKERAGE" | "INDIVIDUAL" => "INVESTMENT".to_string(),
            "JOINT" | "JOINT_ACCOUNT" => "JOINT".to_string(),
            "CORPORATE" | "BUSINESS" => "CORPORATE".to_string(),
            "TRUST" => "TRUST".to_string(),

            // Default fallback
            _ if raw.contains("RRSP") => "RRSP".to_string(),
            _ if raw.contains("TFSA") => "TFSA".to_string(),
            _ if raw.contains("MARGIN") => "MARGIN".to_string(),
            _ if raw.contains("CASH") => "CASH".to_string(),
            _ if raw.contains("IRA") => "IRA".to_string(),
            _ if raw.contains("401") => "401K".to_string(),
            _ => "SECURITIES".to_string(),
        }
    }

    /// Get account name, falling back to institution + account number
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                let inst = self.institution_name.as_deref().unwrap_or("Unknown");
                let acct = self.account_number.as_deref().unwrap_or("Account");
                format!("{} - {}", inst, acct)
            })
    }

    /// Convert to JSON meta string with all relevant broker metadata
    pub fn to_meta_json(&self) -> Option<String> {
        let meta = serde_json::json!({
            "institution_name": self.institution_name,
            "brokerage_authorization": self.brokerage_authorization,
            "created_date": self.created_date,
            "status": self.status,
            "raw_type": self.raw_type,
            "is_paper": self.is_paper,
            "sync_enabled": self.sync_enabled,
            "shared_with_household": self.shared_with_household,
            "sync_status": self.sync_status.as_ref().map(|s| serde_json::json!({
                "transactions": s.transactions.as_ref().map(|t| serde_json::json!({
                    "initial_sync_completed": t.initial_sync_completed,
                    "last_successful_sync": t.last_successful_sync,
                    "first_transaction_date": t.first_transaction_date,
                })),
                "holdings": s.holdings.as_ref().map(|h| serde_json::json!({
                    "initial_sync_completed": h.initial_sync_completed,
                    "last_successful_sync": h.last_successful_sync,
                })),
            })),
            "owner": self.owner.as_ref().map(|o| serde_json::json!({
                "user_id": o.user_id,
                "full_name": o.full_name,
                "email": o.email,
                "avatar_url": o.avatar_url,
                "is_own_account": o.is_own_account,
            })),
        });
        serde_json::to_string(&meta).ok()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Plans Types
// ─────────────────────────────────────────────────────────────────────────────

/// Pricing information for a subscription plan
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPricing {
    pub monthly: f64,
    pub yearly: f64,
    #[serde(default)]
    pub yearly_per_month: Option<f64>,
}

/// Plan limits/quotas
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub household_size: i32,
    pub institution_connections: PlanLimitValue,
    pub devices: i32,
}

/// A plan limit value that can be a number or "unlimited"
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlanLimitValue {
    Limited(i32),
    Unlimited(String),
}

impl PlanLimitValue {
    pub fn display(&self) -> String {
        match self {
            PlanLimitValue::Limited(n) => n.to_string(),
            PlanLimitValue::Unlimited(_) => "Unlimited".to_string(),
        }
    }
}

/// A subscription plan
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPlan {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tagline: Option<String>,
    pub description: String,
    pub pricing: PlanPricing,
    pub limits: PlanLimits,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub features_extended: Option<Vec<String>>,
    #[serde(default)]
    pub is_available: bool,
    #[serde(default)]
    pub is_coming_soon: bool,
    #[serde(default)]
    pub badge: Option<String>,
    #[serde(default)]
    pub yearly_discount_percent: Option<i32>,
}

/// Response containing subscription plans
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlansResponse {
    pub plans: Vec<SubscriptionPlan>,
}

// ─────────────────────────────────────────────────────────────────────────────
// User Info Types
// ─────────────────────────────────────────────────────────────────────────────

/// User's team information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserTeam {
    pub id: String,
    pub name: String,
    pub logo_url: Option<String>,
    pub plan: Option<String>,
    pub subscription_status: Option<String>,
    pub subscription_current_period_end: Option<String>,
    pub subscription_cancel_at_period_end: Option<bool>,
    pub canceled_at: Option<String>,
    pub country_code: Option<String>,
    pub created_at: Option<String>,
}

/// User information from the cloud API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
    pub week_starts_on_monday: Option<bool>,
    pub timezone: Option<String>,
    pub timezone_auto_sync: Option<bool>,
    pub time_format: Option<i32>,
    pub date_format: Option<String>,
    pub team_id: Option<String>,
    pub team_role: Option<String>,
    pub team: Option<UserTeam>,
}
