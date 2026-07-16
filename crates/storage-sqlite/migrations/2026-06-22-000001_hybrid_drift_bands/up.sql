ALTER TABLE allocation_targets
  ADD COLUMN band_type TEXT NOT NULL DEFAULT 'absolute'
      CHECK (band_type IN ('absolute', 'hybrid'));

ALTER TABLE allocation_targets
  ADD COLUMN relative_factor_bps INTEGER NOT NULL DEFAULT 2000
      CHECK (relative_factor_bps >= 0 AND relative_factor_bps <= 10000);
