//! Opt-in upstream smoke test for AMFI's undocumented NAV history endpoint and
//! `NAVAll.txt`; never reads portfolio data or credentials.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use chrono::{Duration, NaiveDate, TimeZone, Utc};
use rust_decimal::Decimal;
use wealthfolio_market_data::errors::MarketDataError;
use wealthfolio_market_data::{
    AmfiProvider, InstrumentId, MarketDataProvider, ProviderInstrument, QuoteContext,
    QuoteIdentifiers,
};

fn context() -> QuoteContext {
    QuoteContext {
        instrument: InstrumentId::Equity {
            ticker: "INF879O01027".into(),
            mic: None,
        },
        identifiers: QuoteIdentifiers::default(),
        overrides: None,
        currency_hint: Some("INR".into()),
        preferred_provider: Some("AMFI".into()),
        bond_metadata: None,
        custom_provider_code: None,
    }
}

#[tokio::test]
#[ignore = "requires live AMFI HTTPS access; run explicitly to check AMFI's formats"]
async fn amfi_latest_nav_and_history_longer_than_five_years() {
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        let provider = AmfiProvider::new();
        // Parag Parikh Flexi Cap Fund, Direct Plan, Growth: ISIN and scheme code.
        let by_isin = ProviderInstrument::EquitySymbol {
            symbol: "INF879O01027".into(),
        };
        let by_code = ProviderInstrument::EquitySymbol {
            symbol: "122639".into(),
        };

        let latest = provider
            .get_latest_quote(&context(), by_isin.clone())
            .await
            .unwrap();
        assert!(latest.close > Decimal::ZERO);
        assert_eq!(latest.currency, "INR");
        assert!(latest.timestamp > Utc::now() - Duration::days(10));

        // Six years needs more than one request under AMFI's five-year limit.
        let end = Utc::now();
        let start = end - Duration::days(6 * 365);
        let history = provider
            .get_historical_quotes(&context(), by_isin, start, end)
            .await
            .unwrap();
        assert!(history.len() > 1000, "only {} NAVs", history.len());
        assert!(history.first().unwrap().timestamp - start < Duration::days(10));
        assert!(history
            .windows(2)
            .all(|pair| pair[0].timestamp.date_naive() < pair[1].timestamp.date_naive()));
        assert!(history
            .iter()
            .all(|quote| quote.timestamp.date_naive() >= start.date_naive()
                && quote.timestamp.date_naive() <= end.date_naive()));

        // The scheme code reaches the same history without NAVAll.txt.
        let recent = provider
            .get_historical_quotes(&context(), by_code, end - Duration::days(14), end)
            .await
            .unwrap();
        assert!(recent.last().unwrap().timestamp > end - Duration::days(10));
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires live AMFI HTTPS access; run explicitly to check AMFI's formats"]
async fn amfi_history_of_a_fund_missing_from_nav_all() {
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        let provider = AmfiProvider::new();
        // Tata Gilt Securities Short Maturity Fund, Regular, Quarterly Dividend
        // (scheme 101828), whose last NAV was on 17 March 2017.
        let closed = ProviderInstrument::EquitySymbol {
            symbol: "INF277K01DP6".into(),
        };
        // NAVAll.txt doesn't list it, so there is no latest NAV.
        assert!(matches!(
            provider.get_latest_quote(&context(), closed.clone()).await,
            Err(MarketDataError::SymbolNotFound(_))
        ));

        // From 45 days before a first activity on 1 March 2016 to today, as
        // quote sync requests a new fund's history.
        let start = Utc.with_ymd_and_hms(2016, 1, 16, 0, 0, 0).unwrap();
        let history = provider
            .get_historical_quotes(&context(), closed, start, Utc::now())
            .await
            .unwrap();
        assert!(history.first().unwrap().timestamp - start < Duration::days(10));
        assert_eq!(
            history.last().unwrap().timestamp.date_naive(),
            NaiveDate::from_ymd_opt(2017, 3, 17).unwrap()
        );
        assert!(history.len() > 250, "only {} NAVs", history.len());
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires live AMFI HTTPS access; run explicitly to check AMFI's formats"]
async fn amfi_search_and_profile_by_isin_or_scheme_code() {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let provider = AmfiProvider::new();
        let name = "Parag Parikh Flexi Cap Fund - Direct Plan - Growth";

        for query in ["INF879O01027", "122639"] {
            let results = provider.search(query).await.unwrap();
            assert_eq!(results.len(), 1, "{query}");
            assert_eq!(results[0].symbol, "122639");
            assert_eq!(results[0].name, name);
        }
        // Two schemes with the same name, plan and option stay apart by code.
        let first = provider.search("135762").await.unwrap();
        let second = provider.search("135764").await.unwrap();
        assert_eq!(first[0].name, second[0].name);
        assert_ne!(first[0].symbol, second[0].symbol);

        let profile = provider.get_profile("122639").await.unwrap();
        assert_eq!(profile.quote_type.as_deref(), Some("MUTUALFUND"));
        assert_eq!(profile.name, None);
    })
    .await
    .unwrap();
}
