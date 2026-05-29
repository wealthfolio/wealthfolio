//! Storage adapters for the `wealthfolio-spending` crate.
//! One submodule per spending sub-feature; each file impls the trait
//! defined in the spending crate against the shared SQLite schema.

pub mod activity_assignments;
pub mod activity_events;
pub mod budget;
pub mod categorization_rules;
mod deterministic_ids;
pub mod events;
pub mod settings;
