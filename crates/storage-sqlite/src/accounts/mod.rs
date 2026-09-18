//! SQLite storage implementation for accounts.

mod cleanup;
mod model;
mod repository;

pub use model::AccountDB;
pub use repository::AccountRepository;

pub(crate) use cleanup::delete_account_references;

#[cfg(test)]
mod cleanup_tests;
