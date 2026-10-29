//! Opt-in upstream smoke test for AMFI's undocumented NAV history endpoint and
//! `NAVAll.txt`; never reads portfolio data or credentials.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use chrono::{Duration, Utc};
use rust_decimal::Decimal;
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
