// Included by holdings_service::tests. These doubles provide captured inputs;
// all financial arithmetic runs through the production read/render path.
struct FixtureReadStore {
    snapshots: Arc<dyn SnapshotServiceTrait>,
    assets: Vec<Asset>,
    lots: std::sync::Mutex<Option<Arc<dyn LotRepositoryTrait>>>,
    activities: std::sync::Mutex<Option<Arc<dyn ActivityRepositoryTrait>>>,
    income: std::sync::Mutex<Option<Arc<dyn HoldingIncomeServiceTrait>>>,
}

#[async_trait::async_trait]
impl ProjectionStoreTrait for FixtureReadStore {
    fn holdings_read(
        &self,
        ids: &[String],
        day: NaiveDate,
        detail_asset: Option<&str>,
    ) -> Result<HoldingsRead> {
        let mut read = HoldingsRead {
            day,
            timezone: "UTC".into(),
            assets: self
                .assets
                .iter()
                .cloned()
                .map(|a| (a.id.clone(), a))
                .collect(),
            ..Default::default()
        };
        let lots = self.lots.lock().unwrap().clone();
        let activities = self.activities.lock().unwrap().clone();
        let income = self.income.lock().unwrap().clone();
        for (index, id) in ids.iter().enumerate() {
            let Some(mut snapshot) = self.snapshots.get_latest_holdings_snapshot(id)? else {
                continue;
            };
            snapshot.account_id.clone_from(id);
            // Static fixture snapshots represent completed calculations in their
            // explicitly declared account/base currency (USD unless specified).
            snapshot
                .base_currency
                .get_or_insert_with(|| snapshot.currency.clone());
            read.base_currency = snapshot.base_currency.clone().unwrap();
            read.accounts.push(crate::accounts::Account {
                id: id.clone(),
                currency: snapshot.currency.clone(),
                tracking_mode: if snapshot.source == snapshot::SnapshotSource::Calculated {
                    crate::accounts::TrackingMode::Transactions
                } else {
                    crate::accounts::TrackingMode::Holdings
                },
                ..Default::default()
            });
            read.last_valued.insert(id.clone(), day);
            if let Some(lots) = &lots {
                if let Some(asset) = detail_asset {
                    read.lots.extend(
                        tokio::runtime::Handle::current()
                            .block_on(lots.get_open_lots_for_account_asset(id, asset))?,
                    );
                }
                let disposals = tokio::runtime::Handle::current()
                    .block_on(lots.get_lot_disposals_for_account(id))?;
                if activities.is_none() {
                    for disposal in &disposals {
                        read.activities.push(test_income_activity(
                            &disposal.disposal_activity_id,
                            id,
                            Some(&disposal.asset_id),
                            ACTIVITY_TYPE_SELL,
                            Decimal::ZERO,
                            &disposal.currency,
                            day,
                        ));
                    }
                }
                read.disposals.extend(disposals);
            }
            if let Some(activities) = &activities {
                read.activities
                    .extend(activities.get_activities_by_account_id(id)?);
            }
            if let Some(income) = &income {
                let currencies: HashMap<String, String> = snapshot
                    .positions
                    .iter()
                    .map(|(asset, p)| (asset.clone(), p.currency.clone()))
                    .collect();
                let amounts = income.get_asset_income(
                    std::slice::from_ref(id),
                    &currencies,
                    &read.base_currency,
                )?;
                // Convert the old arithmetic-test fixture's income inputs to
                // posted cash facts and dated FX, rather than injecting totals
                // into production holdings after capture.
                for (asset_index, (asset, value)) in amounts.into_iter().enumerate() {
                    let Some(amount) = value.local else {
                        continue;
                    };
                    let currency = currencies.get(&asset).expect("fixture asset currency");
                    let date = day
                        - chrono::Duration::days(
                            (index * self.assets.len() + asset_index + 1) as i64,
                        );
                    read.activities.push(test_income_activity(
                        &format!("fixture-income-{id}-{asset}"),
                        id,
                        Some(&asset),
                        ACTIVITY_TYPE_DIVIDEND,
                        amount,
                        currency,
                        date,
                    ));
                    if currency == &read.base_currency {
                        assert_eq!(
                            value.local, value.base,
                            "same-currency fixture amounts must agree"
                        );
                    } else if let Some(base) = value.base.filter(|_| !amount.is_zero()) {
                        read.fx_rates.push(ExchangeRate {
                            id: format!("fixture-fx-{id}-{asset}"),
                            from_currency: currency.clone(),
                            to_currency: read.base_currency.clone(),
                            rate: base / amount,
                            source: "MANUAL".into(),
                            timestamp: date.and_hms_opt(0, 0, 0).unwrap().and_utc(),
                        });
                    }
                }
            }
            read.snapshots.insert(id.clone(), snapshot);
        }
        Ok(read)
    }
    fn pending_markers(&self) -> Result<Vec<crate::portfolio::projection::ProjectionMarker>> {
        Ok(Vec::new())
    }
    fn last_valued_days(&self) -> Result<HashMap<String, NaiveDate>> {
        Ok(HashMap::new())
    }
    fn activity_issues(
        &self,
        _: &[String],
    ) -> Result<Vec<crate::portfolio::projection::ActivityIssue>> {
        Ok(Vec::new())
    }
    async fn write_window(&self, _: Vec<crate::portfolio::projection::WindowRows>) -> Result<()> {
        unimplemented!("read fixture")
    }
    async fn complete_run(&self, _: crate::portfolio::projection::RunCompletion) -> Result<()> {
        unimplemented!("read fixture")
    }
    async fn invalidate(
        &self,
        _: crate::portfolio::projection::MarkerScope,
        _: NaiveDate,
    ) -> Result<()> {
        unimplemented!("read fixture")
    }
}

