//! Contribution limits module - domain models, services, and traits.

mod limits_model;
mod limits_service;
mod limits_traits;

pub use limits_model::{
    AccountDeposit, ContributionActivity, ContributionActivityDetail, ContributionLimit,
    ContributionLimitDetails, ContributionTreatment, DepositsCalculation, NewContributionLimit,
};
pub use limits_service::{check_contribution_limit_accounts, ContributionLimitService};
pub use limits_traits::{ContributionLimitRepositoryTrait, ContributionLimitServiceTrait};
