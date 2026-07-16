//! Account domain models.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

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

    pub fn ensure_supported_for_calculation(self, account_id: &str) -> Result<()> {
        if self == Self::Fifo {
            return Ok(());
        }

        Err(Error::Validation(ValidationError::InvalidInput(format!(
            "Cost basis method {} for account {} is not supported by the snapshot calculator yet; only FIFO is supported.",
            self.as_str(),
            account_id
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
