//! Alternative Assets service implementation.
//!
//! This service manages the lifecycle of alternative assets including
//! properties, vehicles, collectibles, precious metals, and liabilities.
//!
//! Alternative assets use a simplified model:
//! - No dedicated accounts (avoids account clutter)
//! - No activities (avoids activity clutter)
//! - Just asset record + valuation quotes

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use log::debug;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use uuid::Uuid;

use super::alternative_assets_model::{
    AlternativeHolding, CreateAlternativeAssetRequest, CreateAlternativeAssetResponse,
    LinkLiabilityRequest, LinkLiabilityResponse, UpdateAssetDetailsRequest,
    UpdateAssetDetailsResponse, UpdateValuationRequest, UpdateValuationResponse,
};
use super::alternative_assets_traits::{
    AlternativeAssetRepositoryTrait, AlternativeAssetServiceTrait,
};
use super::{AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode};
use crate::errors::{Error, Result, ValidationError};
use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::quotes::constants::DATA_SOURCE_MANUAL;
use crate::quotes::{Quote, QuoteServiceTrait};

/// Service for managing alternative assets.
///
/// This service coordinates between the asset repository and quote service
/// to manage the lifecycle of alternative assets.
///
/// NOTE: Alternative assets don't create accounts or activities - just asset + quotes.
pub struct AlternativeAssetService {
    alternative_asset_repository: Arc<dyn AlternativeAssetRepositoryTrait>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    event_sink: Arc<dyn DomainEventSink>,
}

