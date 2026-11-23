-- A held position without a quote is now valued at its cost, where it used to
-- count as zero and leave its days PARTIAL_UNPRICED or UNAVAILABLE. Stored
-- valuations keep the old values until their days are valued again, and
-- nothing else marks them: a rule change is not a changed fact. Mark each
-- account from its first such day, so the next portfolio update rewrites them.
INSERT INTO projection_state (scope, dirty_from, version)
SELECT account_id, min(valuation_date), 1
FROM daily_account_valuation
WHERE value_status <> 'COMPLETE'
  AND account_id IN (SELECT id FROM accounts)
GROUP BY account_id
ON CONFLICT (scope) DO UPDATE SET
    dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
    version = projection_state.version + 1;
