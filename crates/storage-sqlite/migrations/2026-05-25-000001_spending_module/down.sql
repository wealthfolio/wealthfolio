-- Reverse the spending_module migration.
-- Order: drop FK-dependent objects first.

-- Remove spending module default-enabled setting
DELETE FROM app_settings WHERE setting_key = 'spending.enabled';

-- Drop budget tables
DROP INDEX IF EXISTS idx_budget_rollover_settings_group;
DROP INDEX IF EXISTS idx_budget_rollover_settings_category;
DROP INDEX IF EXISTS idx_budget_rollover_settings_group_unique;
DROP INDEX IF EXISTS idx_budget_rollover_settings_category_unique;
DROP TABLE IF EXISTS budget_rollover_settings;
DROP INDEX IF EXISTS idx_budget_targets_group;
DROP INDEX IF EXISTS idx_budget_targets_category;
DROP INDEX IF EXISTS idx_budget_targets_period;
DROP INDEX IF EXISTS idx_budget_targets_group_buffer_unique;
DROP INDEX IF EXISTS idx_budget_targets_category_unique;
DROP TABLE IF EXISTS budget_targets;
DROP INDEX IF EXISTS idx_budget_group_assignments_category;
DROP INDEX IF EXISTS idx_budget_group_assignments_group;
DROP TABLE IF EXISTS budget_group_assignments;
DROP INDEX IF EXISTS idx_budget_groups_sort;
DROP TABLE IF EXISTS budget_groups;

-- Drop spending_categorization_rules
DROP INDEX IF EXISTS idx_spending_preset_rule_deletions_rule;
DROP TABLE IF EXISTS spending_preset_rule_deletions;
DROP INDEX IF EXISTS idx_spending_categorization_rules_preset_unique;
DROP INDEX IF EXISTS idx_spending_categorization_rules_activity_type;
DROP INDEX IF EXISTS idx_spending_categorization_rules_is_global;
DROP INDEX IF EXISTS idx_spending_categorization_rules_account;
DROP INDEX IF EXISTS idx_spending_categorization_rules_category;
DROP INDEX IF EXISTS idx_spending_categorization_rules_priority;
DROP TABLE IF EXISTS spending_categorization_rules;

-- Drop spending_activity_events join table
DROP INDEX IF EXISTS idx_spending_activity_events_event;
DROP TABLE IF EXISTS spending_activity_events;

-- Drop spending_events + spending_event_types
DROP INDEX IF EXISTS idx_spending_events_dates;
DROP INDEX IF EXISTS idx_spending_events_event_type;
DROP TABLE IF EXISTS spending_events;
DROP INDEX IF EXISTS idx_spending_event_types_key_unique;
DROP TABLE IF EXISTS spending_event_types;

-- Drop activity_taxonomy_assignments
DROP INDEX IF EXISTS ix_activity_taxonomy_assignment_unique;
DROP INDEX IF EXISTS ix_activity_taxonomy_assignments_category;
DROP INDEX IF EXISTS ix_activity_taxonomy_assignments_activity;
DROP TABLE IF EXISTS activity_taxonomy_assignments;

-- Drop seeded activity-scope categories + taxonomies
DELETE FROM taxonomy_categories WHERE taxonomy_id IN ('spending_categories', 'income_sources');
DELETE FROM taxonomies WHERE id IN ('spending_categories', 'income_sources');

-- Reverse taxonomy_categories.icon
ALTER TABLE taxonomy_categories DROP COLUMN icon;

-- Reverse taxonomies.scope
DROP INDEX IF EXISTS ix_taxonomies_scope;
ALTER TABLE taxonomies DROP COLUMN scope;
