CREATE TABLE IF NOT EXISTS spending_activity_splits (
  id TEXT NOT NULL PRIMARY KEY,
  activity_id TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (CAST(amount AS REAL) > 0),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
  FOREIGN KEY (taxonomy_id) REFERENCES taxonomies(id) ON DELETE CASCADE,
  FOREIGN KEY (taxonomy_id, category_id) REFERENCES taxonomy_categories(taxonomy_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_spending_activity_splits_activity
  ON spending_activity_splits(activity_id);

CREATE INDEX IF NOT EXISTS idx_spending_activity_splits_category
  ON spending_activity_splits(taxonomy_id, category_id);
