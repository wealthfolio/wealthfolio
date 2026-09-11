//! Plain-data domain model: scalars, policy, facts (raw and canonical), and
//! the economic event vocabulary. Everything here is `Clone + Debug +
//! PartialEq + Serialize + Deserialize`; no `Arc`, no trait objects.

pub mod canonical;
pub mod decimal_serde;
pub mod event;
pub mod facts;
pub mod performance;
pub mod policy;
pub mod scalar;
pub mod state;
pub mod valuation;

pub use canonical::*;
pub use event::*;
pub use facts::*;
pub use performance::*;
pub use policy::*;
pub use scalar::*;
pub use state::*;
pub use valuation::*;
