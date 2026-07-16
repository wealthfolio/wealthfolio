//! Wealthfolio Spending Module
//!
//! Optional, additive spending tracking for cash and credit-card accounts. Sibling crate to
//! `wealthfolio-core`; depends on it for shared types (Account, Activity, Taxonomy).
//! Mirrors the `wealthfolio-ai` / `wealthfolio-device-sync` leaf-crate pattern.
//!
//! # Isolation contract
//!
//! - Spending categorization, rules, events, and budget live in this crate.
//!   Credit-card net-worth treatment lives in `wealthfolio-core::portfolio`
//!   because it shares the snapshot / valuation pipeline.
//! - Spending is gated by a runtime toggle in `app_settings`. When the toggle is OFF,
//!   spending read paths return empty/default payloads and background categorization
//!   no-ops; settings remains available so the user can re-enable the module.
//!
//! # Module map
//!
//! - `settings` — enable toggle + spending-account opt-in list (stored in app_settings).
//! - `cash_activities` — query/CRUD for spending-account activities.
//! - `categories_seed` — boot-time seeder for the two scope=`activity` system taxonomies.
//! - `categorization_rules` — pattern-based auto-categorization (Gmail-filters style).
//! - `events` — first-class event entity (trips, holidays) with event_types.
//! - `budget` — monthly budget config and per-category allocations.
//! - `analytics` — aggregations for the Spending overview / reports pages.
//! - `insight` — reconciled period payload powering the Spending Insight dashboard.

mod activity_allocations;
pub mod activity_assignments;
mod activity_classification;
pub mod activity_events;
pub mod activity_splits;
pub mod analytics;
pub mod budget;
pub mod cash_activities;
pub mod categories_seed;
pub mod categorization_rules;
pub mod error;
pub mod events;
pub mod insight;
pub mod settings;

pub use error::SpendingError;
