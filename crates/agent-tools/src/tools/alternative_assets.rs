//! Alternative asset and liability create tools (MCP-only).
//!
//! `prepare_alternative_asset` checks one new property, vehicle, collectible,
//! precious metal, private equity, other asset or liability against the
//! stored ones without writing; `commit_alternative_asset` checks it again
//! and creates it through the core alternative asset service, as the app's
//! quick-add form does. A liability is a manual balance: loans with terms and
//! a payment schedule are set up in the app. Dated values and balances are
//! saved afterwards with the quote import tools.

use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::assets::{
    AlternativeAssetServiceTrait, Asset, AssetKind, CreateAlternativeAssetRequest,
};
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// The name length the app's quick-add form accepts.
const NAME_MAX_CHARS: usize = 100;

/// Liability types the app offers. Credit cards are accounts.
const LIABILITY_TYPES: &[&str] = &[
    "mortgage",
    "auto_loan",
    "student_loan",
    "personal_loan",
    "heloc",
    "other",
];
const METAL_TYPES: &[&str] = &["gold", "silver", "platinum", "palladium"];
const WEIGHT_UNITS: &[&str] = &["oz", "g", "kg"];
const KINDS: &[&str] = &[
    "PROPERTY",
    "VEHICLE",
    "COLLECTIBLE",
    "PRECIOUS_METAL",
    "PRIVATE_EQUITY",
    "LIABILITY",
    "OTHER",
];

fn failed(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::ExecutionFailed(error.to_string())
}

fn service(
    env: &dyn AgentEnvironment,
) -> Result<Arc<dyn AlternativeAssetServiceTrait>, AgentToolError> {
    env.alternative_asset_service()
        .ok_or_else(|| failed("Alternative assets are not available in this environment"))
}

/// One new alternative asset or liability, as prepare and commit take it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlternativeAssetArgs {
    pub kind: AssetKind,
    pub name: String,
    pub currency: String,
    /// A JSON number or a decimal string.
    pub current_value: Decimal,
    pub value_date: String,
    #[serde(default)]
    pub purchase_price: Option<Decimal>,
    #[serde(default)]
    pub purchase_date: Option<String>,
    /// Liability type, or metal for a precious metal.
    #[serde(default)]
    pub sub_type: Option<String>,
    /// Precious metals: how much is held, in `unit`.
    #[serde(default)]
    pub quantity: Option<Decimal>,
    #[serde(default)]
    pub unit: Option<String>,
    /// Liabilities: the asset the liability finances, such as a property.
    #[serde(default)]
    pub linked_asset_id: Option<String>,
    #[serde(default)]
    pub allow_duplicate_name: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingAlternativeAssetDto {
    pub id: String,
    pub name: Option<String>,
    pub kind: AssetKind,
    pub currency: String,
}

impl From<&Asset> for ExistingAlternativeAssetDto {
    fn from(asset: &Asset) -> Self {
        Self {
            id: asset.id.clone(),
            name: asset.name.clone(),
            kind: asset.kind.clone(),
            currency: asset.quote_ccy.clone(),
        }
    }
}

/// The checked asset: what the preview shows and, when valid, the request
/// the commit sends.
#[derive(Debug)]
struct AlternativeAssetPlan {
    proposed: serde_json::Value,
    name_clash: Vec<ExistingAlternativeAssetDto>,
    warnings: Vec<String>,
    errors: Vec<String>,
    request: Option<CreateAlternativeAssetRequest>,
}

fn parse_day(field: &str, value: &str, errors: &mut Vec<String>) -> Option<NaiveDate> {
    match NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d") {
        Ok(date) => Some(date),
        Err(_) => {
            errors.push(format!("{field} '{value}' isn't valid; use YYYY-MM-DD"));
            None
        }
    }
}

fn is_alternative(kind: &AssetKind) -> bool {
    !matches!(kind, AssetKind::Investment | AssetKind::Fx)
}

