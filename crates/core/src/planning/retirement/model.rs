use chrono::{Datelike, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::portfolio::fire::GlidepathSettings;

/// Default annual draw estimate for defined-contribution income streams that
/// have fund details but no explicit monthly payout.
pub const DEFAULT_DC_PAYOUT_ESTIMATE_RATE: f64 = 0.035;

pub(crate) const FUNDING_TOLERANCE: f64 = 0.999;

fn default_pre_retirement_annual_return() -> f64 {
    0.0577
}

fn default_retirement_annual_return() -> f64 {
    0.0337
}

fn default_annual_investment_fee_rate() -> f64 {
    0.006
}

fn default_annual_volatility() -> f64 {
    0.12
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetirementPlan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub personal: PersonalProfile,
    pub expenses: ExpenseBudget,
    pub income_streams: Vec<RetirementIncomeStream>,
    pub investment: InvestmentAssumptions,
    pub tax: Option<TaxProfile>,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalProfile {
    #[serde(default)]
    pub birth_year_month: Option<String>,
    pub current_age: u32,
    pub target_retirement_age: u32,
    pub planning_horizon_age: u32,
    pub current_annual_salary: Option<f64>,
    pub salary_growth_rate: Option<f64>,
}

pub fn age_from_birth_year_month(birth_year_month: &str, as_of: NaiveDate) -> Option<u32> {
    let (year, month) = birth_year_month.split_once('-')?;
    let birth_year = year.parse::<i32>().ok()?;
    let birth_month = month.parse::<u32>().ok()?;
    if !(1..=12).contains(&birth_month) || birth_year > as_of.year() {
        return None;
    }

    let mut age = as_of.year() - birth_year;
    if as_of.month() < birth_month {
        age -= 1;
    }
    u32::try_from(age).ok()
}

pub fn normalize_retirement_plan_ages(plan: &mut RetirementPlan) {
    if let Some(age) = plan
        .personal
        .birth_year_month
        .as_deref()
        .and_then(|birth_year_month| {
            age_from_birth_year_month(birth_year_month, Local::now().date_naive())
        })
    {
        plan.personal.current_age = age;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        age_from_birth_year_month, normalize_retirement_plan_ages, PayoutMode,
        RetirementIncomeStream, RetirementPlan, StreamKind,
    };
    use chrono::{Datelike, Local, NaiveDate};

    #[test]
    fn derives_age_from_birth_year_month() {
        let as_of = NaiveDate::from_ymd_opt(2026, 4, 21).unwrap();

        assert_eq!(age_from_birth_year_month("1981-04", as_of), Some(45));
        assert_eq!(age_from_birth_year_month("1981-05", as_of), Some(44));
        assert_eq!(age_from_birth_year_month("1981-13", as_of), None);
    }

    #[test]
    fn old_withdrawal_rule_json_is_ignored() {
        let raw = r#"{
            "personal": {
                "currentAge": 45,
                "targetRetirementAge": 55,
                "planningHorizonAge": 90
            },
            "expenses": { "items": [{ "monthlyAmount": 6000.0 }] },
            "incomeStreams": [],
            "investment": {
                "preRetirementAnnualReturn": 0.057,
                "retirementAnnualReturn": 0.034,
                "annualInvestmentFeeRate": 0.006,
                "annualVolatility": 0.12,
                "inflationRate": 0.02,
                "monthlyContribution": 3000.0,
                "contributionGrowthRate": 0.02,
                "glidePath": null
            },
            "withdrawal": {
                "safeWithdrawalRate": 0.04,
                "strategy": "guardrails",
                "guardrails": { "ceilingRate": 0.06 }
            },
            "tax": null,
            "currency": "CAD"
        }"#;

        let plan: RetirementPlan = serde_json::from_str(raw).expect("old JSON should parse");
        let serialized = serde_json::to_string(&plan).expect("plan should serialize");

        assert_eq!(plan.currency, "CAD");
        assert!(!serialized.contains("withdrawal"));
        assert!(!serialized.contains("safeWithdrawalRate"));
    }

    #[test]
    fn a_fund_saved_without_a_payout_mode_is_an_annuity() {
        let raw = r#"{
            "id": "dc",
            "label": "RRSP",
            "streamType": "dc",
            "startAge": 65,
            "adjustForInflation": false,
            "annualGrowthRate": null,
            "monthlyAmount": null,
            "linkedAccountId": null,
            "currentValue": 100000.0,
            "monthlyContribution": 500.0,
            "accumulationReturn": 0.04
        }"#;

        let stream: RetirementIncomeStream =
            serde_json::from_str(raw).expect("a plan saved before drawdown existed should parse");

        assert_eq!(stream.payout_mode, None);
        assert_eq!(stream.post_payout_return, None);
        assert_eq!(stream.payout_mode.unwrap_or_default(), PayoutMode::Annuity);
        assert!(
            !stream.is_drawdown(),
            "an absent payout mode must not turn a shipped plan into a drawdown"
        );
    }

    #[test]
    fn payout_mode_round_trips_through_json() {
        let raw = r#"{
            "id": "dc",
            "label": "RRSP",
            "streamType": "dc",
            "startAge": 65,
            "adjustForInflation": false,
            "monthlyAmount": null,
            "currentValue": 100000.0,
            "monthlyContribution": null,
            "accumulationReturn": 0.04,
            "payoutMode": "drawdown",
            "postPayoutReturn": 0.03
        }"#;

        let stream: RetirementIncomeStream = serde_json::from_str(raw).expect("should parse");

        assert_eq!(stream.payout_mode, Some(PayoutMode::Drawdown));
        assert_eq!(stream.post_payout_return, Some(0.03));
        assert!(stream.is_drawdown());

        let serialized = serde_json::to_string(&stream).expect("should serialize");
        assert!(serialized.contains("\"payoutMode\":\"drawdown\""));
    }

    #[test]
    fn a_defined_benefit_stream_is_never_a_drawdown() {
        let stream = RetirementIncomeStream {
            id: "db".into(),
            label: "State pension".into(),
            stream_type: StreamKind::DefinedBenefit,
            start_age: 67,
            adjust_for_inflation: true,
            annual_growth_rate: None,
            monthly_amount: Some(1_200.0),
            linked_account_id: None,
            current_value: None,
            monthly_contribution: None,
            accumulation_return: None,
            payout_rate: None,
            payout_mode: Some(PayoutMode::Drawdown),
            post_payout_return: None,
        };

        assert!(
            !stream.is_drawdown(),
            "a defined-benefit stream has no balance to draw against"
        );
    }

    #[test]
    fn age_normalization_only_updates_current_age() {
        let today = Local::now().date_naive();
        let birth_year_month = format!("{}-{:02}", today.year() - 40, today.month());
        let raw = format!(
            r#"{{
                "personal": {{
                    "birthYearMonth": "{birth_year_month}",
                    "currentAge": 1,
                    "targetRetirementAge": 55,
                    "planningHorizonAge": 90
                }},
                "expenses": {{ "items": [{{ "id": "living", "label": "Living", "monthlyAmount": 6000.0 }}] }},
                "incomeStreams": [],
                "investment": {{
                    "preRetirementAnnualReturn": 0.057,
                    "retirementAnnualReturn": 0.034,
                    "annualInvestmentFeeRate": 0.006,
                    "annualVolatility": 0.12,
                    "inflationRate": 0.02,
                    "monthlyContribution": 3000.0,
                    "contributionGrowthRate": 0.02,
                    "glidePath": null
                }},
                "tax": null,
                "currency": "CAD"
            }}"#
        );
        let mut plan: RetirementPlan = serde_json::from_str(&raw).expect("plan should parse");
        let mut expected = serde_json::to_value(&plan).expect("plan should serialize");
        expected["personal"]["currentAge"] = serde_json::Value::from(40);

        normalize_retirement_plan_ages(&mut plan);

        let actual = serde_json::to_value(&plan).expect("plan should serialize");
        assert_eq!(actual, expected);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseBudget {
    #[serde(default)]
    pub items: Vec<ExpenseBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseBucket {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub monthly_amount: f64,
    pub inflation_rate: Option<f64>,
    pub start_age: Option<u32>,
    pub end_age: Option<u32>,
    pub essential: Option<bool>,
}

impl ExpenseBudget {
    pub fn all_buckets(&self) -> Vec<(&ExpenseBucket, bool)> {
        self.items
            .iter()
            .map(|bucket| (bucket, bucket.essential.unwrap_or(true)))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetirementIncomeStream {
    pub id: String,
    pub label: String,
    pub stream_type: StreamKind,
    pub start_age: u32,
    pub adjust_for_inflation: bool,
    pub annual_growth_rate: Option<f64>,
    /// Net monthly payout in today's money. Tax on portfolio withdrawals is modeled separately.
    pub monthly_amount: Option<f64>,
    pub linked_account_id: Option<String>,
    pub current_value: Option<f64>,
    pub monthly_contribution: Option<f64>,
    pub accumulation_return: Option<f64>,
    /// Annual draw rate applied to the projected fund balance once payouts start.
    /// Falls back to `DEFAULT_DC_PAYOUT_ESTIMATE_RATE` when unset.
    pub payout_rate: Option<f64>,
    /// What happens to the fund at `start_age`. Absent means `Annuity`, so plans
    /// saved before this field existed keep projecting exactly as they did.
    pub payout_mode: Option<PayoutMode>,
    /// Annual return the balance still invested earns during a `Drawdown` payout
    /// phase. Falls back to the plan's retirement return.
    pub post_payout_return: Option<f64>,
}

impl RetirementIncomeStream {
    /// A fund that keeps its balance through the payout phase, and can therefore
    /// run out. Only a defined-contribution stream has a balance to draw against.
    pub fn is_drawdown(&self) -> bool {
        self.stream_type == StreamKind::DefinedContribution
            && self.payout_mode.unwrap_or_default() == PayoutMode::Drawdown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum StreamKind {
    #[serde(rename = "db")]
    DefinedBenefit,
    #[serde(rename = "dc")]
    DefinedContribution,
}

/// What a defined-contribution fund does with its balance at `start_age`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum PayoutMode {
    /// The pot buys an income. It leaves the projection at `start_age` and the
    /// income runs to the horizon, funded by capital consumption and mortality
    /// credits rather than by the fund's own return.
    #[default]
    #[serde(rename = "annuity")]
    Annuity,
    /// The pot stays invested and is drawn against. The income stops when the
    /// balance is gone.
    #[serde(rename = "drawdown")]
    Drawdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentAssumptions {
    #[serde(
        alias = "expectedAnnualReturn",
        default = "default_pre_retirement_annual_return"
    )]
    pub pre_retirement_annual_return: f64,
    #[serde(default = "default_retirement_annual_return")]
    pub retirement_annual_return: f64,
    #[serde(default = "default_annual_investment_fee_rate")]
    pub annual_investment_fee_rate: f64,
    #[serde(alias = "expectedReturnStdDev", default = "default_annual_volatility")]
    pub annual_volatility: f64,
    pub inflation_rate: f64,
    pub monthly_contribution: f64,
    pub contribution_growth_rate: f64,
    pub glide_path: Option<GlidepathSettings>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum RetirementTimingMode {
    #[default]
    #[serde(rename = "fire")]
    Fire,
    #[serde(rename = "traditional")]
    Traditional,
}

impl RetirementTimingMode {
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Self {
        match value {
            "traditional" => Self::Traditional,
            _ => Self::Fire,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fire => "fire",
            Self::Traditional => "traditional",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RetirementStartReason {
    #[serde(rename = "funded")]
    Funded,
    #[serde(rename = "target_age_forced")]
    TargetAgeForced,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaxBucketBalances {
    pub taxable: f64,
    pub tax_deferred: f64,
    pub tax_free: f64,
}

impl TaxBucketBalances {
    pub fn total(&self) -> f64 {
        self.taxable + self.tax_deferred + self.tax_free
    }

    pub fn scale_to_total(&self, total: f64) -> Self {
        let source_total = self.total();
        if total <= 0.0 {
            return Self::default();
        }
        if source_total <= 0.0 {
            return Self {
                taxable: total,
                tax_deferred: 0.0,
                tax_free: 0.0,
            };
        }
        let scale = total / source_total;
        Self {
            taxable: self.taxable * scale,
            tax_deferred: self.tax_deferred * scale,
            tax_free: self.tax_free * scale,
        }
    }
}

/// Simple effective-tax model with optional bucket balances for retirement-only
/// withdrawal ordering. Missing balances fall back to "all taxable".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaxProfile {
    /// Effective rate applied to taxable-account withdrawals (0.0–1.0).
    pub taxable_withdrawal_rate: f64,
    /// Effective rate applied to tax-deferred-account withdrawals (0.0–1.0).
    pub tax_deferred_withdrawal_rate: f64,
    /// Effective rate applied to tax-free-account withdrawals (typically 0.0).
    pub tax_free_withdrawal_rate: f64,
    /// Penalty rate on withdrawals before `early_withdrawal_penalty_age`.
    pub early_withdrawal_penalty_rate: Option<f64>,
    /// Age at which early-withdrawal penalty no longer applies.
    pub early_withdrawal_penalty_age: Option<u32>,
    /// Country code for future locale-specific presets.
    pub country_code: Option<String>,
    /// Retirement-only spendable balances by tax bucket.
    /// Until contribution routing exists, these balances also define the tax-bucket mix for
    /// future contributions.
    #[serde(default)]
    pub withdrawal_buckets: TaxBucketBalances,
}
