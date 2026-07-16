//! Classification completeness health check.
//!
//! Detects assets lacking taxonomy assignments (e.g., Asset Class)
//! and assets with legacy classification data needing migration.

use async_trait::async_trait;

use crate::assets::AssetServiceTrait;
use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, FixAction, HealthCategory, HealthDiagnostic,
    HealthEntityRef, HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};
use crate::taxonomies::TaxonomyServiceTrait;
use log::debug;

/// Data about an unclassified asset.
#[derive(Debug, Clone)]
pub struct UnclassifiedAssetInfo {
    /// Asset ID
    pub asset_id: String,
    /// Asset symbol for display
    pub symbol: String,
    /// Asset name (if available)
    pub name: Option<String>,
    /// Market value in base currency
    pub market_value: f64,
    /// Which taxonomy is missing (e.g., "asset_class")
    pub missing_taxonomy: String,
}

/// Info about an asset with legacy classification data.
#[derive(Debug, Clone)]
pub struct LegacyAssetInfo {
    /// Asset ID
    pub asset_id: String,
    /// Asset symbol for display
    pub symbol: String,
    /// Asset name (if available)
    pub name: Option<String>,
}

/// Data about assets with legacy classification data needing migration.
#[derive(Debug, Clone)]
pub struct LegacyMigrationInfo {
    /// Assets with legacy sector/country data needing migration
    pub assets_needing_migration: Vec<LegacyAssetInfo>,
    /// Number of assets already migrated
    pub assets_already_migrated: i32,
}

/// Gathers legacy migration status by checking assets for legacy classification data.
///
/// Returns information about assets that have legacy sector/country data that needs
/// to be migrated to the taxonomy system.
///
/// # Arguments
/// * `asset_service` - The asset service for loading assets
/// * `taxonomy_service` - The taxonomy service for checking assignments
pub fn gather_legacy_migration_status(
    asset_service: &dyn AssetServiceTrait,
    taxonomy_service: &dyn TaxonomyServiceTrait,
) -> Option<LegacyMigrationInfo> {
    use log::{error, info};

    // Get all assets
    let assets = match asset_service.get_assets() {
        Ok(assets) => {
            debug!(
                "gather_legacy_migration_status: loaded {} assets",
                assets.len()
            );
            assets
        }
        Err(e) => {
            error!(
                "gather_legacy_migration_status: failed to load assets: {}",
                e
            );
            return None;
        }
    };

    // Get GICS and Regions taxonomy info
    let gics_taxonomy = taxonomy_service
        .get_taxonomy("industries_gics")
        .ok()
        .flatten();

    let regions_taxonomy = taxonomy_service.get_taxonomy("regions").ok().flatten();

    let mut assets_needing_migration = Vec::new();
    let mut assets_already_migrated = 0;
    let mut assets_with_legacy_data = 0;

    for asset in &assets {
        // Check if asset has legacy sector/country data in metadata.legacy
        let legacy = asset.metadata.as_ref().and_then(|m| m.get("legacy"));

        let has_legacy_sectors = legacy
            .and_then(|l| l.get("sectors"))
            .map(|s| !s.is_null() && s.as_str().map(|str| !str.is_empty()).unwrap_or(true))
            .unwrap_or(false);

        let has_legacy_countries = legacy
            .and_then(|l| l.get("countries"))
            .map(|c| !c.is_null() && c.as_str().map(|str| !str.is_empty()).unwrap_or(true))
            .unwrap_or(false);

        if !has_legacy_sectors && !has_legacy_countries {
            continue;
        }

        assets_with_legacy_data += 1;

        // Check if asset has taxonomy assignments for GICS or regions
        let assignments = taxonomy_service
            .get_asset_assignments(&asset.id)
            .unwrap_or_default();

        let has_gics_assignment = gics_taxonomy
            .as_ref()
            .is_some_and(|t| assignments.iter().any(|a| a.taxonomy_id == t.taxonomy.id));

        let has_regions_assignment = regions_taxonomy
            .as_ref()
            .is_some_and(|t| assignments.iter().any(|a| a.taxonomy_id == t.taxonomy.id));

        // If has legacy data but no corresponding taxonomy assignments, needs migration
        if (has_legacy_sectors && !has_gics_assignment)
            || (has_legacy_countries && !has_regions_assignment)
        {
            assets_needing_migration.push(LegacyAssetInfo {
                asset_id: asset.id.clone(),
                symbol: asset.display_code.clone().unwrap_or_default(),
                name: asset.name.clone(),
            });
        } else if has_gics_assignment || has_regions_assignment {
            assets_already_migrated += 1;
        }
    }

    info!(
        "gather_legacy_migration_status: found {} assets with legacy data, {} needing migration, {} already migrated",
        assets_with_legacy_data,
        assets_needing_migration.len(),
        assets_already_migrated
    );

    Some(LegacyMigrationInfo {
        assets_needing_migration,
        assets_already_migrated,
    })
}

