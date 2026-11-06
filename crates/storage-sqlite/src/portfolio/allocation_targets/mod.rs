mod model;
pub mod repository;

pub(crate) use model::{
    AllocationTargetAssetWeightDB, AllocationTargetConstraintDB, AllocationTargetDB,
    AllocationTargetWeightDB,
};
pub use repository::AllocationTargetRepository;
