-- Your SQL goes here

-- Mark a contribution limit as repeating every subsequent year
ALTER TABLE contribution_limits ADD COLUMN is_recurring BOOLEAN NOT NULL DEFAULT 0;

-- Per-limit exclusions do not modify the underlying activities.
ALTER TABLE contribution_limits ADD COLUMN excluded_activity_ids TEXT;
