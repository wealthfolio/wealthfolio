//! Public production connection settings shared with the frontend.
//! Overrides are resolved by each runtime; these defaults do not enable Connect.
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectDefaults {
    pub api_url: String,
    pub oauth_callback_url: String,
    pub storage_allowed_hosts: Vec<String>,
}

pub fn connect_defaults() -> &'static ConnectDefaults {
    static DEFAULTS: LazyLock<ConnectDefaults> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../config/connect.defaults.json"))
            .expect("The checked-in public Connect defaults must match ConnectDefaults")
    });
    &DEFAULTS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_defaults_are_public_https_destinations() {
        let defaults = connect_defaults();
        assert!(defaults.api_url.starts_with("https://"));
        assert!(defaults.oauth_callback_url.starts_with("https://"));
        assert!(!defaults.storage_allowed_hosts.is_empty());
        for host in &defaults.storage_allowed_hosts {
            assert!(!host.is_empty());
            assert!(host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'));
        }
    }
}
