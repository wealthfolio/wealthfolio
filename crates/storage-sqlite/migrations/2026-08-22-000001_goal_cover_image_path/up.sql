-- Path to a user-uploaded custom cover image file for a goal (custom_save_up
-- goals only, set/cleared via dedicated cover-image commands, not part of
-- the regular goal edit form). NULL = no custom image, falls back to the
-- static per-goal-type stock image.
ALTER TABLE goals ADD COLUMN cover_image_path TEXT;