/// Check one new asset against the stored ones.
fn plan_asset(
    args: &AlternativeAssetArgs,
    stored: &[Asset],
    base_currency: &str,
    today: NaiveDate,
) -> AlternativeAssetPlan {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let kind = args.kind.clone();
    let is_liability = kind == AssetKind::Liability;
    if !is_alternative(&kind) {
        errors.push(format!("kind must be one of {}", KINDS.join(", ")));
    }

    let name = args.name.trim().to_string();
    let name_len = name.chars().count();
    if name_len == 0 || name_len > NAME_MAX_CHARS {
        errors.push(format!("name must be 1 to {NAME_MAX_CHARS} characters"));
    }
    let currency = super::currency_code(&args.currency).unwrap_or_else(|| {
        errors.push("currency must be a currency code of letters, such as EUR".to_string());
        String::new()
    });
    if args.current_value < Decimal::ZERO {
        errors.push("currentValue cannot be negative".to_string());
    }
    let value_date = parse_day("valueDate", &args.value_date, &mut errors);
    if value_date.is_some_and(|date| date > today) {
        errors.push("valueDate cannot be in the future".to_string());
    }

    // Purchase details are for assets; a liability's earlier balances are
    // dated balances.
    if is_liability && (args.purchase_price.is_some() || args.purchase_date.is_some()) {
        errors.push(
            "purchaseDate and purchasePrice are for assets; record a liability's earlier balances with the quote import tools".to_string(),
        );
    }
    let purchase_date = args
        .purchase_date
        .as_deref()
        .filter(|_| !is_liability)
        .and_then(|date| parse_day("purchaseDate", date, &mut errors));
    if args
        .purchase_price
        .is_some_and(|price| price < Decimal::ZERO)
    {
        errors.push("purchasePrice cannot be negative".to_string());
    }
    if let (Some(purchase), Some(value)) = (purchase_date, value_date) {
        if purchase >= value {
            errors.push("purchaseDate must be before valueDate".to_string());
        }
    }

    let sub_type = args
        .sub_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let mut metadata = serde_json::Map::new();
    match kind {
        AssetKind::Liability => {
            let sub_type = sub_type.unwrap_or_else(|| "other".to_string());
            if !LIABILITY_TYPES.contains(&sub_type.as_str()) {
                errors.push(format!(
                    "subType for a liability must be one of {}",
                    LIABILITY_TYPES.join(", ")
                ));
            }
            metadata.insert("sub_type".to_string(), json!(sub_type));
        }
        AssetKind::PreciousMetal => {
            match sub_type.as_deref() {
                Some(metal) if METAL_TYPES.contains(&metal) => {
                    metadata.insert("sub_type".to_string(), json!(metal));
                }
                _ => errors.push(format!(
                    "subType for a precious metal must be one of {}",
                    METAL_TYPES.join(", ")
                )),
            }
            match args.quantity {
                Some(quantity) if quantity > Decimal::ZERO => {
                    metadata.insert("quantity".to_string(), json!(quantity.to_string()));
                }
                _ => {
                    errors.push("quantity above zero is required for a precious metal".to_string())
                }
            }
            let unit = args.unit.as_deref().map(str::trim).unwrap_or("oz");
            if WEIGHT_UNITS.contains(&unit) {
                metadata.insert("unit".to_string(), json!(unit));
            } else {
                errors.push(format!("unit must be one of {}", WEIGHT_UNITS.join(", ")));
            }
        }
        _ => {
            if let Some(sub_type) = sub_type {
                metadata.insert("sub_type".to_string(), json!(sub_type));
            }
        }
    }
    if !matches!(kind, AssetKind::PreciousMetal) && (args.quantity.is_some() || args.unit.is_some())
    {
        errors.push("quantity and unit are for precious metals".to_string());
    }

    let linked_asset_id = args
        .linked_asset_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if let Some(linked) = &linked_asset_id {
        if !is_liability {
            errors.push("linkedAssetId is for liabilities".to_string());
        } else if !stored.iter().any(|asset| {
            asset.id == *linked && is_alternative(&asset.kind) && asset.kind != AssetKind::Liability
        }) {
            errors.push(format!(
                "linkedAssetId {linked} is not a stored alternative asset (such as a property)"
            ));
        }
    }

    let wanted = name.to_lowercase();
    let name_clash: Vec<ExistingAlternativeAssetDto> = stored
        .iter()
        .filter(|asset| asset.kind == kind)
        .filter(|asset| {
            asset
                .name
                .as_deref()
                .is_some_and(|stored| stored.trim().to_lowercase() == wanted)
        })
        .map(ExistingAlternativeAssetDto::from)
        .collect();
    if !name_clash.is_empty() && !args.allow_duplicate_name {
        errors.push(format!(
            "Another {} is already named \"{name}\". Set allowDuplicateName only if the user wants a second one.",
            kind.display_name().to_lowercase()
        ));
    }

    warnings.push(format!(
        "The currency cannot be changed after the {} is created.",
        if is_liability { "liability" } else { "asset" }
    ));
    if !currency.is_empty() && currency != base_currency && !base_currency.is_empty() {
        warnings.push(format!(
            "Values in {currency} convert to the base currency {base_currency}; the {currency}/{base_currency} exchange rate pair is registered when it is created."
        ));
    }
    if is_liability {
        warnings.push(
            "A liability created here is a manual balance: it has no interest rate, term or payment schedule (set those up in the app). Record its dated balances with prepare_quote_import and commit_quote_import (market-data:write), one row per date. They take balances above zero only: a paid-off (zero) balance can be entered as currentValue here or in the app, not through the quote import.".to_string(),
        );
    } else {
        warnings.push(
            "Record further dated values with prepare_quote_import and commit_quote_import (market-data:write); they take values above zero.".to_string(),
        );
    }

    let proposed = json!({
        "kind": kind,
        "name": name,
        "currency": currency,
        "currentValue": args.current_value.normalize().to_string(),
        "valueDate": value_date.map(|date| date.to_string()),
        "purchasePrice": args.purchase_price.map(|price| price.normalize().to_string()),
        "purchaseDate": purchase_date.map(|date| date.to_string()),
        "metadata": metadata,
        "linkedAssetId": linked_asset_id,
    });
    let request = match (errors.is_empty(), value_date) {
        (true, Some(value_date)) => Some(CreateAlternativeAssetRequest {
            kind,
            name,
            currency,
            current_value: args.current_value,
            value_date,
            purchase_price: args.purchase_price.filter(|_| !is_liability),
            purchase_date,
            metadata: (!metadata.is_empty()).then_some(serde_json::Value::Object(metadata)),
            linked_asset_id,
            loan: None,
        }),
        _ => None,
    };
    AlternativeAssetPlan {
        proposed,
        name_clash,
        warnings,
        errors,
        request,
    }
}

