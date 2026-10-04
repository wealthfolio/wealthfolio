-- An activity's type override counts trimmed of what Rust's str::trim strips,
-- and not at all when that leaves it empty (engine rules §5). Every write now
-- stores it that way, but rows written before keep theirs: edits used to write
-- a row's stored override back unchanged, and broker sync never writes it.
-- Readers of the stored column that do not trim, such as the addon SDK's
-- getEffectiveType and hasUserOverride, read a blank one as a type and keep the
-- whitespace around another. Store each trimmed, and a blank one as NULL.
--
-- The list is the storage crate's SQL_WHITESPACE, as the projection triggers
-- spell it. No effective type changes; the projection triggers mark each
-- touched account for a refold, which computes the same result.
UPDATE activities
SET activity_type_override = nullif(trim(activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), '')
WHERE activity_type_override IS NOT nullif(trim(activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), '');
