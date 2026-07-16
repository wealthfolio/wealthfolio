//! Cash activities — query/list activities on opted-in spending accounts.
//! CRUD itself stays in core ActivityService; this module provides the spending-aware
//! filtering surface for cash and credit-card activities in spending settings.

pub mod model;
pub mod service;
pub mod traits;

pub use model::{
    CashActivity, CashActivityFilter, CashActivitySearchRequest, CashActivitySearchResponse,
    CashActivitySortField, CashActivityStatusFilter, SortDirection,
};
pub use service::CashActivityService;
pub use traits::CashActivityServiceTrait;

/// The activity_type values considered spending activities by the spending module.
pub const CASH_ACTIVITY_TYPES: &[&str] = &[
    "DEPOSIT",
    "WITHDRAWAL",
    "TRANSFER_IN",
    "TRANSFER_OUT",
    "FEE",
    "TAX",
    "INTEREST",
    "CREDIT",
];
