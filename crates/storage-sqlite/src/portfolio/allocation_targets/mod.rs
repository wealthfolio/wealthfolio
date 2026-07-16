mod model;
pub mod repository;

pub(crate) use model::{
    AllocationTargetConstraintDB, AllocationTargetDB, AllocationTargetWeightDB,
};
pub use repository::AllocationTargetRepository;
