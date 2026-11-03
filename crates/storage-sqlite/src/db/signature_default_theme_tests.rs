use super::DbAccess;
use rusqlite::{Connection, OptionalExtension};

const UP: &str = include_str!("../../migrations/2026-10-29-000002_signature_default_theme/up.sql");

fn migrated_database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.db");
    DbAccess::plaintext(path.to_str().unwrap())
        .run_migrations()
        .unwrap();
    let conn = Connection::open(path).unwrap();
    (dir, conn)
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT setting_value FROM app_settings WHERE setting_key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn set(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?1, ?2)",
        [key, value],
    )
    .unwrap();
}

#[test]
fn a_new_profile_stores_no_theme_or_font_so_it_starts_on_the_defaults() {
    let (_dir, conn) = migrated_database();
    assert_eq!(setting(&conn, "theme_id"), None);
    assert_eq!(setting(&conn, "font"), None);
}

#[test]
fn a_profile_that_finished_onboarding_keeps_classic_and_mono() {
    let (_dir, conn) = migrated_database();
    set(&conn, "onboarding_completed", "true");
    conn.execute_batch(UP).unwrap();
    assert_eq!(setting(&conn, "theme_id").as_deref(), Some("classic"));
    assert_eq!(setting(&conn, "font").as_deref(), Some("font-mono"));

    // Running it again changes nothing.
    conn.execute_batch(UP).unwrap();
    assert_eq!(setting(&conn, "theme_id").as_deref(), Some("classic"));
    assert_eq!(setting(&conn, "font").as_deref(), Some("font-mono"));
}

#[test]
fn a_profile_keeps_the_theme_and_font_it_picked() {
    let (_dir, conn) = migrated_database();
    set(&conn, "onboarding_completed", "true");
    set(&conn, "theme_id", "ember");
    set(&conn, "font", "font-serif");
    conn.execute_batch(UP).unwrap();
    assert_eq!(setting(&conn, "theme_id").as_deref(), Some("ember"));
    assert_eq!(setting(&conn, "font").as_deref(), Some("font-serif"));
}

#[test]
fn a_profile_still_in_onboarding_starts_on_the_defaults() {
    let (_dir, conn) = migrated_database();
    set(&conn, "onboarding_completed", "false");
    conn.execute_batch(UP).unwrap();
    assert_eq!(setting(&conn, "theme_id"), None);
    assert_eq!(setting(&conn, "font"), None);
}
