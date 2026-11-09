//! Account create and update tools (MCP-only).
//!
//! `prepare_account_change` checks one account change against the stored
//! accounts without writing; `commit_account_change` runs the same checks
//! again and saves through the core account service, whose domain events
//! drive FX registration and recalculation as they do for the app's form.
//! Accounts are never deleted here.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::accounts::{
    account_types, normalize_account_number, Account, AccountUpdate, NewAccount, TrackingMode,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// The account name length the app's account form accepts.
const NAME_MIN_CHARS: usize = 2;
const NAME_MAX_CHARS: usize = 50;

const ACCOUNT_TYPES: &[&str] = &[
    account_types::SECURITIES,
    account_types::CASH,
    account_types::CREDIT_CARD,
    account_types::CRYPTOCURRENCY,
];

/// A field that is either left out (keep the stored value) or sent, possibly
/// as null (clear it).
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One account change, as prepare and commit take it. Without `accountId`
/// it creates an account; with it, it updates that account, and fields left
/// out keep their stored values.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountChangeArgs {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub account_type: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub group: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub account_number: Option<Option<String>>,
    #[serde(default)]
    pub tracking_mode: Option<TrackingMode>,
    #[serde(default)]
    pub hidden: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub allow_duplicate_name: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountChangeAction {
    Create,
    Update,
}

/// An account as the preview shows it. The account number is masked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub account_type: String,
    pub currency: String,
    pub group: Option<String>,
    pub account_number: Option<String>,
    pub tracking_mode: TrackingMode,
    pub hidden: bool,
    pub archived: bool,
    /// Sync provider for broker-connected accounts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub connected: bool,
}

impl AccountView {
    fn from_account(account: &Account) -> Self {
        Self {
            id: Some(account.id.clone()),
            name: account.name.clone(),
            account_type: account.account_type.clone(),
            currency: account.currency.clone(),
            group: account.group.clone(),
            account_number: account.account_number.as_deref().map(mask),
            tracking_mode: account.tracking_mode,
            hidden: !account.is_active,
            archived: account.is_archived,
            provider: account.provider.clone(),
            connected: account.provider_account_id.is_some(),
        }
    }
}

