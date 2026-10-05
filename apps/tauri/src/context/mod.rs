// context/mod.rs
mod ai_environment;
mod providers;
mod registry;

pub use ai_environment::TauriAiEnvironment;
pub(crate) use providers::get_device_display_name;
pub use providers::initialize_context;
// ContextInitResult is used internally but not exported
pub use registry::ServiceContext;
