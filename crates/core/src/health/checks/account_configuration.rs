//! Account configuration health check.
//!
//! Detects accounts that need tracking mode configuration.

use chrono::{Datelike, TimeZone, Utc};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::health::model::{AffectedItem, HealthCategory, HealthIssue, NavigateAction, Severity};
use crate::health::traits::HealthContext;
use crate::utils::time_utils::parse_user_timezone;

/// Information about an account missing tracking mode configuration.
#[derive(Debug, Clone)]
pub struct UnconfiguredAccountInfo {
    /// Account ID
    pub account_id: String,
    /// Account name
    pub account_name: String,
}

/// Health check that detects accounts without tracking mode set.
pub struct AccountConfigurationCheck;

impl AccountConfigurationCheck {
    /// Creates a new account configuration check.
    pub fn new() -> Self {
        Self
    }

    /// Analyzes accounts for missing tracking mode configuration.
    pub fn analyze(
        &self,
        unconfigured_accounts: &[UnconfiguredAccountInfo],
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        let mut issues = Vec::new();

        if !unconfigured_accounts.is_empty() {
            let count = unconfigured_accounts.len();
            let account_ids: Vec<String> = unconfigured_accounts
                .iter()
                .map(|a| a.account_id.clone())
                .collect();
            let data_hash = compute_data_hash(&account_ids);

            let affected_items: Vec<AffectedItem> = unconfigured_accounts
                .iter()
                .map(|a| AffectedItem::account(&a.account_id, &a.account_name))
                .collect();

            let title = if count == 1 {
                "1 account needs setup".to_string()
            } else {
                format!("{} accounts need setup", count)
            };

            let message = if count == 1 {
                "Choose a tracking mode to start syncing data.".to_string()
            } else {
                "Choose tracking modes to start syncing data.".to_string()
            };

            issues.push(
                HealthIssue::builder()
                    .id(format!("unconfigured_accounts:{}", data_hash))
                    .severity(Severity::Warning)
                    .category(HealthCategory::AccountConfiguration)
                    .code("account_unconfigured")
                    .param("count", count as u32)
                    .title(title)
                    .message(message)
                    .affected_count(count as u32)
                    .navigate_action(NavigateAction::to_connect())
                    .affected_items(affected_items)
                    .data_hash(data_hash)
                    .build(),
            );
        }

        issues.extend(self.analyze_timezone(configured_timezone, client_timezone));
        issues
    }

    fn analyze_timezone(
        &self,
        configured_timezone: Option<&str>,
        client_timezone: Option<&str>,
    ) -> Vec<HealthIssue> {
        let configured_timezone = configured_timezone.unwrap_or("").trim();

        if configured_timezone.is_empty() {
            let data_hash = compute_data_hash(&["MISSING".to_string()]);
            return vec![HealthIssue::builder()
                .id(format!("timezone_missing:{}", data_hash))
                .severity(Severity::Warning)
                .category(HealthCategory::SettingsConfiguration)
                .code("account_timezone_missing")
                .title("Timezone not configured".to_string())
                .message(
                    "Set your timezone in General settings to ensure dates match your locale."
                        .to_string(),
                )
                .affected_count(1)
                .navigate_action(NavigateAction::to_general_settings())
                .data_hash(data_hash)
                .build()];
        }

        let configured_tz = match parse_user_timezone(configured_timezone) {
            Ok(tz) => tz,
            Err(_) => {
                let data_hash = compute_data_hash(&[configured_timezone.to_string()]);
                return vec![HealthIssue::builder()
                    .id(format!("timezone_invalid:{}", data_hash))
                    .severity(Severity::Error)
                    .category(HealthCategory::SettingsConfiguration)
                    .code("account_timezone_invalid")
                    .param("timezone", configured_timezone.to_string())
                    .title("Configured timezone is invalid".to_string())
                    .message(format!(
                        "The configured timezone \"{}\" is invalid. Update it in General settings.",
                        configured_timezone
                    ))
                    .affected_count(1)
                    .navigate_action(NavigateAction::to_general_settings())
                    .data_hash(data_hash)
                    .build()];
            }
        };

        let client_timezone = client_timezone.unwrap_or("").trim();
        if client_timezone.is_empty() {
            return Vec::new();
        }

        let client_tz = match parse_user_timezone(client_timezone) {
            Ok(tz) => tz,
            Err(_) => return Vec::new(),
        };

        if are_effectively_same_timezone(configured_tz, client_tz) {
            return Vec::new();
        }

        let data_hash = compute_data_hash(&[
            configured_tz.name().to_string(),
            client_tz.name().to_string(),
        ]);
        vec![HealthIssue::builder()
            .id(format!("timezone_mismatch:{}", data_hash))
            .severity(Severity::Warning)
            .category(HealthCategory::SettingsConfiguration)
            .code("account_timezone_mismatch")
            .param("configured", configured_tz.name())
            .param("browser", client_tz.name())
            .title("Browser and app timezones differ".to_string())
            .message(format!(
                "Configured timezone is \"{}\" but browser timezone is \"{}\". Dates follow the configured timezone.",
                configured_tz.name(),
                client_tz.name()
            ))
            .affected_count(1)
            .navigate_action(NavigateAction::to_general_settings())
            .data_hash(data_hash)
            .build()]
    }
}

