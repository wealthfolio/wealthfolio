//! Account domain models.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{errors::ValidationError, Error, Result};

use super::accounts_constants::account_types;

/// Tracking mode for an account - determines how holdings are tracked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrackingMode {
    /// Holdings are calculated from transaction history
    Transactions,
    /// Holdings are manually entered or imported directly
    Holdings,
    /// Tracking mode has not been set yet
    #[default]
    NotSet,
}

/// Inventory cost-basis method configured for an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostBasisMethod {
    #[default]
    Fifo,
    Lifo,
    Wac,
}

impl CostBasisMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fifo => "FIFO",
            Self::Lifo => "LIFO",
            Self::Wac => "WAC",
        }
    }

    pub fn from_code(value: &str) -> Result<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "FIFO" => Ok(Self::Fifo),
            "LIFO" => Ok(Self::Lifo),
            "WAC" => Ok(Self::Wac),
            other => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unknown cost basis method '{}'",
                other
            )))),
        }
    }

    /// Whether the portfolio engine computes this method: the engine alone
    /// says which methods it computes (engine rules §7).
    pub fn ensure_supported_for_calculation(self, account_id: &str) -> Result<()> {
        if wealthfolio_portfolio_engine::model::CostBasisMethod::parse(self.as_str()).is_some() {
            return Ok(());
        }
        let computed: Vec<&str> = wealthfolio_portfolio_engine::model::CostBasisMethod::ALL
            .iter()
            .map(|method| method.as_str())
            .collect();
        Err(Error::Validation(ValidationError::InvalidInput(format!(
            "Cost basis method {} for account {} is not supported yet; supported: {}.",
            self.as_str(),
            account_id,
            computed.join(", ")
        ))))
    }
}

impl std::fmt::Display for CostBasisMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Jurisdiction/accounting profile used to interpret a cost-basis method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostBasisProfile {
    #[default]
    Generic,
    CanadaAcb,
}

impl CostBasisProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generic => "GENERIC",
            Self::CanadaAcb => "CANADA_ACB",
        }
    }

    pub fn from_code(value: &str) -> Result<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "GENERIC" => Ok(Self::Generic),
            "CANADA_ACB" => Ok(Self::CanadaAcb),
            other => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unknown cost basis profile '{}'",
                other
            )))),
        }
    }
}

/// Scope over which lots are pooled before a method is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PoolingScope {
    #[default]
    Account,
    Portfolio,
}

impl PoolingScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Account => "ACCOUNT",
            Self::Portfolio => "PORTFOLIO",
        }
    }

    pub fn from_code(value: &str) -> Result<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "ACCOUNT" => Ok(Self::Account),
            "PORTFOLIO" => Ok(Self::Portfolio),
            other => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unknown pooling scope '{}'",
                other
            )))),
        }
    }
}

/// Optional selection policy for methods that require choosing a specific lot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LotSelectionStrategy {
    SpecificId,
    HighestCost,
    LowestCost,
}

impl LotSelectionStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SpecificId => "SPECIFIC_ID",
            Self::HighestCost => "HIGHEST_COST",
            Self::LowestCost => "LOWEST_COST",
        }
    }

    pub fn from_code(value: &str) -> Result<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "SPECIFIC_ID" => Ok(Self::SpecificId),
            "HIGHEST_COST" => Ok(Self::HighestCost),
            "LOWEST_COST" => Ok(Self::LowestCost),
            other => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unknown lot selection strategy '{}'",
                other
            )))),
        }
    }
}

/// Per-account accounting policy used by the holdings and lot generation engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAccountingSettings {
    pub account_id: String,
    pub cost_basis_method: CostBasisMethod,
    pub cost_basis_profile: CostBasisProfile,
    pub pooling_scope: PoolingScope,
    pub lot_selection_strategy: Option<LotSelectionStrategy>,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
}

