-- User-uploaded logo override for an asset. Filename only; bytes live under
-- the app's data directory, resolved and served by the asset logo service.
ALTER TABLE assets ADD COLUMN custom_logo_filename TEXT;
