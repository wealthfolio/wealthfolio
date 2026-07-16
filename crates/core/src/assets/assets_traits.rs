use super::assets_model::{
    normalize_quote_ccy_code, Asset, AssetMetadata, AssetProfile, AssetSpec, EnsureAssetsResult,
    InstrumentType, NewAsset, QuoteMode, UpdateAssetProfile,
};
use super::{AssetResolutionInput, AssetResolutionOutput};
use crate::errors::Result;

/// Trait defining the contract for Asset service operations.
#[async_trait::async_trait]
pub trait AssetServiceTrait: Send + Sync {
    fn get_assets(&self) -> Result<Vec<Asset>>;
    fn get_asset_by_id(&self, asset_id: &str) -> Result<Asset>;
    fn get_asset_profile(&self, asset_id: &str) -> Result<AssetProfile> {
        Ok(AssetProfile::new(
            self.get_asset_by_id(asset_id)?,
            None,
            None,
        ))
    }
    async fn delete_asset(&self, asset_id: &str) -> Result<()>;
    async fn update_asset_profile(
        &self,
        asset_id: &str,
        payload: UpdateAssetProfile,
    ) -> Result<Asset>;
    /// Creates a new asset directly without network lookups.
    /// Used for alternative assets and other manually created assets.
    async fn create_asset(&self, new_asset: NewAsset) -> Result<Asset>;
    /// Creates a minimal asset without network calls.
    /// Returns the existing asset if found, or creates a new minimal one.
    /// Accepts optional metadata inputs from the caller (e.g., user-provided asset details).
    /// If `quote_mode` is provided, it overrides the default for the asset kind.
    /// Should be followed by an enrichment event for full profile data.
    async fn get_or_create_minimal_asset(
        &self,
        asset_id: &str,
        context_currency: Option<String>,
        metadata: Option<AssetMetadata>,
        quote_mode: Option<String>,
    ) -> Result<Asset>;
    async fn update_quote_mode(&self, asset_id: &str, quote_mode: &str) -> Result<Asset>;
    /// Updates quote mode without emitting domain events.
    ///
    /// Used by activity preparation flows where the activity mutation itself
    /// emits the recalculation-triggering event after persistence succeeds.
    async fn update_quote_mode_silent(&self, asset_id: &str, quote_mode: &str) -> Result<Asset> {
        self.update_quote_mode(asset_id, quote_mode).await
    }
    async fn get_assets_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>>;
    /// Enriches an existing asset's profile with data from market data provider.
    /// Updates the profile JSON (sectors, countries, website) and notes fields.
    async fn enrich_asset_profile(&self, asset_id: &str) -> Result<Asset>;

    /// Enriches multiple assets in batch, with deduplication and sync state tracking.
    /// Checks if each asset needs enrichment before fetching profile data.
    /// Returns (enriched_count, skipped_count, failed_count).
    async fn enrich_assets(&self, asset_ids: Vec<String>) -> Result<(usize, usize, usize)>;

    /// Removes the $.legacy structure from asset metadata after migration.
    /// Preserves $.identifiers if present.
    async fn cleanup_legacy_metadata(&self, asset_id: &str) -> Result<()>;

    /// Merges an UNKNOWN asset into a resolved asset.
    /// - Copies user metadata (notes) from UNKNOWN to resolved
    /// - Reassigns all activities from UNKNOWN to resolved
    /// - Deactivates the UNKNOWN asset
    /// - Emits assets_merged domain event
    /// Returns the number of activities migrated.
    async fn merge_unknown_asset(
        &self,
        resolved_asset_id: &str,
        unknown_asset_id: &str,
        activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
    ) -> Result<u32>;

    /// Ensures multiple assets exist, creating any that are missing.
    /// Returns existing + created assets, plus any UNKNOWN→resolved merge candidates.
    ///
    /// This is the batch version of `get_or_create_minimal_asset()`.
    /// Use this for bulk operations like CSV import or broker sync.
    async fn ensure_assets(
        &self,
        specs: Vec<AssetSpec>,
        activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
    ) -> Result<EnsureAssetsResult>;

