//! SQLite storage implementation for assets.

mod alternative_repository;
mod logo_model;
mod logo_repository;
mod model;
mod repository;
mod split_merge;

pub use alternative_repository::AlternativeAssetRepository;
pub use logo_model::AssetLogoDB;
pub use logo_repository::AssetLogoRepository;
pub use model::{AssetDB, InsertableAssetDB};
pub use repository::AssetRepository;