/// Show only the last four characters of an account number.
fn mask(number: &str) -> String {
    let chars: Vec<char> = number.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    if chars.len() > 4 {
        format!("••••{tail}")
    } else {
        "••••".to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFieldChange {
    pub field: &'static str,
    pub from: serde_json::Value,
    pub to: serde_json::Value,
}

/// Another account with the same name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameClash {
    pub id: String,
    pub name: String,
    pub hidden: bool,
    pub archived: bool,
}

#[derive(Debug, Clone)]
enum AccountWrite {
    Create(NewAccount),
    Update(AccountUpdate),
}

/// The checked change: what the preview shows and, when it is valid and
/// changes something, the write the commit makes.
#[derive(Debug)]
struct AccountChangePlan {
    action: AccountChangeAction,
    stored: Option<AccountView>,
    proposed: AccountView,
    changes: Vec<AccountFieldChange>,
    name_clash: Vec<NameClash>,
    warnings: Vec<String>,
    errors: Vec<String>,
    write: Option<AccountWrite>,
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn check_name(name: &str, errors: &mut Vec<String>) {
    let count = name.chars().count();
    if !(NAME_MIN_CHARS..=NAME_MAX_CHARS).contains(&count) {
        errors.push(format!(
            "name must be {NAME_MIN_CHARS} to {NAME_MAX_CHARS} characters"
        ));
    }
}

fn check_account_type(account_type: &str, errors: &mut Vec<String>) {
    if !ACCOUNT_TYPES.contains(&account_type) {
        errors.push(format!(
            "accountType must be one of {}",
            ACCOUNT_TYPES.join(", ")
        ));
    }
}

fn is_currency_code(code: &str) -> bool {
    code.len() == 3 && code.chars().all(|c| c.is_ascii_uppercase())
}

/// The account number as storage will keep it: trimmed, and `None` when
/// blank or null.
fn entered_number(value: &Option<String>, errors: &mut Vec<String>) -> Option<String> {
    match normalize_account_number(value.as_deref().unwrap_or_default()) {
        Ok(number) => number,
        Err(error) => {
            errors.push(error.to_string());
            None
        }
    }
}

fn name_clashes(accounts: &[Account], name: &str, own_id: Option<&str>) -> Vec<NameClash> {
    let wanted = name.trim().to_lowercase();
    accounts
        .iter()
        .filter(|account| Some(account.id.as_str()) != own_id)
        .filter(|account| account.name.trim().to_lowercase() == wanted)
        .map(|account| NameClash {
            id: account.id.clone(),
            name: account.name.clone(),
            hidden: !account.is_active,
            archived: account.is_archived,
        })
        .collect()
}

fn mode_switch_warning(from: TrackingMode, to: TrackingMode) -> Option<String> {
    match (from, to) {
        (TrackingMode::Holdings, TrackingMode::Transactions) => Some(
            "Switching from HOLDINGS to TRANSACTIONS: holdings come from activities from now on. The account's holdings snapshots stay stored but are no longer used.".to_string(),
        ),
        (TrackingMode::Transactions, TrackingMode::Holdings) => Some(
            "Switching from TRANSACTIONS to HOLDINGS: holdings come from holdings snapshots from now on. The account's activities stay stored but no longer drive its holdings.".to_string(),
        ),
        _ => None,
    }
}

fn check_tracking_mode(account_type: &str, mode: Option<TrackingMode>, errors: &mut Vec<String>) {
    if mode == Some(TrackingMode::NotSet) {
        errors.push("trackingMode must be TRANSACTIONS or HOLDINGS".to_string());
    }
    if account_type == account_types::CREDIT_CARD && mode == Some(TrackingMode::Holdings) {
        errors.push("Credit card accounts cannot use HOLDINGS tracking mode".to_string());
    }
}

/// Check one change against the stored accounts.
fn plan_change(
    args: &AccountChangeArgs,
    accounts: &[Account],
    base_currency: &str,
) -> AccountChangePlan {
    match trimmed(&args.account_id) {
        None => plan_create(args, accounts, base_currency),
        Some(id) => plan_update(args, accounts, &id),
    }
}

fn plan_create(
    args: &AccountChangeArgs,
    accounts: &[Account],
    base_currency: &str,
) -> AccountChangePlan {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let name = trimmed(&args.name).unwrap_or_default();
    if args.name.is_none() {
        errors.push("name is required to create an account".to_string());
    } else {
        check_name(&name, &mut errors);
    }
    let account_type = trimmed(&args.account_type).unwrap_or_default();
    if args.account_type.is_none() {
        errors.push("accountType is required to create an account".to_string());
    } else {
        check_account_type(&account_type, &mut errors);
    }
    let currency = trimmed(&args.currency).unwrap_or_default();
    if !is_currency_code(&currency) {
        errors.push(
            "currency is required to create an account: a three-letter ISO 4217 code in capitals, such as EUR".to_string(),
        );
    }
    if args.tracking_mode.is_none() {
        errors.push(
            "trackingMode is required to create an account: TRANSACTIONS or HOLDINGS".to_string(),
        );
    }
    check_tracking_mode(&account_type, args.tracking_mode, &mut errors);
    let group = args.group.as_ref().and_then(trimmed);
    let account_number = args
        .account_number
        .as_ref()
        .and_then(|number| entered_number(number, &mut errors));
    let tracking_mode = args.tracking_mode.unwrap_or_default();
    let hidden = args.hidden.unwrap_or(false);
    let archived = args.archived.unwrap_or(false);

    let name_clash = name_clashes(accounts, &name, None);
    if !name_clash.is_empty() && !args.allow_duplicate_name {
        errors.push(format!(
            "Another account is already named \"{name}\". Set allowDuplicateName only if the user wants a second account with that name."
        ));
    }

    warnings.push("The currency cannot be changed after the account is created.".to_string());
    if is_currency_code(&currency) && currency != base_currency {
        warnings.push(format!(
            "Values in {currency} convert to the base currency {base_currency} through exchange rates."
        ));
    }

    let proposed = AccountView {
        id: None,
        name: name.clone(),
        account_type: account_type.clone(),
        currency: currency.clone(),
        group: group.clone(),
        account_number: account_number.as_deref().map(mask),
        tracking_mode,
        hidden,
        archived,
        provider: None,
        connected: false,
    };
    let write = errors
        .is_empty()
        .then_some(AccountWrite::Create(NewAccount {
            id: None,
            name,
            account_type,
            group,
            currency,
            is_default: false,
            is_active: !hidden,
            platform_id: None,
            account_number,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: archived,
            tracking_mode,
        }));
    AccountChangePlan {
        action: AccountChangeAction::Create,
        stored: None,
        proposed,
        changes: Vec::new(),
        name_clash,
        warnings,
        errors,
        write,
    }
}

fn plan_update(args: &AccountChangeArgs, accounts: &[Account], id: &str) -> AccountChangePlan {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let Some(stored) = accounts.iter().find(|account| account.id == id) else {
        return AccountChangePlan {
            action: AccountChangeAction::Update,
            stored: None,
            proposed: AccountView {
                id: Some(id.to_string()),
                name: String::new(),
                account_type: String::new(),
                currency: String::new(),
                group: None,
                account_number: None,
                tracking_mode: TrackingMode::NotSet,
                hidden: false,
                archived: false,
                provider: None,
                connected: false,
            },
            changes: Vec::new(),
            name_clash: Vec::new(),
            warnings,
            errors: vec![format!(
                "No account with id {id}; get_accounts lists the accounts and their ids"
            )],
            write: None,
        };
    };
    let connected = stored.provider_account_id.is_some();

    let name = match &args.name {
        Some(name) => {
            let name = name.trim().to_string();
            check_name(&name, &mut errors);
            name
        }
        None => stored.name.clone(),
    };
    let account_type = match &args.account_type {
        Some(account_type) => {
            let account_type = account_type.trim().to_string();
            check_account_type(&account_type, &mut errors);
            account_type
        }
        None => stored.account_type.clone(),
    };
    if let Some(currency) = trimmed(&args.currency) {
        if currency != stored.currency {
            errors.push(format!(
                "The currency of an existing account cannot change (it is {}); create a new account in {currency} instead",
                stored.currency
            ));
        }
    }
    let group = match &args.group {
        Some(group) => trimmed(group),
        None => stored.group.clone(),
    };
    let account_number = match &args.account_number {
        Some(number) => {
            let number = entered_number(number, &mut errors);
            if connected && number != stored.account_number {
                errors.push(
                    "This account is connected to a broker, which sets its account number"
                        .to_string(),
                );
            }
            number
        }
        None => stored.account_number.clone(),
    };
    let tracking_mode = args.tracking_mode.unwrap_or(stored.tracking_mode);
    check_tracking_mode(&account_type, args.tracking_mode, &mut errors);
    if args.tracking_mode.is_none()
        && account_type == account_types::CREDIT_CARD
        && stored.tracking_mode == TrackingMode::Holdings
    {
        errors.push(
            "Credit card accounts cannot use HOLDINGS tracking mode; set trackingMode to TRANSACTIONS".to_string(),
        );
    }
    if tracking_mode != stored.tracking_mode {
        if connected {
            errors.push(
                "This account is connected to a broker; change its tracking mode in the app, where the broker sync that follows can be reviewed".to_string(),
            );
        } else if let Some(warning) = mode_switch_warning(stored.tracking_mode, tracking_mode) {
            warnings.push(warning);
        }
    }
    if connected {
        warnings.push(format!(
            "This account is connected to {}: its provider link, account number and tracking mode stay as the provider sets them.",
            stored.provider.as_deref().unwrap_or("a broker")
        ));
    }
    let hidden = args.hidden.unwrap_or(!stored.is_active);
    let archived = args.archived.unwrap_or(stored.is_archived);

    let name_clash = if name.trim().to_lowercase() == stored.name.trim().to_lowercase() {
        Vec::new()
    } else {
        name_clashes(accounts, &name, Some(id))
    };
    if !name_clash.is_empty() && !args.allow_duplicate_name {
        errors.push(format!(
            "Another account is already named \"{name}\". Set allowDuplicateName only if the user wants two accounts with that name."
        ));
    }

    let before = AccountView::from_account(stored);
    let proposed = AccountView {
        name: name.clone(),
        account_type: account_type.clone(),
        group: group.clone(),
        account_number: account_number.as_deref().map(mask),
        tracking_mode,
        hidden,
        archived,
        ..before.clone()
    };
    // The masks of two numbers can match, so compare the numbers themselves.
    let number_changed = account_number != stored.account_number;
    let changes: Vec<AccountFieldChange> = [
        ("name", json!(before.name), json!(proposed.name), None),
        (
            "accountType",
            json!(before.account_type),
            json!(proposed.account_type),
            None,
        ),
        ("group", json!(before.group), json!(proposed.group), None),
        (
            "accountNumber",
            json!(before.account_number),
            json!(proposed.account_number),
            Some(number_changed),
        ),
        (
            "trackingMode",
            json!(before.tracking_mode),
            json!(proposed.tracking_mode),
            None,
        ),
        ("hidden", json!(before.hidden), json!(proposed.hidden), None),
        (
            "archived",
            json!(before.archived),
            json!(proposed.archived),
            None,
        ),
    ]
    .into_iter()
    .filter(|(_, from, to, changed)| changed.unwrap_or(from != to))
    .map(|(field, from, to, _)| AccountFieldChange { field, from, to })
    .collect();

    let write = (errors.is_empty() && !changes.is_empty()).then(|| {
        AccountWrite::Update(AccountUpdate {
            id: Some(stored.id.clone()),
            name,
            account_type,
            // Left out, storage keeps the stored group.
            group: args.group.as_ref().map(|_| group),
            is_default: stored.is_default,
            is_active: !hidden,
            platform_id: stored.platform_id.clone(),
            // Left out, storage keeps the stored number; blank clears it.
            account_number: args
                .account_number
                .as_ref()
                .map(|_| account_number.unwrap_or_default()),
            meta: None,
            provider: stored.provider.clone(),
            provider_account_id: stored.provider_account_id.clone(),
            is_archived: args.archived,
            tracking_mode: args.tracking_mode,
        })
    });
    AccountChangePlan {
        action: AccountChangeAction::Update,
        stored: Some(before),
        proposed,
        changes,
        name_clash,
        warnings,
        errors,
        write,
    }
}

async fn load_plan(
    env: &dyn AgentEnvironment,
    args: serde_json::Value,
) -> Result<(AccountChangeArgs, AccountChangePlan), AgentToolError> {
    let args: AccountChangeArgs = serde_json::from_value(args)?;
    let accounts = env
        .account_service()
        .get_all_accounts()
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
    let plan = plan_change(&args, &accounts, &env.base_currency());
    Ok((args, plan))
}

fn change_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "accountId": { "type": "string", "description": "Id of the account to update, from get_accounts. Omit to create an account." },
            "name": { "type": "string", "description": "Account name, 2 to 50 characters. Required to create." },
            "accountType": { "type": "string", "enum": ACCOUNT_TYPES, "description": "Required to create." },
            "currency": { "type": "string", "description": "Three-letter ISO 4217 code in capitals, such as EUR. Required to create; fixed afterwards." },
            "group": { "type": ["string", "null"], "description": "Group name shown in the app; null clears it." },
            "accountNumber": { "type": ["string", "null"], "description": "Account number, up to 64 characters; null clears it. Not for broker-connected accounts." },
            "trackingMode": { "type": "string", "enum": ["TRANSACTIONS", "HOLDINGS"], "description": "TRANSACTIONS: holdings come from activities. HOLDINGS: holdings come from holdings snapshots. Required to create; credit cards use TRANSACTIONS." },
            "hidden": { "type": "boolean", "description": "Hide the account from the app's account lists and get_accounts; its data is kept." },
            "archived": { "type": "boolean", "description": "Archive the account; its data is kept." },
            "allowDuplicateName": { "type": "boolean", "description": "Save even though another account has this name. Set it only when the user wants that." }
        }
    })
}