    /// Resolves import-time asset candidates into canonical asset identity and drafts.
    async fn resolve_import_asset_inputs(
        &self,
        inputs: Vec<AssetResolutionInput>,
    ) -> Result<Vec<AssetResolutionOutput>>;

    /// Finds an existing asset quote currency by market identity.
    /// Uses symbol + optional MIC/type and returns normalized quote currency when found.
    fn existing_quote_ccy_by_symbol(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
    ) -> Option<String> {
        let symbol = symbol.trim();
        if symbol.is_empty() {
            return None;
        }
        let upper_symbol = symbol.to_uppercase();
        let upper_mic = exchange_mic
            .map(str::trim)
            .filter(|mic| !mic.is_empty())
            .map(str::to_uppercase);

        self.get_assets().ok()?.into_iter().find_map(|asset| {
            let asset_symbol = asset.instrument_symbol.as_deref()?.trim().to_uppercase();
            if asset_symbol != upper_symbol {
                return None;
            }

            if let Some(expected_type) = instrument_type {
                if asset.instrument_type.as_ref() != Some(expected_type) {
                    return None;
                }
            }

            match (
                upper_mic.as_deref(),
                asset.instrument_exchange_mic.as_deref(),
            ) {
                (Some(expected), Some(actual)) if actual.eq_ignore_ascii_case(expected) => {}
                (Some(_), _) => return None,
                (None, Some(_)) => return None,
                (None, None) => {}
            }

            normalize_quote_ccy_code(Some(asset.quote_ccy.as_str()))
        })
    }

    /// Validates symbol metadata required for persistence-only user save flows.
    fn validate_persisted_symbol_metadata(
        &self,
        symbol: &str,
        symbol_id: Option<&str>,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_mode: Option<QuoteMode>,
        requested_quote_ccy: Option<&str>,
    ) -> Result<()> {
        let symbol_id = symbol_id.map(str::trim).filter(|s| !s.is_empty());
        let is_non_security = matches!(
            instrument_type,
            Some(InstrumentType::Crypto | InstrumentType::Fx)
        );
        let is_manual = matches!(quote_mode, Some(QuoteMode::Manual));
        let has_explicit_requested_quote_ccy =
            normalize_quote_ccy_code(requested_quote_ccy).is_some();

        let existing_quote_ccy = symbol_id
            .and_then(|id| self.get_asset_by_id(id).ok())
            .and_then(|asset| normalize_quote_ccy_code(Some(asset.quote_ccy.as_str())))
            .or_else(|| self.existing_quote_ccy_by_symbol(symbol, exchange_mic, instrument_type));

        if !is_non_security
            && !is_manual
            && !has_explicit_requested_quote_ccy
            && existing_quote_ccy.is_none()
        {
            return Err(crate::activities::ActivityError::InvalidData(
                "Quote currency is required. Please re-select the symbol.".to_string(),
            )
            .into());
        }

        Ok(())
    }
}

/// Trait defining the contract for Asset repository operations.
#[async_trait::async_trait]
pub trait AssetRepositoryTrait: Send + Sync {
    async fn create(&self, new_asset: NewAsset) -> Result<Asset>;
    /// Creates multiple assets in a single transaction. All-or-nothing.
    async fn create_batch(&self, new_assets: Vec<NewAsset>) -> Result<Vec<Asset>>;
    async fn update_profile(&self, asset_id: &str, payload: UpdateAssetProfile) -> Result<Asset>;
    async fn update_quote_mode(&self, asset_id: &str, quote_mode: &str) -> Result<Asset>;
    fn get_by_id(&self, asset_id: &str) -> Result<Asset>;
    fn list(&self) -> Result<Vec<Asset>>;
    fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>>;
    async fn delete(&self, asset_id: &str) -> Result<()>;

    /// Search for assets by symbol (case-insensitive partial match).
    /// Used for merging existing assets into search results.
    fn search_by_symbol(&self, query: &str) -> Result<Vec<Asset>>;

