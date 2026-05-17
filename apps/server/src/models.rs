use std::str::FromStr;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use tracing::warn;
use utoipa::ToSchema;
use wealthfolio_core::accounts as core_accounts;

#[derive(Serialize, Deserialize, ToSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub currency: String,
    pub is_default: bool,
    pub is_active: bool,
    pub is_archived: bool,
    pub tracking_mode: String,
    #[serde(default = "default_tax_treatment")]
    pub tax_treatment: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
}

impl From<core_accounts::Account> for Account {
    fn from(a: core_accounts::Account) -> Self {
        let tracking_mode = match a.tracking_mode {
            core_accounts::TrackingMode::Transactions => "TRANSACTIONS",
            core_accounts::TrackingMode::Holdings => "HOLDINGS",
            core_accounts::TrackingMode::NotSet => "NOT_SET",
        }
        .to_string();
        let tax_treatment = a.tax_treatment.as_str().to_string();
        Self {
            id: a.id,
            name: a.name,
            account_type: a.account_type,
            group: a.group,
            currency: a.currency,
            is_default: a.is_default,
            is_active: a.is_active,
            is_archived: a.is_archived,
            tracking_mode,
            tax_treatment,
            created_at: a.created_at,
            updated_at: a.updated_at,
            platform_id: a.platform_id,
            account_number: a.account_number,
            meta: a.meta,
            provider: a.provider,
            provider_account_id: a.provider_account_id,
        }
    }
}

#[derive(Serialize, Deserialize, ToSchema, Debug, Clone)]
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
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default = "default_tracking_mode")]
    pub tracking_mode: String,
    #[serde(default = "default_tax_treatment")]
    pub tax_treatment: String,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
}

fn default_tracking_mode() -> String {
    "NOT_SET".to_string()
}

fn default_tax_treatment() -> String {
    "TAXABLE".to_string()
}

fn parse_tracking_mode(s: &str) -> core_accounts::TrackingMode {
    match s {
        "TRANSACTIONS" => core_accounts::TrackingMode::Transactions,
        "HOLDINGS" => core_accounts::TrackingMode::Holdings,
        _ => core_accounts::TrackingMode::NotSet,
    }
}

fn parse_tax_treatment(s: &str) -> core_accounts::TaxTreatment {
    core_accounts::TaxTreatment::from_str(s).unwrap_or_else(|err| {
        warn!(
            "Unrecognized tax_treatment '{}' in HTTP payload ({}); defaulting to TAXABLE",
            s, err
        );
        core_accounts::TaxTreatment::Taxable
    })
}

impl From<NewAccount> for core_accounts::NewAccount {
    fn from(a: NewAccount) -> Self {
        Self {
            id: a.id,
            name: a.name,
            account_type: a.account_type,
            group: a.group,
            currency: a.currency,
            is_default: a.is_default,
            is_active: a.is_active,
            is_archived: a.is_archived,
            tracking_mode: parse_tracking_mode(&a.tracking_mode),
            tax_treatment: parse_tax_treatment(&a.tax_treatment),
            platform_id: a.platform_id,
            account_number: a.account_number,
            meta: a.meta,
            provider: a.provider,
            provider_account_id: a.provider_account_id,
        }
    }
}

#[derive(Serialize, Deserialize, ToSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdate {
    pub id: Option<String>,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub is_default: bool,
    pub is_active: bool,
    pub is_archived: Option<bool>,
    pub tracking_mode: Option<String>,
    pub tax_treatment: Option<String>,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
}

impl From<AccountUpdate> for core_accounts::AccountUpdate {
    fn from(a: AccountUpdate) -> Self {
        Self {
            id: a.id,
            name: a.name,
            account_type: a.account_type,
            group: a.group,
            is_default: a.is_default,
            is_active: a.is_active,
            is_archived: a.is_archived,
            tracking_mode: a.tracking_mode.map(|s| parse_tracking_mode(&s)),
            tax_treatment: a.tax_treatment.map(|s| parse_tax_treatment(&s)),
            platform_id: a.platform_id,
            account_number: a.account_number,
            meta: a.meta,
            provider: a.provider,
            provider_account_id: a.provider_account_id,
        }
    }
}
