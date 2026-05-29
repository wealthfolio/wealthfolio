//! Service for computing portfolio allocations by taxonomy.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::errors::Result;
use crate::portfolio::holdings::{Holding, HoldingSummary, HoldingType, HoldingsServiceTrait};
use crate::taxonomies::{Category, TaxonomyServiceTrait};

use super::{AllocationHoldings, CategoryAllocation, PortfolioAllocations, TaxonomyAllocation};

/// Trait for allocation service.
#[async_trait]
pub trait AllocationServiceTrait: Send + Sync {
    /// Computes portfolio allocations for a real account.
    async fn get_portfolio_allocations(
        &self,
        account_id: &str,
        base_currency: &str,
    ) -> Result<PortfolioAllocations>;

    /// Computes portfolio allocations aggregated across multiple accounts (portfolio filter).
    async fn get_portfolio_allocations_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<PortfolioAllocations>;

    /// Returns holdings filtered by a taxonomy category with full category metadata.
    /// Used for drill-down views when user clicks on an allocation category.
    async fn get_holdings_by_allocation(
        &self,
        account_id: &str,
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<AllocationHoldings>;

    /// Returns holdings by allocation aggregated across multiple accounts.
    async fn get_holdings_by_allocation_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
        aggregated_account_id: &str,
    ) -> Result<AllocationHoldings>;
}

/// Service for computing taxonomy-based portfolio allocations.
pub struct AllocationService {
    holdings_service: Arc<dyn HoldingsServiceTrait>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
}

