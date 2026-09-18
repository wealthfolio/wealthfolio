mod ai_environment;
mod api;
mod auth;
mod config;
mod database_restore;
mod domain_events;
mod error;
mod events;
mod features;
mod main_lib;
mod mcp;
mod models;
mod oidc;
mod scheduler;
mod secrets;

use config::Config;
use main_lib::init_tracing;

/// Offline database maintenance, run with the server stopped.
///
/// Converting the database replaces the file, which requires that nothing is
/// connected to it — so it is a command, not an API call.
fn run_maintenance_cli(args: &[String]) -> Option<anyhow::Result<()>> {
    if args.first().map(String::as_str) != Some("db") {
        return None;
    }

    if args.get(1).map(String::as_str) == Some("restore") {
        return Some(run_restore_cli(&args[2..]));
    }

    // Once `db` is given, a missing or unknown subcommand is an error. Falling
    // through would silently start the server instead of converting anything.
    let encrypt = match args.get(1).map(String::as_str) {
        Some("encrypt") => true,
        Some("decrypt") => false,
        Some(other) => {
            return Some(Err(anyhow::anyhow!(
                "Unknown database command 'db {other}'. Expected 'db encrypt', 'db decrypt', or 'db restore <file> [--password-stdin] [--yes]'."
            )))
        }
        None => {
            return Some(Err(anyhow::anyhow!(
                "Missing database command. Expected 'db encrypt', 'db decrypt', or 'db restore <file> [--password-stdin] [--yes]'."
            )))
        }
    };

    init_tracing();
    Some(main_lib::run_database_maintenance(encrypt))
}

fn run_restore_cli(args: &[String]) -> anyhow::Result<()> {
    use std::io::{IsTerminal, Read};
    let path = args
        .first()
        .filter(|arg| !arg.starts_with("--"))
        .ok_or_else(|| anyhow::anyhow!("Usage: db restore <file> [--password-stdin] [--yes]"))?;
    let mut password_stdin = false;
    let mut confirmed = false;
    for option in &args[1..] {
        match option.as_str() {
            "--password-stdin" if !password_stdin => password_stdin = true,
            "--yes" if !confirmed => confirmed = true,
            _ => anyhow::bail!("Unknown or repeated restore option: {option}"),
        }
    }
    let mut password = zeroize::Zeroizing::new(String::new());
    if password_stdin {
        anyhow::ensure!(
            !std::io::stdin().is_terminal(),
            "Pipe the backup password through standard input; terminal input would echo it."
        );
        std::io::stdin().take(4097).read_to_string(&mut password)?;
        anyhow::ensure!(password.len() <= 4096, "Backup password is too long");
    }
    init_tracing();
    database_restore::run_database_restore(
        std::path::Path::new(path),
        password_stdin.then_some(password.as_str()),
        confirmed,
    )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(result) = run_maintenance_cli(&args) {
        return result;
    }

    let config = Config::from_env()?;
    init_tracing();
    // Bind before starting database workers so a port conflict cannot strand them.
    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;

    if let Some(ref auth) = config.auth {
        tracing::info!(
            "Authentication enabled, cookie secure policy: {}",
            auth.cookie_secure
        );
    } else {
        tracing::info!("Authentication disabled");
    }
    tracing::info!("Listening on {}", config.listen_addr);
    let state = main_lib::build_state(&config).await?;
    scheduler::start_background_workers(state.clone());
    let static_dir = std::path::PathBuf::from(&config.static_dir);
    let router = api::app_router(state.clone(), &config)?
        .fallback_service(tower_http::services::ServeDir::new(&static_dir).fallback(
            tower_http::services::ServeFile::new(static_dir.join("index.html")),
        ))
        .layer(axum::middleware::from_fn(api::security_headers));
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await;
    result?;
    Ok(())
}

#[cfg(test)]
mod cli_tests {
    use super::run_maintenance_cli;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn non_db_arguments_fall_through_to_normal_startup() {
        assert!(run_maintenance_cli(&args(&[])).is_none());
        assert!(run_maintenance_cli(&args(&["--version"])).is_none());
    }

    #[test]
    fn db_without_a_subcommand_is_an_error_not_a_server_start() {
        let result = run_maintenance_cli(&args(&["db"])).expect("must not fall through");
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Missing database command"));
    }

    #[test]
    fn db_with_an_unknown_subcommand_is_an_error() {
        let result = run_maintenance_cli(&args(&["db", "rotate"])).expect("must not fall through");
        assert!(result.unwrap_err().to_string().contains("db rotate"));
    }
}
