-- Existing base amounts have no reliable currency tag. Rebuild calculated data
-- through the existing coordinator; observed snapshots remain user-owned.
ALTER TABLE holdings_snapshots ADD COLUMN base_currency TEXT;
-- Preserve missing acquisition/disposal FX instead of interpreting numeric zero as known.
ALTER TABLE lot_disposals ADD COLUMN proceeds_base_known BOOLEAN;
ALTER TABLE lot_disposals ADD COLUMN cost_basis_base_known BOOLEAN;
INSERT INTO projection_state (scope, dirty_from, version) VALUES ('@all', '0001-01-01', 1)
ON CONFLICT(scope) DO UPDATE SET dirty_from = '0001-01-01', version = version + 1;