/// Gathers held assets that are missing an **asset class** taxonomy assignment.
///
/// Asset class is the core "category" surfaced by the Classification check and is
/// normally auto-assigned from an instrument's type, so a missing assignment is a
/// genuine gap rather than routine noise. Only currently-held assets (present in
/// `holding_mv_map`) are considered, and market value drives the finding severity.
///
/// GICS sector / region are intentionally not flagged here to avoid overwhelming
/// users who have not opted into those taxonomies.
pub fn gather_unclassified_assets(
    asset_service: &dyn AssetServiceTrait,
    taxonomy_service: &dyn TaxonomyServiceTrait,
    holding_mv_map: &std::collections::HashMap<String, f64>,
) -> Vec<UnclassifiedAssetInfo> {
    use log::warn;

    if holding_mv_map.is_empty() {
        return Vec::new();
    }

    let asset_classes = match taxonomy_service.get_taxonomy("asset_classes") {
        Ok(Some(taxonomy)) => taxonomy,
        Ok(None) => return Vec::new(),
        Err(error) => {
            warn!("gather_unclassified_assets: failed to load asset_classes taxonomy: {error}");
            return Vec::new();
        }
    };

    let assets = match asset_service.get_assets() {
        Ok(assets) => assets,
        Err(error) => {
            warn!("gather_unclassified_assets: failed to load assets: {error}");
            return Vec::new();
        }
    };

    let mut unclassified = Vec::new();
    for asset in &assets {
        let Some(&market_value) = holding_mv_map.get(&asset.id) else {
            continue;
        };

        let assignments = taxonomy_service
            .get_asset_assignments(&asset.id)
            .unwrap_or_default();
        let has_asset_class = assignments
            .iter()
            .any(|assignment| assignment.taxonomy_id == asset_classes.taxonomy.id);

        if !has_asset_class {
            unclassified.push(UnclassifiedAssetInfo {
                asset_id: asset.id.clone(),
                symbol: asset.display_code.clone().unwrap_or_default(),
                name: asset.name.clone(),
                market_value,
                missing_taxonomy: "asset_class".to_string(),
            });
        }
    }

    debug!(
        "gather_unclassified_assets: {} held assets missing an asset class",
        unclassified.len()
    );
    unclassified
}

/// Health check that detects missing asset classifications.
pub struct ClassificationCheck;

impl ClassificationCheck {
    /// Creates a new classification check.
    pub fn new() -> Self {
        Self
    }