impl AllocationService {
    pub fn new(
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Self {
        Self {
            holdings_service,
            taxonomy_service,
        }
    }

    /// Aggregates holdings into a taxonomy allocation.
    /// For hierarchical taxonomies (GICS, Regions), rolls up to top-level categories
    /// and populates children for drill-down.
    #[allow(clippy::too_many_arguments)]
    fn aggregate_by_taxonomy(
        &self,
        holdings: &[Holding],
        taxonomy_id: &str,
        taxonomy_name: &str,
        taxonomy_color: &str,
        categories: &[Category],
        assignments_by_asset: &HashMap<String, Vec<(String, String, i32)>>, // asset_id -> [(taxonomy_id, category_id, weight)]
        total_value: Decimal,
        rollup_to_top_level: bool,
    ) -> TaxonomyAllocation {
        // Build category lookup maps
        let category_by_id: HashMap<&str, &Category> =
            categories.iter().map(|c| (c.id.as_str(), c)).collect();

        // For rollup: map child categories to their top-level ancestor
        let top_level_map: HashMap<&str, &str> = if rollup_to_top_level {
            self.build_top_level_map(categories)
        } else {
            // Identity map - each category maps to itself
            categories
                .iter()
                .map(|c| (c.id.as_str(), c.id.as_str()))
                .collect()
        };

        // Aggregate values by category (original assignments, not rolled up)
        // Key: original category_id, Value: (value, top_level_id)
        let mut original_values: HashMap<String, (Decimal, String)> = HashMap::new();
        // Aggregate values by top-level category (rolled up)
        let mut rolled_up_values: HashMap<String, Decimal> = HashMap::new();

        for holding in holdings {
            // Skip cash holdings for sector/region allocation (not for asset_classes)
            // Cash has asset_class classifications but not sector/region classifications
            if holding.holding_type == HoldingType::Cash && taxonomy_id != "asset_classes" {
                continue;
            }

            let asset_id = match &holding.instrument {
                Some(instrument) => &instrument.id,
                None => continue,
            };

            let market_value = holding.market_value.base;

            // Cash holdings have synthetic IDs (no DB record / no taxonomy assignments).
            // Assign them directly to CASH_BANK_DEPOSITS for the asset_classes taxonomy.
            if holding.holding_type == HoldingType::Cash && taxonomy_id == "asset_classes" {
                let cash_category = "CASH_BANK_DEPOSITS";
                let top_level_id = if rollup_to_top_level {
                    top_level_map
                        .get(cash_category)
                        .copied()
                        .unwrap_or(cash_category)
                } else {
                    cash_category
                };

                let entry = original_values
                    .entry(cash_category.to_string())
                    .or_insert((Decimal::ZERO, top_level_id.to_string()));
                entry.0 += market_value;

                *rolled_up_values
                    .entry(top_level_id.to_string())
                    .or_insert(Decimal::ZERO) += market_value;
                continue;
            }

            // Get assignments for this asset and taxonomy
            if let Some(asset_assignments) = assignments_by_asset.get(asset_id) {
                let taxonomy_assignments: Vec<_> = asset_assignments
                    .iter()
                    .filter(|(tid, _, _)| tid == taxonomy_id)
                    .collect();

                if taxonomy_assignments.is_empty() {
                    // No assignment for this taxonomy - count as "Unknown"
                    *rolled_up_values
                        .entry("__UNKNOWN__".to_string())
                        .or_insert(Decimal::ZERO) += market_value;
                } else {
                    // In rollup mode: skip top-level category assignments when a child of
                    // that category is also assigned for this asset (leaf-wins principle).
                    // Without this guard, Americas + United States both roll up to Americas
                    // and double-count the US portion.
                    let top_levels_covered_by_children: std::collections::HashSet<&str> =
                        if rollup_to_top_level {
                            taxonomy_assignments
                                .iter()
                                .filter_map(|(_, cat_id, _)| {
                                    let top = *top_level_map.get(cat_id.as_str())?;
                                    if top != cat_id.as_str() {
                                        Some(top)
                                    } else {
                                        None
                                    }
                                })
                                .collect()
                        } else {
                            std::collections::HashSet::new()
                        };

                    // Build active assignment set after applying leaf-wins filter, then
                    // normalize over only those active assignments. Computing total_weight
                    // before filtering would dilute kept leaf weights by skipped parents.
                    let active_assignments: Vec<_> = taxonomy_assignments
                        .iter()
                        .filter(|(_, category_id, _)| {
                            if !rollup_to_top_level {
                                return true;
                            }
                            let top = top_level_map
                                .get(category_id.as_str())
                                .copied()
                                .unwrap_or(category_id.as_str());
                            !(top == category_id.as_str()
                                && top_levels_covered_by_children.contains(top))
                        })
                        .collect();

                    let total_active_weight: i32 =
                        active_assignments.iter().map(|(_, _, w)| *w).sum();
                    let weight_divisor = Decimal::from(total_active_weight.max(10000));

                    for (_, category_id, weight) in active_assignments.iter() {
                        let top_level_id = if rollup_to_top_level {
                            top_level_map
                                .get(category_id.as_str())
                                .copied()
                                .unwrap_or(category_id.as_str())
                        } else {
                            category_id.as_str()
                        };

                        let weight_decimal = Decimal::from(*weight) / weight_divisor;
                        let weighted_value = market_value * weight_decimal;

                        // Track original category values (for children)
                        let entry = original_values
                            .entry(category_id.clone())
                            .or_insert((Decimal::ZERO, top_level_id.to_string()));
                        entry.0 += weighted_value;

                        // Track rolled-up values
                        *rolled_up_values
                            .entry(top_level_id.to_string())
                            .or_insert(Decimal::ZERO) += weighted_value;
                    }
                }
            } else {
                // No assignments at all - count as "Unknown"
                *rolled_up_values
                    .entry("__UNKNOWN__".to_string())
                    .or_insert(Decimal::ZERO) += market_value;
            }
        }

        // Build children map: top_level_id -> Vec<CategoryAllocation>
        let mut children_map: HashMap<String, Vec<CategoryAllocation>> = HashMap::new();
        if rollup_to_top_level {
            for (cat_id, (value, top_level_id)) in &original_values {
                // Only add as child if different from top-level (i.e., it was rolled up)
                if cat_id != top_level_id && *value > Decimal::ZERO {
                    let (name, color) = category_by_id
                        .get(cat_id.as_str())
                        .map(|c| (c.name.clone(), c.color.clone()))
                        .unwrap_or_else(|| (cat_id.clone(), "#808080".to_string()));

                    let percentage = if total_value > Decimal::ZERO {
                        (*value / total_value * dec!(100)).round_dp(2)
                    } else {
                        Decimal::ZERO
                    };

                    children_map.entry(top_level_id.clone()).or_default().push(
                        CategoryAllocation {
                            category_id: cat_id.clone(),
                            category_name: name,
                            color,
                            value: *value,
                            percentage,
                            children: Vec::new(),
                        },
                    );
                }
            }
            // Sort children by value descending
            for children in children_map.values_mut() {
                children.sort_by_key(|b| std::cmp::Reverse(b.value));
            }
        }

        // Build top-level category allocations
        let mut allocations: Vec<CategoryAllocation> = rolled_up_values
            .into_iter()
            .filter(|(_, value)| *value > Decimal::ZERO)
            .map(|(cat_id, value)| {
                let (name, color) = if cat_id == "__UNKNOWN__" {
                    ("Unknown".to_string(), "#878580".to_string())
                } else {
                    category_by_id
                        .get(cat_id.as_str())
                        .map(|c| (c.name.clone(), c.color.clone()))
                        .unwrap_or_else(|| (cat_id.clone(), "#808080".to_string()))
                };

                let percentage = if total_value > Decimal::ZERO {
                    (value / total_value * dec!(100)).round_dp(2)
                } else {
                    Decimal::ZERO
                };

                let children = children_map.remove(&cat_id).unwrap_or_default();

                CategoryAllocation {
                    category_id: cat_id,
                    category_name: name,
                    color,
                    value,
                    percentage,
                    children,
                }
            })
            .collect();

        // Sort by value descending
        allocations.sort_by_key(|b| std::cmp::Reverse(b.value));

        TaxonomyAllocation {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name: taxonomy_name.to_string(),
            color: taxonomy_color.to_string(),
            categories: allocations,
        }
    }

    /// Builds a map from each category to its top-level ancestor.
    /// Top-level categories are those with parent_id = None.
    fn build_top_level_map<'a>(&self, categories: &'a [Category]) -> HashMap<&'a str, &'a str> {
        let mut result: HashMap<&str, &str> = HashMap::new();

        // Build parent lookup
        let parent_map: HashMap<&str, Option<&str>> = categories
            .iter()
            .map(|c| (c.id.as_str(), c.parent_id.as_deref()))
            .collect();

        for category in categories {
            let top_level = self.find_top_level_ancestor(&category.id, &parent_map);
            result.insert(category.id.as_str(), top_level);
        }

        result
    }