impl AlternativeAssetService {
    /// Creates a new AlternativeAssetService instance.
    pub fn new(
        alternative_asset_repository: Arc<dyn AlternativeAssetRepositoryTrait>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
    ) -> Self {
        Self {
            alternative_asset_repository,
            asset_repository,
            quote_service,
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    /// Sets the domain event sink for this service.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    /// Validates that the request is for an alternative asset kind.
    fn validate_alternative_asset_kind(kind: &AssetKind) -> Result<()> {
        match kind {
            AssetKind::Property
            | AssetKind::Vehicle
            | AssetKind::Collectible
            | AssetKind::PreciousMetal
            | AssetKind::PrivateEquity
            | AssetKind::Liability
            | AssetKind::Other => Ok(()),
            _ => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Asset kind {:?} is not an alternative asset type",
                kind
            )))),
        }
    }

    /// Builds the asset metadata JSON, including purchase info and kind-specific metadata.
    fn build_asset_metadata(request: &CreateAlternativeAssetRequest) -> Option<Value> {
        let mut metadata = request.metadata.clone().unwrap_or_else(|| json!({}));

        // Add purchase info if provided
        if let Some(purchase_price) = &request.purchase_price {
            if let Some(obj) = metadata.as_object_mut() {
                obj.insert(
                    "purchase_price".to_string(),
                    json!(purchase_price.to_string()),
                );
            }
        }
        if let Some(purchase_date) = &request.purchase_date {
            if let Some(obj) = metadata.as_object_mut() {
                obj.insert(
                    "purchase_date".to_string(),
                    json!(purchase_date.to_string()),
                );
            }
        }

        // For liabilities, add linked_asset_id if provided
        if request.kind == AssetKind::Liability {
            if let Some(linked_id) = &request.linked_asset_id {
                if let Some(obj) = metadata.as_object_mut() {
                    obj.insert("linked_asset_id".to_string(), json!(linked_id));
                }
            }
        }

        // Return None if metadata is empty, Some otherwise
        if metadata.as_object().is_some_and(|o| o.is_empty()) {
            None
        } else {
            Some(metadata)
        }
    }

    /// Extracts linked_asset_id from liability metadata.
    #[cfg(test)]
    fn get_linked_asset_id(metadata: &Option<Value>) -> Option<String> {
        metadata
            .as_ref()
            .and_then(|m| m.get("linked_asset_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Adds or updates linked_asset_id in metadata.
    fn set_linked_asset_id(metadata: Option<Value>, linked_asset_id: &str) -> Value {
        let mut meta = metadata.unwrap_or_else(|| json!({}));
        if let Some(obj) = meta.as_object_mut() {
            obj.insert("linked_asset_id".to_string(), json!(linked_asset_id));
        }
        meta
    }

    /// Removes linked_asset_id from metadata.
    #[cfg(test)]
    fn remove_linked_asset_id(metadata: Option<Value>) -> Option<Value> {
        let mut meta = metadata?;
        if let Some(obj) = meta.as_object_mut() {
            obj.remove("linked_asset_id");
            if obj.is_empty() {
                return None;
            }
        }
        Some(meta)
    }

    /// Derives the display code for an alternative asset from its metadata.
    ///
    /// Uses the unified `sub_type` field (e.g., "gold" → "Gold", "mortgage" → "Mortgage").
    /// Falls back to the kind's display name if sub_type is not set.
    pub fn derive_display_code(kind: &AssetKind, metadata: &Option<Value>) -> String {
        metadata
            .as_ref()
            .and_then(|m| m.get("sub_type"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(Self::format_subtype)
            .unwrap_or_else(|| kind.display_name().to_string())
    }

    /// Formats a snake_case subtype to Title Case (e.g., "auto_loan" → "Auto Loan").
    fn format_subtype(subtype: &str) -> String {
        subtype
            .split('_')
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    None => String::new(),
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[async_trait]
impl AlternativeAssetServiceTrait for AlternativeAssetService {
    async fn create_alternative_asset(
        &self,
        request: CreateAlternativeAssetRequest,
    ) -> Result<CreateAlternativeAssetResponse> {
        // Validate the asset kind is an alternative asset
        Self::validate_alternative_asset_kind(&request.kind)?;

        // Validate required fields
        if request.name.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Asset name cannot be empty".to_string(),
            )));
        }
        if request.currency.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Currency cannot be empty".to_string(),
            )));
        }

        // Validate purchase date is before value date when both are provided
        if let (Some(purchase_date), value_date) = (request.purchase_date, request.value_date) {
            if purchase_date >= value_date {
                return Err(Error::Validation(ValidationError::InvalidInput(
                    "Purchase/origination date must be before current value date".to_string(),
                )));
            }
        }

        debug!(
            "Creating alternative asset: {} ({:?})",
            request.name, request.kind
        );

        // 1. Build asset metadata
        let metadata = Self::build_asset_metadata(&request);

        // 2. Determine display_code from metadata
        let display_code = Self::derive_display_code(&request.kind, &metadata);

        // 3. Create the asset record (DB generates UUID)
        let new_asset = NewAsset {
            id: None, // DB generates UUID
            name: Some(request.name.clone()),
            display_code: Some(display_code),
            quote_ccy: request.currency.clone(),
            kind: request.kind.clone(),
            quote_mode: QuoteMode::Manual,
            is_active: true,
            metadata,
            ..Default::default()
        };

        let asset = self.asset_repository.create(new_asset).await?;
        let asset_id = asset.id.clone();
        debug!("Created asset: {}", asset_id);

        // Emit asset created event
        self.event_sink
            .emit(DomainEvent::assets_created(vec![asset_id.clone()]));

        // 4. Create purchase/origination quote if both price and date are provided
        if let (Some(purchase_price), Some(purchase_date)) =
            (request.purchase_price, request.purchase_date)
        {
            let purchase_quote = Quote {
                id: Uuid::new_v4().to_string(),
                asset_id: asset_id.clone(),
                timestamp: Utc.from_utc_datetime(&purchase_date.and_hms_opt(12, 0, 0).unwrap()),
                open: purchase_price,
                high: purchase_price,
                low: purchase_price,
                close: purchase_price,
                adjclose: purchase_price,
                volume: Decimal::ZERO,
                currency: request.currency.clone(),
                data_source: DATA_SOURCE_MANUAL.to_string(),
                created_at: Utc::now(),
                notes: None,
            };
            self.quote_service.add_quote(&purchase_quote).await?;
            debug!(
                "Created purchase/origination quote at {} with value {}",
                purchase_date, purchase_price
            );
        }

        // 5. Create current valuation quote
        let quote_id = Uuid::new_v4().to_string();
        let quote = Quote {
            id: quote_id.clone(),
            asset_id: asset_id.clone(),
            timestamp: Utc.from_utc_datetime(&request.value_date.and_hms_opt(12, 0, 0).unwrap()),
            open: request.current_value,
            high: request.current_value,
            low: request.current_value,
            close: request.current_value,
            adjclose: request.current_value,
            volume: Decimal::ZERO,
            currency: request.currency.clone(),
            data_source: DATA_SOURCE_MANUAL.to_string(),
            created_at: Utc::now(),
            notes: None,
        };

        let saved_quote = self.quote_service.add_quote(&quote).await?;
        debug!("Created current valuation quote: {}", saved_quote.id);

        Ok(CreateAlternativeAssetResponse {
            asset_id,
            quote_id: saved_quote.id,
        })
    }

    async fn update_valuation(
        &self,
        request: UpdateValuationRequest,
    ) -> Result<UpdateValuationResponse> {
        debug!(
            "Updating valuation for asset {} to {} on {}",
            request.asset_id, request.value, request.date
        );

        // Verify the asset exists
        self.asset_repository.get_by_id(&request.asset_id)?;

        // Get the existing quote to find the currency
        let currency = match self.quote_service.get_latest_quote(&request.asset_id) {
            Ok(existing_quote) => existing_quote.currency,
            Err(_) => {
                return Err(Error::Validation(ValidationError::InvalidInput(format!(
                    "Cannot find existing valuation for asset: {}. Please check the asset exists.",
                    request.asset_id
                ))));
            }
        };

        // Create new valuation quote
        let quote_id = Uuid::new_v4().to_string();
        let quote = Quote {
            id: quote_id.clone(),
            asset_id: request.asset_id.clone(),
            timestamp: Utc.from_utc_datetime(&request.date.and_hms_opt(12, 0, 0).unwrap()),
            open: request.value,
            high: request.value,
            low: request.value,
            close: request.value,
            adjclose: request.value,
            volume: Decimal::ZERO,
            currency,
            data_source: DATA_SOURCE_MANUAL.to_string(),
            created_at: Utc::now(),
            notes: request.notes.clone(),
        };

        let saved_quote = self.quote_service.add_quote(&quote).await?;
        debug!("Created valuation quote: {}", saved_quote.id);

        Ok(UpdateValuationResponse {
            quote_id: saved_quote.id,
            valuation_date: request.date,
            value: request.value,
        })
    }

    async fn delete_alternative_asset(&self, asset_id: &str) -> Result<()> {
        debug!("Deleting alternative asset: {}", asset_id);

        // Verify the asset exists and is an alternative asset
        let asset = self.asset_repository.get_by_id(asset_id)?;
        if !asset.kind.is_alternative() {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Asset {} is not an alternative asset (kind: {:?})",
                asset_id, asset.kind
            ))));
        }

        self.alternative_asset_repository
            .delete_alternative_asset(asset_id)
            .await?;

        debug!("Successfully deleted alternative asset: {}", asset_id);
        Ok(())
    }

    async fn link_liability(&self, request: LinkLiabilityRequest) -> Result<LinkLiabilityResponse> {
        debug!(
            "Linking liability {} to asset {}",
            request.liability_id, request.target_asset_id
        );

        // Validate liability is actually a Liability kind
        let liability = self.asset_repository.get_by_id(&request.liability_id)?;
        if liability.kind != AssetKind::Liability {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Asset {} is not a liability (kind: {:?})",
                request.liability_id, liability.kind
            ))));
        }

        // Validate target asset exists and is an alternative asset
        let target = self.asset_repository.get_by_id(&request.target_asset_id)?;
        if !target.kind.is_alternative() {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Target asset {} is not an alternative asset (kind: {:?})",
                request.target_asset_id, target.kind
            ))));
        }

        // Update liability metadata with linked_asset_id
        let new_metadata = Self::set_linked_asset_id(None, &request.target_asset_id);
        self.alternative_asset_repository
            .update_asset_metadata(&request.liability_id, Some(new_metadata))
            .await?;

        debug!(
            "Linked liability {} to asset {}",
            request.liability_id, request.target_asset_id
        );

        Ok(LinkLiabilityResponse {
            liability_id: request.liability_id,
            linked_asset_id: Some(request.target_asset_id),
        })
    }

    async fn unlink_liability(&self, liability_id: &str) -> Result<LinkLiabilityResponse> {
        debug!("Unlinking liability {}", liability_id);

        // Validate liability is actually a Liability kind
        let liability = self.asset_repository.get_by_id(liability_id)?;
        if liability.kind != AssetKind::Liability {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Asset {} is not a liability (kind: {:?})",
                liability_id, liability.kind
            ))));
        }

        // Remove linked_asset_id from metadata
        self.alternative_asset_repository
            .update_asset_metadata(liability_id, None)
            .await?;

        debug!("Unlinked liability {}", liability_id);

        Ok(LinkLiabilityResponse {
            liability_id: liability_id.to_string(),
            linked_asset_id: None,
        })
    }

    async fn update_asset_details(
        &self,
        request: UpdateAssetDetailsRequest,
    ) -> Result<UpdateAssetDetailsResponse> {
        debug!("Updating asset details for {}", request.asset_id);

        // Verify the asset exists and is an alternative asset
        let asset = self.asset_repository.get_by_id(&request.asset_id)?;
        if !asset.kind.is_alternative() {
            return Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Asset {} is not an alternative asset (kind: {:?})",
                request.asset_id, asset.kind
            ))));
        }

        // Parse existing metadata
        let mut metadata_obj = asset
            .metadata
            .as_ref()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        // Track old purchase info for quote sync
        let old_purchase_price = metadata_obj
            .get("purchase_price")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let old_purchase_date = metadata_obj
            .get("purchase_date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Merge new metadata (None values remove the key)
        if let Some(new_metadata) = &request.metadata {
            for (key, value) in new_metadata {
                match value {
                    Some(v) if !v.is_empty() => {
                        metadata_obj.insert(key.clone(), json!(v));
                    }
                    _ => {
                        metadata_obj.remove(key);
                    }
                }
            }
        }

        // Get new purchase info after merge
        let new_purchase_price = metadata_obj
            .get("purchase_price")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let new_purchase_date = metadata_obj
            .get("purchase_date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Recalculate display_code from updated metadata
        let updated_metadata = if metadata_obj.is_empty() {
            None
        } else {
            Some(Value::Object(metadata_obj))
        };
        let display_code = Self::derive_display_code(&asset.kind, &updated_metadata);

        // Persist asset details update
        self.alternative_asset_repository
            .update_asset_details(
                &request.asset_id,
                request.name.as_deref(),
                Some(&display_code),
                updated_metadata,
                request.notes.as_deref(),
            )
            .await?;

        // Check if purchase info changed and update/create purchase quote
        let mut purchase_quote_updated = false;
        let purchase_info_changed =
            old_purchase_price != new_purchase_price || old_purchase_date != new_purchase_date;

        if purchase_info_changed {
            if let (Some(price_str), Some(date_str)) = (&new_purchase_price, &new_purchase_date) {
                let purchase_price: Decimal = price_str.parse().map_err(|_| {
                    Error::Validation(ValidationError::InvalidInput(
                        "Invalid purchase price format".to_string(),
                    ))
                })?;
                let purchase_date = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
                    .map_err(|_| {
                        Error::Validation(ValidationError::InvalidInput(
                            "Invalid purchase date format".to_string(),
                        ))
                    })?;

                let purchase_quote = Quote {
                    id: Uuid::new_v4().to_string(),
                    asset_id: request.asset_id.clone(),
                    timestamp: Utc.from_utc_datetime(&purchase_date.and_hms_opt(12, 0, 0).unwrap()),
                    open: purchase_price,
                    high: purchase_price,
                    low: purchase_price,
                    close: purchase_price,
                    adjclose: purchase_price,
                    volume: Decimal::ZERO,
                    currency: asset.quote_ccy.clone(),
                    data_source: DATA_SOURCE_MANUAL.to_string(),
                    created_at: Utc::now(),
                    notes: None,
                };

                self.quote_service.add_quote(&purchase_quote).await?;
                purchase_quote_updated = true;
                debug!(
                    "Updated purchase quote for {} at {} with value {}",
                    request.asset_id, purchase_date, purchase_price
                );
            }
        }

        debug!(
            "Updated asset details for {}, purchase_quote_updated: {}",
            request.asset_id, purchase_quote_updated
        );

        Ok(UpdateAssetDetailsResponse {
            asset_id: request.asset_id,
            purchase_quote_updated,
        })
    }

    fn get_alternative_holdings(&self) -> Result<Vec<AlternativeHolding>> {
        debug!("Fetching alternative holdings");

        // Get all assets
        let all_assets = self.asset_repository.list()?;

        // Filter to alternative assets only
        let alternative_assets: Vec<_> = all_assets
            .into_iter()
            .filter(|a| a.kind.is_alternative())
            .collect();

        if alternative_assets.is_empty() {
            return Ok(vec![]);
        }

        // Get asset IDs for quote lookup
        let asset_ids: Vec<String> = alternative_assets.iter().map(|a| a.id.clone()).collect();

        // Fetch latest quotes for all alternative assets
        let quotes = self.quote_service.get_latest_quotes(&asset_ids)?;

        // Build AlternativeHolding for each asset
        let holdings: Vec<AlternativeHolding> = alternative_assets
            .into_iter()
            .filter_map(|asset| {
                let quote = quotes.get(&asset.id)?;

                // Extract purchase_price from metadata
                let purchase_price = asset
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("purchase_price"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<Decimal>().ok());

                // Extract purchase_date from metadata
                let purchase_date = asset
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("purchase_date"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());

                // Extract linked_asset_id from metadata (for liabilities)
                let linked_asset_id = asset
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("linked_asset_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Calculate unrealized gain if we have purchase price
                let (unrealized_gain, unrealized_gain_pct) = if let Some(pp) = purchase_price {
                    let gain = quote.close - pp;
                    let pct = if pp != Decimal::ZERO {
                        Some(gain / pp)
                    } else {
                        None
                    };
                    (Some(gain), pct)
                } else {
                    (None, None)
                };

                Some(AlternativeHolding {
                    id: asset.id.clone(),
                    kind: asset.kind.clone(),
                    name: asset
                        .name
                        .clone()
                        .unwrap_or_else(|| asset.display_code.clone().unwrap_or_default()),
                    symbol: asset.display_code.unwrap_or_default(),
                    currency: asset.quote_ccy,
                    market_value: quote.close,
                    purchase_price,
                    purchase_date,
                    unrealized_gain,
                    unrealized_gain_pct,
                    valuation_date: quote.timestamp,
                    metadata: asset.metadata,
                    linked_asset_id,
                    notes: asset.notes,
                })
            })
            .collect();

        debug!("Found {} alternative holdings", holdings.len());
        Ok(holdings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_alternative_asset_kind() {
        // Valid alternative asset kinds
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Property).is_ok()
        );
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Vehicle).is_ok()
        );
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Collectible)
                .is_ok()
        );
        assert!(AlternativeAssetService::validate_alternative_asset_kind(
            &AssetKind::PreciousMetal
        )
        .is_ok());
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Liability).is_ok()
        );
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Other).is_ok()
        );

        // Invalid asset kinds
        assert!(
            AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Investment)
                .is_err()
        );
        assert!(AlternativeAssetService::validate_alternative_asset_kind(&AssetKind::Fx).is_err());
    }

    #[test]
    fn test_build_asset_metadata() {
        let request = CreateAlternativeAssetRequest {
            kind: AssetKind::Property,
            name: "Beach House".to_string(),
            currency: "USD".to_string(),
            current_value: Decimal::new(450000, 0),
            value_date: chrono::NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
            purchase_price: Some(Decimal::new(400000, 0)),
            purchase_date: Some(chrono::NaiveDate::from_ymd_opt(2020, 3, 1).unwrap()),
            metadata: Some(json!({"sub_type": "residence"})),
            linked_asset_id: None,
        };

        let metadata = AlternativeAssetService::build_asset_metadata(&request);
        assert!(metadata.is_some());
        let meta = metadata.unwrap();
        assert_eq!(meta.get("sub_type").unwrap(), "residence");
        assert!(meta.get("purchase_price").is_some());
        assert!(meta.get("purchase_date").is_some());
    }

    #[test]
    fn test_set_and_remove_linked_asset_id() {
        let metadata = AlternativeAssetService::set_linked_asset_id(None, "some-uuid-for-property");
        assert_eq!(
            metadata.get("linked_asset_id").unwrap(),
            "some-uuid-for-property"
        );

        let linked_id = AlternativeAssetService::get_linked_asset_id(&Some(metadata.clone()));
        assert_eq!(linked_id, Some("some-uuid-for-property".to_string()));

        let removed = AlternativeAssetService::remove_linked_asset_id(Some(metadata));
        assert!(removed.is_none()); // Only had linked_asset_id, so should be None when removed
    }
}