    /// Analyzes assets for missing classifications.
    pub fn analyze(
        &self,
        unclassified: &[UnclassifiedAssetInfo],
        ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        let mut issues = Vec::new();

        if unclassified.is_empty() {
            return issues;
        }

        // Group by missing taxonomy type
        let mut by_taxonomy: std::collections::HashMap<String, Vec<&UnclassifiedAssetInfo>> =
            std::collections::HashMap::new();

        for asset in unclassified {
            by_taxonomy
                .entry(asset.missing_taxonomy.clone())
                .or_default()
                .push(asset);
        }

        // Emit issue for each taxonomy type
        for (taxonomy, assets) in by_taxonomy {
            let total_mv: f64 = assets.iter().map(|a| a.market_value).sum();
            let mv_pct = if ctx.total_portfolio_value > 0.0 {
                total_mv / ctx.total_portfolio_value
            } else {
                0.0
            };

            // Determine severity based on MV%
            // 5% → Error, 30% → Critical (per requirements)
            let severity = if mv_pct > ctx.config.mv_escalation_threshold {
                Severity::Critical
            } else if mv_pct > ctx.config.classification_warn_threshold {
                Severity::Error
            } else {
                Severity::Warning
            };

            let count = assets.len();
            let title = if count == 1 {
                "1 holding needs a category".to_string()
            } else {
                format!("{} holdings need categories", count)
            };

            let taxonomy_label = match taxonomy.as_str() {
                "asset_class" => "asset class",
                "sector" => "sector",
                "country" => "country",
                _ => "classification",
            };

            let message = format!(
                "Some holdings don't have an {} assigned. This affects your allocation charts and analytics.",
                taxonomy_label
            );

            let asset_ids: Vec<String> = assets.iter().map(|a| a.asset_id.clone()).collect();
            let data_hash = compute_data_hash(&asset_ids, severity, mv_pct);

            // Build affected items list for display
            let affected_items: Vec<AffectedItem> = assets
                .iter()
                .map(|a| AffectedItem::asset_with_name(&a.asset_id, &a.symbol, a.name.clone()))
                .collect();

            issues.push(
                HealthIssue::builder()
                    .id(format!("classification:{}:{}", taxonomy, data_hash))
                    .severity(severity)
                    .category(HealthCategory::Classification)
                    .code("classification_missing_category")
                    .param("count", count as u32)
                    .param("taxonomy", taxonomy_label)
                    .title(title)
                    .message(message)
                    .affected_count(count as u32)
                    .affected_mv_pct(mv_pct)
                    .affected_items(affected_items)
                    .navigate_action(NavigateAction::to_holdings(Some("unclassified")))
                    .diagnostics(vec![classification_diagnostic(
                        &taxonomy,
                        taxonomy_label,
                        &assets,
                    )])
                    .data_hash(data_hash)
                    .build(),
            );
        }

        issues
    }

    /// Analyzes legacy migration status and creates issue if migration is needed.
    pub fn analyze_legacy_migration(
        &self,
        migration_info: &Option<LegacyMigrationInfo>,
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        let mut issues = Vec::new();

        let info = match migration_info {
            Some(info) if !info.assets_needing_migration.is_empty() => info,
            _ => return issues,
        };

        let count = info.assets_needing_migration.len() as u32;
        let title = if count == 1 {
            "1 asset has legacy classification data".to_string()
        } else {
            format!("{} assets have legacy classification data", count)
        };

        let message = "Some assets have sector/country data from the old format. \
            Migrate to the new taxonomy system for better allocation tracking."
            .to_string();

        let data_hash = compute_legacy_migration_hash(info);

        // Build affected items list
        let affected_items: Vec<AffectedItem> = info
            .assets_needing_migration
            .iter()
            .map(|a| AffectedItem::asset_with_name(&a.asset_id, &a.symbol, a.name.clone()))
            .collect();

        issues.push(
            HealthIssue::builder()
                .id(format!("classification:legacy_migration:{}", data_hash))
                .severity(Severity::Warning)
                .category(HealthCategory::Classification)
                .code("classification_legacy_migration")
                .param("count", count)
                .title(title)
                .message(message)
                .affected_count(count)
                .affected_items(affected_items)
                .fix_action(FixAction::migrate_legacy_classifications())
                .navigate_action(NavigateAction::to_taxonomies())
                .diagnostics(vec![legacy_classification_diagnostic(info)])
                .data_hash(data_hash)
                .build(),
        );

        issues
    }
}

fn classification_diagnostic(
    taxonomy: &str,
    taxonomy_label: &str,
    assets: &[&UnclassifiedAssetInfo],
) -> HealthDiagnostic {
    let mut diagnostic = HealthDiagnostic::new(
        format!("MISSING_{}", taxonomy.to_ascii_uppercase()),
        format!("Missing {taxonomy_label}"),
        format!(
            "These holdings do not have an {taxonomy_label} assigned, so allocation charts and analytics are incomplete."
        ),
    )
    .domain(DiagnosticDomain::Classification)
    .navigate(true, NavigateAction::to_holdings(Some("unclassified")));

    for asset in assets {
        let route = format!("/holdings/{}", urlencoding::encode(&asset.asset_id));
        let label = asset
            .name
            .as_ref()
            .map(|name| format!("{} — {name}", asset.symbol))
            .unwrap_or_else(|| asset.symbol.clone());
        diagnostic = diagnostic
            .entity(
                HealthEntityRef::new("asset", asset.asset_id.clone())
                    .label(label.clone())
                    .route(route.clone()),
            )
            .evidence(Evidence::new("Holding", label).with_route(route));
    }

    diagnostic
}

