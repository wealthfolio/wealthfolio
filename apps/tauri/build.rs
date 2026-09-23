use std::{env, fs, path::PathBuf};

fn read_connect_api_url_from_dotenv() -> Option<String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let dotenv_path = PathBuf::from(manifest_dir).join("../../.env");

    println!("cargo:rerun-if-changed={}", dotenv_path.display());

    let content = fs::read_to_string(dotenv_path).ok()?;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some(value) = line.strip_prefix("CONNECT_API_URL=") else {
            continue;
        };

        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();

        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    None
}

fn read_env_value_from_dotenv(key: &str) -> Option<String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let dotenv_path = PathBuf::from(manifest_dir).join("../../.env");

    println!("cargo:rerun-if-changed={}", dotenv_path.display());

    let content = fs::read_to_string(dotenv_path).ok()?;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let line = line.strip_prefix("export ").unwrap_or(line);
        let prefix = format!("{}=", key);
        let Some(value) = line.strip_prefix(&prefix) else {
            continue;
        };

        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();

        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    None
}

fn main() {
    println!("cargo:rerun-if-env-changed=CONNECT_API_URL");
    println!("cargo:rerun-if-env-changed=CONNECT_AUTH_URL");
    println!("cargo:rerun-if-env-changed=CONNECT_AUTH_PUBLISHABLE_KEY");

    let connect_api_url = env::var("CONNECT_API_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(read_connect_api_url_from_dotenv);

    match connect_api_url {
        Some(val) => {
            println!("cargo:rustc-env=CONNECT_API_URL={}", val);
            println!("cargo:warning=CONNECT_API_URL is set: {}", val);
        }
        None => {
            println!("cargo:warning=CONNECT_API_URL is NOT set");
        }
    }

    let connect_auth_url = env::var("CONNECT_AUTH_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| read_env_value_from_dotenv("CONNECT_AUTH_URL"));
    if let Some(val) = connect_auth_url {
        println!("cargo:rustc-env=CONNECT_AUTH_URL={}", val);
    } else {
        println!("cargo:warning=CONNECT_AUTH_URL is NOT set");
    }

    let connect_auth_publishable_key = env::var("CONNECT_AUTH_PUBLISHABLE_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| read_env_value_from_dotenv("CONNECT_AUTH_PUBLISHABLE_KEY"));
    if let Some(val) = connect_auth_publishable_key {
        println!("cargo:rustc-env=CONNECT_AUTH_PUBLISHABLE_KEY={}", val);
    } else {
        println!("cargo:warning=CONNECT_AUTH_PUBLISHABLE_KEY is NOT set");
    }

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri embeds its default manifest only in application binaries. Link the
        // same manifest into unit-test executables too, which need Common Controls v6.
        // See https://github.com/tauri-apps/tauri/issues/13419.
        let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("failed to run tauri-build");
    } else {
        tauri_build::build()
    }
}