    /// Recursively finds the top-level ancestor of a category.
    #[allow(clippy::only_used_in_recursion)]
    fn find_top_level_ancestor<'a>(
        &self,
        category_id: &'a str,
        parent_map: &HashMap<&str, Option<&'a str>>,
    ) -> &'a str {
        match parent_map.get(category_id) {
            Some(Some(parent_id)) => self.find_top_level_ancestor(parent_id, parent_map),
            _ => category_id, // No parent - this is the top level
        }
    }

    async fn compute_allocations_from_holdings(
        &self,
        holdings: &[Holding],
        _base_currency: &str,
    ) -> Result<PortfolioAllocations> {
        if holdings.is_empty() {
            return Ok(PortfolioAllocations::default());
        }

        // 2. Compute total portfolio value (excluding cash for some allocations)
        let total_value: Decimal = holdings
            .iter()
            .filter(|h| h.holding_type != HoldingType::Cash)
            .map(|h| h.market_value.base)
            .sum();

        let total_with_cash: Decimal = holdings.iter().map(|h| h.market_value.base).sum();

        // 3. Get all taxonomies with categories
        let taxonomies = self.taxonomy_service.get_taxonomies_with_categories()?;

        // 4. Collect all asset IDs from holdings
        let asset_ids: Vec<String> = holdings
            .iter()
            .filter_map(|h| h.instrument.as_ref().map(|i| i.id.clone()))
            .collect();

        // 5. Get all assignments for these assets
        let mut assignments_by_asset: HashMap<String, Vec<(String, String, i32)>> = HashMap::new();

        for asset_id in &asset_ids {
            let assignments = self.taxonomy_service.get_asset_assignments(asset_id)?;
            let entries: Vec<(String, String, i32)> = assignments
                .into_iter()
                .map(|a| (a.taxonomy_id, a.category_id, a.weight))
                .collect();
            if !entries.is_empty() {
                assignments_by_asset.insert(asset_id.clone(), entries);
            }
        }

        // 6. Find each taxonomy and its categories
        let mut asset_classes_alloc =
            TaxonomyAllocation::empty("asset_classes", "Asset Classes", "#879a39");
        let mut sectors_alloc = TaxonomyAllocation::empty("industries_gics", "Sectors", "#da702c");
        let mut regions_alloc = TaxonomyAllocation::empty("regions", "Regions", "#8b7ec8");
        let mut risk_alloc = TaxonomyAllocation::empty("risk_category", "Risk Category", "#d14d41");
        let mut security_types_alloc =
            TaxonomyAllocation::empty("instrument_type", "Instrument Type", "#4385be");
        let mut custom_allocs: Vec<TaxonomyAllocation> = Vec::new();

        for twc in taxonomies {
            let taxonomy = &twc.taxonomy;
            let categories = &twc.categories;

            match taxonomy.id.as_str() {
                "asset_classes" => {
                    // Asset classes include cash, use total_with_cash
                    // Cash holdings now have proper instruments with classifications
                    asset_classes_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        &taxonomy.name,
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_with_cash,
                        true, // Roll up to top-level asset classes
                    );
                }
                "industries_gics" => {
                    sectors_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        "Sectors", // Use friendly name
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        true, // Roll up to top-level GICS sectors
                    );
                }
                "regions" => {
                    regions_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        "Regions",
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        true, // Roll up to top-level regions
                    );
                }
                "risk_category" => {
                    risk_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        "Risk Category",
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        false, // No rollup for risk
                    );
                }
                "instrument_type" => {
                    security_types_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        "Instrument Type",
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        true, // Roll up to top-level instrument types
                    );
                }
                _ if !taxonomy.is_system => {
                    // User-created custom taxonomies only (skip system placeholder "custom_groups")
                    let custom_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        &taxonomy.name,
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        false,
                    );
                    // Only include if there are real categories (not just Unknown)
                    if !custom_alloc.categories.is_empty() {
                        custom_allocs.push(custom_alloc);
                    }
                }
                _ => {}
            }
        }

        Ok(PortfolioAllocations {
            asset_classes: asset_classes_alloc,
            sectors: sectors_alloc,
            regions: regions_alloc,
            risk_category: risk_alloc,
            security_types: security_types_alloc,
            custom_groups: custom_allocs,
            total_value: total_with_cash,
        })
    }

    async fn compute_holdings_by_allocation_from_holdings(
        &self,
        holdings: &[Holding],
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<AllocationHoldings> {
        // Get taxonomy with categories for hierarchy lookup and metadata
        let taxonomy_with_cats = self.taxonomy_service.get_taxonomy(taxonomy_id)?;
        let empty_categories: Vec<Category> = Vec::new();

        let (taxonomy_name, taxonomy_color, categories) = match &taxonomy_with_cats {
            Some(twc) => (
                twc.taxonomy.name.clone(),
                twc.taxonomy.color.clone(),
                &twc.categories,
            ),
            None => (
                "Unknown".to_string(),
                "#808080".to_string(),
                &empty_categories,
            ),
        };

        let (category_name, category_color) = if category_id == "__UNKNOWN__" {
            ("Unknown".to_string(), "#878580".to_string())
        } else {
            categories
                .iter()
                .find(|c| c.id == category_id)
                .map(|c| (c.name.clone(), c.color.clone()))
                .unwrap_or_else(|| (category_id.to_string(), taxonomy_color.clone()))
        };

        if holdings.is_empty() {
            return Ok(AllocationHoldings {
                taxonomy_id: taxonomy_id.to_string(),
                taxonomy_name,
                category_id: category_id.to_string(),
                category_name,
                color: category_color,
                holdings: Vec::new(),
                total_value: Decimal::ZERO,
                currency: base_currency.to_string(),
            });
        }

        // Build map from category to top-level ancestor
        let top_level_map: HashMap<&str, &str> = self.build_top_level_map(categories);

        // Get all assignments for this category (including child categories)
        // First, find all category IDs that roll up to the target category
        let matching_category_ids: Vec<&str> = if category_id == "__UNKNOWN__" {
            vec!["__UNKNOWN__"]
        } else {
            categories
                .iter()
                .filter(|c| {
                    // Include this category if it equals or rolls up to the target
                    c.id == category_id
                        || top_level_map.get(c.id.as_str()).copied() == Some(category_id)
                })
                .map(|c| c.id.as_str())
                .collect()
        };

        // Get assignments for all matching categories, applying leaf-wins to avoid
        // double-counting when both a parent and its child are assigned to the same asset.
        // Separate direct (target category itself) from child category assignments.
        // If an asset has child-level assignments, use those; otherwise fall back to direct.
        let mut direct_weight: HashMap<String, i32> = HashMap::new();
        let mut child_weight: HashMap<String, i32> = HashMap::new();
        for cat_id in &matching_category_ids {
            if *cat_id == "__UNKNOWN__" {
                continue;
            }
            let is_direct = *cat_id == category_id;
            if let Ok(assignments) = self
                .taxonomy_service
                .get_category_assignments(taxonomy_id, cat_id)
            {
                for assignment in assignments {
                    if is_direct {
                        *direct_weight
                            .entry(assignment.asset_id.clone())
                            .or_insert(0) += assignment.weight;
                    } else {
                        *child_weight.entry(assignment.asset_id.clone()).or_insert(0) +=
                            assignment.weight;
                    }
                }
            }
        }
        // Leaf-wins: prefer child weights; fall back to direct only when no child exists.
        // Also normalize each asset's weight to at most 10000 bps (100%).
        let mut asset_to_weight: HashMap<String, i32> = child_weight;
        for (asset_id, weight) in direct_weight {
            asset_to_weight.entry(asset_id).or_insert(weight);
        }
        for weight in asset_to_weight.values_mut() {
            *weight = (*weight).min(10000);
        }

        // Calculate total value of matched holdings for weight calculation
        let mut matched_holdings: Vec<(&Holding, i32)> = Vec::new();

        for holding in holdings {
            let asset_id = match &holding.instrument {
                Some(instrument) => &instrument.id,
                None => continue,
            };

            // Cash holdings: match if drilling into CASH or CASH_BANK_DEPOSITS
            if holding.holding_type == HoldingType::Cash
                && taxonomy_id == "asset_classes"
                && matching_category_ids
                    .iter()
                    .any(|id| *id == "CASH" || *id == "CASH_BANK_DEPOSITS")
            {
                matched_holdings.push((holding, 10000)); // 100% weight
                continue;
            }

            // Check if this holding matches the category
            if category_id == "__UNKNOWN__" {
                // For "Unknown", include holdings with no assignment for this taxonomy
                let has_assignment = self
                    .taxonomy_service
                    .get_asset_assignments(asset_id)
                    .map(|assignments| assignments.iter().any(|a| a.taxonomy_id == taxonomy_id))
                    .unwrap_or(false);

                if !has_assignment {
                    matched_holdings.push((holding, 10000)); // 100% weight
                }
            } else if let Some(&weight) = asset_to_weight.get(asset_id) {
                matched_holdings.push((holding, weight));
            }
        }

        // Calculate total matched value for weight calculation
        let total_matched_value: Decimal = matched_holdings
            .iter()
            .map(|(h, weight)| {
                let weight_decimal = Decimal::from(*weight) / dec!(10000);
                h.market_value.base * weight_decimal
            })
            .sum();

        // Build summaries
        let mut summaries: Vec<HoldingSummary> = matched_holdings
            .into_iter()
            .map(|(holding, weight)| {
                let weight_decimal = Decimal::from(weight) / dec!(10000);
                let weighted_value = holding.market_value.base * weight_decimal;
                let weight_in_category = if total_matched_value > Decimal::ZERO {
                    (weighted_value / total_matched_value * dec!(100)).round_dp(2)
                } else {
                    Decimal::ZERO
                };

                HoldingSummary {
                    // Use instrument.id (the asset ID) for navigation, not holding.id (composite ID)
                    id: holding
                        .instrument
                        .as_ref()
                        .map(|i| i.id.clone())
                        .unwrap_or_else(|| holding.id.clone()),
                    symbol: holding
                        .instrument
                        .as_ref()
                        .map(|i| i.symbol.clone())
                        .unwrap_or_default(),
                    name: holding.instrument.as_ref().and_then(|i| i.name.clone()),
                    holding_type: holding.holding_type.clone(),
                    quantity: holding.quantity,
                    market_value: weighted_value,
                    currency: holding.base_currency.clone(),
                    weight_in_category,
                }
            })
            .collect();

        // Sort by market value descending
        summaries.sort_by_key(|b| std::cmp::Reverse(b.market_value));

        Ok(AllocationHoldings {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name,
            category_id: category_id.to_string(),
            category_name,
            color: category_color,
            holdings: summaries,
            total_value: total_matched_value,
            currency: base_currency.to_string(),
        })
    }
}

