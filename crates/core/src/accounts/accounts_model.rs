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
