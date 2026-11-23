//! Account selection for tools that read across the whole portfolio. The
//! portfolio service decides which accounts belong, as it does for the app's
//! screens, so a tool's totals match the app's.

use wealthfolio_core::accounts::AccountPurpose;
use wealthfolio_core::portfolios::AccountScope;

use crate::env::AgentEnvironment;
use crate::tool::AgentToolError;

/// Ids of the accounts the whole portfolio includes for `purpose`.
pub(crate) fn portfolio_account_ids(
    env: &dyn AgentEnvironment,
    purpose: AccountPurpose,
) -> Result<Vec<String>, AgentToolError> {
    env.portfolio_service()
        .resolve_account_scope_for_purpose(&AccountScope::All, &env.base_currency(), purpose)
        .map(|resolved| resolved.account_ids)
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))
}
