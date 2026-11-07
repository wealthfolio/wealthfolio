// Exercise the full health entry point using the accounting fixture's real
// holdings, coordinator, activity and valuation services.
struct HealthAccounts(Arc<InMemoryAccountRepository>);

#[async_trait]
impl crate::accounts::AccountServiceTrait for HealthAccounts {
    async fn create_account(&self, _: crate::accounts::NewAccount) -> Result<Account> {
        unimplemented!("health reads do not create accounts")
    }
    async fn update_account(&self, _: crate::accounts::AccountUpdate) -> Result<Account> {
        unimplemented!("health reads do not update accounts")
    }
    async fn delete_account(&self, _: &str) -> Result<()> {
        unimplemented!("health reads do not delete accounts")
    }
    fn get_account(&self, id: &str) -> Result<Account> {
        crate::accounts::AccountRepositoryTrait::get_by_id(self.0.as_ref(), id)
    }
    fn list_accounts(
        &self,
        active: Option<bool>,
        archived: Option<bool>,
        ids: Option<&[String]>,
    ) -> Result<Vec<Account>> {
        crate::accounts::AccountRepositoryTrait::list(self.0.as_ref(), active, archived, ids)
    }
    fn get_all_accounts(&self) -> Result<Vec<Account>> {
        self.list_accounts(None, None, None)
    }
    fn get_active_accounts(&self) -> Result<Vec<Account>> {
        self.list_accounts(Some(true), None, None)
    }
    fn get_accounts_by_ids(&self, ids: &[String]) -> Result<Vec<Account>> {
        self.list_accounts(None, None, Some(ids))
    }
    fn get_non_archived_accounts(&self) -> Result<Vec<Account>> {
        self.list_accounts(None, Some(false), None)
    }
    fn get_active_non_archived_accounts(&self) -> Result<Vec<Account>> {
        self.list_accounts(Some(true), Some(false), None)
    }
    fn get_base_currency(&self) -> Option<String> {
        Some("CAD".into())
    }
}

struct NoDismissals;

#[async_trait]
impl crate::health::HealthDismissalStore for NoDismissals {
    async fn save_dismissal(&self, _: &crate::health::IssueDismissal) -> Result<()> {
        unimplemented!("health reads do not save dismissals")
    }
    async fn remove_dismissal(&self, _: &str) -> Result<()> {
        unimplemented!("health reads do not remove dismissals")
    }
    async fn get_dismissals(&self) -> Result<Vec<crate::health::IssueDismissal>> {
        Ok(Vec::new())
    }
    async fn get_dismissal(&self, _: &str) -> Result<Option<crate::health::IssueDismissal>> {
        Ok(None)
    }
    async fn clear_all(&self) -> Result<()> {
        unimplemented!("health reads do not clear dismissals")
    }
}

#[tokio::test]
async fn health_checks_continue_with_pending_unavailable_and_failed_accounts() {
    for state in ["pending", "unsupported", "failed"] {
        let healthy = account("healthy", "CAD", TrackingMode::Transactions);
        let mut incomplete = account("incomplete", "CAD", TrackingMode::Transactions);
        if state == "unsupported" {
            incomplete.meta = Some(
                r#"{"accounting":{"costBasisMethod":"FIFO","costBasisProfile":"CANADA_ACB"}}"#
                    .into(),
            );
        }
        let accounts = vec![
            healthy.clone(),
            incomplete.clone(),
            account("unconfigured", "CAD", TrackingMode::NotSet),
        ];
        let fixture = Fixture::new(
            vec![
                buy(&healthy.id, "CAD", dec!(100)),
                buy(&incomplete.id, "CAD", dec!(80)),
            ],
            Vec::new(),
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, snapshots) = fixture.services(accounts.clone());
        coordinator
            .run_job(PortfolioJobRequest::default(), &SilentObserver)
            .await
            .unwrap();
        if state != "unsupported" {
            fixture
                .store
                .invalidate(MarkerScope::Account(incomplete.id.clone()), GENESIS)
                .await
                .unwrap();
            if state == "failed" {
                fixture.store.fail_next_completion();
                coordinator
                    .run_job(PortfolioJobRequest::default(), &SilentObserver)
                    .await
                    .unwrap();
            }
        }
        let status = fixture
            .full_health_status(accounts, coordinator, holdings, snapshots, "CAD")
            .await;
        assert_eq!(
            fixture.store.holdings_read_count(),
            1,
            "a full health run must capture holdings once"
        );
        assert!(
            status
                .issues
                .iter()
                .any(|issue| issue.code.as_deref() == Some("account_unconfigured")),
            "{state}: unrelated account checks must still run"
        );
        assert!(
            status
                .issues
                .iter()
                .any(|issue| issue.code.as_deref() == Some("data_stale_projection")),
            "{state}: incomplete history must still be reported: {:?}",
            status
                .issues
                .iter()
                .map(|issue| &issue.code)
                .collect::<Vec<_>>()
        );
    }
}

