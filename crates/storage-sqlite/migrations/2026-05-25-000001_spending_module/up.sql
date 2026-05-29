-- Spending Module Migration
-- Adds optional cash-tracking / expense management on top of existing tables.
-- Re-uses the taxonomies system (scope='activity') instead of forking a Categories table.
--
-- Adds:
--   - Columns: taxonomies.scope, taxonomy_categories.icon
--   - Tables: activity_taxonomy_assignments, spending_activity_events, spending_event_types,
--             spending_events, spending_categorization_rules,
--             spending_preset_rule_deletions, budget_groups,
--             budget_group_assignments, budget_targets,
--             budget_rollover_settings
--   - Seeds: 'Spending Categories' + 'Income Sources' system taxonomies (scope='activity')
--           with full category trees ported from PR #494; 7 default event types
--
-- Notes on intentional non-additions:
--   - `accounts` only gets a one-time fallback for non-canonical legacy account_type rows.
--   - `activities.name` not added: existing `notes` column carries payee/merchant string
--     (rules pattern-match on it; CSV import maps Description → notes).

-- Spending introduces CREDIT_CARD as a new account type. Pre-spending rows should not
-- be inferred as credit-card accounts from loose legacy strings; only preserve known
-- cash/crypto aliases and otherwise fall back to the previous default.
UPDATE accounts
SET account_type = CASE
    WHEN UPPER(TRIM(account_type)) IN ('CRYPTO', 'CRYPTO_ACCOUNT', 'CRYPTO ACCOUNT')
        THEN 'CRYPTOCURRENCY'
    WHEN UPPER(TRIM(account_type)) IN ('CASH_ACCOUNT', 'CASH')
        THEN 'CASH'
    ELSE 'SECURITIES'
END
WHERE account_type NOT IN ('SECURITIES', 'CASH', 'CREDIT_CARD', 'CRYPTOCURRENCY');

-- ============================================================================
-- 1. EXTEND TAXONOMIES: scope + icon
-- ============================================================================

ALTER TABLE taxonomies ADD COLUMN scope TEXT NOT NULL DEFAULT 'asset';
CREATE INDEX ix_taxonomies_scope ON taxonomies(scope);

ALTER TABLE taxonomy_categories ADD COLUMN icon TEXT;

-- ============================================================================
-- 2. ACTIVITY_TAXONOMY_ASSIGNMENTS (mirrors asset_taxonomy_assignments)
-- ============================================================================

CREATE TABLE activity_taxonomy_assignments (
    id TEXT NOT NULL PRIMARY KEY,
    activity_id TEXT NOT NULL,
    taxonomy_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 10000,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
    FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE CASCADE,

    CHECK (weight >= 0 AND weight <= 10000)
);

CREATE INDEX ix_activity_taxonomy_assignments_activity ON activity_taxonomy_assignments(activity_id);
CREATE INDEX ix_activity_taxonomy_assignments_category ON activity_taxonomy_assignments(taxonomy_id, category_id);
CREATE UNIQUE INDEX ix_activity_taxonomy_assignment_unique ON activity_taxonomy_assignments(activity_id, taxonomy_id);

-- ============================================================================
-- 3. EVENT_TYPES (lookup) + EVENTS
-- ============================================================================

