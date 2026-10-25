ALTER TABLE contribution_limits
ADD COLUMN contribution_type TEXT NULL
CHECK (contribution_type IS NULL OR contribution_type IN ('employee', 'employer'));
