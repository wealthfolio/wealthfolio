//! Budget — backend-computed monthly targets, groups, and rollover state.

pub mod model;
pub mod service;
pub mod traits;

pub use model::{
    BudgetCategoryRow, BudgetGroup, BudgetGroupAssignment, BudgetGroupRow, BudgetOperation,
    BudgetReview, BudgetRolloverSetting, BudgetRolloverTargetType, BudgetSnapshot,
    BudgetSnapshotComputed, BudgetSnapshotState, BudgetTarget, BudgetTargetType, BudgetTotals,
    CopyMonthRequest, NewBudgetGroup, NewBudgetGroupAssignment, NewBudgetRolloverSetting,
    NewBudgetTarget, UpdateBudgetGroup,
};
pub use service::BudgetService;
pub use traits::BudgetRepositoryTrait;

pub use traits::BudgetServiceTrait;
