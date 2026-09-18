pub mod ai_environment;
pub mod api;
pub mod auth;
pub mod config;
pub mod database_restore;
mod domain_events;
pub mod error;
pub mod events;
pub mod features;
mod main_lib;
pub mod mcp;
pub mod models;
pub mod oidc;
pub mod scheduler;
mod secrets;

pub use ai_environment::ServerAiEnvironment;
pub use main_lib::{build_state, init_tracing, run_database_maintenance, AppState};