impl AccountAccountingSettings {
    pub fn default_for_account(account_id: impl Into<String>) -> Self {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        Self {
            account_id: account_id.into(),
            cost_basis_method: CostBasisMethod::Fifo,
            cost_basis_profile: CostBasisProfile::Generic,
            pooling_scope: PoolingScope::Account,
            lot_selection_strategy: None,
            settings_json: "{}".to_string(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn ensure_supported_for_calculation(&self) -> Result<()> {
        self.cost_basis_method
            .ensure_supported_for_calculation(&self.account_id)?;

        if self.cost_basis_profile != CostBasisProfile::Generic {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Cost basis profile {} for account {} is not supported by the snapshot calculator yet; only GENERIC is supported.",
                self.cost_basis_profile.as_str(),
                self.account_id
            ))));
        }

        if self.pooling_scope != PoolingScope::Account {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Pooling scope {} for account {} is not supported by the snapshot calculator yet; only ACCOUNT is supported.",
                self.pooling_scope.as_str(),
                self.account_id
            ))));
        }

        if let Some(strategy) = self.lot_selection_strategy {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Lot selection strategy {} for account {} is not supported by the snapshot calculator yet.",
                strategy.as_str(),
                self.account_id
            ))));
        }

        Ok(())
    }

    /// `raw_meta` with these settings stored under its `accounting` entry when
    /// it has none. Meta that is not a JSON object is returned as it is.
    pub fn merge_into_meta(&self, raw_meta: Option<&str>) -> Result<Option<String>> {
        let accounting = serde_json::to_value(AccountAccountingSettingsMeta::from_settings(self))?;

        let Some(raw_meta) = raw_meta.map(str::trim).filter(|value| !value.is_empty()) else {
            let mut object = Map::new();
            object.insert(ACCOUNTING_META_KEY.to_string(), accounting);
            return Ok(Some(Value::Object(object).to_string()));
        };

        let Ok(mut meta) = serde_json::from_str::<Value>(raw_meta) else {
            return Ok(Some(raw_meta.to_string()));
        };
        let Some(object) = meta.as_object_mut() else {
            return Ok(Some(raw_meta.to_string()));
        };

        object
            .entry(ACCOUNTING_META_KEY.to_string())
            .or_insert(accounting);
        Ok(Some(meta.to_string()))
    }
}

/// The entry of an account's `meta` that holds its accounting settings.
const ACCOUNTING_META_KEY: &str = "accounting";

/// Accounting settings as stored under an account's `meta`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountAccountingSettingsMeta {
    #[serde(default, alias = "cost_basis_method")]
    cost_basis_method: Option<CostBasisMethod>,
    #[serde(default, alias = "cost_basis_profile")]
    cost_basis_profile: Option<CostBasisProfile>,
    #[serde(default, alias = "pooling_scope")]
    pooling_scope: Option<PoolingScope>,
    #[serde(default, alias = "lot_selection_strategy")]
    lot_selection_strategy: Option<LotSelectionStrategy>,
    #[serde(default, alias = "settings_json")]
    settings_json: Option<Value>,
    #[serde(default, alias = "created_at")]
    created_at: Option<String>,
    #[serde(default, alias = "updated_at")]
    updated_at: Option<String>,
}

impl AccountAccountingSettingsMeta {
    fn from_settings(settings: &AccountAccountingSettings) -> Self {
        let settings_json = serde_json::from_str(&settings.settings_json)
            .unwrap_or_else(|_| Value::String(settings.settings_json.clone()));

        Self {
            cost_basis_method: Some(settings.cost_basis_method),
            cost_basis_profile: Some(settings.cost_basis_profile),
            pooling_scope: Some(settings.pooling_scope),
            lot_selection_strategy: settings.lot_selection_strategy,
            settings_json: Some(settings_json),
            created_at: Some(settings.created_at.clone()),
            updated_at: Some(settings.updated_at.clone()),
        }
    }

    fn into_settings(self, account_id: String) -> Result<AccountAccountingSettings> {
        let mut settings = AccountAccountingSettings::default_for_account(account_id);

        if let Some(cost_basis_method) = self.cost_basis_method {
            settings.cost_basis_method = cost_basis_method;
        }
        if let Some(cost_basis_profile) = self.cost_basis_profile {
            settings.cost_basis_profile = cost_basis_profile;
        }
        if let Some(pooling_scope) = self.pooling_scope {
            settings.pooling_scope = pooling_scope;
        }
        settings.lot_selection_strategy = self.lot_selection_strategy;
        if let Some(settings_json) = self.settings_json {
            settings.settings_json = match settings_json {
                Value::String(value) => value,
                value => serde_json::to_string(&value)?,
            };
        }
        if let Some(created_at) = self.created_at {
            settings.created_at = created_at;
        }
        if let Some(updated_at) = self.updated_at {
            settings.updated_at = updated_at;
        }

        Ok(settings)
    }
}

