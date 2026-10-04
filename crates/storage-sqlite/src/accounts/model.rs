//! Database model for accounts.

use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use wealthfolio_core::accounts::{
    Account, AccountAccountingSettings, AccountUpdate, NewAccount, TrackingMode,
};
use wealthfolio_core::errors::Result;

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
}

// Conversion implementations
impl AccountDB {
    pub fn ensure_default_accounting_meta(&mut self) -> Result<()> {
        self.meta = AccountAccountingSettings::default_for_account(self.id.clone())
            .merge_into_meta(self.meta.as_deref())?;
        Ok(())
    }
}

impl From<AccountDB> for Account {
    fn from(db: AccountDB) -> Self {
        let tracking_mode = match db.tracking_mode.as_str() {
            "TRANSACTIONS" => TrackingMode::Transactions,
            "HOLDINGS" => TrackingMode::Holdings,
            _ => TrackingMode::NotSet,
        };
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
        }
    }
}
