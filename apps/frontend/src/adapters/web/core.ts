// Web adapter core - Internal invoke function, COMMANDS map, and helpers
// This module exports invoke, logger, and platform constants for shared modules

import { notifyUnauthorized } from "@/lib/auth-token";
import type { Logger } from "../types";

/** True when running in the desktop (Tauri) environment */
export const isDesktop = false;

/** True when running in the web environment */
export const isWeb = true;

export const API_PREFIX = "/api/v1";
export const EVENTS_ENDPOINT = `${API_PREFIX}/events/stream`;
export const AI_CHAT_STREAM_ENDPOINT = `${API_PREFIX}/ai/chat/stream`;

const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

// Commands that legitimately do batched network I/O over many symbols (Yahoo
// Finance lookups during CSV import). Larger imports — especially Options —
// can exceed the default 5-minute safety net. See issue #884.
const INVOKE_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  preview_import_assets: 600_000,
  check_activities_import: 600_000,
};

type CommandMap = Record<string, { method: string; path: string }>;

export const COMMANDS: CommandMap = {
  get_accounts: { method: "GET", path: "/accounts" },
  create_account: { method: "POST", path: "/accounts" },
  update_account: { method: "PUT", path: "/accounts" },
  delete_account: { method: "DELETE", path: "/accounts" },
  get_portfolios: { method: "GET", path: "/portfolios" },
  create_portfolio: { method: "POST", path: "/portfolios" },
  update_portfolio_entry: { method: "PUT", path: "/portfolios" },
  delete_portfolio_entry: { method: "DELETE", path: "/portfolios" },
  get_settings: { method: "GET", path: "/settings" },
  update_settings: { method: "PUT", path: "/settings" },
  is_auto_update_check_enabled: { method: "GET", path: "/settings/auto-update-enabled" },
  get_app_info: { method: "GET", path: "/app/info" },
  check_update: { method: "GET", path: "/app/check-update" },
  backup_database: { method: "POST", path: "/utilities/database/backup" },
  list_database_backups: { method: "GET", path: "/utilities/database/backups" },
  delete_database_backup: { method: "DELETE", path: "/utilities/database/backups" },
  get_holdings: { method: "POST", path: "/holdings/query" },
  get_holdings_list: { method: "POST", path: "/holdings/list/query" },
  get_holding: { method: "GET", path: "/holdings/item" },
  get_asset_holdings: { method: "GET", path: "/holdings/by-asset" },
  get_asset_lots: { method: "GET", path: "/holdings/lots" },
  get_historical_valuations: { method: "GET", path: "/valuations/history" },
  get_latest_valuations: { method: "GET", path: "/valuations/latest" },
  get_current_valuation: { method: "POST", path: "/valuations/current/query" },
  get_portfolio_allocations: { method: "POST", path: "/allocations/query" },
  get_holdings_by_allocation: { method: "POST", path: "/allocations/holdings/query" },
  // Snapshot management
  get_snapshots: { method: "GET", path: "/snapshots" },
  get_snapshot_by_date: { method: "GET", path: "/snapshots/holdings" },
  delete_snapshot: { method: "DELETE", path: "/snapshots" },
  save_manual_holdings: { method: "POST", path: "/snapshots" },
  import_holdings_csv: { method: "POST", path: "/snapshots/import" },
  check_holdings_import: { method: "POST", path: "/snapshots/import/check" },
  update_portfolio: { method: "POST", path: "/portfolio/update" },
  recalculate_portfolio: { method: "POST", path: "/portfolio/recalculate" },
  // Performance
  calculate_accounts_simple_performance: { method: "POST", path: "/performance/accounts/simple" },
  calculate_performance_history: { method: "POST", path: "/performance/history" },
  calculate_performance_summary: { method: "POST", path: "/performance/summary" },
  get_performance_summaries: { method: "POST", path: "/performance/summaries" },
  get_income_summary: { method: "POST", path: "/income/summary/query" },
  // Goals
  get_goals: { method: "GET", path: "/goals" },
  get_goal: { method: "GET", path: "/goals" },
  create_goal: { method: "POST", path: "/goals" },
  update_goal: { method: "PUT", path: "/goals" },
  delete_goal: { method: "DELETE", path: "/goals" },
  get_goal_funding: { method: "GET", path: "/goals" },
  save_goal_funding: { method: "PUT", path: "/goals" },
  get_goal_plan: { method: "GET", path: "/goals" },
  save_goal_plan: { method: "POST", path: "/goals/plan" },
  delete_goal_plan: { method: "DELETE", path: "/goals" },
  refresh_goal_summary: { method: "POST", path: "/goals" },
  refresh_all_goal_summaries: { method: "POST", path: "/goals/refresh-summaries" },
  get_retirement_overview: { method: "GET", path: "/goals" },
  get_save_up_overview: { method: "GET", path: "/goals" },
  preview_save_up_overview: { method: "POST", path: "/goals/save-up/preview" },
  // Retirement plan simulations
  calculate_retirement_projection: { method: "POST", path: "/goals/retirement/projection" },
  run_retirement_monte_carlo: { method: "POST", path: "/goals/retirement/monte-carlo" },
  run_retirement_stress_tests: { method: "POST", path: "/goals/retirement/stress-tests" },
  run_retirement_scenario_analysis: {
    method: "POST",
    path: "/goals/retirement/scenario-analysis",
  },
  run_retirement_decision_sensitivity_map: {
    method: "POST",
    path: "/goals/retirement/decision-sensitivity-map",
  },
  run_retirement_sorr: { method: "POST", path: "/goals/retirement/sequence-of-returns" },
  // FX
  get_latest_exchange_rates: { method: "GET", path: "/exchange-rates/latest" },
  update_exchange_rate: { method: "PUT", path: "/exchange-rates" },
  add_exchange_rate: { method: "POST", path: "/exchange-rates" },
  delete_exchange_rate: { method: "DELETE", path: "/exchange-rates" },
  // Activities
  search_activities: { method: "POST", path: "/activities/search" },
  create_activity: { method: "POST", path: "/activities" },
  update_activity: { method: "PUT", path: "/activities" },
  save_activities: { method: "POST", path: "/activities/bulk" },
  delete_activity: { method: "DELETE", path: "/activities" },
  get_transfer_pair_for_activity: { method: "GET", path: "/activities" },
  find_transfer_match_candidates: { method: "POST", path: "/activities/transfer-match-candidates" },
  save_internal_transfer_pair: { method: "POST", path: "/activities/transfer-pair" },
  link_transfer_activities: { method: "POST", path: "/activities/link" },
  unlink_transfer_activities: { method: "POST", path: "/activities/unlink" },
  // Activity import
  check_activities_import: { method: "POST", path: "/activities/import/check" },
  preview_import_assets: { method: "POST", path: "/activities/import/assets/preview" },
  import_activities: { method: "POST", path: "/activities/import" },
  get_account_import_mapping: { method: "GET", path: "/activities/import/mapping" },
  save_account_import_mapping: { method: "POST", path: "/activities/import/mapping" },
  link_account_template: { method: "POST", path: "/activities/import/templates/link" },
  list_import_templates: { method: "GET", path: "/activities/import/templates" },
  get_import_template: { method: "GET", path: "/activities/import/templates/item" },
  save_import_template: { method: "POST", path: "/activities/import/templates" },
  delete_import_template: { method: "DELETE", path: "/activities/import/templates" },
  // Market data providers
  get_exchanges: { method: "GET", path: "/exchanges" },
  get_market_data_providers: { method: "GET", path: "/providers" },
  get_market_data_providers_settings: { method: "GET", path: "/providers/settings" },
  update_market_data_provider_settings: { method: "PUT", path: "/providers/settings" },
  // Custom providers
  get_custom_providers: { method: "GET", path: "/custom-providers" },
  create_custom_provider: { method: "POST", path: "/custom-providers" },
  update_custom_provider: { method: "PUT", path: "/custom-providers" },
  delete_custom_provider: { method: "DELETE", path: "/custom-providers" },
  test_custom_provider_source: { method: "POST", path: "/custom-providers/test-source" },
  // Contribution limits
  get_contribution_limits: { method: "GET", path: "/limits" },
  create_contribution_limit: { method: "POST", path: "/limits" },
  update_contribution_limit: { method: "PUT", path: "/limits" },
  delete_contribution_limit: { method: "DELETE", path: "/limits" },
  calculate_deposits_for_contribution_limit: { method: "GET", path: "/limits" },
  // Asset profile
  get_assets: { method: "GET", path: "/assets" },
  create_asset: { method: "POST", path: "/assets" },
  delete_asset: { method: "DELETE", path: "/assets" },
  get_asset_profile: { method: "GET", path: "/assets/profile" },
  update_asset_profile: { method: "PUT", path: "/assets/profile" },
  update_quote_mode: { method: "PUT", path: "/assets/pricing-mode" },
  // Market data
  search_symbol: { method: "GET", path: "/market-data/search" },
  resolve_symbol_quote: { method: "GET", path: "/market-data/resolve-currency" },
  get_quote_history: { method: "GET", path: "/market-data/quotes/history" },
  fetch_dividends: { method: "GET", path: "/market-data/dividends" },
  get_latest_quotes: { method: "POST", path: "/market-data/quotes/latest" },
  update_quote: { method: "PUT", path: "/market-data/quotes" },
  delete_quote: { method: "DELETE", path: "/market-data/quotes/id" },
  check_quotes_import: { method: "POST", path: "/market-data/quotes/check" },
  import_quotes_csv: { method: "POST", path: "/market-data/quotes/import" },
  synch_quotes: { method: "POST", path: "/market-data/sync/history" },
  sync_market_data: { method: "POST", path: "/market-data/sync" },
  // Secrets
  set_secret: { method: "POST", path: "/secrets" },
  get_secret: { method: "GET", path: "/secrets" },
  delete_secret: { method: "DELETE", path: "/secrets" },
  set_addon_secret: { method: "POST", path: "/addons" },
  get_addon_secret: { method: "GET", path: "/addons" },
  delete_addon_secret: { method: "DELETE", path: "/addons" },
  addon_network_request: { method: "POST", path: "/addons" },
  // Taxonomies
  get_taxonomies: { method: "GET", path: "/taxonomies" },
  get_taxonomy: { method: "GET", path: "/taxonomies" },
  create_taxonomy: { method: "POST", path: "/taxonomies" },
  update_taxonomy: { method: "PUT", path: "/taxonomies" },
  delete_taxonomy: { method: "DELETE", path: "/taxonomies" },
  create_category: { method: "POST", path: "/taxonomies/categories" },
  update_category: { method: "PUT", path: "/taxonomies/categories" },
  delete_category: { method: "DELETE", path: "/taxonomies" },
  move_category: { method: "POST", path: "/taxonomies/categories/move" },
  import_taxonomy_json: { method: "POST", path: "/taxonomies/import" },
  export_taxonomy_json: { method: "GET", path: "/taxonomies" },
  get_asset_taxonomy_assignments: { method: "GET", path: "/taxonomies/assignments/asset" },
  assign_asset_to_category: { method: "POST", path: "/taxonomies/assignments" },
  replace_asset_taxonomy_assignments: { method: "PUT", path: "/taxonomies/assignments/asset" },
  remove_asset_taxonomy_assignment: { method: "DELETE", path: "/taxonomies/assignments" },
  get_migration_status: { method: "GET", path: "/taxonomies/migration/status" },
  migrate_legacy_classifications: { method: "POST", path: "/taxonomies/migration/run" },
  // Spending budget
  get_budget: { method: "GET", path: "/spending/budget" },
  upsert_budget_target: { method: "POST", path: "/spending/budget/targets" },
  delete_budget_target: { method: "DELETE", path: "/spending/budget/targets" },
  upsert_budget_rollover_setting: { method: "POST", path: "/spending/budget/rollovers" },
  delete_budget_rollover_setting: { method: "DELETE", path: "/spending/budget/rollovers" },
  create_budget_group: { method: "POST", path: "/spending/budget/groups" },
  update_budget_group: { method: "PUT", path: "/spending/budget/groups" },
  delete_budget_group: { method: "DELETE", path: "/spending/budget/groups" },
  assign_category_to_group: { method: "POST", path: "/spending/budget/group-assignments" },
  reset_budget_groups: { method: "POST", path: "/spending/budget/groups/reset" },
  copy_budget_targets: { method: "POST", path: "/spending/budget/copy" },
  // Spending settings
  get_spending_settings: { method: "GET", path: "/spending/settings" },
  update_spending_settings: { method: "PUT", path: "/spending/settings" },
  // Spending cash activities + assignments
  list_cash_activities: { method: "GET", path: "/spending/cash-activities" },
  search_cash_activities: { method: "POST", path: "/spending/cash-activities/search" },
  set_activity_event: { method: "PUT", path: "/spending/cash-activities" },
  get_activity_assignments: { method: "GET", path: "/spending/activities" },
  assign_activity_category: { method: "PUT", path: "/spending/activities" },
  unassign_activity_category: { method: "DELETE", path: "/spending/activities" },
  get_activity_splits: { method: "GET", path: "/spending/activities" },
  replace_activity_splits: { method: "PUT", path: "/spending/activities" },
  clear_activity_splits: { method: "DELETE", path: "/spending/activities" },
  bulk_assign_categories: { method: "POST", path: "/spending/assignments/bulk" },
  // Spending categorization rules
  list_categorization_rules: { method: "GET", path: "/spending/rules" },
  create_categorization_rule: { method: "POST", path: "/spending/rules" },
  update_categorization_rule: { method: "PUT", path: "/spending/rules" },
  delete_categorization_rule: { method: "DELETE", path: "/spending/rules" },
  rerun_categorization_rules: { method: "POST", path: "/spending/rules/rerun" },
  list_rule_presets: { method: "GET", path: "/spending/rule-presets" },
  import_rule_preset: { method: "POST", path: "/spending/rule-presets" },
  remove_rule_preset: { method: "DELETE", path: "/spending/rule-presets" },
  // Spending events + event types
  list_event_types: { method: "GET", path: "/spending/event-types" },
  create_event_type: { method: "POST", path: "/spending/event-types" },
  update_event_type: { method: "PUT", path: "/spending/event-types" },
  delete_event_type: { method: "DELETE", path: "/spending/event-types" },
  list_events: { method: "GET", path: "/spending/events" },
  create_event: { method: "POST", path: "/spending/events" },
  update_event: { method: "PUT", path: "/spending/events" },
  delete_event: { method: "DELETE", path: "/spending/events" },
  get_event_spending_summaries: { method: "POST", path: "/spending/event-spending-summaries" },
  // Spending analytics
  get_spending_report: { method: "POST", path: "/spending/report" },
  get_spending_insight: { method: "POST", path: "/spending/insight" },
  // Health Center
  get_health_status: { method: "GET", path: "/health/status" },
  run_health_checks: { method: "POST", path: "/health/check" },
  dismiss_health_issue: { method: "POST", path: "/health/dismiss" },
  restore_health_issue: { method: "POST", path: "/health/restore" },
  get_dismissed_health_issues: { method: "GET", path: "/health/dismissed" },
  execute_health_fix: { method: "POST", path: "/health/fix" },
  get_health_config: { method: "GET", path: "/health/config" },
  update_health_config: { method: "PUT", path: "/health/config" },
  // Addons
  list_installed_addons: { method: "GET", path: "/addons/installed" },
  install_addon_zip: { method: "POST", path: "/addons/install-zip" },
  toggle_addon: { method: "POST", path: "/addons/toggle" },
  uninstall_addon: { method: "DELETE", path: "/addons" },
  load_addon_for_runtime: { method: "GET", path: "/addons/runtime" },
  get_enabled_addons_on_startup: { method: "GET", path: "/addons/enabled-on-startup" },
  extract_addon_zip: { method: "POST", path: "/addons/extract" },
  // Addon store + staging
  fetch_addon_store_listings: { method: "GET", path: "/addons/store/listings" },
  submit_addon_rating: { method: "POST", path: "/addons/store/ratings" },
  get_addon_ratings: { method: "GET", path: "/addons/store/ratings" },
  check_addon_update: { method: "POST", path: "/addons/store/check-update" },
  check_all_addon_updates: { method: "POST", path: "/addons/store/check-all" },
  update_addon_from_store_by_id: { method: "POST", path: "/addons/store/update" },
  download_addon_to_staging: { method: "POST", path: "/addons/store/staging/download" },
  install_addon_from_staging: { method: "POST", path: "/addons/store/install-from-staging" },
  update_addon_network_approvals: { method: "POST", path: "/addons/network-approvals" },
  clear_addon_staging: { method: "DELETE", path: "/addons/store/staging" },
  // Addon key-value storage
  get_addon_storage_item: { method: "GET", path: "/addons/storage" },
  set_addon_storage_item: { method: "PUT", path: "/addons/storage" },
  delete_addon_storage_item: { method: "DELETE", path: "/addons/storage" },
  // Device Sync - Device management
  register_device: { method: "POST", path: "/sync/device/register" },
  get_device: { method: "GET", path: "/sync/device" },
  list_devices: { method: "GET", path: "/sync/devices" },
  update_device: { method: "PATCH", path: "/sync/device" },
  delete_device: { method: "DELETE", path: "/sync/device" },
  revoke_device: { method: "POST", path: "/sync/device" },
  // Device Sync - Team keys (E2EE)
  initialize_team_keys: { method: "POST", path: "/sync/keys/initialize" },
  commit_initialize_team_keys: { method: "POST", path: "/sync/keys/initialize/commit" },
  rotate_team_keys: { method: "POST", path: "/sync/keys/rotate" },
  commit_rotate_team_keys: { method: "POST", path: "/sync/keys/rotate/commit" },
  reset_team_sync: { method: "POST", path: "/sync/team/reset" },
  // Device Sync - Pairing (Issuer - Trusted Device)
  create_pairing: { method: "POST", path: "/sync/pairing" },
  get_pairing: { method: "GET", path: "/sync/pairing" },
  approve_pairing: { method: "POST", path: "/sync/pairing" },
  complete_pairing: { method: "POST", path: "/sync/pairing" },
  cancel_pairing: { method: "POST", path: "/sync/pairing" },
  // Device Sync - Pairing (Claimer - New Device)
  claim_pairing: { method: "POST", path: "/sync/pairing/claim" },
  get_pairing_messages: { method: "GET", path: "/sync/pairing" },
  confirm_pairing: { method: "POST", path: "/sync/pairing" },
  complete_pairing_with_transfer: {
    method: "POST",
    path: "/sync/pairing/complete-with-transfer",
  },
  confirm_pairing_with_bootstrap: {
    method: "POST",
    path: "/sync/pairing/confirm-with-bootstrap",
  },
  begin_pairing_confirm: { method: "POST", path: "/sync/pairing/flow/begin" },
  get_pairing_flow_state: { method: "POST", path: "/sync/pairing/flow/state" },
  approve_pairing_overwrite: { method: "POST", path: "/sync/pairing/flow/approve-overwrite" },
  cancel_pairing_flow: { method: "POST", path: "/sync/pairing/flow/cancel" },
  // Wealthfolio Connect (Broker Sync)
  store_sync_session: { method: "POST", path: "/connect/session" },
  post_login_bootstrap: { method: "POST", path: "/connect/post-login-bootstrap" },
  clear_sync_session: { method: "DELETE", path: "/connect/session" },
  get_sync_session_status: { method: "GET", path: "/connect/session/status" },
  restore_sync_session: { method: "GET", path: "/connect/session/restore" },
  list_broker_connections: { method: "GET", path: "/connect/connections" },
  list_broker_accounts: { method: "GET", path: "/connect/accounts" },
  sync_broker_data: { method: "POST", path: "/connect/sync" },
  broker_ingest_run: { method: "POST", path: "/connect/sync" },
  sync_broker_connections: { method: "POST", path: "/connect/sync/connections" },
  sync_broker_accounts: { method: "POST", path: "/connect/sync/accounts" },
  sync_broker_activities: { method: "POST", path: "/connect/sync/activities" },
  get_subscription_plans: { method: "GET", path: "/connect/plans" },
  get_subscription_plans_public: { method: "GET", path: "/connect/plans/public" },
  get_user_info: { method: "GET", path: "/connect/user" },
  // Local data queries (from local database)
  get_synced_accounts: { method: "GET", path: "/connect/synced-accounts" },
  get_platforms: { method: "GET", path: "/connect/platforms" },
  get_broker_sync_states: { method: "GET", path: "/connect/sync-states" },
  get_broker_ingest_states: { method: "GET", path: "/connect/sync-states" },
  get_import_runs: { method: "GET", path: "/connect/import-runs" },
  get_data_import_runs: { method: "GET", path: "/connect/import-runs" },
  get_broker_sync_profile: { method: "GET", path: "/connect/broker-sync-profile" },
  save_broker_sync_profile_rules: { method: "POST", path: "/connect/broker-sync-profile" },
  // Device Sync / Enrollment
  get_device_sync_state: { method: "GET", path: "/connect/device/sync-state" },
  enable_device_sync: { method: "POST", path: "/connect/device/enable" },
  clear_device_sync_data: { method: "DELETE", path: "/connect/device/sync-data" },
  reinitialize_device_sync: { method: "POST", path: "/connect/device/reinitialize" },
  device_sync_engine_status: { method: "GET", path: "/connect/device/engine-status" },
  device_sync_pairing_source_status: {
    method: "GET",
    path: "/connect/device/pairing-source-status",
  },
  device_sync_bootstrap_overwrite_check: {
    method: "GET",
    path: "/connect/device/bootstrap-overwrite-check",
  },
  device_sync_reconcile_ready_state: {
    method: "POST",
    path: "/connect/device/reconcile-ready-state",
  },
  device_sync_bootstrap_snapshot_if_needed: {
    method: "POST",
    path: "/connect/device/bootstrap-snapshot",
  },
  device_sync_trigger_cycle: { method: "POST", path: "/connect/device/trigger-cycle" },
  device_sync_start_background_engine: {
    method: "POST",
    path: "/connect/device/start-background",
  },
  device_sync_stop_background_engine: {
    method: "POST",
    path: "/connect/device/stop-background",
  },
  device_sync_generate_snapshot_now: {
    method: "POST",
    path: "/connect/device/generate-snapshot",
  },
  device_sync_cancel_snapshot_upload: {
    method: "POST",
    path: "/connect/device/cancel-snapshot",
  },
  // Net Worth
  get_net_worth: { method: "GET", path: "/net-worth" },
  get_net_worth_history: { method: "GET", path: "/net-worth/history" },
  // AI Providers
  get_ai_providers: { method: "GET", path: "/ai/providers" },
  update_ai_provider_settings: { method: "PUT", path: "/ai/providers/settings" },
  set_default_ai_provider: { method: "POST", path: "/ai/providers/default" },
  list_ai_models: { method: "GET", path: "/ai/providers" },
  // AI Threads
  list_ai_threads: { method: "GET", path: "/ai/threads" },
  get_ai_thread: { method: "GET", path: "/ai/threads" },
  get_ai_thread_messages: { method: "GET", path: "/ai/threads" },
  update_ai_thread: { method: "PUT", path: "/ai/threads" },
  delete_ai_thread: { method: "DELETE", path: "/ai/threads" },
  add_ai_thread_tag: { method: "POST", path: "/ai/threads" },
  remove_ai_thread_tag: { method: "DELETE", path: "/ai/threads" },
  get_ai_thread_tags: { method: "GET", path: "/ai/threads" },
  update_tool_result: { method: "PATCH", path: "/ai/tool-result" },
  // Allocation Targets
  list_allocation_targets: { method: "GET", path: "/allocation-targets" },
  get_allocation_target: { method: "GET", path: "/allocation-targets" },
  create_allocation_target: { method: "POST", path: "/allocation-targets" },
  update_allocation_target: { method: "PUT", path: "/allocation-targets" },
  archive_allocation_target: { method: "POST", path: "/allocation-targets" },
  delete_allocation_target: { method: "DELETE", path: "/allocation-targets" },
  list_allocation_target_weights: { method: "GET", path: "/allocation-targets" },
  save_allocation_target_weights: { method: "POST", path: "/allocation-targets" },
  save_allocation_target_with_weights: {
    method: "POST",
    path: "/allocation-targets/save-with-weights",
  },
  get_allocation_target_drift: { method: "POST", path: "/allocation-targets" },
  list_target_constraints: { method: "GET", path: "/allocation-targets" },
  save_target_constraints: { method: "POST", path: "/allocation-targets" },
  calculate_rebalance_plan: { method: "POST", path: "/allocation-targets/rebalance/calculate" },
  // Alternative Assets
  create_alternative_asset: { method: "POST", path: "/alternative-assets" },
  update_alternative_asset_valuation: { method: "PUT", path: "/alternative-assets" },
  delete_alternative_asset: { method: "DELETE", path: "/alternative-assets" },
  link_liability: { method: "POST", path: "/alternative-assets" },
  unlink_liability: { method: "DELETE", path: "/alternative-assets" },
  update_alternative_asset_metadata: { method: "PUT", path: "/alternative-assets" },
  get_alternative_holdings: { method: "GET", path: "/alternative-holdings" },
  // Agent Access (PATs + audit log)
  get_agent_access_status: { method: "GET", path: "/agent-access/status" },
  list_agent_access_tokens: { method: "GET", path: "/agent-access/tokens" },
  create_agent_access_token: { method: "POST", path: "/agent-access/tokens" },
  delete_agent_access_token: { method: "DELETE", path: "/agent-access/tokens" },
  list_agent_audit_log: { method: "GET", path: "/agent-access/audit" },
  purge_agent_audit_log: { method: "POST", path: "/agent-access/audit/purge" },
};

