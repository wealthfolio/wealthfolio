use super::limits_model::{
    ContributionLimit, ContributionLimitDetails, DepositsCalculation, NewContributionLimit,
};
use crate::errors::Result;
use async_trait::async_trait;
use std::collections::HashSet;

/// Trait defining the contract for Contribution Limit repository operations.
#[async_trait]
pub trait ContributionLimitRepositoryTrait: Send + Sync {
    fn get_excluded_activity_ids(&self, limit_id: &str) -> Result<HashSet<String>>;
    async fn set_activity_excluded(
        &self,
        limit_id: &str,
        activity_id: &str,
        excluded: bool,
    ) -> Result<()>;
    fn get_contribution_limit(&self, id: &str) -> Result<ContributionLimit>;
    fn get_contribution_limits(&self) -> Result<Vec<ContributionLimit>>;
    async fn create_contribution_limit(
        &self,
        new_limit: NewContributionLimit,
    ) -> Result<ContributionLimit>;
    async fn update_contribution_limit(
        &self,
        id: &str,
        updated_limit: NewContributionLimit,
    ) -> Result<ContributionLimit>;
    async fn delete_contribution_limit(&self, id: &str) -> Result<()>;
}

/// Trait defining the contract for Contribution Limit service operations.
#[async_trait]
pub trait ContributionLimitServiceTrait: Send + Sync {
    fn get_contribution_limit_details(
        &self,
        limit_id: &str,
        base_currency: &str,
    ) -> Result<ContributionLimitDetails>;
    async fn set_contribution_activity_excluded(
        &self,
        limit_id: &str,
        activity_id: &str,
        excluded: bool,
    ) -> Result<()>;
    fn get_contribution_limits(&self) -> Result<Vec<ContributionLimit>>;
    async fn create_contribution_limit(
        &self,
        new_limit: NewContributionLimit,
    ) -> Result<ContributionLimit>;
    async fn update_contribution_limit(
        &self,
        id: &str,
        updated_limit: NewContributionLimit,
    ) -> Result<ContributionLimit>;
    async fn delete_contribution_limit(&self, id: &str) -> Result<()>;
    fn calculate_deposits_for_contribution_limit(
        &self,
        limit_id: &str,
        base_currency: &str,
    ) -> Result<DepositsCalculation>;
    // Note: calculate_deposits_by_period might be better as a private helper or part of the trait if needed elsewhere
}
