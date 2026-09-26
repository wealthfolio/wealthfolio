use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

// ── Enums ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeType {
    All,
    Portfolio,
    Account,
}

impl ScopeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Portfolio => "portfolio",
            Self::Account => "account",
        }
    }
}

impl TryFrom<&str> for ScopeType {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "all" => Ok(Self::All),
            "portfolio" => Ok(Self::Portfolio),
            "account" => Ok(Self::Account),
            _ => Err(format!("unknown scope type: {s}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    Manual,
    Threshold,
}

impl TriggerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Threshold => "threshold",
        }
    }
}

impl TryFrom<&str> for TriggerType {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "manual" => Ok(Self::Manual),
            "threshold" => Ok(Self::Threshold),
            _ => Err(format!("unknown trigger type: {s}")),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandType {
    #[default]
    Absolute,
    Hybrid,
}

impl BandType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Absolute => "absolute",
            Self::Hybrid => "hybrid",
        }
    }

    pub fn effective_band_bps(
        &self,
        target_bps: i32,
        drift_band_bps: i32,
        relative_factor_bps: i32,
    ) -> i32 {
        match self {
            Self::Absolute => drift_band_bps,
            Self::Hybrid => {
                let relative = target_bps as i64 * relative_factor_bps as i64 / 10_000;
                (relative as i32).max(drift_band_bps)
            }
        }
    }
}

impl TryFrom<&str> for BandType {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "absolute" => Ok(Self::Absolute),
            "hybrid" => Ok(Self::Hybrid),
            _ => Err(format!("unknown band type: {s}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebalanceGoal {
    NearestBand,
    ExactTarget,
}

impl RebalanceGoal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NearestBand => "nearest_band",
            Self::ExactTarget => "exact_target",
        }
    }
}

impl TryFrom<&str> for RebalanceGoal {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "nearest_band" => Ok(Self::NearestBand),
            "exact_target" => Ok(Self::ExactTarget),
            _ => Err(format!("unknown rebalance goal: {s}")),
        }
    }
}

// ── Core domain types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationTarget {
    pub id: String,
    pub name: String,
    pub scope_type: ScopeType,
    pub scope_id: Option<String>,
    pub taxonomy_id: String,
    pub trigger_type: TriggerType,
    pub drift_band_bps: i32,
    pub band_type: BandType,
    pub relative_factor_bps: i32,
    pub rebalance_goal: RebalanceGoal,
    pub min_trade_amount: String,
    pub whole_shares_only: bool,
    pub allow_sells: bool,
    pub max_turnover_bps: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAllocationTarget {
    pub name: String,
    pub scope_type: ScopeType,
    pub scope_id: Option<String>,
    pub taxonomy_id: String,
    pub trigger_type: TriggerType,
    pub drift_band_bps: i32,
    pub band_type: Option<BandType>,
    pub relative_factor_bps: Option<i32>,
    pub rebalance_goal: Option<RebalanceGoal>,
    pub min_trade_amount: Option<String>,
    pub whole_shares_only: Option<bool>,
    pub allow_sells: Option<bool>,
    pub max_turnover_bps: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationTargetWeight {
    pub id: String,
    pub target_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub target_bps: i32,
    pub is_locked: bool,
    pub is_required: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAllocationTargetWeight {
    pub category_id: String,
    pub target_bps: i32,
    pub is_locked: bool,
    pub is_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAllocationTargetResult {
    pub target: AllocationTarget,
    pub weights: Vec<AllocationTargetWeight>,
}

// ── Drift types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftStatus {
    InBand,
    Underweight,
    Overweight,
    NotTargeted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftRow {
    pub category_id: String,
    pub category_name: String,
    pub color: String,
    pub current_bps: i32,
    pub target_bps: i32,
    pub drift_bps: i32,
    pub current_value: Decimal,
    pub target_value: Decimal,
    pub value_delta: Decimal,
    pub effective_band_bps: i32,
    pub status: DriftStatus,
    pub is_required: bool,
    pub is_zero_current: bool,
    #[serde(default)]
    pub is_cash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub target_id: String,
    pub scope_type: ScopeType,
    pub scope_id: Option<String>,
    pub total_value: Decimal,
    pub base_currency: String,
    pub max_drift_bps: i32,
    pub out_of_band_count: usize,
    pub rows: Vec<DriftRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holdings: Option<DriftHoldingsReport>,
    /// Cash that is available for deployment — excludes cash tagged into
    /// a non-cash sleeve (e.g. a cash account classified as Fixed Income).
    #[serde(default)]
    pub deployable_cash: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftHoldingRow {
    pub id: String,
    pub holding_id: String,
    pub asset_id: String,
    pub account_id: String,
    #[serde(default)]
    pub source_account_ids: Vec<String>,
    pub symbol: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrument_type: Option<crate::assets::InstrumentType>,
    pub category_id: String,
    pub category_name: String,
    pub category_color: Option<String>,
    pub value: Decimal,
    pub current_pct: Decimal,
    pub target_pct: Option<Decimal>,
    pub drift_bps: Option<i32>,
    pub is_unknown_category: bool,
    pub is_cash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftHoldingsReport {
    pub target_id: String,
    pub total_value: Decimal,
    pub base_currency: String,
    pub rows: Vec<DriftHoldingRow>,
}

// ── Allocation target constraints ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintSubjectType {
    Asset,
    Account,
    Category,
}

impl ConstraintSubjectType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Account => "account",
            Self::Category => "category",
        }
    }
}

impl TryFrom<&str> for ConstraintSubjectType {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "asset" => Ok(Self::Asset),
            "account" => Ok(Self::Account),
            "category" => Ok(Self::Category),
            _ => Err(format!("unknown constraint subject type: {s}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintAction {
    Buy,
    Sell,
    Trade,
}

impl ConstraintAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Buy => "buy",
            Self::Sell => "sell",
            Self::Trade => "trade",
        }
    }
}

