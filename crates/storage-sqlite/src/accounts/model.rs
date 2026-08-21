//! Database model for accounts.

use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use wealthfolio_core::accounts::{
    Account, AccountAccountingSettings, AccountUpdate, CostBasisMethod, CostBasisProfile,
    LotSelectionStrategy, NewAccount, PoolingScope, TrackingMode,
};
use wealthfolio_core::errors::Result;

const ACCOUNTING_META_KEY: &str = "accounting";

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
    pub interest_rate: Option<String>,
}

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

// Conversion implementations
impl AccountDB {
    pub fn accounting_settings(&self) -> Result<AccountAccountingSettings> {
        let default = AccountAccountingSettings::default_for_account(self.id.clone());
        let Some(raw_meta) = self
            .meta
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            return Ok(default);
        };

        let Ok(meta) = serde_json::from_str::<Value>(raw_meta) else {
            return Ok(default);
        };
        let Some(accounting) = meta
            .get(ACCOUNTING_META_KEY)
            .filter(|value| value.is_object())
        else {
            return Ok(default);
        };

        let settings_meta =
            serde_json::from_value::<AccountAccountingSettingsMeta>(accounting.clone())?;
        settings_meta.into_settings(self.id.clone())
    }

    pub fn ensure_default_accounting_meta(&mut self) -> Result<()> {
        let settings = AccountAccountingSettings::default_for_account(self.id.clone());
        self.meta = merge_accounting_settings_into_meta(self.meta.as_deref(), &settings)?;
        Ok(())
    }
}

fn merge_accounting_settings_into_meta(
    raw_meta: Option<&str>,
    settings: &AccountAccountingSettings,
) -> Result<Option<String>> {
    let accounting = serde_json::to_value(AccountAccountingSettingsMeta::from_settings(settings))?;

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
            interest_rate: db.interest_rate,
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
            interest_rate: domain.interest_rate,
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
            interest_rate: domain.interest_rate,
        }
    }
}