fn legacy_classification_diagnostic(info: &LegacyMigrationInfo) -> HealthDiagnostic {
    let mut diagnostic = HealthDiagnostic::new(
        "LEGACY_CLASSIFICATION_MIGRATION",
        "Legacy classification data",
        "These assets still use the previous sector/country fields. Migrate them to the taxonomy system to keep allocation reporting consistent.",
    )
    .domain(DiagnosticDomain::Classification)
    .fix(true, FixAction::migrate_legacy_classifications())
    .navigate(false, NavigateAction::to_taxonomies());

    for asset in &info.assets_needing_migration {
        let route = format!("/holdings/{}", urlencoding::encode(&asset.asset_id));
        let label = asset
            .name
            .as_ref()
            .map(|name| format!("{} — {name}", asset.symbol))
            .unwrap_or_else(|| asset.symbol.clone());
        diagnostic = diagnostic
            .entity(
                HealthEntityRef::new("asset", asset.asset_id.clone())
                    .label(label.clone())
                    .route(route.clone()),
            )
            .evidence(Evidence::new("Asset", label).with_route(route));
    }

    diagnostic
}

impl Default for ClassificationCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for ClassificationCheck {
    fn id(&self) -> &'static str {
        "classification"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::Classification
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        // The service will call analyze() directly with classification data
        Ok(Vec::new())
    }
}

/// Computes a data hash for issue identity and change detection.
fn compute_data_hash(asset_ids: &[String], severity: Severity, mv_pct: f64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    let mut sorted_ids = asset_ids.to_vec();
    sorted_ids.sort();
    for id in &sorted_ids {
        id.hash(&mut hasher);
    }
    severity.as_str().hash(&mut hasher);
    ((mv_pct * 100.0) as u32).hash(&mut hasher);

    format!("{:x}", hasher.finish())
}

/// Computes a data hash for legacy migration issue.
fn compute_legacy_migration_hash(info: &LegacyMigrationInfo) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    // Hash asset IDs for change detection
    let mut asset_ids: Vec<&str> = info
        .assets_needing_migration
        .iter()
        .map(|a| a.asset_id.as_str())
        .collect();
    asset_ids.sort();
    for id in &asset_ids {
        id.hash(&mut hasher);
    }
    info.assets_already_migrated.hash(&mut hasher);

    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::model::HealthConfig;

    #[test]
    fn test_unclassified_warning() {
        let check = ClassificationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let unclassified = vec![UnclassifiedAssetInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            name: Some("Apple Inc.".to_string()),
            market_value: 1_000.0, // 1% of portfolio
            missing_taxonomy: "asset_class".to_string(),
        }];

        let issues = check.analyze(&unclassified, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn test_unclassified_error_threshold() {
        let check = ClassificationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let unclassified = vec![UnclassifiedAssetInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            name: None,
            market_value: 10_000.0, // 10% of portfolio (> 5% threshold)
            missing_taxonomy: "asset_class".to_string(),
        }];

        let issues = check.analyze(&unclassified, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Error);
    }

    #[test]
    fn test_unclassified_critical_threshold() {
        let check = ClassificationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let unclassified = vec![UnclassifiedAssetInfo {
            asset_id: "SEC:AAPL:XNAS".to_string(),
            symbol: "AAPL".to_string(),
            name: None,
            market_value: 35_000.0, // 35% of portfolio (> 30% threshold)
            missing_taxonomy: "asset_class".to_string(),
        }];

        let issues = check.analyze(&unclassified, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Critical);
    }

    #[test]
    fn test_no_unclassified() {
        let check = ClassificationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], &ctx);
        assert!(issues.is_empty());
    }
}