CREATE TABLE spending_event_types (
    id TEXT NOT NULL PRIMARY KEY,
    key TEXT,
    name TEXT NOT NULL,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_spending_event_types_key_unique
  ON spending_event_types(key)
  WHERE key IS NOT NULL;

CREATE TABLE spending_events (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    event_type_id TEXT NOT NULL REFERENCES spending_event_types(id) ON DELETE RESTRICT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_spending_events_event_type ON spending_events(event_type_id);
CREATE INDEX idx_spending_events_dates ON spending_events(start_date, end_date);

-- ============================================================================
-- 4. ACTIVITY_EVENTS (join table — activity ⇄ event tag)
--    Kept as a sidecar table rather than a column on `activities` so the core
--    activities schema stays focused on portfolio fields (account, asset,
--    type, amount, date) and isn't coupled to a spending-domain concept.
--    Mirrors the activity_taxonomy_assignments pattern above.
--
--    1:1 by construction: PRIMARY KEY (activity_id) means at most one event
--    tag per activity. CASCADE in both directions cleans up dangling rows.
-- ============================================================================

CREATE TABLE spending_activity_events (
    activity_id TEXT NOT NULL PRIMARY KEY,
    event_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES spending_events(id) ON DELETE CASCADE
);

CREATE INDEX idx_spending_activity_events_event ON spending_activity_events(event_id);

-- ============================================================================
-- 5. CATEGORIZATION_RULES (auto-categorization on create / import)
--    References taxonomy_categories via composite FK.
-- ============================================================================

CREATE TABLE spending_categorization_rules (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains',  -- 'contains' | 'starts_with' | 'exact' | 'regex'
    taxonomy_id TEXT,
    category_id TEXT,
    activity_type TEXT,                            -- optional: BUY | WITHDRAWAL | DEPOSIT | ...
    priority INTEGER NOT NULL DEFAULT 0,
    is_global INTEGER NOT NULL DEFAULT 1,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    -- Preset provenance (NULL for user-created rules):
    --   preset_id        — short slug of the source preset, e.g. "ca", "us"
    --   preset_rule_key  — stable per-rule key used for diff/update across versions
    --   preset_version   — preset version installed for this rule
    --   preset_modified  — flips to 1 when the user edits a preset-sourced rule, so
    --                      future updates ask before overwriting
    preset_id TEXT,
    preset_rule_key TEXT,
    preset_version TEXT,
    preset_modified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE SET NULL,
    CHECK (is_global IN (0, 1)),
    CHECK ((is_global = 1 AND account_id IS NULL) OR (is_global = 0 AND account_id IS NOT NULL))
);

CREATE INDEX idx_spending_categorization_rules_priority ON spending_categorization_rules(priority DESC, created_at ASC, id ASC);
CREATE INDEX idx_spending_categorization_rules_category ON spending_categorization_rules(taxonomy_id, category_id);
CREATE INDEX idx_spending_categorization_rules_account ON spending_categorization_rules(account_id);
CREATE INDEX idx_spending_categorization_rules_is_global ON spending_categorization_rules(is_global);
CREATE INDEX idx_spending_categorization_rules_activity_type ON spending_categorization_rules(activity_type);
-- Used by the preset update flow to look up "the user's installed copy of preset rule X".
-- NULL preset_id rows (user-created) are excluded from the unique index.
CREATE UNIQUE INDEX idx_spending_categorization_rules_preset_unique
  ON spending_categorization_rules(preset_id, preset_rule_key)
  WHERE preset_id IS NOT NULL;

CREATE TABLE spending_preset_rule_deletions (
    preset_id TEXT NOT NULL,
    preset_rule_key TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (preset_id, preset_rule_key),
    UNIQUE (rule_id)
);

CREATE INDEX idx_spending_preset_rule_deletions_rule
    ON spending_preset_rule_deletions(rule_id);

-- ============================================================================
-- 6. BUDGET tables
-- ============================================================================

CREATE TABLE budget_groups (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    color TEXT,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CHECK (is_system IN (0, 1))
);

CREATE INDEX idx_budget_groups_sort ON budget_groups(sort_order);

CREATE TABLE budget_group_assignments (
    id TEXT NOT NULL PRIMARY KEY,
    group_id TEXT NOT NULL,
    taxonomy_id TEXT NOT NULL DEFAULT 'spending_categories',
    category_id TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (group_id) REFERENCES budget_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE CASCADE,

    CHECK (taxonomy_id = 'spending_categories'),
    CHECK (is_system IN (0, 1)),
    UNIQUE (taxonomy_id, category_id)
);

CREATE INDEX idx_budget_group_assignments_group ON budget_group_assignments(group_id);
CREATE INDEX idx_budget_group_assignments_category ON budget_group_assignments(taxonomy_id, category_id);

CREATE TABLE budget_targets (
    id TEXT NOT NULL PRIMARY KEY,
    period_key TEXT NOT NULL,
    target_type TEXT NOT NULL,
    taxonomy_id TEXT,
    category_id TEXT,
    group_id TEXT,
    amount TEXT NOT NULL DEFAULT '0',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES budget_groups(id) ON DELETE CASCADE,

    CHECK (target_type IN ('category', 'group_buffer')),
    CHECK (
      period_key = 'default'
      OR period_key GLOB '[0-9][0-9][0-9][0-9]-0[1-9]'
      OR period_key GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
    ),
    CHECK (
      (target_type = 'category' AND taxonomy_id IS NOT NULL AND category_id IS NOT NULL AND group_id IS NULL)
      OR
      (target_type = 'group_buffer' AND taxonomy_id IS NULL AND category_id IS NULL AND group_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_budget_targets_category_unique
  ON budget_targets(period_key, taxonomy_id, category_id)
  WHERE target_type = 'category';
CREATE UNIQUE INDEX idx_budget_targets_group_buffer_unique
  ON budget_targets(period_key, group_id)
  WHERE target_type = 'group_buffer';
CREATE INDEX idx_budget_targets_period ON budget_targets(period_key);
CREATE INDEX idx_budget_targets_category ON budget_targets(taxonomy_id, category_id);
CREATE INDEX idx_budget_targets_group ON budget_targets(group_id);

CREATE TABLE budget_rollover_settings (
    id TEXT NOT NULL PRIMARY KEY,
    target_type TEXT NOT NULL,
    taxonomy_id TEXT,
    category_id TEXT,
    group_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    start_month TEXT NOT NULL,
    starting_balance TEXT NOT NULL DEFAULT '0',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES budget_groups(id) ON DELETE CASCADE,

    CHECK (target_type IN ('category', 'group')),
    CHECK (enabled IN (0, 1)),
    CHECK (
      start_month GLOB '[0-9][0-9][0-9][0-9]-0[1-9]'
      OR start_month GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
    ),
    CHECK (
      (target_type = 'category' AND taxonomy_id = 'spending_categories' AND category_id IS NOT NULL AND group_id IS NULL)
      OR
      (target_type = 'group' AND taxonomy_id IS NULL AND category_id IS NULL AND group_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_budget_rollover_settings_category_unique
  ON budget_rollover_settings(taxonomy_id, category_id)
  WHERE target_type = 'category';
CREATE UNIQUE INDEX idx_budget_rollover_settings_group_unique
  ON budget_rollover_settings(group_id)
  WHERE target_type = 'group';
CREATE INDEX idx_budget_rollover_settings_category ON budget_rollover_settings(taxonomy_id, category_id);
CREATE INDEX idx_budget_rollover_settings_group ON budget_rollover_settings(group_id);

-- ============================================================================
-- 7. SEED: BUDGET GROUPS + SYSTEM TAXONOMIES with scope='activity'
-- ============================================================================

-- Color palette: muted/earthy Flexoki-adjacent hues lifted from the spending
-- tracker design. Categories without a direct design counterpart fall back to
-- Flexoki 500/600 shades (see apps/frontend/src/globals.css).
INSERT INTO budget_groups (id, name, key, color, icon, sort_order, is_system) VALUES
  ('032ecb02-5912-42e8-9724-2cd566fc08d5', 'Needs',    'needs',    '#4F6B92', 'Home',          1, 1),
  ('a409e0d6-9152-49c8-a5b4-a147a8ac636e', 'Wants',    'wants',    '#8E7CB3', 'Sparkles',      2, 1),
  ('1fb6f2a3-3245-4702-83e8-ab116458d13e', 'Savings',  'savings',  '#6B8E54', 'PiggyBank',     3, 1),
  ('8cbd26c8-e3b2-4176-8c61-e5c11e10b808', 'Giving',   'giving',   '#A35742', 'Gift',          4, 1),
  ('3ff71753-5dd5-4372-9ca2-63d8d9a04851', 'Personal', 'personal', '#B89A4C', 'User',          5, 1),
  ('6e25d097-0c73-4521-9407-d47e8dfb73e2', 'Other',    'other',    '#9C998E', 'MoreHorizontal',99, 1);

INSERT INTO taxonomies (id, name, color, description, is_system, is_single_select, sort_order, scope)
VALUES
  ('spending_categories', 'Spending Categories', '#B0552E',
   'Hierarchical expense categories (Food, Transport, Housing, …) used to classify cash withdrawals and outgoing transfers.',
   1, 1, 200, 'activity'),
  ('income_sources', 'Income Sources', '#5A7A3E',
   'Income classification (Salary, Dividends, Rental, …) used to classify cash deposits.',
   1, 1, 210, 'activity');

-- ----------------------------------------------------------------------------
-- 9a. Spending Categories: TOP LEVEL (parents)
-- ----------------------------------------------------------------------------

INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_housing',         'spending_categories', NULL, 'Housing',          'housing',         '#A35742', 'Home',           1),
  ('cat_groceries',       'spending_categories', NULL, 'Groceries',        'groceries',       '#5A7A3E', 'ShoppingCart',   2),
  ('cat_food',            'spending_categories', NULL, 'Food & Dining',    'food',            '#B89A4C', 'UtensilsCrossed',3),
  ('cat_transport',       'spending_categories', NULL, 'Transportation',   'transport',       '#7B96C9', 'Car',            4),
  ('cat_shopping',        'spending_categories', NULL, 'Shopping',         'shopping',        '#8E7CB3', 'ShoppingBag',    5),
  ('cat_entertainment',   'spending_categories', NULL, 'Entertainment',    'entertainment',   '#B0552E', 'Film',           6),
  ('cat_health',          'spending_categories', NULL, 'Health & Wellness','health',          '#6B8E54', 'Heart',          7),
  ('cat_bills',           'spending_categories', NULL, 'Bills & Utilities','bills',           '#4F6B92', 'FileText',       8),
  ('cat_personal',        'spending_categories', NULL, 'Personal Care',    'personal',        '#B74583', 'User',           9),
  ('cat_education',       'spending_categories', NULL, 'Education',        'education',       '#24837B', 'GraduationCap', 10),
  ('cat_travel',          'spending_categories', NULL, 'Travel',           'travel',          '#3171B2', 'Plane',         11),
  ('cat_gifts',           'spending_categories', NULL, 'Gifts & Donations','gifts',           '#AF3029', 'Gift',          12),
  ('cat_fees',            'spending_categories', NULL, 'Fees & Charges',   'fees',            '#9C998E', 'CreditCard',    13),
  ('cat_savings',         'spending_categories', NULL, 'Savings',          'savings',         '#6B8E54', 'PiggyBank',     14),
  ('cat_other_expense',   'spending_categories', NULL, 'Other Expenses',   'other_expense',   '#B6B2A4', 'MoreHorizontal',99);

INSERT INTO budget_group_assignments (id, group_id, taxonomy_id, category_id, is_system) VALUES
  ('d36f8d92-36f8-4e07-b4b4-9e979ce8a9f4', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_housing', 1),
  ('c9a1ef0d-72b2-4f75-858d-5f48e5bc7626', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_groceries', 1),
  ('e9543a4c-dead-42f6-9e73-7343e8f43392', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_transport', 1),
  ('aa46cdeb-d224-4f3f-9ffb-f6331bafeade', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_health', 1),
  ('00769d66-fac3-45e9-9e98-1db5d4447bec', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_bills', 1),
  ('9eeaa7b8-aa98-4861-94d3-54650226d9cc', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_fees', 1),
  ('5ba8b7fa-bd44-456a-9165-dfdf554bfe10', '032ecb02-5912-42e8-9724-2cd566fc08d5', 'spending_categories', 'cat_education', 1),
  ('2f4bbcbd-8120-4fbe-ab4a-85f7c406e488', 'a409e0d6-9152-49c8-a5b4-a147a8ac636e', 'spending_categories', 'cat_food', 1),
  ('39148a03-c9e9-40e4-867f-5949146b85b8', 'a409e0d6-9152-49c8-a5b4-a147a8ac636e', 'spending_categories', 'cat_shopping', 1),
  ('c2721f07-e7b6-4c74-b449-f138a7d7dabf', 'a409e0d6-9152-49c8-a5b4-a147a8ac636e', 'spending_categories', 'cat_entertainment', 1),
  ('5a2a7585-9f60-4a4b-9cbe-420432720f28', 'a409e0d6-9152-49c8-a5b4-a147a8ac636e', 'spending_categories', 'cat_travel', 1),
  ('d48afe20-18d3-422e-bc26-bd16f4d9d78c', '8cbd26c8-e3b2-4176-8c61-e5c11e10b808', 'spending_categories', 'cat_gifts', 1),
  ('dc8d3b07-dbc5-4134-bc31-9f65a7f726bc', '3ff71753-5dd5-4372-9ca2-63d8d9a04851', 'spending_categories', 'cat_personal', 1),
  ('2f46a6a5-dda6-41c7-b372-a0d4f2e571eb', '1fb6f2a3-3245-4702-83e8-ab116458d13e', 'spending_categories', 'cat_savings', 1),
  ('fb622784-fb8a-497d-8b36-8eb8f347c222', '6e25d097-0c73-4521-9407-d47e8dfb73e2', 'spending_categories', 'cat_other_expense', 1);

-- ----------------------------------------------------------------------------
-- 9b. Spending Categories: SUBCATEGORIES
-- ----------------------------------------------------------------------------

-- Housing
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_housing_rent',        'spending_categories', 'cat_housing', 'Rent/Mortgage',         'housing_rent',        '#A35742', 'Home',     1),
  ('cat_housing_utilities',   'spending_categories', 'cat_housing', 'Utilities',             'housing_utilities',   '#A35742', 'Lightbulb',2),
  ('cat_housing_insurance',   'spending_categories', 'cat_housing', 'Home Insurance',        'housing_insurance',   '#A35742', 'Shield',   3),
  ('cat_housing_maintenance', 'spending_categories', 'cat_housing', 'Maintenance & Repairs', 'housing_maintenance', '#A35742', 'Wrench',   4),
  ('cat_housing_furnishing',  'spending_categories', 'cat_housing', 'Furnishing',            'housing_furnishing',  '#A35742', 'Sofa',     5);

-- Food & Dining (eating out — Groceries lifted to its own top-level since
-- modern PFM apps universally treat it as separate from "dining out".)
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_food_restaurants', 'spending_categories', 'cat_food', 'Restaurants',     'food_restaurants', '#B89A4C', 'UtensilsCrossed', 1),
  ('cat_food_coffee',      'spending_categories', 'cat_food', 'Coffee Shops',    'food_coffee',      '#B89A4C', 'Coffee',          2),
  ('cat_food_delivery',    'spending_categories', 'cat_food', 'Food Delivery',   'food_delivery',    '#B89A4C', 'Truck',           3),
  ('cat_food_alcohol',     'spending_categories', 'cat_food', 'Bars & Alcohol',  'food_alcohol',     '#B89A4C', 'Wine',            4);

-- Transportation
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_transport_gas',         'spending_categories', 'cat_transport', 'Gas & Fuel',       'transport_gas',         '#7B96C9', 'Fuel',          1),
  ('cat_transport_parking',     'spending_categories', 'cat_transport', 'Parking',          'transport_parking',     '#7B96C9', 'ParkingCircle', 2),
  ('cat_transport_public',      'spending_categories', 'cat_transport', 'Public Transit',   'transport_public',      '#7B96C9', 'Train',         3),
  ('cat_transport_rideshare',   'spending_categories', 'cat_transport', 'Rideshare & Taxi', 'transport_rideshare',   '#7B96C9', 'Car',           4),
  ('cat_transport_maintenance', 'spending_categories', 'cat_transport', 'Car Maintenance',  'transport_maintenance', '#7B96C9', 'Wrench',        5),
  ('cat_transport_insurance',   'spending_categories', 'cat_transport', 'Auto Insurance',   'transport_insurance',   '#7B96C9', 'Shield',        6);

-- Shopping
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_shopping_clothing',    'spending_categories', 'cat_shopping', 'Clothing',        'shopping_clothing',    '#8E7CB3', 'Shirt',      1),
  ('cat_shopping_electronics', 'spending_categories', 'cat_shopping', 'Electronics',     'shopping_electronics', '#8E7CB3', 'Smartphone', 2),
  ('cat_shopping_home',        'spending_categories', 'cat_shopping', 'Home Goods',      'shopping_home',        '#8E7CB3', 'Home',       3),
  ('cat_shopping_online',      'spending_categories', 'cat_shopping', 'Online Shopping', 'shopping_online',      '#8E7CB3', 'Globe',      4);

-- Entertainment
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_entertainment_streaming', 'spending_categories', 'cat_entertainment', 'Streaming Services',  'entertainment_streaming', '#B0552E', 'Tv',       1),
  ('cat_entertainment_movies',    'spending_categories', 'cat_entertainment', 'Movies & Events',     'entertainment_movies',    '#B0552E', 'Film',     2),
  ('cat_entertainment_games',     'spending_categories', 'cat_entertainment', 'Games & Apps',        'entertainment_games',     '#B0552E', 'Gamepad2', 3),
  ('cat_entertainment_hobbies',   'spending_categories', 'cat_entertainment', 'Hobbies',             'entertainment_hobbies',   '#B0552E', 'Palette',  4),
  ('cat_entertainment_sports',    'spending_categories', 'cat_entertainment', 'Sports & Recreation', 'entertainment_sports',    '#B0552E', 'Dumbbell', 5);

-- Health & Wellness
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_health_medical',   'spending_categories', 'cat_health', 'Medical',          'health_medical',   '#6B8E54', 'Stethoscope', 1),
  ('cat_health_pharmacy',  'spending_categories', 'cat_health', 'Pharmacy',         'health_pharmacy',  '#6B8E54', 'Pill',        2),
  ('cat_health_dental',    'spending_categories', 'cat_health', 'Dental',           'health_dental',    '#6B8E54', 'Smile',       3),
  ('cat_health_vision',    'spending_categories', 'cat_health', 'Vision',           'health_vision',    '#6B8E54', 'Eye',         4),
  ('cat_health_fitness',   'spending_categories', 'cat_health', 'Gym & Fitness',    'health_fitness',   '#6B8E54', 'Dumbbell',    5),
  ('cat_health_insurance', 'spending_categories', 'cat_health', 'Health Insurance', 'health_insurance', '#6B8E54', 'Shield',      6);

-- Bills & Utilities
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_bills_phone',         'spending_categories', 'cat_bills', 'Phone',               'bills_phone',         '#4F6B92', 'Smartphone', 1),
  ('cat_bills_internet',      'spending_categories', 'cat_bills', 'Internet',            'bills_internet',      '#4F6B92', 'Wifi',       2),
  ('cat_bills_subscriptions', 'spending_categories', 'cat_bills', 'Subscriptions',       'bills_subscriptions', '#4F6B92', 'Calendar',   3),
  ('cat_bills_software',      'spending_categories', 'cat_bills', 'Software & Services', 'bills_software',      '#4F6B92', 'Code',       4);

-- Fees & Charges
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_fees_bank',     'spending_categories', 'cat_fees', 'Bank Fees',        'fees_bank',     '#9C998E', 'Building',    1),
  ('cat_fees_atm',      'spending_categories', 'cat_fees', 'ATM Fees',         'fees_atm',      '#9C998E', 'Banknote',    2),
  ('cat_fees_interest', 'spending_categories', 'cat_fees', 'Interest Charges', 'fees_interest', '#9C998E', 'Percent',     3),
  ('cat_fees_late',     'spending_categories', 'cat_fees', 'Late Fees',        'fees_late',     '#9C998E', 'AlertCircle', 4);

-- Savings
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_savings_emergency',    'spending_categories', 'cat_savings', 'Emergency Fund',           'savings_emergency',    '#6B8E54', 'Shield',     1),
  ('cat_savings_retirement',   'spending_categories', 'cat_savings', 'Retirement',               'savings_retirement',   '#6B8E54', 'PiggyBank',  2),
  ('cat_savings_investments',  'spending_categories', 'cat_savings', 'Investment Contributions', 'savings_investments',  '#6B8E54', 'TrendingUp', 3),
  ('cat_savings_short_term',   'spending_categories', 'cat_savings', 'Short-Term Savings',       'savings_short_term',   '#6B8E54', 'Wallet',     4),
  ('cat_savings_education',    'spending_categories', 'cat_savings', 'Education / 529',          'savings_education',    '#6B8E54', 'GraduationCap', 5),
  ('cat_savings_charitable',   'spending_categories', 'cat_savings', 'Charitable Reserve',       'savings_charitable',   '#6B8E54', 'Heart',      6);

-- ----------------------------------------------------------------------------
-- 9c. Income Sources: TOP LEVEL (parents)
-- ----------------------------------------------------------------------------

INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_income_employment',  'income_sources', NULL, 'Employment',        'income_employment',  '#5A7A3E', 'Briefcase',  1),
  ('cat_income_selfemploy',  'income_sources', NULL, 'Self-Employment',   'income_selfemploy',  '#6B8E54', 'User',       2),
  ('cat_income_investment',  'income_sources', NULL, 'Investment Income', 'income_investment',  '#B89A4C', 'TrendingUp', 3),
  ('cat_income_other',       'income_sources', NULL, 'Other Income',      'income_other',       '#9C998E', 'DollarSign', 4);

-- Income subcategories
INSERT INTO taxonomy_categories (id, taxonomy_id, parent_id, name, key, color, icon, sort_order) VALUES
  ('cat_income_salary',         'income_sources', 'cat_income_employment', 'Salary',         'income_salary',         '#5A7A3E', 'Briefcase',  1),
  ('cat_income_bonus',          'income_sources', 'cat_income_employment', 'Bonus',          'income_bonus',          '#5A7A3E', 'Award',      2),
  ('cat_income_commission',     'income_sources', 'cat_income_employment', 'Commission',     'income_commission',     '#5A7A3E', 'Target',     3),
  ('cat_income_freelance',      'income_sources', 'cat_income_selfemploy', 'Freelance',      'income_freelance',      '#6B8E54', 'Laptop',     1),
  ('cat_income_business',       'income_sources', 'cat_income_selfemploy', 'Business Income','income_business',       '#6B8E54', 'Building',   2),
  ('cat_income_dividends',      'income_sources', 'cat_income_investment', 'Dividends',      'income_dividends',      '#B89A4C', 'PiggyBank',  1),
  ('cat_income_interest',       'income_sources', 'cat_income_investment', 'Interest',       'income_interest',       '#B89A4C', 'Percent',    2),
  ('cat_income_rental',         'income_sources', 'cat_income_investment', 'Rental Income',  'income_rental',         '#B89A4C', 'Home',       3),
  ('cat_income_capital_gains',  'income_sources', 'cat_income_investment', 'Capital Gains',  'income_capital_gains',  '#B89A4C', 'TrendingUp', 4),
  ('cat_income_gifts',          'income_sources', 'cat_income_other',      'Gifts Received', 'income_gifts',          '#9C998E', 'Gift',       1),
  ('cat_income_refunds',        'income_sources', 'cat_income_other',      'Refunds',        'income_refunds',        '#9C998E', 'RotateCcw',  2),
  ('cat_income_reimbursements', 'income_sources', 'cat_income_other',      'Reimbursements', 'income_reimbursements', '#9C998E', 'Receipt',    3),
  ('cat_income_tax_refund',     'income_sources', 'cat_income_other',      'Tax Refund',     'income_tax_refund',     '#9C998E', 'FileText',   4);

-- ============================================================================
-- 8. SEED: DEFAULT EVENT TYPES
-- ============================================================================

INSERT INTO spending_event_types (id, key, name, color) VALUES
  ('255600dc-c2a3-47e0-979d-a602c21fc337', 'travel',           'Travel',           '#7B96C9'),
  ('51e3eedb-5484-45ba-a525-6b88209c46ed', 'holiday',          'Holiday',          '#6B8E54'),
  ('d9871ccb-5396-4c70-ac08-5b07ed90e64a', 'business',         'Business',         '#B89A4C'),
  ('22442173-c794-45bf-97ee-9b3f9a7c8ba3', 'education',        'Education',        '#5A7A3E'),
  ('94fc13ed-ac40-466b-8071-64f1e3c72204', 'medical',          'Medical',          '#B0552E'),
  ('1aaab8fb-8fd9-4543-bd46-d9ee4a5a8564', 'special_occasion', 'Special Occasion', '#8E7CB3'),
  ('fa4812ee-e06e-4117-a819-e4d88b7acbaf', 'other',            'Other',            '#9C998E');

-- ============================================================================
-- 9. SEED: ENABLE SPENDING MODULE BY DEFAULT
-- ============================================================================

INSERT OR IGNORE INTO app_settings (setting_key, setting_value)
VALUES ('spending.enabled', 'true');
