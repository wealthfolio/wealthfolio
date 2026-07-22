//! Rule suggestions — reads how the user has categorized transactions by hand
//! and proposes categorization rules that would reproduce (and extend) those
//! choices. The engine in [`service`] is pure; [`crate::categorization_rules`]
//! wires it to the repositories and applies accepted suggestions.

pub mod model;
pub mod service;

pub use model::{ApplySuggestionRequest, SuggestedRule, SuggestionAction};
pub use service::{generate_suggestions, CategorizedSample};
