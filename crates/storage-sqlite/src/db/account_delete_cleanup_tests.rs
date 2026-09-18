use super::DbAccess;
use rusqlite::Connection;

const UP: &str = include_str!("../../migrations/2026-09-15-000001_account_delete_cleanup/up.sql");
const DOWN: &str =
    include_str!("../../migrations/2026-09-15-000001_account_delete_cleanup/down.sql");

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn legacy_database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("accounts.db");
    DbAccess::plaintext(path.to_str().unwrap())
        .run_migrations()
        .unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(DOWN).unwrap();
    conn.execute_batch(
        "INSERT INTO accounts (id, name, currency) VALUES
            ('keep', 'Keep', 'USD'), ('delete', 'Delete', 'USD');
         INSERT INTO sync_entity_metadata (entity, entity_id, last_event_id, last_client_timestamp, last_op, last_seq)
            VALUES ('account', 'orphan', 'delete-event', '2026-09-01T12:00:00Z', 'delete', 1);
         INSERT INTO assets (id, kind, quote_mode, quote_ccy)
            VALUES ('asset', 'INVESTMENT', 'MANUAL', 'USD');
         INSERT INTO holdings_snapshots (
            id, account_id, snapshot_date, currency, positions, cash_balances,
            cost_basis, net_contribution, calculated_at, net_contribution_base,
            cash_total_account_currency, cash_total_base_currency, source
         ) SELECT a.id || '-' || s.source, a.id, '2026-09-01', 'USD',
            '{\"asset\":{}}', '{\"USD\":12}', '10', '11', '2026-09-01T12:00:00Z',
            '13', '14', '15', s.source
         FROM (SELECT 'keep' AS id UNION ALL SELECT 'delete' UNION ALL SELECT 'orphan') a
         CROSS JOIN (SELECT 'CALCULATED' AS source UNION ALL SELECT 'MANUAL_ENTRY'
            UNION ALL SELECT 'CSV_IMPORT' UNION ALL SELECT 'BROKER_IMPORTED'
            UNION ALL SELECT 'SYNTHETIC') s;
         INSERT INTO snapshot_positions (
            snapshot_id, asset_id, quantity, average_cost, total_cost_basis,
            currency, inception_date, created_at, last_updated
         ) SELECT id, 'asset', '2', '5', '10', 'USD', '2026-09-01',
            '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z' FROM holdings_snapshots;
         INSERT INTO daily_account_valuation (
            id, account_id, valuation_date, account_currency, base_currency,
            fx_rate_to_base, cash_balance, investment_market_value, total_value,
            cost_basis, net_contribution, cash_balance_base, investment_market_value_base,
            total_value_base, cost_basis_base, net_contribution_base, external_inflow_base,
            external_outflow_base, performance_eligible_value_base, calculated_at,
            external_flow_source, value_status, basis_status
         ) SELECT id, id, '2026-09-01', 'USD', 'CAD', '1.3', '1', '2', '3',
            '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
            '2026-09-01T12:00:00Z', 'ACTIVITY', 'PARTIAL', 'COMPLETE'
         FROM (SELECT 'keep' AS id UNION ALL SELECT 'delete' UNION ALL SELECT 'orphan');
         CREATE TEMP TABLE expected_snapshots AS SELECT * FROM holdings_snapshots
            WHERE account_id != 'orphan';
         CREATE TEMP TABLE expected_positions AS SELECT * FROM snapshot_positions
            WHERE snapshot_id NOT LIKE 'orphan-%';
         CREATE TEMP TABLE expected_valuations AS SELECT * FROM daily_account_valuation
            WHERE account_id != 'orphan';",
    )
    .unwrap();
    (dir, conn)
}

fn assert_preserved(conn: &Connection) {
    for (table, expected) in [
        ("holdings_snapshots", "expected_snapshots"),
        ("snapshot_positions", "expected_positions"),
        ("daily_account_valuation", "expected_valuations"),
    ] {
        assert_eq!(
            count(conn, &format!("SELECT COUNT(*) FROM {table}")),
            count(conn, &format!("SELECT COUNT(*) FROM {expected}")),
            "row count in {table}"
        );
        assert_eq!(
            count(
                conn,
                &format!(
                    "SELECT COUNT(*) FROM (SELECT * FROM {table} EXCEPT SELECT * FROM {expected})"
                )
            ),
            0,
            "all persisted fields in {table} must survive the migration"
        );
    }
    assert_eq!(
        count(conn, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
        0
    );
    assert_eq!(
        count(
            conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN (
            'idx_holdings_snapshots_account_date', 'idx_holdings_snapshots_account_id',
            'idx_holdings_snapshots_date', 'ix_holdings_snapshots_source',
            'idx_daily_account_valuation_account_date')"
        ),
        5
    );
}

#[test]
fn account_delete_cleanup_migration_cleans_orphans_and_preserves_valid_data() {
    let (_dir, mut conn) = legacy_database();
    // Match the migration runner: foreign keys disabled, migration transactional.
    let tx = conn.transaction().unwrap();
    tx.execute_batch(UP).unwrap();
    tx.commit().unwrap();
    assert_preserved(&conn);

    let tx = conn.transaction().unwrap();
    tx.execute_batch(DOWN).unwrap();
    tx.commit().unwrap();
    assert_preserved(&conn);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'accounts_delete_portfolio_rows'"),
        0
    );
    // Repeating the data repair must preserve surviving data.
    conn.execute_batch(UP).unwrap();
    assert_preserved(&conn);
}

#[test]
fn account_delete_cleanup_preserves_snapshots_waiting_for_their_account() {
    let (_dir, conn) = legacy_database();
    conn.execute_batch(
        "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, source)
         VALUES ('waiting', 'late-account', '2026-09-01', 'USD', 'MANUAL_ENTRY'),
                ('derived-orphan', 'late-account', '2026-09-01', 'USD', 'CALCULATED');",
    )
    .unwrap();
    conn.execute_batch(UP).unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM holdings_snapshots WHERE id = 'waiting'"
        ),
        1
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM holdings_snapshots WHERE id = 'derived-orphan'"
        ),
        0
    );
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, source)
         VALUES ('waiting-csv', 'late-account', '2026-09-02', 'USD', 'CSV_IMPORT');
         INSERT INTO accounts (id, name, currency) VALUES ('late-account', 'Late account', 'USD');",
    )
    .unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM holdings_snapshots WHERE account_id = 'late-account'"
        ),
        2
    );
}
