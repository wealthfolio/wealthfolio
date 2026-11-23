-- This file should undo anything in `up.sql`
ALTER TABLE contribution_limits DROP COLUMN excluded_activity_ids;
ALTER TABLE contribution_limits DROP COLUMN is_recurring;
