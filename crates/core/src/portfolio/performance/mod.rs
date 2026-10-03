//! Portfolio performance: returns, attribution and risk served from stored
//! rows through the kernel.

pub mod performance_model;
pub mod performance_service;

pub use performance_model::*;
pub use performance_service::*;
