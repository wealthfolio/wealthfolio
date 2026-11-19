//! Checked-in request budgets shared by the web server and frontend adapters.
//! These bound waiting; they do not imply cancellation or transaction rollback.

use std::{collections::HashMap, sync::LazyLock, time::Duration};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeoutBudget {
    pub server_ms: u64,
    pub client_ms: u64,
    pub proxy_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TimeoutRule {
    profile: String,
    commands: Vec<String>,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTimeouts {
    pub connect_ms: u64,
    pub request_ms: u64,
    pub exchange_search_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeoutPolicy {
    profiles: HashMap<String, TimeoutBudget>,
    rules: Vec<TimeoutRule>,
    pub provider: ProviderTimeouts,
}

pub fn policy() -> &'static TimeoutPolicy {
    static POLICY: LazyLock<TimeoutPolicy> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../config/timeouts.json"))
            .expect("checked-in timeout policy must match TimeoutPolicy")
    });
    &POLICY
}

impl TimeoutPolicy {
    pub fn interactive(&self) -> &TimeoutBudget {
        self.budget("interactive")
    }

    fn budget(&self, profile: &str) -> &TimeoutBudget {
        self.profiles
            .get(profile)
            .expect("checked-in timeout rules must name a defined profile")
    }

    /// A '*' at the end matches a route family. Before a suffix it matches one
    /// encoded path segment, for example a backup identifier or filename.
    pub fn for_path(&self, path: &str) -> &TimeoutBudget {
        self.rule_for_path(path)
            .map_or_else(|| self.interactive(), |rule| self.budget(&rule.profile))
    }

    fn rule_for_path(&self, path: &str) -> Option<&TimeoutRule> {
        let path = path
            .strip_prefix("/api/v1")
            .filter(|rest| rest.starts_with('/'))
            .unwrap_or(path);
        self.rules
            .iter()
            .find(|rule| rule.paths.iter().any(|pattern| matches_path(pattern, path)))
    }

    pub fn for_command(&self, command: &str) -> &TimeoutBudget {
        self.rules
            .iter()
            .find(|rule| rule.commands.iter().any(|candidate| candidate == command))
            .map_or_else(|| self.interactive(), |rule| self.budget(&rule.profile))
    }
}

fn matches_path(pattern: &str, path: &str) -> bool {
    let Some((prefix, suffix)) = pattern.split_once('*') else {
        return pattern == path;
    };
    path.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(suffix))
        .is_some_and(|middle| suffix.is_empty() || (!middle.is_empty() && !middle.contains('/')))
}

/// Preserve the legacy override for ordinary requests. Classified operations
/// retain their explicit budgets, as backup/transfer routes did previously.
pub fn request_timeout(path: &str, ordinary: Duration) -> Duration {
    let policy = policy();
    policy.rule_for_path(path).map_or(ordinary, |rule| {
        Duration::from_millis(policy.budget(&rule.profile).server_ms)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_profile_leaves_response_and_proxy_margin() {
        for budget in policy().profiles.values() {
            assert!(budget.server_ms > 0);
            assert!(budget.server_ms < budget.client_ms);
            assert!(budget.client_ms < budget.proxy_ms);
        }
        for rule in &policy().rules {
            policy().budget(&rule.profile);
        }
        let provider = &policy().provider;
        assert!(provider.connect_ms > 0);
        assert!(provider.connect_ms < provider.request_ms);
        assert!(provider.exchange_search_ms > 0);
        assert!(provider.exchange_search_ms < provider.request_ms);
        assert!(provider.request_ms < policy().interactive().server_ms);
    }

    #[test]
    fn import_and_history_routes_have_the_same_class_as_their_commands() {
        for (command, paths, expected) in [
            ("get_accounts", vec!["/accounts"], 45_000),
            (
                "cloud_backup_action",
                vec!["/cloud-backups/action"],
                270_000,
            ),
            ("parse_csv", vec!["/activities/import/parse"], 270_000),
            (
                "device_sync_trigger_cycle",
                vec!["/connect/device/trigger-cycle"],
                270_000,
            ),
            (
                "migrate_legacy_classifications",
                vec!["/taxonomies/migration/run"],
                270_000,
            ),
            ("reset_team_sync", vec!["/sync/team/reset"], 270_000),
            (
                "preview_import_assets",
                vec!["/activities/import/assets/preview"],
                540_000,
            ),
            (
                "check_activities_import",
                vec!["/activities/import/check"],
                540_000,
            ),
            (
                "check_holdings_import",
                vec!["/snapshots/import/check"],
                540_000,
            ),
            ("import_activities", vec!["/activities/import"], 270_000),
            ("import_holdings_csv", vec!["/snapshots/import"], 270_000),
            (
                "calculate_performance_history",
                vec!["/performance/history"],
                270_000,
            ),
            (
                "get_historical_valuations",
                vec!["/valuations/history"],
                270_000,
            ),
            (
                "get_holdings",
                vec!["/holdings", "/holdings/query"],
                270_000,
            ),
            (
                "get_retirement_overview",
                vec!["/goals/id/retirement/overview"],
                270_000,
            ),
            (
                "cloud_backup_capture",
                vec!["/cloud-backups/capture"],
                1_860_000,
            ),
            (
                "complete_pairing_with_transfer",
                vec!["/sync/pairing/complete-with-transfer"],
                1_860_000,
            ),
        ] {
            let command = policy().for_command(command);
            for path in paths {
                for path in [path.to_string(), format!("/api/v1{path}")] {
                    let budget = policy().for_path(&path);
                    assert_eq!(budget.server_ms, expected, "{path}");
                    assert_eq!(budget.client_ms, command.client_ms, "{path}");
                }
            }
        }
    }

    #[test]
    fn route_families_do_not_extend_unrelated_or_malformed_paths() {
        for path in [
            "/holdings-elsewhere",
            "/api/v10/holdings",
            "/cloud-backups//package",
            "/cloud-backups/id/extra/package",
            "/settings",
        ] {
            assert_eq!(policy().for_path(path).server_ms, 45_000, "{path}");
        }
        assert_eq!(
            policy()
                .for_path("/utilities/database/backups/a%2Fb/export")
                .server_ms,
            1_860_000
        );
    }
}
