//! SQLite storage implementation for Wealthfolio.
//!
//! This crate provides all database-related functionality using Diesel ORM with SQLite.
//! It implements the repository traits defined in `wealthfolio-core` and contains:
//! - Database connection pooling and management
//! - Diesel migrations
//! - Repository implementations for all domain entities
//! - Database-specific model types (with Diesel derives)
//!
//! # Architecture
//!
//! This crate is the only place in the application where Diesel dependencies exist.
//! All other crates (`core`, `connect`) are database-agnostic and work with traits.
//!
//! ```text
//! core (domain)          connect (sync)
//!       │                      │
//!       └──────────┬───────────┘
//!                  │
//!                  ▼
//!          storage-sqlite (this crate)
//!                  │
//!                  ▼
//!              SQLite DB
//! ```

pub mod db;
pub mod errors;
pub mod schema;
pub mod utils;

// Repository implementations
pub mod accounts;
pub mod activities;
pub mod ai_chat;
pub mod assets;
pub mod custom_provider;
pub mod fx;
pub mod goals;
pub mod health;
pub mod limits;
pub mod lots;
pub mod market_data;
pub mod portfolio;
pub mod settings;
pub mod sync;
pub mod taxonomies;

// Re-export database utilities
pub use db::{
    backup_database, create_pool, get_connection, get_db_path, init, restore_database,
    restore_database_safe, run_migrations, DbConnection, DbPool, DbTransactionExecutor,
    WriteHandle,
};

// Re-export storage errors and conversion helpers
pub use errors::{IntoCore, StorageError};

// Re-export from wealthfolio-core for convenience
pub use wealthfolio_core::errors::{DatabaseError, Error, Result};

// Re-export SQLite utilities
pub use utils::{chunk_for_sqlite, SQLITE_MAX_PARAMS_CHUNK};