impl Fixture {
    async fn full_health_status(
        &self,
        accounts: Vec<Account>,
        coordinator: PortfolioCoordinator,
        holdings: HoldingsService,
        snapshots: Arc<SnapshotService>,
        base_currency: &str,
    ) -> crate::health::HealthStatus {
        let account_repo = Arc::new(InMemoryAccountRepository::new(accounts));
        let accounts = Arc::new(HealthAccounts(account_repo.clone()));
        let assets = Arc::new(AssetService::new(self.assets.clone(), self.quotes.clone()).unwrap());
        let timezone = Arc::new(RwLock::new("UTC".into()));
        let valuations = Arc::new(crate::portfolio::valuation::ValuationService::new(
            Arc::new(InMemoryValuationRepository::default()),
            FactSources {
                accounts: account_repo,
                activities: self.activities.clone(),
                assets: self.assets.clone(),
                quotes: self.quotes.clone(),
                fx_rates: self.fx_repo.clone(),
                snapshots: self.snapshots.clone(),
                projections: self.store.clone(),
            },
            self.lots.clone(),
            timezone,
        ));
        let activities = Arc::new(crate::activities::ActivityService::new(
            self.activities.clone(),
            accounts.clone(),
            assets.clone(),
            self.fx.clone(),
            self.quotes.clone(),
        ));
        crate::health::HealthService::new(Arc::new(NoDismissals))
            .with_projection_freshness(Arc::new(coordinator))
            .run_full_checks(
                base_currency,
                accounts,
                Arc::new(holdings),
                self.quotes.clone(),
                assets,
                Arc::new(EmptyTaxonomyService),
                valuations,
                snapshots,
                activities,
                self.lots.clone(),
                Some("UTC"),
                None,
            )
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn health_missing_fx_keeps_the_base_impact_unknown() {
    let account = account("observed", "CAD", TrackingMode::Holdings);
    let fixture = Fixture::new(Vec::new(), Vec::new());
    let _clock = crate::utils::clock::freeze(fixture.now);
    let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
    fixture.save_holding(&snapshots, &account, dec!(100)).await;
    *fixture.base_currency.write().unwrap() = "USD".into();
    let status = fixture
        .full_health_status(vec![account], coordinator, holdings, snapshots, "USD")
        .await;
    let fx = status
        .issues
        .iter()
        .find(|issue| issue.code.as_deref() == Some("fx_missing"))
        .expect("missing FX remains a health issue");
    assert_eq!(fx.affected_count, 1);
    assert_eq!(fx.affected_mv_pct, None);
    assert!(status
        .issues
        .iter()
        .all(|issue| issue.affected_mv_pct.is_none()));
    assert!(fx.diagnostics.as_ref().unwrap()[0].evidence[0]
        .value
        .contains("unknown"));
}