impl TryFrom<&str> for ConstraintAction {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "buy" => Ok(Self::Buy),
            "sell" => Ok(Self::Sell),
            "trade" => Ok(Self::Trade),
            _ => Err(format!("unknown constraint action: {s}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintEffect {
    Block,
    Avoid,
}

impl ConstraintEffect {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Avoid => "avoid",
        }
    }
}

impl TryFrom<&str> for ConstraintEffect {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "block" => Ok(Self::Block),
            "avoid" => Ok(Self::Avoid),
            _ => Err(format!("unknown constraint effect: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationTargetConstraint {
    pub id: String,
    pub target_id: String,
    pub subject_type: ConstraintSubjectType,
    pub subject_id: String,
    pub action: ConstraintAction,
    pub effect: ConstraintEffect,
    pub reason: Option<String>,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Calculated worksheet types ───────────────────────────────────────────────
//
// Shapes for the calculated rebalancing worksheet described in
// `docs/features/allocations/self-directed-rebalancing-design.md`. The
// arithmetic that produces them lives in `worksheet_calculator`.

/// Which directions the calculation is allowed to produce (design §4).
///
/// Replaces the former three-way scenario mode: cash-flow-only and
/// sell-to-rebalance were the two ends of the same cash-first sequence, and
/// hybrid was that sequence with both inputs present.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorksheetMode {
    /// Cash increases positions and nothing is reduced.
    #[default]
    InvestCash,
    /// Cash is used first, then reductions cover what is left. Offered only
    /// when the target allows sells.
    Rebalance,
}

/// How a category's gap is spread across the securities that carry it
/// (design §4.2). One rule ships first, and the user selects it explicitly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllocationRule {
    #[default]
    CurrentHoldingProportions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorksheetDirection {
    Increase,
    Reduce,
}

/// A category amount that no eligible security can carry (design §4.4).
///
/// Nothing is recorded, everything is excluded, or no price is usable. The
/// amount is surfaced against its category rather than forced onto an
/// unrelated security, and is excluded from the projected figures.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedCategoryAmount {
    pub category_id: String,
    pub category_name: String,
    pub amount: Decimal,
    pub reason: UnresolvedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    /// No security in the category is recorded in scope.
    NoRecordedSecurity,
    /// Every security carrying the category was left out of the eligible set.
    NoEligibleSecurity,
    /// Securities exist and are eligible, but none has a usable price.
    NoUsablePrice,
}

/// Proportional scaling applied before the worksheet is prefilled (§4.6).
///
/// Both factors are reported so a scaled figure is never mistaken for the full
/// amount. `None` means that limit did not bind.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentScaling {
    /// Step 2 — reductions scaled to fit the target's turnover cap.
    pub reduction_factor: Option<Decimal>,
    /// Step 4 — increases that depend on reduction proceeds, scaled to the
    /// funding those proceeds actually raised.
    pub increase_factor: Option<Decimal>,
}

/// One prefilled worksheet line.
///
/// Amounts are primary and quantities are estimates (§7).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedAdjustment {
    pub line_id: String,
    pub direction: WorksheetDirection,
    pub asset_id: String,
    pub symbol: String,
    /// `None` when several accounts are eligible and the user has to place the
    /// line (§6). Reductions always carry the account they are drawn from.
    pub account_id: Option<String>,
    /// Signed, in base currency. Negative for a reduction.
    pub amount: Decimal,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    /// Below the target's minimum line size — reported, never dropped (§4.6).
    pub is_below_minimum: bool,
}