/**
 * Logger implementation using console
 */
export const logger: Logger = {
  error: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  info: (...args: unknown[]) => console.warn(...args),
  debug: (...args: unknown[]) => console.warn(...args),
  trace: (...args: unknown[]) => console.warn(...args),
};

/**
 * Convert Uint8Array or number[] to base64 string
 */
export function toBase64(data: Uint8Array | number[]): string {
  const bytes = Array.isArray(data) ? new Uint8Array(data) : data;
  // Fast base64 encoding without TextEncoder for binary
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa expects binary string
  return btoa(binary);
}

/**
 * Invoke a command via REST API (internal - use typed adapter functions instead)
 */
export const invoke = async <T>(command: string, payload?: Record<string, unknown>): Promise<T> => {
  const config = COMMANDS[command];
  if (!config) throw new Error(`Unsupported command ${command}`);
  let url = `${API_PREFIX}${config.path}`;
  let method = config.method;
  let body: BodyInit | undefined;

  const addPeriodKey = (periodKey?: string) => {
    if (!periodKey) return;
    const params = new URLSearchParams();
    params.set("periodKey", periodKey);
    url += `?${params.toString()}`;
  };

  switch (command) {
    case "update_account": {
      const data = payload as { accountUpdate: { id: string } & Record<string, unknown> };
      url += `/${data.accountUpdate.id}`;
      body = JSON.stringify(data.accountUpdate);
      break;
    }
    case "delete_account": {
      const data = payload as { accountId: string };
      url += `/${data.accountId}`;
      break;
    }
    case "create_account": {
      const data = payload as { account: Record<string, unknown> };
      body = JSON.stringify(data.account);
      break;
    }
    case "create_portfolio": {
      const { portfolio } = payload as { portfolio: Record<string, unknown> };
      body = JSON.stringify(portfolio);
      break;
    }
    case "update_portfolio_entry": {
      const { portfolio } = payload as { portfolio: { id: string } & Record<string, unknown> };
      url += `/${encodeURIComponent(portfolio.id)}`;
      body = JSON.stringify(portfolio);
      break;
    }
    case "delete_portfolio_entry": {
      const { portfolioId } = payload as { portfolioId: string };
      url += `/${encodeURIComponent(portfolioId)}`;
      break;
    }
    case "delete_database_backup": {
      const { filename } = payload as { filename: string };
      url += `/${encodeURIComponent(filename)}`;
      break;
    }
    case "update_settings": {
      const data = payload as { settingsUpdate: Record<string, unknown> };
      body = JSON.stringify(data.settingsUpdate);
      break;
    }
    case "get_holdings":
    case "get_holdings_list": {
      const p = payload as { filter: { type: string; accountId?: string } };
      if (p.filter?.type === "account" && p.filter.accountId) {
        const path = command === "get_holdings_list" ? "/holdings/list" : "/holdings";
        url = `${API_PREFIX}${path}?accountId=${encodeURIComponent(p.filter.accountId)}`;
        method = "GET";
      } else {
        body = JSON.stringify({ filter: p.filter });
      }
      break;
    }
    case "get_holding": {
      const { accountId, assetId } = payload as { accountId: string; assetId: string };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      params.set("assetId", assetId);
      url += `?${params.toString()}`;
      break;
    }
    case "get_asset_holdings": {
      const p = payload as { assetId: string };
      url += `?assetId=${encodeURIComponent(p.assetId)}`;
      break;
    }
    case "get_asset_lots": {
      const p = payload as { assetId: string; includeSnapshotPositions?: boolean };
      const params = new URLSearchParams();
      params.set("assetId", p.assetId);
      if (p.includeSnapshotPositions !== undefined) {
        params.set("includeSnapshotPositions", String(p.includeSnapshotPositions));
      }
      url += `?${params.toString()}`;
      break;
    }
    case "get_historical_valuations": {
      const p = payload as {
        accountId?: string;
        filter?: { type: string; accountId?: string; portfolioId?: string; accountIds?: string[] };
        startDate?: string;
        endDate?: string;
      };
      if (p?.filter) {
        url = `${API_PREFIX}/valuations/history/query`;
        method = "POST";
        body = JSON.stringify({
          filter: p.filter,
          startDate: p.startDate,
          endDate: p.endDate,
        });
        break;
      }
      const params = new URLSearchParams();
      if (p?.accountId) params.set("accountId", p.accountId);
      if (p?.startDate) params.set("startDate", p.startDate);
      if (p?.endDate) params.set("endDate", p.endDate);
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      break;
    }
    case "get_latest_valuations": {
      const p = payload as { accountIds?: string[] };
      const params = new URLSearchParams();
      if (Array.isArray(p?.accountIds)) {
        for (const id of p.accountIds) params.append("accountIds[]", id);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      break;
    }
    case "get_current_valuation": {
      const { filter, includeAccounts } = (payload ?? {}) as {
        filter?: unknown;
        includeAccounts?: boolean;
      };
      body = JSON.stringify({ filter, includeAccounts: includeAccounts ?? false });
      break;
    }
    case "get_portfolio_allocations": {
      const p = payload as { filter: { type: string; accountId?: string } };
      if (p.filter?.type === "account" && p.filter.accountId) {
        url = `${API_PREFIX}/allocations?accountId=${encodeURIComponent(p.filter.accountId)}`;
        method = "GET";
      } else {
        body = JSON.stringify({ filter: p.filter });
      }
      break;
    }
    case "get_holdings_by_allocation": {
      const p = payload as {
        filter: { type: string; accountId?: string };
        taxonomyId: string;
        categoryId: string;
      };
      if (p.filter?.type === "account" && p.filter.accountId) {
        const params = new URLSearchParams();
        params.set("accountId", p.filter.accountId);
        params.set("taxonomyId", p.taxonomyId);
        params.set("categoryId", p.categoryId);
        url = `${API_PREFIX}/allocations/holdings?${params.toString()}`;
        method = "GET";
      } else {
        body = JSON.stringify({
          filter: p.filter,
          taxonomyId: p.taxonomyId,
          categoryId: p.categoryId,
        });
      }
      break;
    }
    // Snapshot management
    case "get_snapshots": {
      const { accountId, dateFrom, dateTo } = payload as {
        accountId: string;
        dateFrom?: string;
        dateTo?: string;
      };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      url += `?${params.toString()}`;
      break;
    }
    case "get_snapshot_by_date": {
      const { accountId, date } = payload as { accountId: string; date: string };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      params.set("date", date);
      url += `?${params.toString()}`;
      break;
    }
    case "delete_snapshot": {
      const { accountId, date } = payload as { accountId: string; date: string };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      params.set("date", date);
      url += `?${params.toString()}`;
      break;
    }
    case "save_manual_holdings": {
      const { accountId, holdings, cashBalances, snapshotDate } = payload as {
        accountId: string;
        holdings: unknown[];
        cashBalances: Record<string, string>;
        snapshotDate?: string;
      };
      body = JSON.stringify({ accountId, holdings, cashBalances, snapshotDate });
      break;
    }
    case "import_holdings_csv":
    case "check_holdings_import": {
      const { accountId, snapshots } = payload as {
        accountId: string;
        snapshots: unknown[];
      };
      body = JSON.stringify({ accountId, snapshots });
      break;
    }
    case "calculate_accounts_simple_performance": {
      const { accountIds } = (payload ?? {}) as { accountIds?: string[] };
      body = JSON.stringify({ accountIds });
      break;
    }
    case "get_accounts": {
      const { includeArchived } = (payload ?? {}) as { includeArchived?: boolean };
      if (includeArchived) {
        const params = new URLSearchParams();
        params.set("includeArchived", "true");
        url += `?${params.toString()}`;
      }
      break;
    }
    case "calculate_performance_history": {
      const { itemType, itemId, startDate, endDate, trackingMode, filter } = payload as {
        itemType: string;
        itemId: string;
        startDate?: string;
        endDate?: string;
        trackingMode?: string;
        filter?: unknown;
      };
      body = JSON.stringify({ itemType, itemId, startDate, endDate, trackingMode, filter });
      break;
    }
    case "calculate_performance_summary": {
      const { itemType, itemId, startDate, endDate, trackingMode, filter, profile } = payload as {
        itemType: string;
        itemId: string;
        startDate?: string;
        endDate?: string;
        trackingMode?: string;
        filter?: unknown;
        profile?: string;
      };
      body = JSON.stringify({
        itemType,
        itemId,
        startDate,
        endDate,
        trackingMode,
        filter,
        profile,
      });
      break;
    }
    case "get_performance_summaries": {
      const { scopes, startDate, endDate, profile } = payload as {
        scopes: unknown[];
        startDate?: string | null;
        endDate?: string | null;
        profile?: string;
      };
      body = JSON.stringify({ scopes, startDate, endDate, profile });
      break;
    }
    case "check_update": {
      const { currentVersion, target, arch, force } = (payload ?? {}) as {
        currentVersion?: string;
        target?: string;
        arch?: string;
        force?: boolean;
      };
      const params = new URLSearchParams();
      if (currentVersion) params.set("currentVersion", currentVersion);
      if (target) params.set("target", target);
      if (arch) params.set("arch", arch);
      if (force) params.set("force", "true");
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      break;
    }
    case "get_income_summary": {
      const p = payload as { filter?: { type: string; accountId?: string } };
      if (p?.filter?.type === "account" && p.filter.accountId) {
        url = `${API_PREFIX}/income/summary?accountId=${encodeURIComponent(p.filter.accountId)}`;
        method = "GET";
      } else {
        body = JSON.stringify({ filter: p?.filter ?? null });
      }
      break;
    }
    case "get_goal":
    case "delete_goal": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}`;
      break;
    }
    case "get_goal_funding": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}/funding`;
      break;
    }
    case "save_goal_funding": {
      const { goalId, rules } = payload as { goalId: string; rules: unknown[] };
      url += `/${encodeURIComponent(goalId)}/funding`;
      body = JSON.stringify(rules);
      break;
    }
    case "get_goal_plan":
    case "delete_goal_plan": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}/plan`;
      break;
    }
    case "save_goal_plan": {
      const { plan } = payload as { plan: Record<string, unknown> };
      body = JSON.stringify(plan);
      break;
    }
    case "refresh_goal_summary": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}/refresh-summary`;
      break;
    }
    case "get_retirement_overview": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}/retirement/overview`;
      break;
    }
    case "get_save_up_overview": {
      const { goalId } = payload as { goalId: string };
      url += `/${encodeURIComponent(goalId)}/save-up/overview`;
      break;
    }
    case "preview_save_up_overview": {
      const { input } = payload as { input: Record<string, unknown> };
      body = JSON.stringify(input);
      break;
    }
    // Retirement plan simulation commands
    case "calculate_retirement_projection":
    case "run_retirement_monte_carlo":
    case "run_retirement_stress_tests":
    case "run_retirement_scenario_analysis":
    case "run_retirement_decision_sensitivity_map":
    case "run_retirement_sorr": {
      body = JSON.stringify(payload);
      break;
    }
    case "create_goal": {
      const { goal } = payload as { goal: Record<string, unknown> };
      body = JSON.stringify(goal);
      break;
    }
    case "update_goal": {
      const { goal } = payload as { goal: Record<string, unknown> };
      body = JSON.stringify(goal);
      break;
    }
    case "update_exchange_rate": {
      const { rate } = payload as { rate: Record<string, unknown> };
      body = JSON.stringify(rate);
      break;
    }
    case "add_exchange_rate": {
      const { newRate } = payload as { newRate: Record<string, unknown> };
      body = JSON.stringify(newRate);
      break;
    }
    case "delete_exchange_rate": {
      const { rateId } = payload as { rateId: string };
      url += `/${encodeURIComponent(rateId)}`;
      break;
    }
    case "get_exchanges":
    case "synch_quotes":
      break;
    case "search_activities": {
      body = JSON.stringify(payload);
      break;
    }
    case "create_activity": {
      const { activity } = payload as { activity: Record<string, unknown> };
      body = JSON.stringify(activity);
      break;
    }
    case "update_activity": {
      const { activity } = payload as { activity: Record<string, unknown> };
      body = JSON.stringify(activity);
      break;
    }
    case "save_activities": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "delete_activity": {
      const { activityId } = payload as { activityId: string };
      url += `/${encodeURIComponent(activityId)}`;
      break;
    }
    case "get_transfer_pair_for_activity": {
      const { activityId } = payload as { activityId: string };
      url += `/${encodeURIComponent(activityId)}/transfer-pair`;
      break;
    }
    case "find_transfer_match_candidates": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "save_internal_transfer_pair": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "link_transfer_activities": {
      const { activityAId, activityBId } = payload as {
        activityAId: string;
        activityBId: string;
      };
      body = JSON.stringify({ activityAId, activityBId });
      break;
    }
    case "unlink_transfer_activities": {
      const { activityAId, activityBId } = payload as {
        activityAId: string;
        activityBId: string;
      };
      body = JSON.stringify({ activityAId, activityBId });
      break;
    }
    case "check_activities_import":
    case "preview_import_assets":
    case "import_activities": {
      body = JSON.stringify(payload);
      break;
    }
    case "get_account_import_mapping": {
      const { accountId, contextKind } = payload as { accountId: string; contextKind?: string };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      if (contextKind) params.set("contextKind", contextKind);
      url += `?${params.toString()}`;
      break;
    }
    case "save_account_import_mapping": {
      const { mapping } = payload as { mapping: Record<string, unknown> };
      body = JSON.stringify({ mapping });
      break;
    }
    case "get_import_template":
    case "delete_import_template": {
      const { id } = payload as { id: string };
      const params = new URLSearchParams();
      params.set("id", id);
      url += `?${params.toString()}`;
      break;
    }
    case "save_import_template": {
      const { template } = payload as { template: Record<string, unknown> };
      body = JSON.stringify({ template });
      break;
    }
    case "link_account_template": {
      const { accountId, templateId, contextKind } = payload as {
        accountId: string;
        templateId: string;
        contextKind?: string;
      };
      body = JSON.stringify({ accountId, templateId, contextKind });
      break;
    }
    case "update_market_data_provider_settings": {
      body = JSON.stringify(payload);
      break;
    }
    case "create_custom_provider": {
      const { payload: cp } = payload as { payload: Record<string, unknown> };
      body = JSON.stringify(cp);
      break;
    }
    case "update_custom_provider": {
      const { providerId, payload: cp } = payload as {
        providerId: string;
        payload: Record<string, unknown>;
      };
      url += `/${encodeURIComponent(providerId)}`;
      body = JSON.stringify(cp);
      break;
    }
    case "delete_custom_provider": {
      const { providerId } = payload as { providerId: string };
      url += `/${encodeURIComponent(providerId)}`;
      break;
    }
    case "test_custom_provider_source": {
      const { payload: tp } = payload as { payload: Record<string, unknown> };
      body = JSON.stringify(tp);
      break;
    }
    case "create_contribution_limit": {
      const { newLimit } = payload as { newLimit: Record<string, unknown> };
      body = JSON.stringify(newLimit);
      break;
    }
    case "update_contribution_limit": {
      const { id, updatedLimit } = payload as { id: string; updatedLimit: Record<string, unknown> };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(updatedLimit);
      break;
    }
    case "delete_contribution_limit": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "create_asset": {
      const { payload: assetPayload } = payload as { payload: Record<string, unknown> };
      body = JSON.stringify(assetPayload);
      break;
    }
    case "delete_asset": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "calculate_deposits_for_contribution_limit": {
      const { limitId } = payload as { limitId: string };
      url += `/${encodeURIComponent(limitId)}/deposits`;
      break;
    }
    case "get_asset_profile": {
      const { assetId } = payload as { assetId: string };
      const params = new URLSearchParams();
      params.set("assetId", assetId);
      url += `?${params.toString()}`;
      break;
    }
    case "update_asset_profile": {
      const { id, payload: bodyPayload } = payload as {
        id: string;
        payload: Record<string, unknown>;
      };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(bodyPayload);
      break;
    }
    case "update_quote_mode": {
      const { id, quoteMode } = payload as { id: string; quoteMode: string };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify({ quoteMode });
      break;
    }
    case "search_symbol": {
      const { query } = payload as { query: string };
      const params = new URLSearchParams();
      params.set("query", query);
      url += `?${params.toString()}`;
      break;
    }
    case "resolve_symbol_quote": {
      const { symbol, exchangeMic, instrumentType, providerId, quoteCcy } = payload as {
        symbol: string;
        exchangeMic?: string;
        instrumentType?: string;
        providerId?: string;
        quoteCcy?: string;
      };
      const params = new URLSearchParams();
      params.set("symbol", symbol);
      if (exchangeMic) params.set("exchangeMic", exchangeMic);
      if (instrumentType) params.set("instrumentType", instrumentType);
      if (providerId) params.set("providerId", providerId);
      if (quoteCcy) params.set("quoteCcy", quoteCcy);
      url += `?${params.toString()}`;
      break;
    }
    case "get_quote_history": {
      const { symbol } = payload as { symbol: string };
      const params = new URLSearchParams();
      params.set("symbol", symbol);
      url += `?${params.toString()}`;
      break;
    }
    case "fetch_dividends": {
      const { symbol, exchangeMic, instrumentType, quoteCcy, providerId, startDate, endDate } =
        payload as {
          symbol: string;
          exchangeMic?: string;
          instrumentType?: string;
          quoteCcy?: string;
          providerId?: string;
          startDate?: string;
          endDate?: string;
        };
      const params = new URLSearchParams();
      params.set("symbol", symbol);
      if (exchangeMic) params.set("exchangeMic", exchangeMic);
      if (instrumentType) params.set("instrumentType", instrumentType);
      if (quoteCcy) params.set("quoteCcy", quoteCcy);
      if (providerId) params.set("providerId", providerId);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      url += `?${params.toString()}`;
      break;
    }
    case "get_latest_quotes": {
      const { assetIds } = payload as { assetIds: string[] };
      body = JSON.stringify({ assetIds });
      break;
    }
    case "update_quote": {
      const { symbol, quote } = payload as { symbol: string; quote: Record<string, unknown> };
      url += `/${encodeURIComponent(symbol)}`;
      body = JSON.stringify(quote);
      break;
    }
    case "delete_quote": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "check_quotes_import": {
      const { content, hasHeaderRow } = payload as { content: number[]; hasHeaderRow: boolean };
      body = JSON.stringify({ content, hasHeaderRow });
      break;
    }
    case "import_quotes_csv": {
      const { quotes, overwriteExisting } = payload as {
        quotes: unknown;
        overwriteExisting: boolean;
      };
      body = JSON.stringify({ quotes, overwriteExisting });
      break;
    }
    case "sync_market_data": {
      body = JSON.stringify(payload);
      break;
    }
    case "set_secret": {
      const { secretKey, secret } = payload as { secretKey: string; secret: string };
      body = JSON.stringify({ secretKey, secret });
      break;
    }
    case "get_secret": {
      const { secretKey } = payload as { secretKey: string };
      const params = new URLSearchParams();
      params.set("secretKey", secretKey);
      url += `?${params.toString()}`;
      break;
    }
    case "delete_secret": {
      const { secretKey } = payload as { secretKey: string };
      const params = new URLSearchParams();
      params.set("secretKey", secretKey);
      url += `?${params.toString()}`;
      break;
    }
    case "set_addon_secret": {
      const { addonId, key, secret } = payload as {
        addonId: string;
        key: string;
        secret: string;
      };
      url += `/${encodeURIComponent(addonId)}/secrets`;
      body = JSON.stringify({ key, secret });
      break;
    }
    case "get_addon_secret":
    case "delete_addon_secret": {
      const { addonId, key } = payload as { addonId: string; key: string };
      const params = new URLSearchParams();
      params.set("key", key);
      url += `/${encodeURIComponent(addonId)}/secrets?${params.toString()}`;
      break;
    }
    case "addon_network_request": {
      const { addonId, request } = payload as {
        addonId: string;
        request: unknown;
      };
      url += `/${encodeURIComponent(addonId)}/network/request`;
      body = JSON.stringify({ request });
      break;
    }
    // Taxonomy commands
    case "get_taxonomies":
      break;
    case "get_taxonomy": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "create_taxonomy": {
      const { taxonomy } = payload as { taxonomy: Record<string, unknown> };
      body = JSON.stringify(taxonomy);
      break;
    }
    case "update_taxonomy": {
      const { taxonomy } = payload as { taxonomy: Record<string, unknown> };
      body = JSON.stringify(taxonomy);
      break;
    }
    case "delete_taxonomy": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "create_category": {
      const { category } = payload as { category: Record<string, unknown> };
      body = JSON.stringify(category);
      break;
    }
    case "update_category": {
      const { category } = payload as { category: Record<string, unknown> };
      body = JSON.stringify(category);
      break;
    }
    case "delete_category": {
      const { taxonomyId, categoryId } = payload as { taxonomyId: string; categoryId: string };
      url += `/${encodeURIComponent(taxonomyId)}/categories/${encodeURIComponent(categoryId)}`;
      break;
    }
    case "move_category": {
      const { taxonomyId, categoryId, newParentId, position } = payload as {
        taxonomyId: string;
        categoryId: string;
        newParentId: string | null;
        position: number;
      };
      body = JSON.stringify({ taxonomyId, categoryId, newParentId, position });
      break;
    }
    case "import_taxonomy_json": {
      const { jsonStr } = payload as { jsonStr: string };
      body = JSON.stringify({ jsonStr });
      break;
    }
    case "export_taxonomy_json": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}/export`;
      break;
    }
    case "get_asset_taxonomy_assignments": {
      const { assetId } = payload as { assetId: string };
      url += `/${encodeURIComponent(assetId)}`;
      break;
    }
    case "assign_asset_to_category": {
      const { assignment } = payload as { assignment: Record<string, unknown> };
      body = JSON.stringify(assignment);
      break;
    }
    case "replace_asset_taxonomy_assignments": {
      const { assetId, taxonomyId, assignments } = payload as {
        assetId: string;
        taxonomyId: string;
        assignments: Record<string, unknown>[];
      };
      url += `/${encodeURIComponent(assetId)}/taxonomy/${encodeURIComponent(taxonomyId)}`;
      body = JSON.stringify(assignments);
      break;
    }
    case "remove_asset_taxonomy_assignment": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "get_migration_status":
      break;
    case "migrate_legacy_classifications":
      break;
    // Spending budget commands
    case "get_budget": {
      const { periodKey } = (payload ?? {}) as { periodKey?: string };
      addPeriodKey(periodKey);
      break;
    }
    case "upsert_budget_target": {
      const { target, periodKey } = payload as {
        target: Record<string, unknown>;
        periodKey?: string;
      };
      addPeriodKey(periodKey);
      body = JSON.stringify(target);
      break;
    }
    case "delete_budget_target": {
      const { id, periodKey } = payload as { id: string; periodKey?: string };
      url += `/${encodeURIComponent(id)}`;
      addPeriodKey(periodKey);
      break;
    }
    case "upsert_budget_rollover_setting": {
      const { setting, periodKey } = payload as {
        setting: Record<string, unknown>;
        periodKey?: string;
      };
      addPeriodKey(periodKey);
      body = JSON.stringify(setting);
      break;
    }
    case "delete_budget_rollover_setting": {
      const { id, periodKey } = payload as { id: string; periodKey?: string };
      url += `/${encodeURIComponent(id)}`;
      addPeriodKey(periodKey);
      break;
    }
    case "create_budget_group": {
      const { group, periodKey } = payload as {
        group: Record<string, unknown>;
        periodKey?: string;
      };
      addPeriodKey(periodKey);
      body = JSON.stringify(group);
      break;
    }
    case "update_budget_group": {
      const { id, patch, periodKey } = payload as {
        id: string;
        patch: Record<string, unknown>;
        periodKey?: string;
      };
      url += `/${encodeURIComponent(id)}`;
      addPeriodKey(periodKey);
      body = JSON.stringify(patch);
      break;
    }
    case "delete_budget_group": {
      const { id, reassignToGroupId, periodKey } = payload as {
        id: string;
        reassignToGroupId: string;
        periodKey?: string;
      };
      url += `/${encodeURIComponent(id)}`;
      addPeriodKey(periodKey);
      body = JSON.stringify({ reassignToGroupId });
      break;
    }
    case "assign_category_to_group": {
      const { categoryId, groupId, periodKey } = payload as {
        categoryId: string;
        groupId: string;
        periodKey?: string;
      };
      addPeriodKey(periodKey);
      body = JSON.stringify({ categoryId, groupId });
      break;
    }
    case "reset_budget_groups": {
      const { periodKey } = (payload ?? {}) as { periodKey?: string };
      addPeriodKey(periodKey);
      break;
    }
    case "copy_budget_targets": {
      const { sourcePeriodKey, targetPeriodKey, overwrite } = payload as {
        sourcePeriodKey: string;
        targetPeriodKey: string;
        overwrite?: boolean;
      };
      body = JSON.stringify({ sourcePeriodKey, targetPeriodKey, overwrite: !!overwrite });
      break;
    }
    // Spending settings
    case "get_spending_settings":
      break;
    case "update_spending_settings": {
      const { update } = payload as { update: Record<string, unknown> };
      body = JSON.stringify(update);
      break;
    }
    // Spending cash activities + assignments
    case "list_cash_activities": {
      const { filter } = (payload ?? {}) as { filter?: Record<string, unknown> };
      if (filter) {
        const params = new URLSearchParams();
        // Stringify only primitives so the query string never gets
        // "[object Object]" from an accidental nested value. Filter shape is
        // string/number/boolean/string[]; the guard keeps that contract
        // visible (and silences @typescript-eslint/no-base-to-string).
        const toQs = (val: unknown): string | null => {
          if (typeof val === "string") return val;
          if (typeof val === "number" || typeof val === "boolean") return String(val);
          return null;
        };
        for (const [k, v] of Object.entries(filter)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) {
            for (const item of v) {
              const s = toQs(item);
              if (s !== null) params.append(`${k}[]`, s);
            }
          } else {
            const s = toQs(v);
            if (s !== null) params.set(k, s);
          }
        }
        const qs = params.toString();
        if (qs) url += `?${qs}`;
      }
      break;
    }
    case "search_cash_activities": {
      const { request } = (payload ?? {}) as { request?: Record<string, unknown> };
      body = JSON.stringify(request ?? {});
      break;
    }
    case "set_activity_event": {
      const { activityId, eventId } = payload as {
        activityId: string;
        eventId: string | null;
      };
      url += `/${encodeURIComponent(activityId)}/event`;
      body = JSON.stringify({ eventId });
      break;
    }
    case "get_activity_assignments": {
      const { activityId } = payload as { activityId: string };
      url += `/${encodeURIComponent(activityId)}/assignments`;
      break;
    }
    case "assign_activity_category": {
      const { activityId, taxonomyId, categoryId } = payload as {
        activityId: string;
        taxonomyId: string;
        categoryId: string;
      };
      url += `/${encodeURIComponent(activityId)}/assignments`;
      body = JSON.stringify({ taxonomyId, categoryId });
      break;
    }
    case "unassign_activity_category": {
      const { activityId, taxonomyId } = payload as {
        activityId: string;
        taxonomyId: string;
      };
      url += `/${encodeURIComponent(activityId)}/assignments/${encodeURIComponent(taxonomyId)}`;
      break;
    }
    case "get_activity_splits": {
      const { activityId } = payload as { activityId: string };
      url += `/${encodeURIComponent(activityId)}/splits`;
      break;
    }
    case "replace_activity_splits": {
      const { activityId, splits } = payload as {
        activityId: string;
        splits: unknown[];
      };
      url += `/${encodeURIComponent(activityId)}/splits`;
      body = JSON.stringify(splits);
      break;
    }
    case "clear_activity_splits": {
      const { activityId } = payload as { activityId: string };
      url += `/${encodeURIComponent(activityId)}/splits`;
      break;
    }
    case "bulk_assign_categories": {
      const { items } = payload as { items: unknown[] };
      body = JSON.stringify(items);
      break;
    }
    // Spending categorization rules
    case "list_categorization_rules":
    case "list_rule_presets":
      break;
    case "create_categorization_rule": {
      const { rule } = payload as { rule: Record<string, unknown> };
      body = JSON.stringify(rule);
      break;
    }
    case "update_categorization_rule": {
      const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(patch);
      break;
    }
    case "delete_categorization_rule": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "rerun_categorization_rules": {
      const { onlyUncategorized } = payload as { onlyUncategorized: boolean };
      body = JSON.stringify({ onlyUncategorized });
      break;
    }
    case "import_rule_preset": {
      const { presetId } = payload as { presetId: string };
      url += `/${encodeURIComponent(presetId)}/import`;
      break;
    }
    case "remove_rule_preset": {
      const { presetId } = payload as { presetId: string };
      url += `/${encodeURIComponent(presetId)}`;
      break;
    }
    // Spending events + event types
    case "list_event_types":
    case "list_events":
      break;
    case "create_event_type": {
      const { newType } = payload as { newType: Record<string, unknown> };
      body = JSON.stringify(newType);
      break;
    }
    case "update_event_type": {
      const { id, patch } = payload as {
        id: string;
        patch: { name?: string; color?: string | null };
      };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(patch);
      break;
    }
    case "delete_event_type": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "create_event": {
      const { event } = payload as { event: Record<string, unknown> };
      body = JSON.stringify(event);
      break;
    }
    case "update_event": {
      const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(patch);
      break;
    }
    case "delete_event": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "get_event_spending_summaries": {
      const { request } = (payload ?? {}) as { request?: Record<string, unknown> };
      body = JSON.stringify(request ?? null);
      break;
    }
    // Spending analytics
    case "get_spending_report":
    case "get_spending_insight": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    // Health Center commands
    case "get_health_status":
    case "run_health_checks":
    case "get_dismissed_health_issues":
    case "get_health_config":
      break;
    case "dismiss_health_issue": {
      const { issueId, dataHash } = payload as { issueId: string; dataHash: string };
      body = JSON.stringify({ issueId, dataHash });
      break;
    }
    case "restore_health_issue": {
      const { issueId } = payload as { issueId: string };
      body = JSON.stringify({ issueId });
      break;
    }
    case "execute_health_fix": {
      const { action } = payload as { action: Record<string, unknown> };
      body = JSON.stringify(action);
      break;
    }
    case "update_health_config": {
      const { config } = payload as { config: Record<string, unknown> };
      body = JSON.stringify(config);
      break;
    }
    // Addons
    case "install_addon_zip": {
      const { zipData, enableAfterInstall, approvedNetworkHosts } = payload as {
        zipData: Uint8Array | number[];
        enableAfterInstall?: boolean;
        approvedNetworkHosts?: string[];
      };
      // Send compact base64 payload to avoid gigantic JSON arrays of numbers
      const zipDataB64 = toBase64(zipData);
      body = JSON.stringify({ zipDataB64, enableAfterInstall, approvedNetworkHosts });
      break;
    }
    case "toggle_addon": {
      const { addonId, enabled } = payload as { addonId: string; enabled: boolean };
      body = JSON.stringify({ addonId, enabled });
      break;
    }
    case "uninstall_addon": {
      const { addonId } = payload as { addonId: string };
      url += `/${encodeURIComponent(addonId)}`;
      break;
    }
    case "load_addon_for_runtime": {
      const { addonId } = payload as { addonId: string };
      url += `/${encodeURIComponent(addonId)}`;
      break;
    }
    case "get_addon_storage_item":
    case "delete_addon_storage_item": {
      const { addonId, key } = payload as { addonId: string; key: string };
      url += `/${encodeURIComponent(addonId)}/${encodeURIComponent(key)}`;
      break;
    }
    case "set_addon_storage_item": {
      const { addonId, key, value } = payload as { addonId: string; key: string; value: string };
      url += `/${encodeURIComponent(addonId)}/${encodeURIComponent(key)}`;
      body = JSON.stringify({ value });
      break;
    }
    case "extract_addon_zip": {
      const { zipData } = payload as { zipData: Uint8Array | number[] };
      const zipDataB64 = toBase64(zipData);
      body = JSON.stringify({ zipDataB64 });
      break;
    }
    case "check_addon_update":
    case "update_addon_from_store_by_id": {
      const { addonId } = payload as { addonId: string };
      body = JSON.stringify({ addonId });
      break;
    }
    case "check_all_addon_updates":
      break;
    case "download_addon_to_staging": {
      const { addonId } = payload as { addonId: string };
      body = JSON.stringify({ addonId });
      break;
    }
    case "install_addon_from_staging": {
      const { addonId, enableAfterInstall, approvedNetworkHosts } = payload as {
        addonId: string;
        enableAfterInstall?: boolean;
        approvedNetworkHosts?: string[];
      };
      body = JSON.stringify({ addonId, enableAfterInstall, approvedNetworkHosts });
      break;
    }
    case "update_addon_network_approvals": {
      const { addonId, approvedNetworkHosts } = payload as {
        addonId: string;
        approvedNetworkHosts: string[];
      };
      body = JSON.stringify({ addonId, approvedNetworkHosts });
      break;
    }
    case "clear_addon_staging": {
      const { addonId } = (payload ?? {}) as { addonId?: string };
      if (addonId) {
        const params = new URLSearchParams();
        params.set("addonId", addonId);
        url += `?${params.toString()}`;
      }
      break;
    }
    case "submit_addon_rating": {
      const { addonId, rating, review } = payload as {
        addonId: string;
        rating: number;
        review?: string;
      };
      body = JSON.stringify({ addonId, rating, review });
      break;
    }
    case "get_addon_ratings": {
      const { addonId } = payload as { addonId: string };
      const params = new URLSearchParams();
      params.set("addonId", addonId);
      url += `?${params.toString()}`;
      break;
    }
    // Device Sync commands - Device management
    case "register_device": {
      const { displayName, deviceNonce, instanceId } = payload as {
        displayName: string;
        deviceNonce?: string;
        instanceId?: string;
      };
      // Detect platform from browser user agent
      const userAgent = navigator.userAgent.toLowerCase();
      let platform = "server"; // default fallback
      if (userAgent.includes("mac")) platform = "macos";
      else if (userAgent.includes("win")) platform = "windows";
      else if (userAgent.includes("linux") && !userAgent.includes("android")) platform = "linux";
      else if (userAgent.includes("android")) platform = "android";
      else if (userAgent.includes("iphone") || userAgent.includes("ipad")) platform = "ios";

      body = JSON.stringify({ displayName, platform, deviceNonce: deviceNonce ?? instanceId });
      break;
    }
    case "get_device": {
      const { deviceId } = (payload ?? {}) as { deviceId?: string };
      if (deviceId) {
        url += `/${encodeURIComponent(deviceId)}`;
      } else {
        url += "/current";
      }
      break;
    }
    case "update_device": {
      const { deviceId, displayName } = payload as { deviceId: string; displayName: string };
      url += `/${encodeURIComponent(deviceId)}`;
      body = JSON.stringify({ displayName });
      break;
    }
    case "delete_device": {
      const { deviceId } = payload as { deviceId: string };
      url += `/${encodeURIComponent(deviceId)}`;
      break;
    }
    case "revoke_device": {
      const { deviceId } = payload as { deviceId: string };
      url += `/${encodeURIComponent(deviceId)}/revoke`;
      break;
    }
    // Device Sync commands - Team keys (E2EE)
    case "commit_initialize_team_keys": {
      const { keyVersion, deviceKeyEnvelope, signature, challengeResponse, recoveryEnvelope } =
        payload as {
          keyVersion: number;
          deviceKeyEnvelope: string;
          signature: string;
          challengeResponse?: string;
          recoveryEnvelope?: string;
        };
      body = JSON.stringify({
        keyVersion,
        deviceKeyEnvelope,
        signature,
        challengeResponse,
        recoveryEnvelope,
      });
      break;
    }
    case "commit_rotate_team_keys": {
      const { newKeyVersion, envelopes, signature, challengeResponse } = payload as {
        newKeyVersion: number;
        envelopes: { deviceId: string; deviceKeyEnvelope: string }[];
        signature: string;
        challengeResponse?: string;
      };
      body = JSON.stringify({ newKeyVersion, envelopes, signature, challengeResponse });
      break;
    }
    case "reset_team_sync": {
      const { reason } = (payload ?? {}) as { reason?: string };
      body = reason ? JSON.stringify({ reason }) : JSON.stringify({});
      break;
    }
    // Device Sync commands - Pairing (Issuer - Trusted Device)
    case "create_pairing": {
      const { codeHash, ephemeralPublicKey } = payload as {
        codeHash: string;
        ephemeralPublicKey: string;
      };
      body = JSON.stringify({ codeHash, ephemeralPublicKey });
      break;
    }
    case "get_pairing": {
      const { pairingId } = payload as { pairingId: string };
      url += `/${encodeURIComponent(pairingId)}`;
      break;
    }
    case "approve_pairing": {
      const { pairingId } = payload as { pairingId: string };
      url += `/${encodeURIComponent(pairingId)}/approve`;
      break;
    }
    case "complete_pairing": {
      const { pairingId, encryptedKeyBundle, sasProof, signature } = payload as {
        pairingId: string;
        encryptedKeyBundle: string;
        sasProof: string | Record<string, unknown>;
        signature: string;
      };
      url += `/${encodeURIComponent(pairingId)}/complete`;
      body = JSON.stringify({ encryptedKeyBundle, sasProof, signature });
      break;
    }
    case "cancel_pairing": {
      const { pairingId } = payload as { pairingId: string };
      url += `/${encodeURIComponent(pairingId)}/cancel`;
      break;
    }
    // Claimer-side pairing commands
    case "claim_pairing": {
      const { code, ephemeralPublicKey } = payload as {
        code: string;
        ephemeralPublicKey: string;
      };
      body = JSON.stringify({ code, ephemeralPublicKey });
      break;
    }
    case "get_pairing_messages": {
      const { pairingId } = payload as { pairingId: string };
      url += `/${encodeURIComponent(pairingId)}/messages`;
      break;
    }
    case "confirm_pairing": {
      const { pairingId, proof, minSnapshotCreatedAt } = payload as {
        pairingId: string;
        proof?: string;
        minSnapshotCreatedAt?: string;
      };
      url += `/${encodeURIComponent(pairingId)}/confirm`;
      body = JSON.stringify({ proof, minSnapshotCreatedAt });
      break;
    }
    case "complete_pairing_with_transfer": {
      body = JSON.stringify(payload);
      break;
    }
    case "confirm_pairing_with_bootstrap": {
      body = JSON.stringify(payload);
      break;
    }
    case "begin_pairing_confirm":
    case "get_pairing_flow_state":
    case "approve_pairing_overwrite":
    case "cancel_pairing_flow": {
      body = JSON.stringify(payload);
      break;
    }
    case "device_sync_reconcile_ready_state": {
      body = JSON.stringify(payload ?? {});
      break;
    }
    // Wealthfolio Connect commands
    case "store_sync_session": {
      const { refreshToken } = payload as {
        refreshToken: string;
      };
      body = JSON.stringify({ refreshToken });
      break;
    }
    case "list_devices":
    case "initialize_team_keys":
    case "rotate_team_keys":
    case "post_login_bootstrap":
    case "clear_sync_session":
    case "get_sync_session_status":
    case "restore_sync_session":
    case "list_broker_connections":
    case "list_broker_accounts":
    case "sync_broker_data":
    case "broker_ingest_run":
    case "sync_broker_connections":
    case "sync_broker_accounts":
    case "sync_broker_activities":
    case "get_subscription_plans":
    case "get_subscription_plans_public":
    case "get_user_info":
    case "get_synced_accounts":
    case "get_platforms":
    case "get_broker_sync_states":
    case "get_broker_ingest_states":
    // Device Sync / Enrollment (falls through)
    // eslint-disable-next-line no-fallthrough
    case "get_device_sync_state":
    case "enable_device_sync":
    case "clear_device_sync_data":
    case "reinitialize_device_sync":
      break;
    case "get_import_runs":
    case "get_data_import_runs": {
      const { runType, limit, offset } = (payload ?? {}) as {
        runType?: string;
        limit?: number;
        offset?: number;
      };
      const params = new URLSearchParams();
      if (runType) params.set("runType", runType);
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      break;
    }
    case "get_broker_sync_profile": {
      const { accountId, sourceSystem } = payload as { accountId: string; sourceSystem: string };
      const params = new URLSearchParams();
      params.set("accountId", accountId);
      params.set("sourceSystem", sourceSystem);
      url += `?${params.toString()}`;
      break;
    }
    case "save_broker_sync_profile_rules": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    // Net Worth commands
    case "get_net_worth": {
      const { date } = (payload ?? {}) as { date?: string };
      if (date) {
        const params = new URLSearchParams();
        params.set("date", date);
        url += `?${params.toString()}`;
      }
      break;
    }
    case "get_net_worth_history": {
      const { startDate, endDate } = payload as { startDate: string; endDate: string };
      const params = new URLSearchParams();
      params.set("startDate", startDate);
      params.set("endDate", endDate);
      url += `?${params.toString()}`;
      break;
    }
    // Alternative Assets commands
    case "create_alternative_asset": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "update_alternative_asset_valuation": {
      const { assetId, request } = payload as { assetId: string; request: Record<string, unknown> };
      url += `/${encodeURIComponent(assetId)}/valuation`;
      body = JSON.stringify(request);
      break;
    }
    case "delete_alternative_asset": {
      const { assetId } = payload as { assetId: string };
      url += `/${encodeURIComponent(assetId)}`;
      break;
    }
    case "link_liability": {
      const { liabilityId, request } = payload as {
        liabilityId: string;
        request: Record<string, unknown>;
      };
      url += `/${encodeURIComponent(liabilityId)}/link`;
      body = JSON.stringify(request);
      break;
    }
    case "unlink_liability": {
      const { liabilityId } = payload as { liabilityId: string };
      url += `/${encodeURIComponent(liabilityId)}/unlink`;
      break;
    }
    case "update_alternative_asset_metadata": {
      const { assetId, metadata, name, notes } = payload as {
        assetId: string;
        metadata: Record<string, string>;
        name?: string;
        notes?: string | null;
      };
      url += `/${encodeURIComponent(assetId)}/metadata`;
      body = JSON.stringify({ metadata, name, notes });
      break;
    }
    case "get_alternative_holdings":
      break;
    // Allocation Targets
    case "list_allocation_targets":
      break;
    case "get_allocation_target": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "create_allocation_target": {
      const { input } = payload as { input: Record<string, unknown> };
      body = JSON.stringify(input);
      break;
    }
    case "update_allocation_target": {
      const { id, input } = payload as { id: string; input: Record<string, unknown> };
      url += `/${encodeURIComponent(id)}`;
      body = JSON.stringify(input);
      break;
    }
    case "archive_allocation_target": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}/archive`;
      break;
    }
    case "delete_allocation_target": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "list_allocation_target_weights": {
      const { targetId } = payload as { targetId: string };
      url += `/${encodeURIComponent(targetId)}/weights`;
      break;
    }
    case "save_allocation_target_weights": {
      const { targetId, weights } = payload as { targetId: string; weights: unknown[] };
      url += `/${encodeURIComponent(targetId)}/weights`;
      body = JSON.stringify(weights);
      break;
    }
    case "save_allocation_target_with_weights": {
      const { id, input, weights } = payload as {
        id: string | null;
        input: Record<string, unknown>;
        weights: unknown[];
      };
      body = JSON.stringify({ id, input, weights });
      break;
    }
    case "get_allocation_target_drift": {
      const { targetId, filter, includeHoldings } = payload as {
        targetId: string;
        filter: unknown;
        includeHoldings?: boolean;
      };
      url += `/${encodeURIComponent(targetId)}/drift`;
      body = JSON.stringify({ filter, includeHoldings: includeHoldings ?? false });
      break;
    }
    case "list_target_constraints": {
      const { targetId } = payload as { targetId: string };
      url += `/${encodeURIComponent(targetId)}/constraints`;
      break;
    }
    case "save_target_constraints": {
      const { targetId, constraints } = payload as {
        targetId: string;
        constraints: unknown[];
      };
      url += `/${encodeURIComponent(targetId)}/constraints`;
      body = JSON.stringify(constraints);
      break;
    }
    case "calculate_rebalance_plan": {
      const { targetId, availableCash, filter, scenarioMode } = payload as {
        targetId: string;
        availableCash: number;
        filter: unknown;
        scenarioMode: string;
      };
      body = JSON.stringify({
        targetId,
        availableCash,
        filter,
        scenarioMode,
      });
      break;
    }
    // AI Providers
    case "get_ai_providers":
      break;
    case "update_ai_provider_settings": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "set_default_ai_provider": {
      const { request } = payload as { request: Record<string, unknown> };
      body = JSON.stringify(request);
      break;
    }
    case "list_ai_models": {
      const { providerId } = payload as { providerId: string };
      url += `/${encodeURIComponent(providerId)}/models`;
      break;
    }
    // AI Threads
    case "list_ai_threads": {
      const { cursor, limit, search } = (payload ?? {}) as {
        cursor?: string;
        limit?: number;
        search?: string;
      };
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (limit !== undefined) params.set("limit", String(limit));
      if (search) params.set("search", search);
      const qs = params.toString();
      if (qs) url += `?${qs}`;
      break;
    }
    case "get_ai_thread": {
      const { threadId } = payload as { threadId: string };
      url += `/${encodeURIComponent(threadId)}`;
      break;
    }
    case "get_ai_thread_messages": {
      const { threadId } = payload as { threadId: string };
      url += `/${encodeURIComponent(threadId)}/messages`;
      break;
    }
    case "update_tool_result": {
      const { request } = payload as {
        request: { threadId: string; toolCallId: string; resultPatch: unknown };
      };
      body = JSON.stringify({
        threadId: request.threadId,
        toolCallId: request.toolCallId,
        resultPatch: request.resultPatch,
      });
      break;
    }
    case "update_ai_thread": {
      const { request } = payload as {
        request: { id: string; title?: string; isPinned?: boolean };
      };
      url += `/${encodeURIComponent(request.id)}`;
      body = JSON.stringify({ title: request.title, isPinned: request.isPinned });
      break;
    }
    case "delete_ai_thread": {
      const { threadId } = payload as { threadId: string };
      url += `/${encodeURIComponent(threadId)}`;
      break;
    }
    case "add_ai_thread_tag": {
      const { threadId, tag } = payload as { threadId: string; tag: string };
      url += `/${encodeURIComponent(threadId)}/tags`;
      body = JSON.stringify({ tag });
      break;
    }
    case "remove_ai_thread_tag": {
      const { threadId, tag } = payload as { threadId: string; tag: string };
      url += `/${encodeURIComponent(threadId)}/tags/${encodeURIComponent(tag)}`;
      break;
    }
    case "get_ai_thread_tags": {
      const { threadId } = payload as { threadId: string };
      url += `/${encodeURIComponent(threadId)}/tags`;
      break;
    }
    // Agent Access
    case "create_agent_access_token": {
      const { name, expiresAt, scopes } = payload as {
        name: string;
        expiresAt?: string;
        scopes: string[];
      };
      body = JSON.stringify({ name, expiresAt, scopes });
      break;
    }
    case "delete_agent_access_token": {
      const { id } = payload as { id: string };
      url += `/${encodeURIComponent(id)}`;
      break;
    }
    case "list_agent_audit_log": {
      const { page, pageSize, q, tools, outcomes, actorKinds } = payload as {
        page: number;
        pageSize: number;
        q?: string;
        tools?: string[];
        outcomes?: string[];
        actorKinds?: string[];
      };
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (q) params.set("q", q);
      if (tools?.length) params.set("tools", tools.join(","));
      if (outcomes?.length) params.set("outcomes", outcomes.join(","));
      if (actorKinds?.length) params.set("actorKinds", actorKinds.join(","));
      url += `?${params.toString()}`;
      break;
    }
  }

  const headers: HeadersInit = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (command === "get_health_status" || command === "run_health_checks") {
    const payloadTimezone =
      typeof payload === "object" && payload !== null && "clientTimezone" in payload
        ? String((payload as { clientTimezone?: string }).clientTimezone ?? "").trim()
        : "";
    const clientTimezone = payloadTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (clientTimezone) {
      headers["X-Client-Timezone"] = clientTimezone;
    }
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    credentials: "same-origin",
    signal: AbortSignal.timeout(INVOKE_TIMEOUT_OVERRIDES_MS[command] ?? DEFAULT_INVOKE_TIMEOUT_MS),
  });

  // 401 = app auth failure (JWT expired/invalid). Cloud auth failures return 403.
  if (res.status === 401) {
    notifyUnauthorized();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const err = (await res.json()) as unknown;
      if (
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof err.message === "string"
      ) {
        msg = err.message;
      }
    } catch (_e) {
      // ignore JSON parse error from non-JSON error bodies
      void 0;
    }
    console.error(`[Invoke] Command "${command}" failed: ${msg}`);
    throw new Error(msg);
  }
  // Handle responses with no body (204 No Content, 202 Accepted, or empty 200)
  if (res.status === 204 || res.status === 202) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
};
