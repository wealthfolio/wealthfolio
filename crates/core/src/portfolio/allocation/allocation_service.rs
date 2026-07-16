//! Service for computing portfolio allocations by taxonomy.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

use crate::accounts::AccountServiceTrait;
use crate::errors::Result;
use crate::portfolio::holdings::{Holding, HoldingSummary, HoldingType, HoldingsServiceTrait};
use crate::taxonomies::{AssetTaxonomyAssignment, Category, TaxonomyServiceTrait};

use super::{
    AllocationHoldings, CategoryAllocation, HoldingAllocationContribution, PortfolioAllocations,
    TaxonomyAllocation, TaxonomyHoldingContributions,
};

const CUSTOM_GROUPS_TAXONOMY_ID: &str = "custom_groups";

#[derive(Debug, Clone)]
struct HoldingTaxonomyShare {
    category_id: String,
    assigned_category_id: String,
    share: Decimal,
}

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

    /// Returns weighted holding contributions for every category in a taxonomy.
    async fn get_holding_contributions_for_taxonomy_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
        aggregated_account_id: &str,
    ) -> Result<TaxonomyHoldingContributions>;
}

/// Service for computing taxonomy-based portfolio allocations.
pub struct AllocationService {
    holdings_service: Arc<dyn HoldingsServiceTrait>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    account_service: Option<Arc<dyn AccountServiceTrait>>,
}

impl AllocationService {
    pub fn new(
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Self {
        Self {
            holdings_service,
            taxonomy_service,
            account_service: None,
        }
    }

    pub fn with_account_service(mut self, account_service: Arc<dyn AccountServiceTrait>) -> Self {
        self.account_service = Some(account_service);
        self
    }

    fn load_cash_overrides(&self, account_ids: &[String]) -> HashMap<String, String> {
        let Some(account_service) = &self.account_service else {
            return HashMap::new();
        };
        let Ok(accounts) = account_service.get_accounts_by_ids(account_ids) else {
            return HashMap::new();
        };
        accounts
            .into_iter()
            .filter_map(|a| a.cash_allocation_category_id().map(|ov| (a.id, ov)))
            .collect()
    }

    fn load_account_names(&self, account_ids: &[String]) -> HashMap<String, String> {
        let Some(account_service) = &self.account_service else {
            return HashMap::new();
        };
        let Ok(accounts) = account_service.get_accounts_by_ids(account_ids) else {
            return HashMap::new();
        };
        accounts
            .into_iter()
            .map(|account| (account.id, account.name))
            .collect()
    }

    fn account_ids_for_holdings(holdings: &[Holding]) -> Vec<String> {
        let mut account_ids = Vec::new();
        for holding in holdings {
            if holding.source_account_ids.is_empty() {
                account_ids.push(holding.account_id.clone());
            } else {
                account_ids.extend(holding.source_account_ids.iter().cloned());
            }
        }
        account_ids.sort();
        account_ids.dedup();
        account_ids
    }

    fn single_source_account_id(holding: &Holding) -> Option<&str> {
        if holding.source_account_ids.is_empty() {
            return Some(holding.account_id.as_str());
        }
        if holding.source_account_ids.len() == 1 {
            return holding.source_account_ids.first().map(String::as_str);
        }
        None
    }

    fn cash_account_name(
        holding: &Holding,
        account_names: &HashMap<String, String>,
    ) -> Option<String> {
        if holding.holding_type != HoldingType::Cash {
            return None;
        }
        Self::single_source_account_id(holding).and_then(|id| account_names.get(id).cloned())
    }

    fn merge_non_cash_detail_rows(
        matched_values: Vec<(HoldingSummary, Decimal)>,
    ) -> Vec<(HoldingSummary, Decimal)> {
        let mut merged: Vec<(HoldingSummary, Decimal)> = Vec::new();
        let mut non_cash_index_by_id: HashMap<String, usize> = HashMap::new();

        for (summary, value) in matched_values {
            if summary.holding_type == HoldingType::Cash {
                merged.push((summary, value));
                continue;
            }

            if let Some(&index) = non_cash_index_by_id.get(&summary.id) {
                let (existing_summary, existing_value) = &mut merged[index];
                existing_summary.quantity += summary.quantity;
                existing_summary.market_value += summary.market_value;
                if existing_summary.name.is_none() {
                    existing_summary.name = summary.name;
                }
                if existing_summary.unit_price.is_none() {
                    existing_summary.unit_price = summary.unit_price;
                }
                *existing_value += value;
            } else {
                non_cash_index_by_id.insert(summary.id.clone(), merged.len());
                merged.push((summary, value));
            }
        }

        merged
    }

    fn should_load_cash_detail_by_account(taxonomy_id: &str, category_id: &str) -> bool {
        taxonomy_id == "asset_classes"
            && (category_id == "CASH" || category_id.starts_with("CASH_"))
    }

    async fn get_unmerged_holdings_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
    ) -> Result<Vec<Holding>> {
        let mut all_holdings: Vec<Holding> = Vec::new();
        for account_id in account_ids {
            let holdings = self
                .holdings_service
                .get_holdings(account_id, base_currency)
                .await?;
            all_holdings.extend(holdings);
        }
        Ok(all_holdings)
    }

    async fn get_holdings_for_allocation(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
        cash_overrides: &HashMap<String, String>,
    ) -> Result<Vec<Holding>> {
        if cash_overrides.is_empty() {
            return self
                .holdings_service
                .get_holdings_for_accounts(account_ids, base_currency, aggregated_account_id)
                .await;
        }
        self.get_unmerged_holdings_for_accounts(account_ids, base_currency)
            .await
    }

    fn rollup_to_top_level(taxonomy_id: &str) -> bool {
        matches!(
            taxonomy_id,
            "asset_classes" | "industries_gics" | "regions" | "instrument_type"
        )
    }

