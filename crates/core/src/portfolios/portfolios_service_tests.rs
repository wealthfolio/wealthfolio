#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::NaiveDateTime;
    use std::sync::{Arc, Mutex};

    use crate::accounts::{
        account_types, Account, AccountPurpose, AccountRepositoryTrait, AccountUpdate, NewAccount,
        TrackingMode,
    };
    use crate::errors::{DatabaseError, Error, Result};
    use crate::portfolios::{
        AccountScope, NewPortfolio, PortfolioRepositoryTrait, PortfolioService,
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

        fn resolve_account_ids(&self, filter: &AccountScope) -> Result<Vec<String>> {
            match filter {
                AccountScope::All => Ok(vec!["a1".to_string(), "a2".to_string()]),
                AccountScope::Account { account_id } => Ok(vec![account_id.clone()]),
                AccountScope::Portfolio { portfolio_id } if portfolio_id == "empty" => Ok(vec![]),
                AccountScope::Portfolio { portfolio_id: _ } => {
                    Ok(vec!["a1".to_string(), "a2".to_string()])
                }
                AccountScope::Accounts { account_ids } => Ok(account_ids.clone()),
            }
        }
    }

    // ── Mock account repository ───────────────────────────────────────────────

    struct MockAccountRepo {
        accounts: Vec<Account>,
    }

    impl MockAccountRepo {
        fn with_ids(ids: &[&str]) -> Self {
            let accounts = ids
                .iter()
                .map(|id| mock_account(id, account_types::SECURITIES, TrackingMode::Transactions))
                .collect();
            Self::with_accounts(accounts)
        }

        fn with_accounts(accounts: Vec<Account>) -> Self {
            Self { accounts }
        }
    }

    fn mock_account(id: &str, account_type: &str, tracking_mode: TrackingMode) -> Account {
        let dt = NaiveDateTime::default();
        Account {
            id: id.to_string(),
            name: id.to_string(),
            account_type: account_type.to_string(),
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
            tracking_mode,
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

    fn make_service_with_accounts(
        repo: MockPortfolioRepo,
        accounts: Vec<Account>,
    ) -> PortfolioService {
        PortfolioService::new(
            Arc::new(repo),
            Arc::new(MockAccountRepo::with_accounts(accounts)),
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
        let ids = svc.resolve_account_filter(&AccountScope::All).unwrap();
        assert_eq!(ids, vec!["a1", "a2"]);
    }

    #[tokio::test]
    async fn resolve_account_filter_single_account() {
        let svc = make_service_with(MockPortfolioRepo::default(), &[]);
        let ids = svc
            .resolve_account_filter(&AccountScope::Account {
                account_id: "a1".to_string(),
            })
            .unwrap();
        assert_eq!(ids, vec!["a1"]);
    }

    #[tokio::test]
    async fn resolve_account_scope_all_uses_real_accounts() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1", "a2"]);
        let scope = svc
            .resolve_account_scope(&AccountScope::All, "USD")
            .unwrap();
        assert_eq!(scope.scope_id, "all");
        assert_eq!(scope.account_ids, vec!["a1", "a2"]);
        assert_eq!(scope.base_currency, "USD");
    }

    #[tokio::test]
    async fn resolve_account_scope_accounts_uses_stable_scope_id() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1", "a2"]);
        let scope = svc
            .resolve_account_scope(
                &AccountScope::Accounts {
                    account_ids: vec!["a2".to_string(), "a1".to_string(), "a1".to_string()],
                },
                "USD",
            )
            .unwrap();
        assert!(scope.scope_id.starts_with("accounts:"));
        assert_eq!(scope.scope_id.len(), "accounts:".len() + 16);
        assert_eq!(scope.account_ids, vec!["a1", "a2"]);
    }

    #[tokio::test]
    async fn resolve_account_scope_keeps_hidden_and_excludes_archived_accounts() {
        let mut hidden = mock_account(
            "hidden",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        );
        hidden.is_active = false;
        let mut archived = mock_account(
            "archived",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        );
        archived.is_archived = true;
        let svc = make_service_with_accounts(
            MockPortfolioRepo::default(),
            vec![
                mock_account(
                    "active",
                    account_types::SECURITIES,
                    TrackingMode::Transactions,
                ),
                hidden,
                archived,
            ],
        );

        let scope = svc
            .resolve_account_scope(
                &AccountScope::Accounts {
                    account_ids: vec![
                        "active".to_string(),
                        "hidden".to_string(),
                        "archived".to_string(),
                    ],
                },
                "USD",
            )
            .unwrap();

        assert_eq!(scope.account_ids, vec!["active", "hidden"]);
    }

    #[tokio::test]
    async fn resolve_account_scope_rejects_fake_account_id() {
        let svc = make_service_with(MockPortfolioRepo::default(), &["a1"]);
        let err = svc
            .resolve_account_scope(
                &AccountScope::Account {
                    account_id: "missing".to_string(),
                },
                "USD",
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("unknown account"));
    }

    #[tokio::test]
    async fn resolve_account_scope_empty_portfolio_is_deterministic() {
        let svc = make_service_with(MockPortfolioRepo::default(), &[]);
        let scope = svc
            .resolve_account_scope(
                &AccountScope::Portfolio {
                    portfolio_id: "empty".to_string(),
                },
                "USD",
            )
            .unwrap();
        assert_eq!(scope.scope_id, "portfolio:empty");
        assert!(scope.account_ids.is_empty());
    }

    #[tokio::test]
    async fn resolve_account_scope_for_purpose_filters_by_account_capability() {
        let mut hidden = mock_account(
            "hidden",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        );
        hidden.is_active = false;
        let mut archived = mock_account(
            "archived",
            account_types::SECURITIES,
            TrackingMode::Transactions,
        );
        archived.is_archived = true;
        let svc = PortfolioService::new(
            Arc::new(MockPortfolioRepo::default()),
            Arc::new(MockAccountRepo::with_accounts(vec![
                mock_account(
                    "security-holdings",
                    account_types::SECURITIES,
                    TrackingMode::Holdings,
                ),
                mock_account(
                    "security-transactions",
                    account_types::SECURITIES,
                    TrackingMode::Transactions,
                ),
                mock_account("cash", account_types::CASH, TrackingMode::Transactions),
                mock_account(
                    "crypto",
                    account_types::CRYPTOCURRENCY,
                    TrackingMode::Holdings,
                ),
                mock_account(
                    "card",
                    account_types::CREDIT_CARD,
                    TrackingMode::Transactions,
                ),
                hidden,
                archived,
            ])),
        );
        let filter = AccountScope::Accounts {
            account_ids: vec![
                "security-transactions".to_string(),
                "card".to_string(),
                "crypto".to_string(),
                "security-holdings".to_string(),
                "cash".to_string(),
                "security-transactions".to_string(),
                "hidden".to_string(),
                "archived".to_string(),
            ],
        };

        let unfiltered = svc.resolve_account_scope(&filter, "CAD").unwrap();
        let filtered = svc
            .resolve_account_scope_for_purpose(&filter, "CAD", AccountPurpose::Holdings)
            .unwrap();

        assert_eq!(filtered.scope_id, unfiltered.scope_id);
        assert_eq!(filtered.base_currency, "CAD");
        assert_eq!(
            filtered.account_ids,
            vec![
                "cash".to_string(),
                "crypto".to_string(),
                "hidden".to_string(),
                "security-holdings".to_string(),
                "security-transactions".to_string(),
            ]
        );
    }
}
