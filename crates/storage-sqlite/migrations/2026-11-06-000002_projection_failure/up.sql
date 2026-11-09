-- A failure belongs only to the exact inputs attempted. Existing invalidation
-- triggers bump version, so a later edit cannot inherit an obsolete failure.
ALTER TABLE projection_state ADD COLUMN failed_version BIGINT;