#[async_trait]
impl AllocationServiceTrait for AllocationService {
    async fn get_portfolio_allocations(
        &self,
        account_id: &str,
        base_currency: &str,
    ) -> Result<PortfolioAllocations> {
        let holdings = self
            .holdings_service
            .get_holdings(account_id, base_currency)
            .await?;
        self.compute_allocations_from_holdings(&holdings, base_currency)
            .await
    }

    async fn get_portfolio_allocations_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<PortfolioAllocations> {
        let holdings = self
            .holdings_service
            .get_holdings_for_accounts(account_ids, base_currency, aggregated_account_id)
            .await?;
        self.compute_allocations_from_holdings(&holdings, base_currency)
            .await
    }

    async fn get_holdings_by_allocation(
        &self,
        account_id: &str,
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<AllocationHoldings> {
        let holdings = self
            .holdings_service
            .get_holdings(account_id, base_currency)
            .await?;
        self.compute_holdings_by_allocation_from_holdings(
            &holdings,
            base_currency,
            taxonomy_id,
            category_id,
        )
        .await
    }

    async fn get_holdings_by_allocation_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
        aggregated_account_id: &str,
    ) -> Result<AllocationHoldings> {
        let holdings = self
            .holdings_service
            .get_holdings_for_accounts(account_ids, base_currency, aggregated_account_id)
            .await?;
        self.compute_holdings_by_allocation_from_holdings(
            &holdings,
            base_currency,
            taxonomy_id,
            category_id,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::holdings::holdings_model::{Instrument, MonetaryValue};
    use crate::taxonomies::{
        AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
        Taxonomy, TaxonomyWithCategories,
    };
    use async_trait::async_trait;
    use chrono::{NaiveDateTime, Utc};
    use rust_decimal_macros::dec;

    // Minimal mocks — aggregate_by_taxonomy is pure data, does not call these
    struct NoopHoldings;
    struct NoopTaxonomies;

    #[async_trait]
    impl HoldingsServiceTrait for NoopHoldings {
        async fn get_holdings(&self, _: &str, _: &str) -> Result<Vec<Holding>> {
            unimplemented!()
        }
        async fn get_holdings_for_accounts(
            &self,
            _: &[String],
            _: &str,
            _: &str,
        ) -> Result<Vec<Holding>> {
            unimplemented!()
        }
        async fn get_holding(&self, _: &str, _: &str, _: &str) -> Result<Option<Holding>> {
            unimplemented!()
        }
        async fn holdings_from_snapshot(
            &self,
            _: &crate::portfolio::snapshot::AccountStateSnapshot,
            _: &str,
        ) -> Result<Vec<Holding>> {
            unimplemented!()
        }
    }

    #[async_trait]
    impl TaxonomyServiceTrait for NoopTaxonomies {
        fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
            unimplemented!()
        }
        fn get_taxonomy(&self, _: &str) -> Result<Option<TaxonomyWithCategories>> {
            unimplemented!()
        }
        fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
            unimplemented!()
        }
        async fn create_taxonomy(&self, _: NewTaxonomy) -> Result<Taxonomy> {
            unimplemented!()
        }
        async fn update_taxonomy(&self, _: Taxonomy) -> Result<Taxonomy> {
            unimplemented!()
        }
        async fn delete_taxonomy(&self, _: &str) -> Result<usize> {
            unimplemented!()
        }
        async fn create_category(&self, _: NewCategory) -> Result<Category> {
            unimplemented!()
        }
        async fn update_category(&self, _: Category) -> Result<Category> {
            unimplemented!()
        }
        async fn delete_category(&self, _: &str, _: &str) -> Result<usize> {
            unimplemented!()
        }
        async fn move_category(
            &self,
            _: &str,
            _: &str,
            _: Option<String>,
            _: i32,
        ) -> Result<Category> {
            unimplemented!()
        }
        async fn import_taxonomy_json(&self, _: &str) -> Result<Taxonomy> {
            unimplemented!()
        }
        fn export_taxonomy_json(&self, _: &str) -> Result<String> {
            unimplemented!()
        }
        fn get_asset_assignments(&self, _: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        fn get_category_assignments(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn assign_asset_to_category(
            &self,
            _: NewAssetTaxonomyAssignment,
        ) -> Result<AssetTaxonomyAssignment> {
            unimplemented!()
        }
        async fn remove_asset_assignment(&self, _: &str) -> Result<usize> {
            unimplemented!()
        }
    }

    fn svc() -> AllocationService {
        AllocationService::new(Arc::new(NoopHoldings), Arc::new(NoopTaxonomies))
    }

    fn now() -> NaiveDateTime {
        Utc::now().naive_utc()
    }

    fn make_category(id: &str, parent_id: Option<&str>) -> Category {
        Category {
            id: id.to_string(),
            taxonomy_id: "regions".to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            name: id.to_string(),
            key: id.to_string(),
            color: "#808080".to_string(),
            description: None,
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
            icon: None,
        }
    }

    fn make_holding(asset_id: &str, base_value: Decimal) -> Holding {
        Holding {
            id: asset_id.to_string(),
            account_id: "acc".to_string(),
            holding_type: HoldingType::Security,
            instrument: Some(Instrument {
                id: asset_id.to_string(),
                symbol: asset_id.to_string(),
                name: None,
                currency: "USD".to_string(),
                notes: None,
                pricing_mode: "MARKET".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            }),
            asset_kind: None,
            quantity: dec!(1),
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: base_value,
                base: base_value,
            },
            cost_basis: None,
            price: None,
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            metadata: None,
            source_account_ids: vec![],
        }
    }

    /// Weights summing above 100% must not cause any category percentage to exceed
    /// the portfolio total. With AAPL assigned 60% North_America + 60% Europe (120% total),
    /// the normalized sum across all regions must equal 100%.
    #[test]
    fn weights_above_100_pct_are_normalized() {
        let svc = svc();
        let holdings = vec![make_holding("AAPL", dec!(1000))];

        // North_America and Europe are both top-level (no parent)
        let categories = vec![
            make_category("North_America", None),
            make_category("Europe", None),
        ];

        // 60% + 60% = 120% (invalid, should be normalized to 50% + 50%)
        let mut assignments: HashMap<String, Vec<(String, String, i32)>> = HashMap::new();
        assignments.insert(
            "AAPL".to_string(),
            vec![
                ("regions".to_string(), "North_America".to_string(), 6000),
                ("regions".to_string(), "Europe".to_string(), 6000),
            ],
        );

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "regions",
            "Regions",
            "#ccc",
            &categories,
            &assignments,
            dec!(1000),
            false,
        );

        let total_pct: Decimal = result.categories.iter().map(|c| c.percentage).sum();
        assert!(
            total_pct <= dec!(100.01),
            "Total percentage {total_pct} exceeds 100% — normalization failed"
        );
    }

