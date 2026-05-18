#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::NaiveDateTime;
    use std::sync::{Arc, Mutex};

    use crate::accounts::{Account, AccountRepositoryTrait, AccountUpdate, NewAccount};
    use crate::errors::{DatabaseError, Error, Result};
    use crate::portfolios::{
        AccountFilter, NewPortfolio, PortfolioRepositoryTrait, PortfolioService,
        PortfolioServiceTrait, PortfolioUpdate, PortfolioWithAccounts,
    };

    // ── Mock portfolio repository ─────────────────────────────────────────────

    #[derive(Default)]
    struct MockPortfolioRepo {
        portfolios: Arc<Mutex<Vec<PortfolioWithAccounts>>>,
        force_unique_violation: bool,
    }

    impl MockPortfolioRepo {
        fn with_violation() -> Self {
            Self {
                force_unique_violation: true,
                ..Default::default()
            }
        }
    }

    #[async_trait]
    impl PortfolioRepositoryTrait for MockPortfolioRepo {
        async fn create(&self, new: NewPortfolio) -> Result<PortfolioWithAccounts> {
            if self.force_unique_violation {
                return Err(Error::Database(DatabaseError::UniqueViolation(
                    "portfolios.name".to_string(),
                )));
            }
            let p = PortfolioWithAccounts {
                id: "p1".to_string(),
                name: new.name,
                description: new.description,
                sort_order: new.sort_order,
                account_ids: new.account_ids,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            };
            self.portfolios.lock().unwrap().push(p.clone());
            Ok(p)
        }

        async fn update(&self, update: PortfolioUpdate) -> Result<PortfolioWithAccounts> {
            if self.force_unique_violation {
                return Err(Error::Database(DatabaseError::UniqueViolation(
                    "portfolios.name".to_string(),
                )));
            }
            let p = PortfolioWithAccounts {
                id: update.id,
                name: update.name,
                description: update.description,
                sort_order: update.sort_order,
                account_ids: update.account_ids,
                created_at: "2024-01-01T00:00:00Z".to_string(),
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            };
            Ok(p)
        }

        async fn delete(&self, _id: &str) -> Result<usize> {
            Ok(1)
        }

        fn get_by_id(&self, id: &str) -> Result<PortfolioWithAccounts> {
            self.portfolios
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or_else(|| Error::Unexpected("not found".to_string()))
        }

        fn list(&self) -> Result<Vec<PortfolioWithAccounts>> {
            Ok(self.portfolios.lock().unwrap().clone())
        }

        fn resolve_account_ids(&self, filter: &AccountFilter) -> Result<Vec<String>> {
            match filter {
                AccountFilter::All => Ok(vec!["a1".to_string(), "a2".to_string()]),
                AccountFilter::Account { account_id } => Ok(vec![account_id.clone()]),
                AccountFilter::Portfolio { portfolio_id: _ } => {
                    Ok(vec!["a1".to_string(), "a2".to_string()])
                }
            }
        }
    }

    // ── Mock account repository ───────────────────────────────────────────────

    struct MockAccountRepo {
        accounts: Vec<Account>,
    }

    impl MockAccountRepo {
        fn with_ids(ids: &[&str]) -> Self {
            let dt = NaiveDateTime::default();
            let accounts = ids
                .iter()
                .map(|id| Account {
                    id: id.to_string(),
                    name: id.to_string(),
                    account_type: "SECURITIES".to_string(),
                    group: None,
                    currency: "USD".to_string(),
                    is_default: false,
                    is_active: true,
                    created_at: dt,
                    updated_at: dt,
                    platform_id: None,
                    account_number: None,
                    meta: None,
                    provider: None,
                    provider_account_id: None,
                    is_archived: false,
                    tracking_mode: Default::default(),
                })
                .collect();
            Self { accounts }
        }
    }

    #[async_trait]
    impl AccountRepositoryTrait for MockAccountRepo {
        async fn create(&self, _: NewAccount) -> Result<Account> {
            unimplemented!()
        }
        async fn update(&self, _: AccountUpdate) -> Result<Account> {
            unimplemented!()
        }
        async fn delete(&self, _: &str) -> Result<usize> {
            unimplemented!()
        }
        fn get_by_id(&self, _: &str) -> Result<Account> {
            unimplemented!()
        }
        fn list(
            &self,
            _active: Option<bool>,
            _archived: Option<bool>,
            ids: Option<&[String]>,
        ) -> Result<Vec<Account>> {
            match ids {
                None => Ok(self.accounts.clone()),
                Some(filter_ids) => Ok(self
                    .accounts
                    .iter()
                    .filter(|a| filter_ids.contains(&a.id))
                    .cloned()
                    .collect()),
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn make_service_with(repo: MockPortfolioRepo, account_ids: &[&str]) -> PortfolioService {
        PortfolioService::new(
            Arc::new(repo),
            Arc::new(MockAccountRepo::with_ids(account_ids)),
        )
    }

    fn valid_new(name: &str, account_ids: Vec<String>) -> NewPortfolio {
        NewPortfolio {
            name: name.to_string(),
            description: None,
            sort_order: 0,
            account_ids,
        }
    }

    // ── Service tests ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_trims_name() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1"]);
        let result = svc
            .create_portfolio(valid_new("  My Portfolio  ", vec!["a1".to_string()]))
            .await
            .unwrap();
        assert_eq!(result.name, "My Portfolio");
    }

    #[tokio::test]
    async fn create_rejects_empty_name() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1"]);
        let err = svc
            .create_portfolio(valid_new("   ", vec!["a1".to_string()]))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("empty"));
    }

    #[tokio::test]
    async fn create_rejects_empty_account_list() {
        let svc = make_service_with(MockPortfolioRepo::default(), &[]);
        let err = svc
            .create_portfolio(valid_new("P", vec![]))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("at least one account"));
    }

    #[tokio::test]
    async fn create_rejects_duplicate_account_ids() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1"]);
        let err = svc
            .create_portfolio(valid_new("P", vec!["a1".to_string(), "a1".to_string()]))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().to_lowercase().contains("duplicate"));
    }

    #[tokio::test]
    async fn create_rejects_nonexistent_account() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1"]);
        let err = svc
            .create_portfolio(valid_new("P", vec!["unknown".to_string()]))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("does not exist"));
    }

    #[tokio::test]
    async fn create_maps_unique_violation_to_friendly_error() {
        let svc = make_service_with(MockPortfolioRepo::with_violation(), &["a1"]);
        let err = svc
            .create_portfolio(valid_new("P", vec!["a1".to_string()]))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn update_maps_unique_violation_to_friendly_error() {
        let svc = make_service_with(MockPortfolioRepo::with_violation(), &["a1"]);
        let update = PortfolioUpdate {
            id: "p1".to_string(),
            name: "P".to_string(),
            description: None,
            sort_order: 0,
            account_ids: vec!["a1".to_string()],
        };
        let err = svc.update_portfolio(update).await.unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn resolve_account_filter_all() {
        let svc = make_service_with(MockPortfolioRepo::default(), &[]);
        let ids = svc.resolve_account_filter(&AccountFilter::All).unwrap();
        assert_eq!(ids, vec!["a1", "a2"]);
    }

    #[tokio::test]
    async fn resolve_account_filter_single_account() {
        let svc = make_service_with(MockPortfolioRepo::default(), &[]);
        let ids = svc
            .resolve_account_filter(&AccountFilter::Account {
                account_id: "a1".to_string(),
            })
            .unwrap();
        assert_eq!(ids, vec!["a1"]);
    }
}