async fn load_plan(
    env: &dyn AgentEnvironment,
    args: serde_json::Value,
) -> Result<AlternativeAssetPlan, AgentToolError> {
    let args: AlternativeAssetArgs = serde_json::from_value(args)?;
    let stored: Vec<Asset> = env
        .asset_service()
        .get_assets()
        .map_err(failed)?
        .into_iter()
        .filter(|asset| is_alternative(&asset.kind))
        .collect();
    let timezone = env
        .settings_service()
        .get_settings()
        .map_err(failed)?
        .timezone;
    let today = user_today(parse_user_timezone_or_default(&timezone));
    Ok(plan_asset(&args, &stored, &env.base_currency(), today))
}

fn asset_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "kind": { "type": "string", "enum": KINDS },
            "name": { "type": "string", "description": "1 to 100 characters." },
            "currency": { "type": "string", "description": "Currency code, such as EUR. Fixed after creation." },
            "currentValue": { "type": "number", "minimum": 0, "description": "Total value (for a liability, the balance owed) on valueDate, in currency." },
            "valueDate": { "type": "string", "description": "YYYY-MM-DD, today or earlier." },
            "purchasePrice": { "type": "number", "minimum": 0, "description": "Assets only: what was paid, for gain." },
            "purchaseDate": { "type": "string", "description": "Assets only: YYYY-MM-DD, before valueDate." },
            "subType": { "type": "string", "description": "Liability: mortgage, auto_loan, student_loan, personal_loan, heloc or other (default). Precious metal: gold, silver, platinum or palladium (required). Other kinds: optional label." },
            "quantity": { "type": "number", "exclusiveMinimum": 0, "description": "Precious metals only: amount held, in unit." },
            "unit": { "type": "string", "enum": WEIGHT_UNITS, "description": "Precious metals only; oz when left out." },
            "linkedAssetId": { "type": "string", "description": "Liabilities only: the stored alternative asset it finances, such as a property." },
            "allowDuplicateName": { "type": "boolean", "description": "Create even though another asset of this kind has this name. Set it only when the user wants that." }
        },
        "required": ["kind", "name", "currency", "currentValue", "valueDate"]
    })
}

/// Keep the kind, currency, dates and link; never names or amounts.
fn asset_for_audit(args: &serde_json::Value) -> serde_json::Value {
    let mut audit = serde_json::Map::new();
    for key in [
        "kind",
        "currency",
        "valueDate",
        "purchaseDate",
        "subType",
        "unit",
        "linkedAssetId",
        "allowDuplicateName",
    ] {
        if let Some(value) = args.get(key) {
            audit.insert(key.to_string(), value.clone());
        }
    }
    serde_json::Value::Object(audit)
}