impl Default for AccountConfigurationCheck {
    fn default() -> Self {
        Self::new()
    }
}

fn are_effectively_same_timezone(configured_tz: chrono_tz::Tz, client_tz: chrono_tz::Tz) -> bool {
    if configured_tz.name() == client_tz.name() {
        return true;
    }

    let current_year = Utc::now().year();
    [current_year, current_year + 1]
        .into_iter()
        .all(|year| offsets_match_for_year(configured_tz, client_tz, year))
}

fn offsets_match_for_year(
    configured_tz: chrono_tz::Tz,
    client_tz: chrono_tz::Tz,
    year: i32,
) -> bool {
    (1..=12).all(|month| {
        let sample_utc = match Utc.with_ymd_and_hms(year, month, 1, 12, 0, 0).single() {
            Some(sample) => sample,
            None => return false,
        };

        let configured_offset = sample_utc
            .with_timezone(&configured_tz)
            .format("%z")
            .to_string();
        let client_offset = sample_utc
            .with_timezone(&client_tz)
            .format("%z")
            .to_string();
        configured_offset == client_offset
    })
}

/// Computes a data hash for issue identity and change detection.
fn compute_data_hash(account_ids: &[String]) -> String {
    let mut hasher = DefaultHasher::new();
    let mut sorted_ids = account_ids.to_vec();
    sorted_ids.sort();
    for id in &sorted_ids {
        id.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::model::HealthConfig;

    #[test]
    fn test_no_unconfigured_accounts() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], Some("UTC"), None, &ctx);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_single_unconfigured_account() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let accounts = vec![UnconfiguredAccountInfo {
            account_id: "acc_123".to_string(),
            account_name: "My Brokerage".to_string(),
        }];

        let issues = check.analyze(&accounts, Some("UTC"), None, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].category, HealthCategory::AccountConfiguration);
        assert_eq!(issues[0].affected_count, 1);
        assert!(issues[0].title.contains("1 account"));
        assert!(issues[0].navigate_action.is_some());
        assert_eq!(
            issues[0].navigate_action.as_ref().unwrap().route,
            "/connect"
        );
    }

    #[test]
    fn test_multiple_unconfigured_accounts() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let accounts = vec![
            UnconfiguredAccountInfo {
                account_id: "acc_1".to_string(),
                account_name: "Account 1".to_string(),
            },
            UnconfiguredAccountInfo {
                account_id: "acc_2".to_string(),
                account_name: "Account 2".to_string(),
            },
            UnconfiguredAccountInfo {
                account_id: "acc_3".to_string(),
                account_name: "Account 3".to_string(),
            },
        ];

        let issues = check.analyze(&accounts, Some("UTC"), None, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].affected_count, 3);
        assert!(issues[0].title.contains("3 accounts"));
        assert!(issues[0].affected_items.is_some());
        assert_eq!(issues[0].affected_items.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn test_missing_timezone_emits_warning_issue() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], Some(""), None, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].category, HealthCategory::SettingsConfiguration);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert!(issues[0].title.contains("Timezone"));
        assert_eq!(
            issues[0].navigate_action.as_ref().map(|a| a.route.as_str()),
            Some("/settings/general")
        );
    }

    #[test]
    fn test_invalid_configured_timezone_emits_error_issue() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], Some("Mars/Phobos"), None, &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].category, HealthCategory::SettingsConfiguration);
        assert_eq!(issues[0].severity, Severity::Error);
        assert!(issues[0].title.contains("invalid"));
    }

    #[test]
    fn test_timezone_mismatch_emits_warning_issue() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], Some("UTC"), Some("Europe/Paris"), &ctx);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].category, HealthCategory::SettingsConfiguration);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert!(issues[0].title.contains("timezones differ"));
    }

    #[test]
    fn test_timezone_match_emits_no_issue() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(&[], Some("Europe/Paris"), Some("Europe/Paris"), &ctx);
        assert!(issues.is_empty());
    }

    #[test]
    fn test_effectively_same_timezones_emit_no_issue() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(
            &[],
            Some("Australia/Melbourne"),
            Some("Australia/Sydney"),
            &ctx,
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn test_effectively_different_timezones_still_emit_warning() {
        let check = AccountConfigurationCheck::new();
        let ctx = HealthContext::new(HealthConfig::default(), "USD", 100_000.0);

        let issues = check.analyze(
            &[],
            Some("Australia/Melbourne"),
            Some("Australia/Perth"),
            &ctx,
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].category, HealthCategory::SettingsConfiguration);
    }
}