    /// When an asset is assigned to both a parent region (Americas) and a child (United_States),
    /// rolling up to the top level must not double-count: United_States rolls up to Americas,
    /// so the direct Americas assignment should be skipped (leaf-wins).
    #[test]
    fn parent_child_region_not_double_counted_on_rollup() {
        let svc = svc();
        let holdings = vec![make_holding("AAPL", dec!(1000))];

        // Americas is top-level; United_States is its child
        let categories = vec![
            make_category("Americas", None),
            make_category("United_States", Some("Americas")),
        ];

        // 60% Americas (parent) + 40% United_States (child of Americas)
        // Leaf-wins: Americas direct assignment should be skipped, only US rolls up
        let mut assignments: HashMap<String, Vec<(String, String, i32)>> = HashMap::new();
        assignments.insert(
            "AAPL".to_string(),
            vec![
                ("regions".to_string(), "Americas".to_string(), 6000),
                ("regions".to_string(), "United_States".to_string(), 4000),
            ],
        );

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "regions",
            "Regions",
            "#ccc",
            &categories,
            &assignments,
            dec!(1000),
            true, // rollup_to_top_level
        );

        let americas = result
            .categories
            .iter()
            .find(|c| c.category_id == "Americas")
            .expect("Americas category missing");

        // Only the United_States leaf (40%) should count — not Americas direct (60%) + US (40%)
        assert!(
            americas.value <= dec!(1000),
            "Americas value {} exceeds total holding value — parent/child double-counted",
            americas.value
        );
        assert_eq!(
            americas.value,
            dec!(400),
            "Expected Americas = 400 (leaf US only), got {}",
            americas.value
        );
    }
}