fn plan_content(plan: &AlternativeAssetPlan) -> serde_json::Value {
    json!({
        "proposed": plan.proposed,
        "nameClash": plan.name_clash,
        "warnings": plan.warnings,
        "errors": plan.errors,
    })
}

/// Preview creating an alternative asset or liability without saving it.
pub struct PrepareAlternativeAsset;

#[async_trait::async_trait]
impl AgentTool for PrepareAlternativeAsset {
    fn name(&self) -> &'static str {
        "prepare_alternative_asset"
    }

    fn description(&self) -> &'static str {
        "Preview creating an alternative asset (PROPERTY, VEHICLE, COLLECTIBLE, PRECIOUS_METAL, PRIVATE_EQUITY, OTHER) or a LIABILITY (mortgage, auto, student or personal loan, HELOC, other), WITHOUT saving. Takes a name, currency, the value or balance owed on a date, and kind details (a liability's type and the asset it finances; a metal's type, quantity and unit; an asset's purchase price and date). A liability created here is a manual balance with no interest rate, term or payment schedule; loans with terms are set up in the app. Returns the asset as it would be created, other assets of that kind with the same name, warnings and errors. A non-base currency registers its exchange rate pair on creation. After commit_alternative_asset, record further dated values or balances with prepare_quote_import / commit_quote_import using the returned assetId (values above zero only). Show the preview to the user, then pass the same arguments to commit_alternative_asset."
    }

    fn input_schema(&self) -> serde_json::Value {
        asset_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::HoldingsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        asset_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let plan = load_plan(env.as_ref(), args).await?;
        let mut content = plan_content(&plan);
        content["ready"] = json!(plan.request.is_some());
        Ok(AgentToolResult { content })
    }
}

/// Create a reviewed alternative asset or liability.
pub struct CommitAlternativeAsset;

