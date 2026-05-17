//! Database model for accounts.

use std::str::FromStr;

use chrono::NaiveDateTime;
use diesel::prelude::*;
use log::warn;
use serde::{Deserialize, Serialize};

use wealthfolio_core::accounts::{Account, AccountUpdate, NewAccount, TaxTreatment, TrackingMode};

/// Database model for accounts
#[derive(
    Queryable,
    Identifiable,
    Insertable,
    AsChangeset,
    Selectable,
    PartialEq,
    Serialize,
    Deserialize,
    Debug,
    Clone,
)]
#[diesel(table_name = crate::schema::accounts)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AccountDB {
    #[diesel(column_name = id)]
    pub id: String,
    pub name: String,
    pub account_type: String,
    pub group: Option<String>,
    pub currency: String,
    pub is_default: bool,
    pub is_active: bool,
    #[diesel(skip_insertion)]
    pub created_at: NaiveDateTime,
    #[diesel(skip_insertion)]
    pub updated_at: NaiveDateTime,
    pub platform_id: Option<String>,
    pub account_number: Option<String>,
    pub meta: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
    pub is_archived: bool,
    pub tracking_mode: String,
    pub tax_treatment: String,
}

// Conversion implementations
impl From<AccountDB> for Account {
    fn from(db: AccountDB) -> Self {
        let tracking_mode = match db.tracking_mode.as_str() {
            "TRANSACTIONS" => TrackingMode::Transactions,
            "HOLDINGS" => TrackingMode::Holdings,
            _ => TrackingMode::NotSet,
        };
        let tax_treatment = TaxTreatment::from_str(&db.tax_treatment).unwrap_or_else(|err| {
            warn!(
                "Unrecognized tax_treatment '{}' for account '{}' ({}); defaulting to TAXABLE",
                db.tax_treatment, db.id, err
            );
            TaxTreatment::Taxable
        });
        Self {
            id: db.id,
            name: db.name,
            account_type: db.account_type,
            group: db.group,
            currency: db.currency,
            is_default: db.is_default,
            is_active: db.is_active,
            created_at: db.created_at,
            updated_at: db.updated_at,
            platform_id: db.platform_id,
            account_number: db.account_number,
            meta: db.meta,
            provider: db.provider,
            provider_account_id: db.provider_account_id,
            is_archived: db.is_archived,
            tracking_mode,
            tax_treatment,
        }
    }
}

impl From<NewAccount> for AccountDB {
    fn from(domain: NewAccount) -> Self {
        let now = chrono::Utc::now().naive_utc();
        let tracking_mode = match domain.tracking_mode {
            TrackingMode::Transactions => "TRANSACTIONS",
            TrackingMode::Holdings => "HOLDINGS",
            TrackingMode::NotSet => "NOT_SET",
        }
        .to_string();
        let tax_treatment = domain.tax_treatment.as_str().to_string();
        Self {
            id: domain.id.unwrap_or_default(),
            name: domain.name,
            account_type: domain.account_type,
            group: domain.group,
            currency: domain.currency,
            is_default: domain.is_default,
            is_active: domain.is_active,
            created_at: now,
            updated_at: now,
            platform_id: domain.platform_id,
            account_number: domain.account_number,
            meta: domain.meta,
            provider: domain.provider,
            provider_account_id: domain.provider_account_id,
            is_archived: domain.is_archived,
            tracking_mode,
            tax_treatment,
        }
    }
}

impl From<AccountUpdate> for AccountDB {
    fn from(domain: AccountUpdate) -> Self {
        let tracking_mode = domain
            .tracking_mode
            .map(|tm| match tm {
                TrackingMode::Transactions => "TRANSACTIONS",
                TrackingMode::Holdings => "HOLDINGS",
                TrackingMode::NotSet => "NOT_SET",
            })
            .unwrap_or("NOT_SET")
            .to_string();
        // When `tax_treatment` is not provided on the update, leave an empty
        // placeholder; the repository is responsible for populating it from the
        // existing record (same pattern as `currency` and `created_at`).
        let tax_treatment = domain
            .tax_treatment
            .map(|tt| tt.as_str().to_string())
            .unwrap_or_default();
        Self {
            id: domain.id.unwrap_or_default(),
            name: domain.name,
            account_type: domain.account_type,
            group: domain.group,
            currency: String::new(), // This will be filled from existing record
            is_default: domain.is_default,
            is_active: domain.is_active,
            created_at: NaiveDateTime::default(), // This will be filled from existing record
            updated_at: chrono::Utc::now().naive_utc(),
            platform_id: domain.platform_id,
            account_number: domain.account_number,
            meta: domain.meta,
            provider: domain.provider,
            provider_account_id: domain.provider_account_id,
            is_archived: domain.is_archived.unwrap_or(false),
            tracking_mode,
            tax_treatment,
        }
    }
}
