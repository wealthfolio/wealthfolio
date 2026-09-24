use std::{ffi::OsString, path::PathBuf};

/// Persisted production identity; retain its database and credential compatibility.
pub const PRODUCTION_APP_IDENTIFIER: &str = "com.teymz.wealthfolio";

/// Resolve both the profile registry root and the legacy database at the native
/// boundary. Non-production identities never adopt DATABASE_URL from the shell.
pub fn profile_paths(
    app_data_dir: String,
    identifier: &str,
    override_value: Option<OsString>,
) -> Result<(PathBuf, PathBuf), String> {
    if let Some(root) = development_override(override_value)? {
        let database = root.join("app.db");
        return Ok((root, database));
    }
    let root = PathBuf::from(&app_data_dir);
    let database = if identifier == PRODUCTION_APP_IDENTIFIER {
        wealthfolio_storage_sqlite::db::get_db_path(&app_data_dir).into()
    } else {
        root.join("app.db")
    };
    Ok((root, database))
}

/// A packaged or mobile app must never follow a development data-directory override.
pub fn development_override(value: Option<OsString>) -> Result<Option<PathBuf>, String> {
    #[cfg(all(debug_assertions, desktop, not(feature = "custom-protocol")))]
    {
        let Some(value) = value.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("WF_DATA_DIR must be an absolute path (do not use ~).".into());
        }
        Ok(Some(path))
    }
    #[cfg(not(all(debug_assertions, desktop, not(feature = "custom-protocol"))))]
    {
        let _ = value;
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonproduction_identity_keeps_legacy_database_inside_its_profile_root() {
        let root = std::env::temp_dir().join("wealthfolio-dev");
        let (registry, legacy) = profile_paths(
            root.to_string_lossy().into_owned(),
            "com.teymz.wealthfolio.dev",
            None,
        )
        .unwrap();
        assert_eq!(registry, root);
        assert_eq!(legacy, root.join("app.db"));
    }

    #[test]
    fn profile_override_moves_registry_and_legacy_database_together() {
        let root = std::env::temp_dir().join("wealthfolio-default");
        let custom = std::env::temp_dir().join("wealthfolio-custom");
        let (registry, legacy) = profile_paths(
            root.to_string_lossy().into_owned(),
            "com.teymz.wealthfolio.dev",
            Some(custom.clone().into_os_string()),
        )
        .unwrap();
        let expected = if cfg!(all(
            debug_assertions,
            desktop,
            not(feature = "custom-protocol")
        )) {
            custom
        } else {
            root
        };
        assert_eq!(registry, expected);
        assert_eq!(legacy, expected.join("app.db"));
    }

    #[test]
    fn unset_or_empty_uses_app_data() {
        assert_eq!(development_override(None), Ok(None));
        assert_eq!(development_override(Some(OsString::new())), Ok(None));
    }

    #[test]
    fn override_is_only_enabled_for_desktop_development() {
        let path = std::env::temp_dir().join("wealthfolio-dev");
        let result = development_override(Some(path.clone().into_os_string()));
        if cfg!(all(
            debug_assertions,
            desktop,
            not(feature = "custom-protocol")
        )) {
            assert_eq!(result, Ok(Some(path)));
            assert!(development_override(Some("./dev-data".into())).is_err());
            assert!(development_override(Some("~/dev-data".into())).is_err());
        } else {
            assert_eq!(result, Ok(None));
            assert_eq!(development_override(Some("./dev-data".into())), Ok(None));
        }
    }
}
