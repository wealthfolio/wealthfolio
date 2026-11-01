-- This file should undo anything in `up.sql`
ALTER TABLE contribution_limits DROP COLUMN is_recurring;