    /// Find an asset by its instrument_key (e.g., "FX:EUR/USD", "EQUITY:AAPL@XNAS").
    /// Returns None if not found.
    fn find_by_instrument_key(&self, instrument_key: &str) -> Result<Option<Asset>>;

    /// Removes the $.legacy structure from asset metadata.
    /// Preserves $.identifiers if present.
    async fn cleanup_legacy_metadata(&self, asset_id: &str) -> Result<()>;

    /// Deactivates an asset (sets is_active=0).
    /// Used when merging UNKNOWN assets into resolved ones.
    async fn deactivate(&self, asset_id: &str) -> Result<()>;

    /// Reactivates an asset (sets is_active=1).
    /// Used when new activities reference a previously deactivated asset.
    async fn reactivate(&self, asset_id: &str) -> Result<()>;

    /// Reactivates multiple assets.
    async fn reactivate_batch(&self, asset_ids: &[String]) -> Result<()> {
        for asset_id in asset_ids {
            self.reactivate(asset_id).await?;
        }
        Ok(())
    }

    /// Copies user-editable fields from source asset to target asset.
    /// Used during UNKNOWN asset merge to preserve user customizations.
    async fn copy_user_metadata(&self, source_id: &str, target_id: &str) -> Result<()>;

    /// Finds INVESTMENT assets with no remaining activities and deactivates them.
    /// Returns the IDs of deactivated assets.
    async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{DatabaseError, Error};

    struct TestAssetService;

    #[async_trait::async_trait]
    impl AssetServiceTrait for TestAssetService {
        fn get_assets(&self) -> Result<Vec<Asset>> {
            Ok(Vec::new())
        }

        fn get_asset_by_id(&self, _asset_id: &str) -> Result<Asset> {
            Err(Error::Database(DatabaseError::NotFound(
                "Asset not found".to_string(),
            )))
        }

        async fn delete_asset(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn update_asset_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn create_asset(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!()
        }

        async fn get_or_create_minimal_asset(
            &self,
            _asset_id: &str,
            _context_currency: Option<String>,
            _metadata: Option<AssetMetadata>,
            _quote_mode: Option<String>,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!()
        }

        async fn get_assets_by_asset_ids(&self, _asset_ids: &[String]) -> Result<Vec<Asset>> {
            unimplemented!()
        }

        async fn enrich_asset_profile(&self, _asset_id: &str) -> Result<Asset> {
            unimplemented!()
        }

        async fn enrich_assets(&self, _asset_ids: Vec<String>) -> Result<(usize, usize, usize)> {
            unimplemented!()
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn merge_unknown_asset(
            &self,
            _resolved_asset_id: &str,
            _unknown_asset_id: &str,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<u32> {
            unimplemented!()
        }

        async fn ensure_assets(
            &self,
            _specs: Vec<AssetSpec>,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<EnsureAssetsResult> {
            unimplemented!()
        }

        async fn resolve_import_asset_inputs(
            &self,
            _inputs: Vec<AssetResolutionInput>,
        ) -> Result<Vec<AssetResolutionOutput>> {
            unimplemented!()
        }
    }

    #[test]
    fn validate_persisted_symbol_metadata_allows_manual_mode_without_quote_currency() {
        let service = TestAssetService;

        let result = service.validate_persisted_symbol_metadata(
            "NFLX",
            None,
            Some("XNAS"),
            Some(&InstrumentType::Equity),
            Some(QuoteMode::Manual),
            None,
        );

        assert!(result.is_ok());
    }

    #[test]
    fn validate_persisted_symbol_metadata_rejects_market_mode_without_quote_currency() {
        let service = TestAssetService;

        let result = service.validate_persisted_symbol_metadata(
            "NFLX",
            None,
            Some("XNAS"),
            Some(&InstrumentType::Equity),
            Some(QuoteMode::Market),
            None,
        );

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Quote currency is required"));
    }
}
