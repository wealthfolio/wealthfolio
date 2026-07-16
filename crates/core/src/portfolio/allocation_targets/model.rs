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
pub enum ScenarioMode {
    #[default]
    CashFlowOnly,
    SellToRebalance,
    Hybrid,
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

// ── Rebalance types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculateRebalancePlanInput {
    pub target_id: String,
    pub available_cash: Decimal,
    pub account_ids: Vec<String>,
    pub base_currency: String,
    pub aggregated_account_id: String,
    #[serde(default)]
    pub scenario_mode: ScenarioMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebalanceWarningKind {
    MissingQuote,
    NoBuyCandidate,
    TaggedCash,
    /// Asset has no taxonomy assignments for the active taxonomy — skipped as buy candidate.
    UnclassifiedAsset,
    /// Asset has partial taxonomy weights (<100%) — known exposure used, remainder ignored.
    PartialClassification,
    /// A sell candidate was skipped due to a do-not-sell or avoid-selling constraint.
    ConstraintSkippedSell,
    /// The sell phase stopped because the turnover cap was reached.
    TurnoverCapReached,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalanceWarning {
    pub kind: RebalanceWarningKind,
    pub category_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedManualTrade {
    pub action: String,
    pub category_id: String,
    pub category_name: String,
    pub asset_id: Option<String>,
    pub account_id: Option<String>,
    pub holding_id: Option<String>,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub quantity: Option<Decimal>,
    pub estimated_price: Option<Decimal>,
    pub estimated_amount: Decimal,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebalancePlan {
    pub target_id: String,
    pub available_cash: Decimal,
    pub cash_used: Decimal,
    pub cash_remaining: Decimal,
    pub max_drift_bps_before: i32,
    pub max_drift_bps_after: i32,
    pub trades: Vec<SuggestedManualTrade>,
    pub warnings: Vec<RebalanceWarning>,
    /// After-trade allocation in bps per category_id.
    /// Accounts for multi-category ETF exposure; use this for BeforeAfterStack
    /// instead of re-deriving from trades (which only carry the primary category).
    #[serde(default)]
    pub after_bps_by_category: std::collections::HashMap<String, i32>,
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
