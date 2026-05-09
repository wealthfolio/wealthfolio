//! Database model for assets.
//!
//! Split into read (AssetDB) and write (InsertableAssetDB) structs because
//! `instrument_key` is a STORED generated column — readable but not writable.

use chrono::NaiveDateTime;
use diesel::prelude::*;
use log::error;
use serde::{Deserialize, Serialize};

use wealthfolio_core::assets::{Asset, AssetKind, InstrumentType, NewAsset, QuoteMode};

/// Helper to parse datetime string to NaiveDateTime.
///
/// Supports multiple formats:
/// - RFC3339: `2024-01-06T16:51:39Z` or `2024-01-06T16:51:39+00:00`
/// - SQLite CURRENT_TIMESTAMP: `2024-01-06 16:51:39`
/// - Date only: `2024-01-06`
fn text_to_datetime(s: &str) -> NaiveDateTime {
    // Try RFC3339 first (preferred format)
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.naive_utc();
    }

    // Try SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS"
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return dt;
    }

    // Try ISO 8601 without timezone: "YYYY-MM-DDTHH:MM:SS"
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return dt;
    }

    // Try date only: "YYYY-MM-DD"
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());
    }

    error!("Failed to parse datetime '{}': unsupported format", s);
    chrono::Utc::now().naive_utc()
}

/// Database read model for assets (includes generated columns).
#[derive(
    Queryable, Identifiable, Selectable, PartialEq, Serialize, Deserialize, Debug, Clone, Default,
)]
#[diesel(table_name = crate::schema::assets)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AssetDB {
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
    pub display_code: Option<String>,
    pub notes: Option<String>,
    pub metadata: Option<String>,
    pub is_active: i32,
    pub quote_mode: String,
    pub quote_ccy: String,
    pub instrument_type: Option<String>,
    pub instrument_symbol: Option<String>,
    pub instrument_exchange_mic: Option<String>,
    #[serde(skip_serializing)]
    pub instrument_key: Option<String>, // STORED generated column (read-only)
    pub provider_config: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Database write model for assets (excludes generated columns).
#[derive(Insertable, AsChangeset, Debug, Clone)]
#[diesel(table_name = crate::schema::assets)]
pub struct InsertableAssetDB {
    pub id: Option<String>,
    pub kind: String,
    pub name: Option<String>,
    pub display_code: Option<String>,
    pub notes: Option<String>,
    pub metadata: Option<String>,
    pub is_active: i32,
    pub quote_mode: String,
    pub quote_ccy: String,
    pub instrument_type: Option<String>,
    pub instrument_symbol: Option<String>,
    pub instrument_exchange_mic: Option<String>,
    // instrument_key: NOT included (STORED generated column)
    pub provider_config: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// Conversion: DB read model → domain model
impl From<AssetDB> for Asset {
    fn from(db: AssetDB) -> Self {
        let kind = AssetKind::from_db_str(&db.kind).unwrap_or_default();
        let quote_mode = match db.quote_mode.as_str() {
            "MANUAL" => QuoteMode::Manual,
            _ => QuoteMode::Market,
        };
        let instrument_type = db
            .instrument_type
            .as_deref()
            .and_then(InstrumentType::from_db_str);

        let metadata = db
            .metadata
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let provider_config = db
            .provider_config
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Self {
            id: db.id,
            kind,
            name: db.name,
            display_code: db.display_code,
            notes: db.notes,
            metadata,
            is_active: db.is_active != 0,
            quote_mode,
            quote_ccy: db.quote_ccy,
            instrument_type,
            instrument_symbol: db.instrument_symbol,
            instrument_exchange_mic: db.instrument_exchange_mic,
            instrument_key: db.instrument_key,
            provider_config,
            exchange_name: None, // Computed by Asset::enrich()
            created_at: text_to_datetime(&db.created_at),
            updated_at: text_to_datetime(&db.updated_at),
        }
    }
}

// Conversion: domain NewAsset → DB write model
impl From<NewAsset> for InsertableAssetDB {
    fn from(domain: NewAsset) -> Self {
        let now = chrono::Utc::now().to_rfc3339();

        let kind = domain.kind.as_db_str().to_string();
        let quote_mode = domain.quote_mode.as_db_str().to_string();

        let instrument_type = domain
            .instrument_type
            .as_ref()
            .map(|t| t.as_db_str().to_string());

        let provider_config = domain
            .provider_config
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok());

        let metadata = domain
            .metadata
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok());

        Self {
            id: domain.id,
            kind,
            name: domain.name,
            display_code: domain.display_code,
            notes: domain.notes,
            metadata,
            is_active: if domain.is_active { 1 } else { 0 },
            quote_mode,
            quote_ccy: domain.quote_ccy,
            instrument_type,
            instrument_symbol: domain.instrument_symbol,
            instrument_exchange_mic: domain.instrument_exchange_mic,
            provider_config,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
