-- A missing account can be a sync parent that has not arrived yet. Preserve
-- source snapshots unless the account has a deletion tombstone; calculated
-- snapshots and daily valuations are rebuildable local data.
DELETE FROM holdings_snapshots
WHERE account_id NOT IN (SELECT id FROM accounts)
  AND (
      source = 'CALCULATED'
      OR account_id IN (
          SELECT entity_id FROM sync_entity_metadata
          WHERE entity = 'account' AND last_op = 'delete'
      )
  );

-- Migration connections disable foreign keys, so clean position rows explicitly.
DELETE FROM snapshot_positions
WHERE snapshot_id NOT IN (SELECT id FROM holdings_snapshots);

DELETE FROM daily_account_valuation
WHERE account_id NOT IN (SELECT id FROM accounts);

-- Sync may insert snapshots before their account, so a foreign key on account_id
-- would reject valid replay. A trigger covers both repository and direct SQL
-- account deletion without imposing an insertion order.
CREATE TRIGGER accounts_delete_portfolio_rows
AFTER DELETE ON accounts
BEGIN
    DELETE FROM holdings_snapshots WHERE account_id = OLD.id;
    DELETE FROM daily_account_valuation WHERE account_id = OLD.id;
END;

-- Absence alone can mean a synced account has not arrived. Only repair references
-- to accounts with a recorded deletion, and retain all shared configuration.
CREATE TEMP TABLE deleted_account_refs AS
SELECT entity_id AS id FROM sync_entity_metadata
WHERE entity = 'account' AND last_op = 'delete'
  AND entity_id NOT IN (SELECT id FROM accounts);

CREATE TEMP TABLE deleted_account_targets AS
SELECT id FROM allocation_targets
WHERE scope_type = 'account' AND scope_id IN (SELECT id FROM deleted_account_refs);

DELETE FROM import_account_templates
WHERE account_id IN (SELECT id FROM deleted_account_refs);
-- Migration connections disable foreign keys; remove dependent rows explicitly.
DELETE FROM allocation_target_weights
WHERE target_id IN (SELECT id FROM deleted_account_targets);
DELETE FROM allocation_target_constraints
WHERE target_id IN (SELECT id FROM deleted_account_targets)
   OR (subject_type = 'account' AND subject_id IN (SELECT id FROM deleted_account_refs));
DELETE FROM allocation_targets WHERE id IN (SELECT id FROM deleted_account_targets);

-- Quote before splitting so quotes/backslashes in stored tokens stay valid JSON.
-- Keep original tokens and their order; trim only for account-ID comparison.
CREATE TEMP TABLE contribution_account_tokens AS
SELECT limits.id, CAST(tokens.key AS INTEGER) AS position, tokens.value AS token,
       trim(tokens.value, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288)) AS account_id
FROM contribution_limits AS limits,
     json_each('[' || replace(json_quote(limits.account_ids), ',', '","') || ']') AS tokens
WHERE limits.account_ids IS NOT NULL;

UPDATE contribution_limits
SET account_ids = COALESCE((
    SELECT group_concat(token, ',') FROM (
        SELECT token FROM contribution_account_tokens
        WHERE id = contribution_limits.id
          AND account_id NOT IN (SELECT id FROM deleted_account_refs)
        ORDER BY position
    )
), '')
WHERE id IN (
    SELECT id FROM contribution_account_tokens
    WHERE account_id IN (SELECT id FROM deleted_account_refs)
);

-- Match the application's Vec<String> parsing: preserve invalid JSON, objects,
-- and arrays containing non-string values rather than guessing at their meaning.
CREATE TEMP TABLE spending_account_tokens AS
SELECT tokens.key AS position, tokens.value AS account_id, tokens.type
FROM app_settings,
     json_each(CASE WHEN json_valid(setting_value)
                    THEN CASE WHEN json_type(setting_value) = 'array' THEN setting_value ELSE '[]' END
                    ELSE '[]' END) AS tokens
WHERE setting_key = 'spending.account_ids';

UPDATE app_settings
SET setting_value = (
    SELECT json_group_array(account_id) FROM (
        SELECT account_id FROM spending_account_tokens
        WHERE account_id NOT IN (SELECT id FROM deleted_account_refs)
        ORDER BY position
    )
)
WHERE setting_key = 'spending.account_ids'
  AND NOT EXISTS (SELECT 1 FROM spending_account_tokens WHERE type <> 'text')
  AND EXISTS (SELECT 1 FROM spending_account_tokens WHERE account_id IN (SELECT id FROM deleted_account_refs));

DROP TABLE spending_account_tokens;
DROP TABLE contribution_account_tokens;
DROP TABLE deleted_account_targets;
DROP TABLE deleted_account_refs;