/// An increase placed in an account that account cannot fund on its own (§6).
///
/// No transfer between accounts is assumed, so this is reported rather than
/// resolved by moving cash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFundingShortfall {
    pub account_id: String,
    pub required: Decimal,
    pub available: Decimal,
}

/// The calculated adjustments the worksheet is prefilled with (§4, §5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedAdjustments {
    pub mode: WorksheetMode,
    pub rule: AllocationRule,
    pub adjustments: Vec<CalculatedAdjustment>,
    pub unresolved: Vec<UnresolvedCategoryAmount>,
    pub scaling: AdjustmentScaling,
    /// Left over after rounding and minimum-line reporting. Never
    /// redistributed — that would be another round of construction (§4.6).
    pub remaining_cash: Decimal,
    /// Accounts whose increases exceed what they can fund on their own (§6).
    pub funding_shortfalls: Vec<AccountFundingShortfall>,
}

/// What the worksheet is prefilled from (§4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCalculatedAdjustmentsInput {
    pub target_id: String,
    pub account_ids: Vec<String>,
    pub base_currency: String,
    pub aggregated_account_id: String,
    /// Accounts the worksheet may change: where positions are reduced,
    /// increases are placed and cash is deployed. The target's weights are
    /// still measured against every account in `account_ids`.
    pub selected_account_ids: Vec<String>,
    pub mode: WorksheetMode,
    pub rule: AllocationRule,
    pub cash: WorksheetCashInput,
    /// Securities the user marked as able to receive increases (§4.1). `None`
    /// is every recorded security, which is a fact rather than a selection.
    ///
    /// An empty list is a valid state and not a validation error: the increases
    /// that cannot be placed become unresolved category amounts (§4.4).
    #[serde(default)]
    pub eligible_asset_ids: Option<Vec<String>>,
}

// ── Worksheet request and preview types ──────────────────────────────────────
//
// The worksheet the user edits and the result that validates it. Ported from
// `feature/allocation-worksheet-refactor`, where the worksheet started empty.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorksheetInputMode {
    Amount,
    Quantity,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetCashInput {
    pub tracked_cash_to_use: Decimal,
    /// Hypothetical cash not recorded anywhere, keyed by the account it would
    /// arrive in (§6). A single-account scope has one entry, so the user is
    /// asked for nothing beyond the amount; a multi-account scope is where the
    /// split has to be stated, since no transfer between accounts is assumed.
    #[serde(default)]
    pub external_contribution: std::collections::HashMap<String, Decimal>,
}

