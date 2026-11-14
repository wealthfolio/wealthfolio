import { expect, it } from "vitest";
import { invokeTimeoutMs } from "./invoke-timeout";
import policy from "../../../../config/timeouts.json";
import { COMMANDS } from "./web/core";

it.each([
  ["get_accounts", 60_000],
  ["get_settings", 60_000],
  ["future_routine_command", 60_000],
  ["get_historical_valuations", 300_000],
  ["calculate_performance_history", 300_000],
  ["run_retirement_monte_carlo", 300_000],
  ["parse_csv", 300_000],
  ["preview_import_assets", 600_000],
  ["check_activities_import", 600_000],
  ["check_holdings_import", 600_000],
  ["import_activities", 300_000],
  ["import_holdings_csv", 300_000],
  ["cloud_backup_capture", 1_920_000],
  ["device_sync_generate_snapshot_now", 1_920_000],
  ["complete_pairing_with_transfer", 1_920_000],
  ["install_app_update", 1_920_000],
  ["write_pending_export_text_file", 300_000],
  ["write_pending_export_file", 300_000],
  ["export_data_file", 300_000],
  ["cloud_backup_action", 300_000],
  ["device_sync_trigger_cycle", 300_000],
  ["migrate_legacy_classifications", 300_000],
  ["reset_team_sync", 300_000],
])("gives %s its production client deadline", (command, expected) => {
  expect(invokeTimeoutMs(command)).toBe(expected);
});

it("leaves server and proxy margins and classifies each command only once", () => {
  const seen = new Set<string>();
  for (const rule of policy.rules) {
    expect(rule.profile in policy.profiles).toBe(true);
    for (const command of rule.commands) {
      expect(seen.has(command), command).toBe(false);
      seen.add(command);
    }
  }
  for (const profile of Object.values(policy.profiles)) {
    expect(profile.serverMs).toBeGreaterThan(0);
    expect(profile.serverMs).toBeLessThan(profile.clientMs);
    expect(profile.clientMs).toBeLessThan(profile.proxyMs);
  }
});

it("keeps web command routes inside their shared client budgets", () => {
  const profiles: Record<string, typeof policy.profiles.interactive> = policy.profiles;
  for (const [command, route] of Object.entries(COMMANDS)) {
    const rule = policy.rules.find((rule) =>
      rule.paths.some((pattern) => {
        const [prefix, suffix] = pattern.split("*");
        return suffix === undefined
          ? pattern === route.path
          : route.path.startsWith(prefix) && route.path.endsWith(suffix);
      }),
    );
    const server = profiles[rule?.profile ?? "interactive"];
    expect(invokeTimeoutMs(command), `${command}: ${route.path}`).toBeGreaterThan(server.serverMs);
  }
});