/// Domain model representing an account in the system.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub currency: String,
    pub is_default: bool,
    pub is_active: bool,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub platform_id: Option<String>,
    /// Account number from the broker
    pub account_number: Option<String>,
    /// Additional metadata as JSON string
    pub meta: Option<String>,
    /// Provider name (e.g., 'SNAPTRADE', 'PLAID', 'MANUAL')
    pub provider: Option<String>,
    /// Account ID in the provider's system
    pub provider_account_id: Option<String>,
    /// Whether the account is archived
    pub is_archived: bool,
    /// Tracking mode for the account
    pub tracking_mode: TrackingMode,
}

impl Account {
    pub fn cash_allocation_category_id(&self) -> Option<String> {
        let meta = self.meta.as_deref()?.trim();
        if meta.is_empty() {
            return None;
        }
        let parsed: serde_json::Value = serde_json::from_str(meta).ok()?;
        parsed
            .get("allocation")?
            .get("cashCategoryId")?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
    }

    /// The account's accounting settings, read from its `meta` (engine rules
    /// R7.2). An account without any (no meta, or no `accounting` entry in it)
    /// takes the defaults. Settings this version cannot read (meta that is not
    /// JSON, an `accounting` entry that is not an object, a code it does not
    /// know) are an error for this account, never the defaults.
    pub fn accounting_settings(&self) -> Result<AccountAccountingSettings> {
        let Some(raw_meta) = self
            .meta
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            return Ok(AccountAccountingSettings::default_for_account(
                self.id.clone(),
            ));
        };
        // Failures are logged, so the reason names what could not be read and
        // never echoes the stored value (serde's messages quote it).
        let unreadable = |reason: &str| {
            Error::Validation(ValidationError::InvalidInput(format!(
                "Accounting settings for account {} cannot be read: {reason}.",
                self.id
            )))
        };

        let meta = serde_json::from_str::<Value>(raw_meta)
            .map_err(|_| unreadable("its meta is not JSON"))?;
        let Some(accounting) = meta.get(ACCOUNTING_META_KEY) else {
            return Ok(AccountAccountingSettings::default_for_account(
                self.id.clone(),
            ));
        };
        if !accounting.is_object() {
            return Err(unreadable("its accounting entry is not an object"));
        }
        serde_json::from_value::<AccountAccountingSettingsMeta>(accounting.clone())
            .map_err(|_| {
                unreadable("its accounting entry holds a value this version does not know")
            })?
            .into_settings(self.id.clone())
    }
}

/// Input model for creating a new account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub currency: String,
    pub is_default: bool,
    pub is_active: bool,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub tracking_mode: TrackingMode,
}

impl NewAccount {
    /// Validates the new account data.
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Account name cannot be empty".to_string(),
            )));
        }
        if self.currency.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Currency cannot be empty".to_string(),
            )));
        }
        if self.account_type == account_types::CREDIT_CARD
            && self.tracking_mode == TrackingMode::Holdings
        {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Credit card accounts cannot use HOLDINGS tracking mode".to_string(),
            )));
        }
        Ok(())
    }
}

/// Input model for updating an existing account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdate {
    pub id: Option<String>,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub is_default: bool,
    pub is_active: bool,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
    pub is_archived: Option<bool>,
    pub tracking_mode: Option<TrackingMode>,
}

impl AccountUpdate {
    /// Validates the account update data.
    pub fn validate(&self) -> Result<()> {
        if self.id.is_none() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Account ID is required for updates".to_string(),
            )));
        }
        if self.name.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Account name cannot be empty".to_string(),
            )));
        }
        if self.account_type == account_types::CREDIT_CARD
            && self.tracking_mode == Some(TrackingMode::Holdings)
        {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Credit card accounts cannot use HOLDINGS tracking mode".to_string(),
            )));
        }
        Ok(())
    }
}
