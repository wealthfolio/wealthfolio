ALTER TABLE allocation_targets
  ADD COLUMN max_turnover_bps INTEGER DEFAULT NULL
      CHECK (max_turnover_bps IS NULL
             OR (max_turnover_bps >= 0 AND max_turnover_bps <= 10000));

CREATE TABLE allocation_target_constraints (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('asset', 'account', 'category')),
    subject_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'trade')),
    effect TEXT NOT NULL DEFAULT 'block' CHECK (effect IN ('block', 'avoid')),
    reason TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE,
    UNIQUE(target_id, subject_type, subject_id, action, effect)
);

CREATE INDEX idx_allocation_target_constraints_target
ON allocation_target_constraints(target_id);

CREATE INDEX idx_allocation_target_constraints_lookup
ON allocation_target_constraints(target_id, subject_type, action, effect);