    fn cash_category_id(taxonomy_id: &str) -> Option<&'static str> {
        match taxonomy_id {
            "asset_classes" => Some("CASH_BANK_DEPOSITS"),
            "instrument_type" => Some("CASH"),
            _ => None,
        }
    }

    fn category_display(
        category_by_id: &HashMap<&str, &Category>,
        category_id: &str,
        fallback_color: &str,
    ) -> (String, String) {
        if category_id == "__UNKNOWN__" {
            return ("Unknown".to_string(), "#878580".to_string());
        }

        category_by_id
            .get(category_id)
            .map(|category| (category.name.clone(), category.color.clone()))
            .unwrap_or_else(|| (category_id.to_string(), fallback_color.to_string()))
    }

    fn holding_display(holding: &Holding) -> (String, String, String) {
        let asset_id = holding
            .instrument
            .as_ref()
            .map(|instrument| instrument.id.clone())
            .unwrap_or_else(|| holding.id.clone());

        if holding.holding_type == HoldingType::Cash {
            let symbol = holding.local_currency.clone();
            return (
                asset_id,
                symbol.clone(),
                format!("Cash ({})", holding.local_currency),
            );
        }

        let symbol = holding
            .instrument
            .as_ref()
            .map(|instrument| instrument.symbol.clone())
            .unwrap_or_else(|| "-".to_string());
        let name = holding
            .instrument
            .as_ref()
            .and_then(|instrument| instrument.name.clone())
            .unwrap_or_else(|| symbol.clone());

        (asset_id, symbol, name)
    }

    fn contribution_shares_for_holding(
        &self,
        holding: &Holding,
        taxonomy_id: &str,
        rollup_to_top_level: bool,
        top_level_map: &HashMap<&str, &str>,
        assignments_by_asset: &HashMap<String, Vec<AssetTaxonomyAssignment>>,
        cash_overrides: &HashMap<String, String>,
    ) -> Vec<HoldingTaxonomyShare> {
        if holding.holding_type == HoldingType::Cash {
            let Some(default_cash_id) = Self::cash_category_id(taxonomy_id) else {
                return Vec::new();
            };
            let source_ids = if holding.source_account_ids.is_empty() {
                std::slice::from_ref(&holding.account_id)
            } else {
                &holding.source_account_ids
            };
            let override_id = if taxonomy_id == "asset_classes" && !cash_overrides.is_empty() {
                let mut unique_override: Option<&String> = None;
                let mut all_agree = true;
                for id in source_ids {
                    match cash_overrides.get(id) {
                        Some(ov) => match unique_override {
                            None => unique_override = Some(ov),
                            Some(prev) if prev != ov => {
                                all_agree = false;
                                break;
                            }
                            _ => {}
                        },
                        None => {
                            if unique_override.is_some() {
                                all_agree = false;
                                break;
                            }
                        }
                    }
                }
                if all_agree {
                    unique_override
                } else {
                    None
                }
            } else {
                None
            };
            let resolved_category_id = if let Some(ov) = override_id {
                ov.as_str()
            } else {
                default_cash_id
            };
            let category_id = if rollup_to_top_level {
                top_level_map
                    .get(resolved_category_id)
                    .copied()
                    .unwrap_or(resolved_category_id)
            } else {
                resolved_category_id
            };
            return vec![HoldingTaxonomyShare {
                category_id: category_id.to_string(),
                assigned_category_id: resolved_category_id.to_string(),
                share: Decimal::ONE,
            }];
        }

        let asset_id = match &holding.instrument {
            Some(instrument) => &instrument.id,
            None => return Vec::new(),
        };

        let taxonomy_assignments: Vec<_> = assignments_by_asset
            .get(asset_id)
            .map(|assignments| {
                assignments
                    .iter()
                    .filter(|assignment| assignment.taxonomy_id == taxonomy_id)
                    .collect()
            })
            .unwrap_or_default();

        if taxonomy_assignments.is_empty() {
            return vec![HoldingTaxonomyShare {
                category_id: "__UNKNOWN__".to_string(),
                assigned_category_id: "__UNKNOWN__".to_string(),
                share: Decimal::ONE,
            }];
        }

        let top_levels_covered_by_children: HashSet<&str> = if rollup_to_top_level {
            taxonomy_assignments
                .iter()
                .filter_map(|assignment| {
                    let assigned_category_id = assignment.category_id.as_str();
                    let top = *top_level_map.get(assigned_category_id)?;
                    if top != assigned_category_id {
                        Some(top)
                    } else {
                        None
                    }
                })
                .collect()
        } else {
            HashSet::new()
        };

        let active_assignments: Vec<_> = taxonomy_assignments
            .into_iter()
            .filter(|assignment| {
                if !rollup_to_top_level {
                    return true;
                }
                let assigned_category_id = assignment.category_id.as_str();
                let top = top_level_map
                    .get(assigned_category_id)
                    .copied()
                    .unwrap_or(assigned_category_id);
                !(top == assigned_category_id && top_levels_covered_by_children.contains(top))
            })
            .collect();

        let total_active_weight: i32 = active_assignments
            .iter()
            .map(|assignment| assignment.weight)
            .sum();
        if total_active_weight <= 0 {
            return vec![HoldingTaxonomyShare {
                category_id: "__UNKNOWN__".to_string(),
                assigned_category_id: "__UNKNOWN__".to_string(),
                share: Decimal::ONE,
            }];
        }

        let weight_divisor = Decimal::from(total_active_weight.max(10000));
        let mut shares: Vec<HoldingTaxonomyShare> = Vec::new();

        for assignment in active_assignments {
            let assigned_category_id = assignment.category_id.as_str();
            let category_id = if rollup_to_top_level {
                top_level_map
                    .get(assigned_category_id)
                    .copied()
                    .unwrap_or(assigned_category_id)
            } else {
                assigned_category_id
            };

            shares.push(HoldingTaxonomyShare {
                category_id: category_id.to_string(),
                assigned_category_id: assigned_category_id.to_string(),
                share: Decimal::from(assignment.weight) / weight_divisor,
            });
        }

        if total_active_weight < 10000 {
            shares.push(HoldingTaxonomyShare {
                category_id: "__UNKNOWN__".to_string(),
                assigned_category_id: "__UNKNOWN__".to_string(),
                share: Decimal::from(10000 - total_active_weight) / dec!(10000),
            });
        }

        shares
            .into_iter()
            .filter(|share| share.share > Decimal::ZERO)
            .collect()
    }

    fn collect_assignments_by_asset(
        &self,
        holdings: &[Holding],
    ) -> Result<HashMap<String, Vec<AssetTaxonomyAssignment>>> {
        let mut asset_ids: Vec<String> = holdings
            .iter()
            .filter_map(|holding| {
                holding
                    .instrument
                    .as_ref()
                    .map(|instrument| instrument.id.clone())
            })
            .collect();
        asset_ids.sort();
        asset_ids.dedup();

        let mut assignments_by_asset = HashMap::new();
        for assignment in self
            .taxonomy_service
            .get_asset_assignments_for_assets(&asset_ids)?
        {
            assignments_by_asset
                .entry(assignment.asset_id.clone())
                .or_insert_with(Vec::new)
                .push(assignment);
        }

        for assignments in assignments_by_asset.values_mut() {
            assignments.sort_by(|a, b| {
                a.taxonomy_id
                    .cmp(&b.taxonomy_id)
                    .then_with(|| a.category_id.cmp(&b.category_id))
                    .then_with(|| a.id.cmp(&b.id))
            });
        }

        Ok(assignments_by_asset)
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
        assignments_by_asset: &HashMap<String, Vec<AssetTaxonomyAssignment>>,
        total_value: Decimal,
        rollup_to_top_level: bool,
        cash_overrides: &HashMap<String, String>,
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
            let market_value = holding.market_value.base;
            let shares = self.contribution_shares_for_holding(
                holding,
                taxonomy_id,
                rollup_to_top_level,
                &top_level_map,
                assignments_by_asset,
                cash_overrides,
            );

            for share in shares {
                let weighted_value = market_value * share.share;

                let entry = original_values
                    .entry(share.assigned_category_id)
                    .or_insert((Decimal::ZERO, share.category_id.clone()));
                entry.0 += weighted_value;

                *rolled_up_values
                    .entry(share.category_id)
                    .or_insert(Decimal::ZERO) += weighted_value;
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
            for children in children_map.values_mut() {
                children.sort_by(|a, b| {
                    b.value
                        .cmp(&a.value)
                        .then_with(|| a.category_id.cmp(&b.category_id))
                });
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

        allocations.sort_by(|a, b| {
            b.value
                .cmp(&a.value)
                .then_with(|| a.category_id.cmp(&b.category_id))
        });

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
        account_ids: &[String],
    ) -> Result<PortfolioAllocations> {
        if holdings.is_empty() {
            return Ok(PortfolioAllocations::default());
        }

        let cash_overrides = self.load_cash_overrides(account_ids);

        // 2. Compute total portfolio value (excluding cash for some allocations)
        let total_value: Decimal = holdings
            .iter()
            .filter(|h| h.holding_type != HoldingType::Cash)
            .map(|h| h.market_value.base)
            .sum();

        let total_with_cash: Decimal = holdings.iter().map(|h| h.market_value.base).sum();

        // 3. Get all taxonomies with categories
        let taxonomies = self.taxonomy_service.get_taxonomies_with_categories()?;

        // 4. Get all assignments for held assets once, then reuse for each taxonomy.
        let assignments_by_asset = self.collect_assignments_by_asset(holdings)?;

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
                        true,
                        &cash_overrides,
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
                        true,
                        &cash_overrides,
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
                        true,
                        &cash_overrides,
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
                        false,
                        &cash_overrides,
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
                        total_with_cash,
                        true,
                        &cash_overrides,
                    );
                }
                _ if !taxonomy.is_system || taxonomy.id == CUSTOM_GROUPS_TAXONOMY_ID => {
                    // User-created custom taxonomies plus the seeded Custom Groups taxonomy.
                    // Custom Groups is marked system so the taxonomy row is protected, but its
                    // categories and assignments are user data and must be included in allocations.
                    let custom_alloc = self.aggregate_by_taxonomy(
                        holdings,
                        &taxonomy.id,
                        &taxonomy.name,
                        &taxonomy.color,
                        categories,
                        &assignments_by_asset,
                        total_value,
                        false,
                        &cash_overrides,
                    );
                    // Only include if there are real categories (not just Unknown)
                    if custom_alloc
                        .categories
                        .iter()
                        .any(|category| category.category_id.as_str() != "__UNKNOWN__")
                    {
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

    async fn compute_holding_contributions_for_taxonomy_from_holdings(
        &self,
        holdings: &[Holding],
        base_currency: &str,
        taxonomy_id: &str,
        cash_overrides: &HashMap<String, String>,
    ) -> Result<TaxonomyHoldingContributions> {
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

        if holdings.is_empty() {
            return Ok(TaxonomyHoldingContributions {
                taxonomy_id: taxonomy_id.to_string(),
                taxonomy_name,
                total_value: Decimal::ZERO,
                currency: base_currency.to_string(),
                contributions: Vec::new(),
            });
        }

        let rollup_to_top_level = Self::rollup_to_top_level(taxonomy_id);
        let top_level_map: HashMap<&str, &str> = if rollup_to_top_level {
            self.build_top_level_map(categories)
        } else {
            categories
                .iter()
                .map(|c| (c.id.as_str(), c.id.as_str()))
                .collect()
        };
        let category_by_id: HashMap<&str, &Category> =
            categories.iter().map(|c| (c.id.as_str(), c)).collect();

        let assignments_by_asset = self.collect_assignments_by_asset(holdings)?;

        let mut contributions: Vec<HoldingAllocationContribution> = Vec::new();
        for holding in holdings {
            let shares = self.contribution_shares_for_holding(
                holding,
                taxonomy_id,
                rollup_to_top_level,
                &top_level_map,
                &assignments_by_asset,
                cash_overrides,
            );
            let (asset_id, symbol, name) = Self::holding_display(holding);
            let mut value_by_category: BTreeMap<String, Decimal> = BTreeMap::new();
            for share in shares {
                *value_by_category.entry(share.category_id).or_default() +=
                    holding.market_value.base * share.share;
            }

            for (category_id, value) in value_by_category {
                if value == Decimal::ZERO {
                    continue;
                }
                let (category_name, category_color) =
                    Self::category_display(&category_by_id, &category_id, &taxonomy_color);

                contributions.push(HoldingAllocationContribution {
                    id: format!("{}:{}", holding.id, category_id),
                    holding_id: holding.id.clone(),
                    asset_id: asset_id.clone(),
                    account_id: holding.account_id.clone(),
                    source_account_ids: holding.source_account_ids.clone(),
                    symbol: symbol.clone(),
                    name: name.clone(),
                    holding_type: holding.holding_type.clone(),
                    quantity: holding.quantity,
                    category_id,
                    category_name,
                    category_color,
                    value,
                });
            }
        }

        contributions.sort_by(|a, b| {
            b.value
                .cmp(&a.value)
                .then_with(|| a.holding_id.cmp(&b.holding_id))
                .then_with(|| a.category_id.cmp(&b.category_id))
        });
        let total_value: Decimal = contributions
            .iter()
            .map(|contribution| contribution.value)
            .sum();

        Ok(TaxonomyHoldingContributions {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name,
            total_value,
            currency: base_currency.to_string(),
            contributions,
        })
    }

    async fn compute_holdings_by_allocation_from_holdings(
        &self,
        holdings: &[Holding],
        base_currency: &str,
        taxonomy_id: &str,
        category_id: &str,
        cash_overrides: &HashMap<String, String>,
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

        let rollup_to_top_level = Self::rollup_to_top_level(taxonomy_id);
        let top_level_map: HashMap<&str, &str> = if rollup_to_top_level {
            self.build_top_level_map(categories)
        } else {
            categories
                .iter()
                .map(|category| (category.id.as_str(), category.id.as_str()))
                .collect()
        };
        let assignments_by_asset = self.collect_assignments_by_asset(holdings)?;
        let account_names = self.load_account_names(&Self::account_ids_for_holdings(holdings));

        let mut matched_values: Vec<(HoldingSummary, Decimal)> = Vec::new();
        for holding in holdings {
            let shares = self.contribution_shares_for_holding(
                holding,
                taxonomy_id,
                rollup_to_top_level,
                &top_level_map,
                &assignments_by_asset,
                cash_overrides,
            );

            let matched_share: Decimal = shares
                .into_iter()
                .filter(|share| {
                    share.category_id == category_id || share.assigned_category_id == category_id
                })
                .map(|share| share.share)
                .sum();

            if matched_share <= Decimal::ZERO {
                continue;
            }

            let matched_value = holding.market_value.base * matched_share;
            let (asset_id, symbol, name) = Self::holding_display(holding);
            matched_values.push((
                HoldingSummary {
                    id: asset_id,
                    symbol,
                    name: Some(name),
                    account_name: Self::cash_account_name(holding, &account_names),
                    holding_type: holding.holding_type.clone(),
                    quantity: holding.quantity,
                    market_value: matched_value,
                    currency: base_currency.to_string(),
                    weight_in_category: Decimal::ZERO,
                    unit_price: holding.price,
                },
                matched_value,
            ));
        }

        let matched_values = Self::merge_non_cash_detail_rows(matched_values);
        let total_matched_value: Decimal = matched_values.iter().map(|(_, value)| *value).sum();

        let mut summaries: Vec<HoldingSummary> = matched_values
            .into_iter()
            .map(|(mut summary, value)| {
                summary.weight_in_category = if total_matched_value > Decimal::ZERO {
                    (value / total_matched_value * dec!(100)).round_dp(2)
                } else {
                    Decimal::ZERO
                };
                summary
            })
            .collect();

        summaries.sort_by(|a, b| {
            b.market_value
                .cmp(&a.market_value)
                .then_with(|| a.symbol.cmp(&b.symbol))
                .then_with(|| a.id.cmp(&b.id))
        });

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
        self.compute_allocations_from_holdings(&holdings, base_currency, &[account_id.to_string()])
            .await
    }

    async fn get_portfolio_allocations_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<PortfolioAllocations> {
        let cash_overrides = self.load_cash_overrides(account_ids);
        let holdings = self
            .get_holdings_for_allocation(
                account_ids,
                base_currency,
                aggregated_account_id,
                &cash_overrides,
            )
            .await?;
        self.compute_allocations_from_holdings(&holdings, base_currency, account_ids)
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
        let overrides = self.load_cash_overrides(&[account_id.to_string()]);
        self.compute_holdings_by_allocation_from_holdings(
            &holdings,
            base_currency,
            taxonomy_id,
            category_id,
            &overrides,
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
        let overrides = self.load_cash_overrides(account_ids);
        let holdings = if Self::should_load_cash_detail_by_account(taxonomy_id, category_id) {
            self.get_unmerged_holdings_for_accounts(account_ids, base_currency)
                .await?
        } else {
            self.get_holdings_for_allocation(
                account_ids,
                base_currency,
                aggregated_account_id,
                &overrides,
            )
            .await?
        };
        self.compute_holdings_by_allocation_from_holdings(
            &holdings,
            base_currency,
            taxonomy_id,
            category_id,
            &overrides,
        )
        .await
    }

    async fn get_holding_contributions_for_taxonomy_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
        aggregated_account_id: &str,
    ) -> Result<TaxonomyHoldingContributions> {
        let overrides = self.load_cash_overrides(account_ids);
        let holdings = self
            .get_holdings_for_allocation(
                account_ids,
                base_currency,
                aggregated_account_id,
                &overrides,
            )
            .await?;
        self.compute_holding_contributions_for_taxonomy_from_holdings(
            &holdings,
            base_currency,
            taxonomy_id,
            &overrides,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{Account, AccountUpdate, NewAccount};
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
    struct StaticTaxonomies {
        taxonomies: Vec<TaxonomyWithCategories>,
        assignments_by_asset: HashMap<String, Vec<AssetTaxonomyAssignment>>,
    }
    struct StaticAccountService {
        accounts: HashMap<String, Account>,
    }

    impl StaticAccountService {
        fn new(accounts: Vec<Account>) -> Self {
            Self {
                accounts: accounts
                    .into_iter()
                    .map(|account| (account.id.clone(), account))
                    .collect(),
            }
        }
    }

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
    impl AccountServiceTrait for StaticAccountService {
        async fn create_account(&self, _: NewAccount) -> Result<Account> {
            unimplemented!()
        }

        async fn update_account(&self, _: AccountUpdate) -> Result<Account> {
            unimplemented!()
        }

        async fn delete_account(&self, _: &str) -> Result<()> {
            unimplemented!()
        }

        fn get_account(&self, account_id: &str) -> Result<Account> {
            self.accounts.get(account_id).cloned().ok_or_else(|| {
                crate::Error::Database(crate::errors::DatabaseError::NotFound(format!(
                    "Account {} not found",
                    account_id
                )))
            })
        }

        fn list_accounts(
            &self,
            _: Option<bool>,
            _: Option<bool>,
            _: Option<&[String]>,
        ) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_all_accounts(&self) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_active_accounts(&self) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_accounts_by_ids(&self, account_ids: &[String]) -> Result<Vec<Account>> {
            Ok(account_ids
                .iter()
                .filter_map(|id| self.accounts.get(id).cloned())
                .collect())
        }

        fn get_non_archived_accounts(&self) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_active_non_archived_accounts(&self) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_base_currency(&self) -> Option<String> {
            None
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
        async fn replace_asset_taxonomy_assignments(
            &self,
            _: &str,
            _: &str,
            _: Vec<NewAssetTaxonomyAssignment>,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn remove_asset_assignment(&self, _: &str) -> Result<usize> {
            unimplemented!()
        }
    }

    #[async_trait]
    impl TaxonomyServiceTrait for StaticTaxonomies {
        fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
            Ok(self
                .taxonomies
                .iter()
                .map(|entry| entry.taxonomy.clone())
                .collect())
        }
        fn get_taxonomy(&self, id: &str) -> Result<Option<TaxonomyWithCategories>> {
            Ok(self
                .taxonomies
                .iter()
                .find(|entry| entry.taxonomy.id == id)
                .cloned())
        }
        fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
            Ok(self.taxonomies.clone())
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
        fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
            Ok(self
                .assignments_by_asset
                .get(asset_id)
                .cloned()
                .unwrap_or_default())
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
        async fn replace_asset_taxonomy_assignments(
            &self,
            _: &str,
            _: &str,
            _: Vec<NewAssetTaxonomyAssignment>,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
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

    fn make_taxonomy(id: &str, name: &str, is_system: bool) -> Taxonomy {
        Taxonomy {
            id: id.to_string(),
            name: name.to_string(),
            color: "#808080".to_string(),
            description: None,
            is_system,
            is_single_select: false,
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
            scope: "asset".to_string(),
        }
    }

    fn make_category_for_taxonomy(
        taxonomy_id: &str,
        id: &str,
        parent_id: Option<&str>,
    ) -> Category {
        Category {
            id: id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
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

    fn make_category(id: &str, parent_id: Option<&str>) -> Category {
        make_category_for_taxonomy("regions", id, parent_id)
    }

    fn make_assignment(
        asset_id: &str,
        taxonomy_id: &str,
        category_id: &str,
        weight: i32,
    ) -> AssetTaxonomyAssignment {
        AssetTaxonomyAssignment {
            id: format!("{asset_id}:{taxonomy_id}:{category_id}"),
            asset_id: asset_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            weight,
            source: "manual".to_string(),
            created_at: now(),
            updated_at: now(),
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
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            metadata: None,
            source_account_ids: vec![],
        }
    }

    fn make_cash_holding(currency: &str, base_value: Decimal) -> Holding {
        Holding {
            id: format!("cash_{currency}"),
            account_id: "acc".to_string(),
            holding_type: HoldingType::Cash,
            instrument: None,
            asset_kind: None,
            quantity: base_value,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: currency.to_string(),
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
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
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
        let mut assignments: HashMap<String, Vec<AssetTaxonomyAssignment>> = HashMap::new();
        assignments.insert(
            "AAPL".to_string(),
            vec![
                make_assignment("AAPL", "regions", "North_America", 6000),
                make_assignment("AAPL", "regions", "Europe", 6000),
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
            &HashMap::new(),
        );

        let total_pct: Decimal = result.categories.iter().map(|c| c.percentage).sum();
        assert!(
            total_pct <= dec!(100.01),
            "Total percentage {total_pct} exceeds 100% — normalization failed"
        );
    }

    #[test]
    fn weights_below_100_pct_are_counted_as_unknown_remainder() {
        let svc = svc();
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let categories = vec![
            make_category("North_America", None),
            make_category("Europe", None),
        ];

        let mut assignments: HashMap<String, Vec<AssetTaxonomyAssignment>> = HashMap::new();
        assignments.insert(
            "AAPL".to_string(),
            vec![make_assignment("AAPL", "regions", "North_America", 6000)],
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
            &HashMap::new(),
        );

        let north_america = result
            .categories
            .iter()
            .find(|c| c.category_id == "North_America")
            .expect("North_America category missing");
        let unknown = result
            .categories
            .iter()
            .find(|c| c.category_id == "__UNKNOWN__")
            .expect("Unknown category missing");

        assert_eq!(north_america.value, dec!(600));
        assert_eq!(north_america.percentage, dec!(60));
        assert_eq!(unknown.value, dec!(400));
        assert_eq!(unknown.percentage, dec!(40));
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
        let mut assignments: HashMap<String, Vec<AssetTaxonomyAssignment>> = HashMap::new();
        assignments.insert(
            "AAPL".to_string(),
            vec![
                make_assignment("AAPL", "regions", "Americas", 6000),
                make_assignment("AAPL", "regions", "United_States", 4000),
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
            &HashMap::new(),
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

    #[tokio::test]
    async fn holdings_by_allocation_normalizes_weights_above_100_pct() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![
                    make_category_for_taxonomy("regions", "North_America", None),
                    make_category_for_taxonomy("regions", "Europe", None),
                ],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![
                    make_assignment("AAPL", "regions", "North_America", 6000),
                    make_assignment("AAPL", "regions", "Europe", 6000),
                ],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let north_america = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "North_America",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let europe = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "Europe",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(north_america.total_value, dec!(500));
        assert_eq!(north_america.holdings[0].market_value, dec!(500));
        assert_eq!(europe.total_value, dec!(500));
        assert_eq!(europe.holdings[0].market_value, dec!(500));
    }

    #[tokio::test]
    async fn holdings_by_allocation_includes_unknown_remainder_below_100_pct() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![make_category_for_taxonomy("regions", "North_America", None)],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment("AAPL", "regions", "North_America", 6000)],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let north_america = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "North_America",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let unknown = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "__UNKNOWN__",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(north_america.total_value, dec!(600));
        assert_eq!(north_america.holdings[0].market_value, dec!(600));
        assert_eq!(unknown.total_value, dec!(400));
        assert_eq!(unknown.holdings[0].market_value, dec!(400));
    }

    #[tokio::test]
    async fn holdings_by_allocation_returns_child_contributions_for_rolled_taxonomy() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![
                    make_category_for_taxonomy("regions", "Americas", None),
                    make_category_for_taxonomy("regions", "United_States", Some("Americas")),
                    make_category_for_taxonomy("regions", "Europe", None),
                ],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![
                    make_assignment("AAPL", "regions", "United_States", 4000),
                    make_assignment("AAPL", "regions", "Europe", 6000),
                ],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let child = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "United_States",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let parent = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "regions",
                "Americas",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(child.total_value, dec!(400));
        assert_eq!(child.holdings[0].market_value, dec!(400));
        assert_eq!(parent.total_value, dec!(400));
        assert_eq!(parent.holdings[0].market_value, dec!(400));
    }

    #[tokio::test]
    async fn holdings_by_allocation_returns_cash_bank_deposit_child() {
        let holdings = vec![make_cash_holding("USD", dec!(2000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![
                    make_category_for_taxonomy("asset_classes", "CASH", None),
                    make_category_for_taxonomy("asset_classes", "CASH_BANK_DEPOSITS", Some("CASH")),
                ],
            }],
            assignments_by_asset: HashMap::new(),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let child = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "CASH_BANK_DEPOSITS",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let parent = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "CASH",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(child.total_value, dec!(2000));
        assert_eq!(child.holdings[0].holding_type, HoldingType::Cash);
        assert_eq!(parent.total_value, dec!(2000));
        assert_eq!(parent.holdings[0].holding_type, HoldingType::Cash);
    }

    #[tokio::test]
    async fn holdings_by_allocation_names_cash_rows_by_account() {
        let account_id = "cash-account";
        let account_name = "Emergency Fund";
        let holdings = vec![make_cash_holding_for_account("USD", dec!(2000), account_id)];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![
                    make_category_for_taxonomy("asset_classes", "CASH", None),
                    make_category_for_taxonomy("asset_classes", "CASH_BANK_DEPOSITS", Some("CASH")),
                    make_category_for_taxonomy("asset_classes", "FIXED_INCOME", None),
                ],
            }],
            assignments_by_asset: HashMap::new(),
        };
        let account_service = StaticAccountService::new(vec![Account {
            id: account_id.to_string(),
            name: account_name.to_string(),
            ..Account::default()
        }]);
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies))
            .with_account_service(Arc::new(account_service));

        let cash = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "CASH",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let fixed_income = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "FIXED_INCOME",
                &HashMap::from([(account_id.to_string(), "FIXED_INCOME".to_string())]),
            )
            .await
            .unwrap();

        assert_eq!(cash.holdings[0].account_name.as_deref(), Some(account_name));
        assert_eq!(
            fixed_income.holdings[0].account_name.as_deref(),
            Some(account_name)
        );
    }

    #[tokio::test]
    async fn holdings_by_allocation_excludes_default_cash_from_fixed_income() {
        let default_cash_account_id = "checking";
        let fixed_income_cash_account_id = "business-cash";
        let holdings = vec![
            make_cash_holding_for_account("CAD", dec!(1000), default_cash_account_id),
            make_cash_holding_for_account("USD", dec!(2000), fixed_income_cash_account_id),
        ];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![
                    make_category_for_taxonomy("asset_classes", "CASH", None),
                    make_category_for_taxonomy("asset_classes", "CASH_BANK_DEPOSITS", Some("CASH")),
                    make_category_for_taxonomy("asset_classes", "FIXED_INCOME", None),
                ],
            }],
            assignments_by_asset: HashMap::new(),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));
        let overrides = HashMap::from([(
            fixed_income_cash_account_id.to_string(),
            "FIXED_INCOME".to_string(),
        )]);

        let fixed_income = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "FIXED_INCOME",
                &overrides,
            )
            .await
            .unwrap();
        let bank_deposits = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "CASH_BANK_DEPOSITS",
                &overrides,
            )
            .await
            .unwrap();

        assert_eq!(fixed_income.total_value, dec!(2000));
        assert_eq!(fixed_income.holdings.len(), 1);
        assert_eq!(fixed_income.holdings[0].symbol, "USD");

        assert_eq!(bank_deposits.total_value, dec!(1000));
        assert_eq!(bank_deposits.holdings.len(), 1);
        assert_eq!(bank_deposits.holdings[0].symbol, "CAD");
    }

    #[tokio::test]
    async fn holdings_by_allocation_excludes_cash_from_equity_when_overrides_exist() {
        let default_cash_account_id = "checking";
        let fixed_income_cash_account_id = "business-cash";
        let holdings = vec![
            make_holding("AAPL", dec!(3000)),
            make_cash_holding_for_account("CAD", dec!(1000), default_cash_account_id),
            make_cash_holding_for_account("USD", dec!(2000), fixed_income_cash_account_id),
        ];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![
                    make_category_for_taxonomy("asset_classes", "EQUITY", None),
                    make_category_for_taxonomy("asset_classes", "CASH", None),
                    make_category_for_taxonomy("asset_classes", "CASH_BANK_DEPOSITS", Some("CASH")),
                    make_category_for_taxonomy("asset_classes", "FIXED_INCOME", None),
                ],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment("AAPL", "asset_classes", "EQUITY", 10000)],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));
        let overrides = HashMap::from([(
            fixed_income_cash_account_id.to_string(),
            "FIXED_INCOME".to_string(),
        )]);

        let equity = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "EQUITY",
                &overrides,
            )
            .await
            .unwrap();

        assert_eq!(equity.total_value, dec!(3000));
        assert_eq!(equity.holdings.len(), 1);
        assert_eq!(equity.holdings[0].symbol, "AAPL");
        assert_ne!(equity.holdings[0].holding_type, HoldingType::Cash);
    }

    #[tokio::test]
    async fn holdings_by_allocation_merges_duplicate_non_cash_rows() {
        let holdings = vec![
            Holding {
                account_id: "account-a".to_string(),
                ..make_holding("ZGRO", dec!(1185.01))
            },
            Holding {
                account_id: "account-b".to_string(),
                ..make_holding("ZGRO", dec!(610.83))
            },
        ];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![make_category_for_taxonomy(
                    "asset_classes",
                    "FIXED_INCOME",
                    None,
                )],
            }],
            assignments_by_asset: HashMap::from([(
                "ZGRO".to_string(),
                vec![make_assignment(
                    "ZGRO",
                    "asset_classes",
                    "FIXED_INCOME",
                    10000,
                )],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let fixed_income = svc
            .compute_holdings_by_allocation_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                "FIXED_INCOME",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(fixed_income.holdings.len(), 1);
        assert_eq!(fixed_income.holdings[0].symbol, "ZGRO");
        assert_eq!(fixed_income.holdings[0].quantity, dec!(2));
        assert_eq!(fixed_income.holdings[0].market_value, dec!(1795.84));
        assert_eq!(fixed_income.holdings[0].weight_in_category, dec!(100));
    }

    #[tokio::test]
    async fn holding_contributions_exclude_cash_from_region_taxonomy() {
        let holdings = vec![
            make_holding("AAPL", dec!(1000)),
            make_cash_holding("USD", dec!(500)),
        ];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![make_category_for_taxonomy("regions", "North_America", None)],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment("AAPL", "regions", "North_America", 10000)],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let result = svc
            .compute_holding_contributions_for_taxonomy_from_holdings(
                &holdings,
                "USD",
                "regions",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(result.total_value, dec!(1000));
        assert_eq!(result.contributions.len(), 1);
        assert_eq!(result.contributions[0].holding_id, "AAPL");
        assert_eq!(result.contributions[0].category_id, "North_America");
    }

    #[tokio::test]
    async fn holding_contributions_have_stable_category_order_and_ids() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![
                    make_category_for_taxonomy("regions", "Europe", None),
                    make_category_for_taxonomy("regions", "North_America", None),
                ],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![
                    make_assignment("AAPL", "regions", "North_America", 5000),
                    make_assignment("AAPL", "regions", "Europe", 5000),
                ],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let result = svc
            .compute_holding_contributions_for_taxonomy_from_holdings(
                &holdings,
                "USD",
                "regions",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let ids: Vec<_> = result
            .contributions
            .iter()
            .map(|contribution| contribution.id.as_str())
            .collect();

        assert_eq!(ids, vec!["AAPL:Europe", "AAPL:North_America"]);
    }

    #[tokio::test]
    async fn holding_contributions_leaf_wins_and_keeps_unknown_remainder() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("regions", "Regions", true),
                categories: vec![
                    make_category_for_taxonomy("regions", "Americas", None),
                    make_category_for_taxonomy("regions", "United_States", Some("Americas")),
                ],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![
                    make_assignment("AAPL", "regions", "Americas", 6000),
                    make_assignment("AAPL", "regions", "United_States", 4000),
                ],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let result = svc
            .compute_holding_contributions_for_taxonomy_from_holdings(
                &holdings,
                "USD",
                "regions",
                &HashMap::new(),
            )
            .await
            .unwrap();
        let americas = result
            .contributions
            .iter()
            .find(|contribution| contribution.category_id == "Americas")
            .expect("Americas contribution missing");
        let unknown = result
            .contributions
            .iter()
            .find(|contribution| contribution.category_id == "__UNKNOWN__")
            .expect("Unknown contribution missing");

        assert_eq!(americas.value, dec!(400));
        assert_eq!(unknown.value, dec!(600));
        assert_eq!(result.total_value, dec!(1000));
    }

    #[tokio::test]
    async fn holding_contributions_roll_cash_to_asset_class_cash() {
        let holdings = vec![make_cash_holding("USD", dec!(2000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy("asset_classes", "Asset Classes", true),
                categories: vec![
                    make_category_for_taxonomy("asset_classes", "CASH", None),
                    make_category_for_taxonomy("asset_classes", "CASH_BANK_DEPOSITS", Some("CASH")),
                ],
            }],
            assignments_by_asset: HashMap::new(),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let result = svc
            .compute_holding_contributions_for_taxonomy_from_holdings(
                &holdings,
                "USD",
                "asset_classes",
                &HashMap::new(),
            )
            .await
            .unwrap();

        assert_eq!(result.total_value, dec!(2000));
        assert_eq!(result.contributions.len(), 1);
        assert_eq!(result.contributions[0].category_id, "CASH");
        assert_eq!(result.contributions[0].symbol, "USD");
        assert_eq!(result.contributions[0].holding_type, HoldingType::Cash);
    }

    #[test]
    fn cash_rolls_up_to_asset_class_cash_without_instrument() {
        let svc = svc();
        let holdings = vec![make_cash_holding("USD", dec!(2000))];
        let categories = vec![
            make_category("CASH", None),
            make_category("CASH_BANK_DEPOSITS", Some("CASH")),
        ];

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "asset_classes",
            "Asset Classes",
            "#ccc",
            &categories,
            &HashMap::new(),
            dec!(12000),
            true,
            &HashMap::new(),
        );

        let cash = result
            .categories
            .iter()
            .find(|c| c.category_id == "CASH")
            .expect("cash allocation missing");
        assert_eq!(cash.value, dec!(2000));
        assert_eq!(cash.percentage, dec!(16.67));
    }

    #[test]
    fn cash_rolls_up_to_instrument_type_cash_fx_without_instrument() {
        let svc = svc();
        let holdings = vec![make_cash_holding("USD", dec!(2000))];
        let categories = vec![
            make_category("CASH_FX", None),
            make_category("CASH", Some("CASH_FX")),
        ];

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "instrument_type",
            "Instrument Type",
            "#ccc",
            &categories,
            &HashMap::new(),
            dec!(12000),
            true,
            &HashMap::new(),
        );

        let cash_fx = result
            .categories
            .iter()
            .find(|c| c.category_id == "CASH_FX")
            .expect("cash/fx allocation missing");
        assert_eq!(cash_fx.value, dec!(2000));
        assert_eq!(cash_fx.percentage, dec!(16.67));
    }

    #[tokio::test]
    async fn system_custom_groups_taxonomy_is_included_in_custom_allocations() {
        let holdings = vec![make_holding("AAPL", dec!(1000))];
        let taxonomies = StaticTaxonomies {
            taxonomies: vec![TaxonomyWithCategories {
                taxonomy: make_taxonomy(CUSTOM_GROUPS_TAXONOMY_ID, "Custom Groups", true),
                categories: vec![make_category_for_taxonomy(
                    CUSTOM_GROUPS_TAXONOMY_ID,
                    "small_cap",
                    None,
                )],
            }],
            assignments_by_asset: HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment(
                    "AAPL",
                    CUSTOM_GROUPS_TAXONOMY_ID,
                    "small_cap",
                    10000,
                )],
            )]),
        };
        let svc = AllocationService::new(Arc::new(NoopHoldings), Arc::new(taxonomies));

        let result = svc
            .compute_allocations_from_holdings(&holdings, "USD", &[])
            .await
            .unwrap();

        let custom_groups = result
            .custom_groups
            .iter()
            .find(|allocation| allocation.taxonomy_id == CUSTOM_GROUPS_TAXONOMY_ID)
            .expect("custom_groups allocation missing");
        let small_cap = custom_groups
            .categories
            .iter()
            .find(|category| category.category_id == "small_cap")
            .expect("small_cap custom group missing");

        assert_eq!(small_cap.value, dec!(1000));
        assert_eq!(small_cap.percentage, dec!(100));
    }

    // ── Cash allocation override tests ─────────────────────────────────────

    fn make_cash_holding_for_account(
        currency: &str,
        base_value: Decimal,
        account_id: &str,
    ) -> Holding {
        Holding {
            account_id: account_id.to_string(),
            ..make_cash_holding(currency, base_value)
        }
    }

    fn make_merged_cash_holding(
        currency: &str,
        base_value: Decimal,
        source_account_ids: Vec<&str>,
    ) -> Holding {
        Holding {
            id: format!("AGG-CASH-{currency}"),
            account_id: "aggregated".to_string(),
            source_account_ids: source_account_ids.into_iter().map(String::from).collect(),
            ..make_cash_holding(currency, base_value)
        }
    }

    #[test]
    fn cash_override_maps_to_fixed_income_in_asset_classes() {
        let svc = svc();
        let holdings = vec![
            make_holding("AAPL", dec!(5000)),
            make_cash_holding_for_account("USD", dec!(5000), "savings"),
        ];
        let categories = vec![
            make_category("EQUITY", None),
            make_category("FIXED_INCOME", None),
            make_category("CASH", None),
            make_category("CASH_BANK_DEPOSITS", Some("CASH")),
        ];
        let overrides = HashMap::from([("savings".to_string(), "FIXED_INCOME".to_string())]);

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "asset_classes",
            "Asset Classes",
            "#ccc",
            &categories,
            &HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment("AAPL", "asset_classes", "EQUITY", 10000)],
            )]),
            dec!(10000),
            true,
            &overrides,
        );

        let fi = result
            .categories
            .iter()
            .find(|c| c.category_id == "FIXED_INCOME");
        assert!(fi.is_some(), "FIXED_INCOME category should exist");
        assert_eq!(fi.unwrap().value, dec!(5000));

        let cash = result.categories.iter().find(|c| c.category_id == "CASH");
        assert!(
            cash.is_none(),
            "CASH category should not exist when all cash is overridden"
        );
    }

    #[test]
    fn cash_override_does_not_affect_instrument_type() {
        let svc = svc();
        let holdings = vec![make_cash_holding_for_account("USD", dec!(5000), "savings")];
        let categories = vec![
            make_category("CASH_FX", None),
            make_category("CASH", Some("CASH_FX")),
        ];
        let overrides = HashMap::from([("savings".to_string(), "FIXED_INCOME".to_string())]);

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "instrument_type",
            "Instrument Type",
            "#ccc",
            &categories,
            &HashMap::new(),
            dec!(5000),
            true,
            &overrides,
        );

        let cash_fx = result
            .categories
            .iter()
            .find(|c| c.category_id == "CASH_FX");
        assert!(
            cash_fx.is_some(),
            "instrument_type should still show CASH_FX"
        );
        assert_eq!(cash_fx.unwrap().value, dec!(5000));

        let fi = result
            .categories
            .iter()
            .find(|c| c.category_id == "FIXED_INCOME");
        assert!(
            fi.is_none(),
            "FIXED_INCOME should not appear in instrument_type"
        );
    }

    #[test]
    fn default_cash_behavior_unchanged_without_override() {
        let svc = svc();
        let holdings = vec![
            make_holding("AAPL", dec!(8000)),
            make_cash_holding("USD", dec!(2000)),
        ];
        let categories = vec![
            make_category("EQUITY", None),
            make_category("CASH", None),
            make_category("CASH_BANK_DEPOSITS", Some("CASH")),
        ];

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "asset_classes",
            "Asset Classes",
            "#ccc",
            &categories,
            &HashMap::from([(
                "AAPL".to_string(),
                vec![make_assignment("AAPL", "asset_classes", "EQUITY", 10000)],
            )]),
            dec!(10000),
            true,
            &HashMap::new(),
        );

        let cash = result.categories.iter().find(|c| c.category_id == "CASH");
        assert!(cash.is_some(), "CASH should exist with default behavior");
        assert_eq!(cash.unwrap().value, dec!(2000));
    }

    #[test]
    fn mixed_source_accounts_fall_back_to_default() {
        let svc = svc();
        let holdings = vec![make_merged_cash_holding(
            "USD",
            dec!(10000),
            vec!["savings", "checking"],
        )];
        let categories = vec![
            make_category("FIXED_INCOME", None),
            make_category("CASH", None),
            make_category("CASH_BANK_DEPOSITS", Some("CASH")),
        ];
        // savings has override, checking does not → mixed → should fall back to CASH
        let overrides = HashMap::from([("savings".to_string(), "FIXED_INCOME".to_string())]);

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "asset_classes",
            "Asset Classes",
            "#ccc",
            &categories,
            &HashMap::new(),
            dec!(10000),
            true,
            &overrides,
        );

        let cash = result.categories.iter().find(|c| c.category_id == "CASH");
        assert!(cash.is_some(), "mixed sources should fall back to CASH");
        assert_eq!(cash.unwrap().value, dec!(10000));

        let fi = result
            .categories
            .iter()
            .find(|c| c.category_id == "FIXED_INCOME");
        assert!(
            fi.is_none(),
            "FIXED_INCOME should not appear with mixed sources"
        );
    }

    #[test]
    fn all_sources_same_override_applies() {
        let svc = svc();
        let holdings = vec![make_merged_cash_holding(
            "USD",
            dec!(10000),
            vec!["sav1", "sav2"],
        )];
        let categories = vec![
            make_category("FIXED_INCOME", None),
            make_category("CASH", None),
            make_category("CASH_BANK_DEPOSITS", Some("CASH")),
        ];
        let overrides = HashMap::from([
            ("sav1".to_string(), "FIXED_INCOME".to_string()),
            ("sav2".to_string(), "FIXED_INCOME".to_string()),
        ]);

        let result = svc.aggregate_by_taxonomy(
            &holdings,
            "asset_classes",
            "Asset Classes",
            "#ccc",
            &categories,
            &HashMap::new(),
            dec!(10000),
            true,
            &overrides,
        );

        let fi = result
            .categories
            .iter()
            .find(|c| c.category_id == "FIXED_INCOME");
        assert!(fi.is_some(), "all sources agree → FIXED_INCOME");
        assert_eq!(fi.unwrap().value, dec!(10000));
    }
}
