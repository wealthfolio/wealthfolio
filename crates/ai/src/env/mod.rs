//! Environment abstraction for AI assistant.
//!
//! The data-service surface lives in `wealthfolio-agent-tools` as
//! [`AgentEnvironment`] so agent tools stay runtime-neutral. This module
//! adds the assistant-only extension trait `AiEnvironment` on top:
//! secret store (LLM API keys), chat persistence, and services only the
//! assistant's write tools touch. The Tauri and Axum backends implement
//! both traits with their specific service instances.

use std::sync::Arc;
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignmentService;

use crate::types::ChatRepositoryTrait;

pub use wealthfolio_agent_tools::AgentEnvironment;

/// Assistant-only extension of [`AgentEnvironment`].
///
/// Implementations provide access to:
/// - Secret store for LLM API keys
/// - Chat repository for thread/message persistence
/// - Services used only by assistant write tools
pub trait AiEnvironment: AgentEnvironment {
    /// Get the secret store for API keys.
    fn secret_store(&self) -> Arc<dyn SecretStore>;

    /// Get the chat repository for thread/message persistence.
    fn chat_repository(&self) -> Arc<dyn ChatRepositoryTrait>;

    /// Get the activity-taxonomy-assignment service for category writes.
    fn activity_taxonomy_assignment_service(&self) -> Arc<ActivityTaxonomyAssignmentService>;
}

#[cfg(any(test, feature = "test-utils"))]
pub mod test_env;