struct TestHoldingsService {
    inner: HoldingsService,
    read: Arc<FixtureReadStore>,
    activity_repository: Option<Arc<dyn ActivityRepositoryTrait>>,
}

impl std::ops::Deref for TestHoldingsService {
    type Target = HoldingsService;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl TestHoldingsService {
    fn with_lot_repository(mut self, lots: Arc<dyn LotRepositoryTrait>) -> Self {
        *self.read.lots.lock().unwrap() = Some(lots.clone());
        self.inner = self.inner.with_lot_repository(lots);
        self
    }
    fn with_income_service(self, income: Arc<dyn HoldingIncomeServiceTrait>) -> Self {
        *self.read.income.lock().unwrap() = Some(income);
        self
    }
    fn prepare(&self) {
        *self.read.activities.lock().unwrap() = self.activity_repository.clone();
    }
    async fn get_holdings(&self, id: &str, base: &str) -> Result<Vec<Holding>> {
        self.prepare();
        self.inner.get_holdings(id, base).await
    }
    async fn get_holding(&self, id: &str, asset: &str, base: &str) -> Result<Option<Holding>> {
        self.prepare();
        self.inner.get_holding(id, asset, base).await
    }
    async fn get_holdings_with_options(
        &self,
        id: &str,
        base: &str,
        closed: bool,
    ) -> Result<Vec<Holding>> {
        self.prepare();
        self.inner.get_holdings_with_options(id, base, closed).await
    }
    async fn get_holdings_for_accounts(
        &self,
        ids: &[String],
        base: &str,
        scope: &str,
    ) -> Result<Vec<Holding>> {
        self.prepare();
        self.inner.get_holdings_for_accounts(ids, base, scope).await
    }
    async fn get_holdings_for_accounts_with_options(
        &self,
        ids: &[String],
        base: &str,
        scope: &str,
        closed: bool,
    ) -> Result<Vec<Holding>> {
        self.prepare();
        self.inner
            .get_holdings_for_accounts_with_options(ids, base, scope, closed)
            .await
    }
}

fn test_service_with_snapshots(
    snapshots: Arc<dyn SnapshotServiceTrait>,
    assets: Vec<Asset>,
    values: HashMap<String, Decimal>,
) -> TestHoldingsService {
    let read = Arc::new(FixtureReadStore {
        snapshots: snapshots.clone(),
        assets: assets.clone(),
        lots: std::sync::Mutex::new(None),
        activities: std::sync::Mutex::new(None),
        income: std::sync::Mutex::new(None),
    });
    let inner = HoldingsService::new(
        Arc::new(MockAssetService::new(assets)),
        snapshots,
        Arc::new(MockValuationService { values }),
        Arc::new(AssetClassificationService::new(Arc::new(
            EmptyTaxonomyService,
        ))),
    )
    .with_projection_store(read.clone());
    TestHoldingsService {
        inner,
        read,
        activity_repository: None,
    }
}