fn change_for_audit(args: &serde_json::Value) -> serde_json::Value {
    let mut audit = serde_json::Map::new();
    for key in [
        "accountId",
        "name",
        "accountType",
        "currency",
        "group",
        "trackingMode",
        "hidden",
        "archived",
        "allowDuplicateName",
    ] {
        if let Some(value) = args.get(key) {
            audit.insert(key.to_string(), value.clone());
        }
    }
    if args.get("accountNumber").is_some() {
        audit.insert("accountNumber".to_string(), json!("[redacted]"));
    }
    serde_json::Value::Object(audit)
}

/// Output for `prepare_account_change`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAccountChangeOutput {
    pub action: AccountChangeAction,
    /// True when the commit would save this change.
    pub ready: bool,
    pub stored: Option<AccountView>,
    pub proposed: AccountView,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<AccountFieldChange>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub name_clash: Vec<NameClash>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

/// Preview one account create or update without saving it.
pub struct PrepareAccountChange;

#[async_trait::async_trait]
impl AgentTool for PrepareAccountChange {
    fn name(&self) -> &'static str {
        "prepare_account_change"
    }

    fn description(&self) -> &'static str {
        "Preview creating an account, or updating one, WITHOUT saving. Omit accountId to create (name, accountType, currency and trackingMode required); pass accountId to update (fields left out keep their stored values). Settable: name, accountType, currency (create only; it cannot change later), group, accountNumber, trackingMode (TRANSACTIONS or HOLDINGS), hidden and archived. Returns the stored account, the proposed one, the changed fields, accounts with the same name, warnings (fixed currency, the other tracking mode's data left unused, broker-connected accounts) and errors. Broker-connected accounts keep their provider link, account number and tracking mode. Accounts cannot be deleted here. Show the preview to the user, then pass the same arguments to commit_account_change."
    }

    fn input_schema(&self) -> serde_json::Value {
        change_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead, AgentScope::AccountsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        change_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let (_, plan) = load_plan(env.as_ref(), args).await?;
        let output = PrepareAccountChangeOutput {
            action: plan.action,
            ready: plan.write.is_some(),
            stored: plan.stored,
            proposed: plan.proposed,
            changes: plan.changes,
            name_clash: plan.name_clash,
            warnings: plan.warnings,
            errors: plan.errors,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// Output for `commit_account_change`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAccountChangeOutput {
    pub committed: bool,
    pub action: AccountChangeAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountView>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<AccountFieldChange>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    pub message: String,
}

/// Save one reviewed account create or update.
pub struct CommitAccountChange;

#[async_trait::async_trait]
impl AgentTool for CommitAccountChange {
    fn name(&self) -> &'static str {
        "commit_account_change"
    }

    fn description(&self) -> &'static str {
        "Create or update one account. This MUTATES data: only call it after prepare_account_change and the user's confirmation, with the same arguments. The change is checked again; if it has errors (including a name another account already has, unless allowDuplicateName is set), nothing is saved and committed is false. An update that changes nothing saves nothing. Returns the saved account with its id. Holdings and valuations recalculate in the background."
    }

    fn input_schema(&self) -> serde_json::Value {
        change_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::AccountsRead, AgentScope::AccountsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        change_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let (_, plan) = load_plan(env.as_ref(), args).await?;
        let output = |committed, account, plan: AccountChangePlan, message: &str| {
            serde_json::to_value(CommitAccountChangeOutput {
                committed,
                action: plan.action,
                account,
                changes: plan.changes,
                errors: plan.errors,
                message: message.to_string(),
            })
        };
        if !plan.errors.is_empty() {
            return Ok(AgentToolResult {
                content: output(false, None, plan, "Nothing was saved; see errors.")?,
            });
        }
        let service = env.account_service();
        let saved = match plan.write.clone() {
            None => {
                let account = plan.stored.clone();
                return Ok(AgentToolResult {
                    content: output(true, account, plan, "Nothing to change.")?,
                });
            }
            Some(AccountWrite::Create(new_account)) => service.create_account(new_account).await,
            Some(AccountWrite::Update(update)) => service.update_account(update).await,
        }
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        let message = match plan.action {
            AccountChangeAction::Create => "Account created.",
            AccountChangeAction::Update => "Account updated.",
        };
        Ok(AgentToolResult {
            content: output(true, Some(AccountView::from_account(&saved)), plan, message)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, name: &str) -> Account {
        Account {
            id: id.to_string(),
            name: name.to_string(),
            account_type: account_types::SECURITIES.to_string(),
            group: Some("Investments".to_string()),
            currency: "EUR".to_string(),
            is_default: true,
            is_active: true,
            tracking_mode: TrackingMode::Transactions,
            meta: Some("{\"accounting\":{}}".to_string()),
            ..Account::default()
        }
    }

    fn args(value: serde_json::Value) -> AccountChangeArgs {
        serde_json::from_value(value).unwrap()
    }

    fn create_args() -> serde_json::Value {
        json!({ "name": "Brokerage", "accountType": "SECURITIES", "currency": "USD", "trackingMode": "HOLDINGS" })
    }

    #[test]
    fn create_builds_the_account_the_form_would() {
        let plan = plan_change(&args(create_args()), &[], "EUR");
        assert!(plan.errors.is_empty(), "{:?}", plan.errors);
        let Some(AccountWrite::Create(new_account)) = plan.write else {
            panic!("expected a create");
        };
        assert_eq!(new_account.name, "Brokerage");
        assert_eq!(new_account.currency, "USD");
        assert_eq!(new_account.tracking_mode, TrackingMode::Holdings);
        assert!(new_account.is_active);
        assert!(!new_account.is_archived);
        assert!(!new_account.is_default);
        assert!(new_account.provider.is_none());
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("cannot be changed")));
        assert!(plan.warnings.iter().any(|warning| warning.contains("EUR")));
    }

    #[test]
    fn create_requires_the_fields_the_form_requires() {
        let plan = plan_change(&args(json!({})), &[], "EUR");
        assert!(plan.write.is_none());
        for field in ["name", "accountType", "currency", "trackingMode"] {
            assert!(
                plan.errors.iter().any(|error| error.contains(field)),
                "{field}: {:?}",
                plan.errors
            );
        }
        let mut lower = create_args();
        lower["currency"] = json!("usd");
        assert!(plan_change(&args(lower), &[], "EUR").write.is_none());
        let mut short = create_args();
        short["name"] = json!(" B ");
        assert!(plan_change(&args(short), &[], "EUR").write.is_none());
        let mut not_set = create_args();
        not_set["trackingMode"] = json!("NOT_SET");
        assert!(plan_change(&args(not_set), &[], "EUR").write.is_none());
    }

    #[test]
    fn credit_cards_cannot_track_holdings() {
        let mut card = create_args();
        card["accountType"] = json!("CREDIT_CARD");
        let plan = plan_change(&args(card), &[], "EUR");
        assert!(plan.write.is_none());
        assert!(plan.errors.iter().any(|error| error.contains("HOLDINGS")));

        let mut stored = account("a", "Savings");
        stored.tracking_mode = TrackingMode::Holdings;
        let plan = plan_change(
            &args(json!({ "accountId": "a", "accountType": "CREDIT_CARD" })),
            &[stored],
            "EUR",
        );
        assert!(plan.write.is_none());
        assert!(plan.errors.iter().any(|error| error.contains("HOLDINGS")));
    }

    #[test]
    fn a_name_clash_blocks_unless_allowed() {
        let stored = [account("a", "Brokerage")];
        let mut clash = create_args();
        clash["name"] = json!(" brokerage ");
        let plan = plan_change(&args(clash.clone()), &stored, "EUR");
        assert_eq!(plan.name_clash.len(), 1);
        assert_eq!(plan.name_clash[0].id, "a");
        assert!(plan.write.is_none());

        clash["allowDuplicateName"] = json!(true);
        let plan = plan_change(&args(clash), &stored, "EUR");
        assert_eq!(plan.name_clash.len(), 1);
        assert!(plan.write.is_some());

        // Renaming an account to its own name is no clash.
        let plan = plan_change(
            &args(json!({ "accountId": "a", "name": "BROKERAGE" })),
            &stored,
            "EUR",
        );
        assert!(plan.name_clash.is_empty());
        assert!(plan.errors.is_empty());
    }

    #[test]
    fn update_keeps_omitted_fields_and_lists_changes() {
        let mut stored = account("a", "Brokerage");
        stored.account_number = Some("NL91ABNA0417164300".to_string());
        let plan = plan_change(
            &args(json!({ "accountId": "a", "name": "Main brokerage", "hidden": true })),
            &[stored],
            "EUR",
        );
        assert!(plan.errors.is_empty(), "{:?}", plan.errors);
        let fields: Vec<_> = plan.changes.iter().map(|change| change.field).collect();
        assert_eq!(fields, vec!["name", "hidden"]);
        assert_eq!(
            plan.stored.as_ref().unwrap().account_number.as_deref(),
            Some("••••4300")
        );
        let Some(AccountWrite::Update(update)) = plan.write else {
            panic!("expected an update");
        };
        assert_eq!(update.name, "Main brokerage");
        assert!(!update.is_active);
        assert!(update.is_default, "is_default is sent back as stored");
        // Left out, storage keeps the stored values.
        assert_eq!(update.group, None);
        assert_eq!(update.account_number, None);
        assert_eq!(update.meta, None);
        assert_eq!(update.tracking_mode, None);
        assert_eq!(update.is_archived, None);
    }

    #[test]
    fn update_clears_group_and_number_with_null() {
        let mut stored = account("a", "Brokerage");
        stored.account_number = Some("12345".to_string());
        let plan = plan_change(
            &args(json!({ "accountId": "a", "group": null, "accountNumber": null })),
            &[stored],
            "EUR",
        );
        let Some(AccountWrite::Update(update)) = plan.write else {
            panic!("expected an update");
        };
        assert_eq!(update.group, Some(None));
        assert_eq!(update.account_number.as_deref(), Some(""));
    }

    #[test]
    fn an_update_that_changes_nothing_writes_nothing() {
        let plan = plan_change(
            &args(json!({ "accountId": "a", "name": "Brokerage", "currency": "EUR" })),
            &[account("a", "Brokerage")],
            "EUR",
        );
        assert!(plan.errors.is_empty());
        assert!(plan.changes.is_empty());
        assert!(plan.write.is_none());
    }

    #[test]
    fn currency_is_fixed_after_creation() {
        let plan = plan_change(
            &args(json!({ "accountId": "a", "currency": "USD" })),
            &[account("a", "Brokerage")],
            "EUR",
        );
        assert!(plan.write.is_none());
        assert!(plan.errors.iter().any(|error| error.contains("currency")));
    }

    #[test]
    fn a_tracking_mode_switch_warns_that_the_other_data_goes_unused() {
        let plan = plan_change(
            &args(json!({ "accountId": "a", "trackingMode": "HOLDINGS" })),
            &[account("a", "Brokerage")],
            "EUR",
        );
        assert!(plan.write.is_some());
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("activities stay stored")));
    }

    #[test]
    fn connected_accounts_keep_their_mode_and_number() {
        let mut stored = account("a", "Broker");
        stored.provider = Some("SNAPTRADE".to_string());
        stored.provider_account_id = Some("remote-1".to_string());
        stored.account_number = Some("9999".to_string());
        for change in [
            json!({ "accountId": "a", "trackingMode": "HOLDINGS" }),
            json!({ "accountId": "a", "accountNumber": "1234" }),
        ] {
            let plan = plan_change(&args(change), std::slice::from_ref(&stored), "EUR");
            assert!(plan.write.is_none(), "{:?}", plan.changes);
        }
        let plan = plan_change(
            &args(json!({ "accountId": "a", "name": "Broker main" })),
            &[stored],
            "EUR",
        );
        let Some(AccountWrite::Update(update)) = plan.write else {
            panic!("expected an update");
        };
        assert_eq!(update.provider.as_deref(), Some("SNAPTRADE"));
        assert_eq!(update.provider_account_id.as_deref(), Some("remote-1"));
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.contains("SNAPTRADE")));
    }

    #[test]
    fn unknown_accounts_and_fields_are_errors() {
        let plan = plan_change(&args(json!({ "accountId": "missing" })), &[], "EUR");
        assert!(plan.write.is_none());
        assert!(plan.errors[0].contains("missing"));
        assert!(serde_json::from_value::<AccountChangeArgs>(json!({ "type": "CASH" })).is_err());
    }

    #[test]
    fn audit_redacts_the_account_number() {
        let audit = CommitAccountChange.sanitize_args_for_audit(&json!({
            "accountId": "a", "accountNumber": "NL91ABNA0417164300", "note": "extra"
        }));
        assert_eq!(
            audit,
            json!({ "accountId": "a", "accountNumber": "[redacted]" })
        );
    }

    #[test]
    fn prepare_and_commit_take_the_same_arguments() {
        assert_eq!(
            PrepareAccountChange.input_schema(),
            CommitAccountChange.input_schema()
        );
    }
}