impl WorksheetCashInput {
    pub fn external_total(&self) -> Decimal {
        self.external_contribution.values().sum()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationWorksheetLineInput {
    pub line_id: String,
    pub direction: WorksheetDirection,
    pub asset_id: String,
    pub account_id: String,
    pub input_mode: WorksheetInputMode,
    pub value: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculateAllocationWorksheetInput {
    pub target_id: String,
    pub cash: WorksheetCashInput,
    pub lines: Vec<AllocationWorksheetLineInput>,
    pub account_ids: Vec<String>,
    pub base_currency: String,
    pub aggregated_account_id: String,
    /// Accounts the worksheet may change: where positions are reduced,
    /// increases are placed and cash is deployed. The target's weights are
    /// still measured against every account in `account_ids`.
    pub selected_account_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorksheetWarningKind {
    StaleQuote,
    StaleFx,
    PartialClassification,
    UnclassifiedAsset,
    ExternalContribution,
    BelowMinimumLine,
    TurnoverExceeded,
    AvoidConstraint,
    /// The increases exceed the selected cash and the reduction proceeds.
    /// Reported rather than corrected, because after prefill the worksheet is
    /// the source of truth (§5).
    InsufficientFunding,
    /// An account's increases exceed what that account can fund on its own
    /// (§6).
    AccountFunding,
    /// The cash to deploy exceeded what the chosen accounts record, so the
    /// worksheet deployed what exists. Cash that is not recorded yet belongs in
    /// the contribution input (§6).
    CashUnavailable,
    /// The amount buys less than one whole unit under the target's whole-unit
    /// policy, so the line places nothing. Reported rather than refused, since
    /// the worksheet is the source of truth once prefilled (§5).
    BelowOneUnit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetWarning {
    pub id: String,
    pub kind: WorksheetWarningKind,
    pub line_id: Option<String>,
    pub message: String,
    pub acknowledgement_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetPricingSource {
    pub id: String,
    pub source_type: String,
    pub value: Decimal,
    pub from_currency: String,
    pub to_currency: String,
    pub timestamp: String,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetCategoryExposure {
    pub category_id: String,
    pub category_name: String,
    pub weight_bps: i32,
    pub value_delta: Decimal,
    pub is_unclassified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationWorksheetLineResult {
    pub line_id: String,
    pub direction: WorksheetDirection,
    pub asset_id: String,
    pub account_id: String,
    pub symbol: String,
    pub name: String,
    pub input_mode: WorksheetInputMode,
    pub input_value: Decimal,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub estimated_amount: Decimal,
    pub contract_multiplier: Decimal,
    pub quote_source: WorksheetPricingSource,
    pub fx_source: Option<WorksheetPricingSource>,
    pub category_exposures: Vec<WorksheetCategoryExposure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetCategoryResult {
    pub category_id: String,
    pub category_name: String,
    pub color: String,
    pub target_bps: i32,
    pub current_value: Decimal,
    pub projected_value: Decimal,
    pub current_bps: i32,
    pub projected_bps: i32,
    pub current_difference_bps: i32,
    pub projected_difference_bps: i32,
    pub is_cash: bool,
    pub is_unclassified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetSourceRecord {
    pub source_type: String,
    pub id: String,
    pub version: String,
    pub details: String,
}

/// Where one account stands once the worksheet is applied (§6).
///
/// An account spends its own cash, the cash not yet recorded that the user put
/// there, and what its own reductions raise. A negative `remaining` is funding
/// the account needs and does not have; it is reported, never corrected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetAccountFunding {
    pub account_id: String,
    pub available_cash: Decimal,
    pub external_cash: Decimal,
    pub reduction_proceeds: Decimal,
    pub increases: Decimal,
    pub remaining: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationWorksheetResult {
    pub target_id: String,
    pub target_name: String,
    pub base_currency: String,
    pub calculated_at: String,
    pub source_fingerprint: String,
    pub resolved_account_ids: Vec<String>,
    pub observed_tracked_cash: Decimal,
    pub tracked_cash_to_use: Decimal,
    pub external_contribution: Decimal,
    pub increase_total: Decimal,
    pub reduction_total: Decimal,
    pub cash_remaining: Decimal,
    pub max_difference_bps_before: i32,
    pub max_difference_bps_after: i32,
    pub lines: Vec<AllocationWorksheetLineResult>,
    pub categories: Vec<WorksheetCategoryResult>,
    pub account_funding: Vec<WorksheetAccountFunding>,
    pub warnings: Vec<WorksheetWarning>,
    pub source_records: Vec<WorksheetSourceRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_band_ignores_target_bps() {
        let band = BandType::Absolute;
        assert_eq!(band.effective_band_bps(5000, 500, 2000), 500);
        assert_eq!(band.effective_band_bps(100, 500, 2000), 500);
        assert_eq!(band.effective_band_bps(0, 500, 2000), 500);
    }

    #[test]
    fn hybrid_band_large_sleeve_uses_relative() {
        let band = BandType::Hybrid;
        // 50% target, 20% factor → relative = 5000 * 2000 / 10000 = 1000 bps
        // floor = 100 bps → max(1000, 100) = 1000
        assert_eq!(band.effective_band_bps(5000, 100, 2000), 1000);
    }

    #[test]
    fn hybrid_band_small_sleeve_uses_floor() {
        let band = BandType::Hybrid;
        // 1% target, 20% factor → relative = 100 * 2000 / 10000 = 20 bps
        // floor = 100 bps → max(20, 100) = 100
        assert_eq!(band.effective_band_bps(100, 100, 2000), 100);
    }

    #[test]
    fn hybrid_band_zero_target_uses_floor() {
        let band = BandType::Hybrid;
        // 0% target → relative = 0, floor = 100
        assert_eq!(band.effective_band_bps(0, 100, 2000), 100);
    }

    #[test]
    fn hybrid_band_mid_sleeve() {
        let band = BandType::Hybrid;
        // 10% target, 20% factor → relative = 1000 * 2000 / 10000 = 200 bps
        // floor = 100 → max(200, 100) = 200
        assert_eq!(band.effective_band_bps(1000, 100, 2000), 200);
    }

    #[test]
    fn band_type_round_trip() {
        assert_eq!(BandType::try_from("absolute"), Ok(BandType::Absolute));
        assert_eq!(BandType::try_from("hybrid"), Ok(BandType::Hybrid));
        assert!(BandType::try_from("invalid").is_err());
        assert_eq!(BandType::Absolute.as_str(), "absolute");
        assert_eq!(BandType::Hybrid.as_str(), "hybrid");
    }
}