#[async_trait::async_trait]
impl AgentTool for CommitAlternativeAsset {
    fn name(&self) -> &'static str {
        "commit_alternative_asset"
    }

    fn description(&self) -> &'static str {
        "Create one alternative asset or liability. This MUTATES data: only call it after prepare_alternative_asset and the user's confirmation, with the same arguments. The asset is checked again; if it has errors (including a name another asset of that kind already has, unless allowDuplicateName is set), nothing is created and committed is false. Creates the asset with its value on valueDate as a manual price, and registers the exchange rate pair of a non-base currency. Returns the assetId to record further dated values or balances with prepare_quote_import / commit_quote_import. Check the result with get_net_worth."
    }

    fn input_schema(&self) -> serde_json::Value {
        asset_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::HoldingsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn is_additive(&self) -> bool {
        true
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        asset_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let plan = load_plan(env.as_ref(), args).await?;
        let mut content = plan_content(&plan);
        let Some(request) = plan.request else {
            content["committed"] = json!(false);
            content["message"] = json!("Nothing was created; see errors.");
            return Ok(AgentToolResult { content });
        };
        let created = service(env.as_ref())?
            .create_alternative_asset(request)
            .await
            .map_err(failed)?;
        content["committed"] = json!(true);
        content["assetId"] = json!(created.asset_id);
        content["message"] = json!(
            "Created. Record further dated values or balances with prepare_quote_import and commit_quote_import using this assetId, then check get_net_worth."
        );
        Ok(AgentToolResult { content })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 8).unwrap()
    }

    fn args(value: serde_json::Value) -> AlternativeAssetArgs {
        serde_json::from_value(value).unwrap()
    }

    fn mortgage() -> serde_json::Value {
        json!({
            "kind": "LIABILITY", "name": "Mortgage", "currency": "eur",
            "currentValue": "250000", "valueDate": "2026-10-31", "subType": "mortgage"
        })
    }

    fn property(id: &str, name: &str) -> Asset {
        Asset {
            id: id.to_string(),
            name: Some(name.to_string()),
            kind: AssetKind::Property,
            quote_ccy: "EUR".to_string(),
            ..Asset::default()
        }
    }

    #[test]
    fn a_liability_is_a_manual_balance_in_its_currency() {
        let mut input = mortgage();
        input["linkedAssetId"] = json!("home");
        let plan = plan_asset(&args(input), &[property("home", "Home")], "USD", today());
        assert!(plan.errors.is_empty(), "{:?}", plan.errors);
        let request = plan.request.unwrap();
        assert_eq!(request.kind, AssetKind::Liability);
        assert_eq!(request.currency, "EUR");
        assert!(request.loan.is_none());
        assert!(request.purchase_price.is_none());
        assert_eq!(request.linked_asset_id.as_deref(), Some("home"));
        assert_eq!(request.metadata.unwrap()["sub_type"], json!("mortgage"));
        assert!(plan.warnings.iter().any(|w| w.contains("EUR/USD")));
        assert!(plan.warnings.iter().any(|w| w.contains("above zero")));
    }

    #[test]
    fn liabilities_refuse_asset_fields_and_unknown_links() {
        for (field, value) in [
            ("purchasePrice", json!(1000)),
            ("purchaseDate", json!("2020-01-01")),
            ("linkedAssetId", json!("missing")),
            ("subType", json!("credit_card")),
        ] {
            let mut input = mortgage();
            input[field] = value;
            let plan = plan_asset(&args(input), &[], "USD", today());
            assert!(plan.request.is_none(), "{field}");
        }
        // A liability can't finance another liability.
        let mut loan = property("loan", "Loan");
        loan.kind = AssetKind::Liability;
        let mut input = mortgage();
        input["linkedAssetId"] = json!("loan");
        assert!(plan_asset(&args(input), &[loan], "USD", today())
            .request
            .is_none());
    }

    #[test]
    fn precious_metals_need_a_metal_and_quantity() {
        let gold = json!({
            "kind": "PRECIOUS_METAL", "name": "Gold bars", "currency": "USD",
            "currentValue": 2600, "valueDate": "2026-11-01", "subType": "gold", "quantity": 1
        });
        let plan = plan_asset(&args(gold.clone()), &[], "USD", today());
        assert!(plan.errors.is_empty(), "{:?}", plan.errors);
        let metadata = plan.request.unwrap().metadata.unwrap();
        assert_eq!(metadata["unit"], json!("oz"));
        assert_eq!(metadata["quantity"], json!("1"));
        for missing in ["subType", "quantity"] {
            let mut input = gold.clone();
            input.as_object_mut().unwrap().remove(missing);
            assert!(plan_asset(&args(input), &[], "USD", today())
                .request
                .is_none());
        }
    }

    #[test]
    fn dates_values_and_kinds_are_checked() {
        for (field, value) in [
            ("valueDate", json!("2026-12-01")),
            ("valueDate", json!("31/10/2026")),
            ("currentValue", json!(-1)),
            ("kind", json!("INVESTMENT")),
            ("name", json!(" ")),
            ("currency", json!("E1R")),
        ] {
            let mut input = mortgage();
            input[field] = value;
            assert!(
                plan_asset(&args(input), &[], "USD", today())
                    .request
                    .is_none(),
                "{field}"
            );
        }
        // A paid-off balance of zero is a valid starting value.
        let mut input = mortgage();
        input["currentValue"] = json!(0);
        assert!(plan_asset(&args(input), &[], "USD", today())
            .request
            .is_some());
        let house = json!({
            "kind": "PROPERTY", "name": "House", "currency": "USD", "currentValue": 500000,
            "valueDate": "2026-01-01", "purchasePrice": 400000, "purchaseDate": "2026-02-01"
        });
        assert!(plan_asset(&args(house), &[], "USD", today())
            .request
            .is_none());
    }

    #[test]
    fn a_name_clash_of_the_same_kind_blocks_unless_allowed() {
        let stored = [property("home", "Home")];
        let house = json!({
            "kind": "PROPERTY", "name": " home ", "currency": "EUR",
            "currentValue": 1, "valueDate": "2026-01-01"
        });
        let plan = plan_asset(&args(house.clone()), &stored, "EUR", today());
        assert_eq!(plan.name_clash.len(), 1);
        assert!(plan.request.is_none());
        let mut allowed = house;
        allowed["allowDuplicateName"] = json!(true);
        assert!(plan_asset(&args(allowed), &stored, "EUR", today())
            .request
            .is_some());
        // Another kind with the same name is no clash.
        let mut liability = mortgage();
        liability["name"] = json!("Home");
        assert!(plan_asset(&args(liability), &stored, "EUR", today())
            .name_clash
            .is_empty());
    }

    #[test]
    fn audit_keeps_no_names_or_amounts() {
        let audit = CommitAlternativeAsset.sanitize_args_for_audit(&json!({
            "kind": "LIABILITY", "name": "Mortgage on 1 Main St", "currency": "EUR",
            "currentValue": 250000, "valueDate": "2026-10-31"
        }));
        assert_eq!(
            audit,
            json!({ "kind": "LIABILITY", "currency": "EUR", "valueDate": "2026-10-31" })
        );
        assert_eq!(
            PrepareAlternativeAsset.input_schema(),
            CommitAlternativeAsset.input_schema()
        );
    }
}
