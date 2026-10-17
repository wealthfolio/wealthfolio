//! Opt-in upstream smoke test; never reads portfolio data or credentials.
use chrono::{TimeZone, Utc};
use rust_decimal::Decimal;
use wealthfolio_market_data::{
    InstrumentId, MarketDataProvider, MoexProvider, ProviderInstrument, QuoteContext,
    QuoteIdentifiers,
};

fn context(ticker: &str) -> QuoteContext {
    QuoteContext {
        instrument: InstrumentId::Equity {
            ticker: ticker.into(),
            mic: Some("MISX".into()),
        },
        identifiers: QuoteIdentifiers::default(),
        overrides: None,
        currency_hint: Some("RUB".into()),
        preferred_provider: None,
        bond_metadata: None,
        custom_provider_code: None,
    }
}

fn symbol(ticker: &str) -> ProviderInstrument {
    ProviderInstrument::EquitySymbol {
        symbol: ticker.into(),
    }
}

#[tokio::test]
#[ignore = "requires live MOEX ISS HTTPS access; run explicitly"]
async fn moex_search_profile_latest_and_paged_history() {
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let provider = MoexProvider::new();

        let results = provider.search("AFLT").await.unwrap();
        assert!(results
            .iter()
            .any(|r| r.symbol == "AFLT" && r.exchange_mic.as_deref() == Some("MISX")));

        let profile = provider.get_profile("AFLT").await.unwrap();
        assert_eq!(profile.isin.as_deref(), Some("RU0009062285"));

        let latest = provider
            .get_latest_quote(&context("AFLT"), symbol("AFLT"))
            .await
            .unwrap();
        assert_eq!(latest.currency, "RUB");
        assert!(latest.close > Decimal::ZERO);

        // Spans more than one 100-row ISS page.
        let start = Utc.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2020, 8, 31, 0, 0, 0).unwrap();
        let history = provider
            .get_historical_quotes(&context("AFLT"), symbol("AFLT"), start, end)
            .await
            .unwrap();
        assert!(history.len() > 100, "got {} bars", history.len());
        let feb26 = history
            .iter()
            .find(|q| q.timestamp.date_naive().to_string() == "2020-02-26")
            .expect("2020-02-26 bar");
        assert_eq!(feb26.close, Decimal::new(10822, 2));

        // Delisted GDR: history must still come back from its old board.
        let mail = provider
            .get_historical_quotes(
                &context("MAIL"),
                symbol("MAIL"),
                Utc.with_ymd_and_hms(2020, 8, 26, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2020, 8, 28, 0, 0, 0).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mail.len(), 3);

        assert!(provider
            .get_latest_quote(&context("NOSUCHSECID"), symbol("NOSUCHSECID"))
            .await
            .is_err());
    })
    .await
    .expect("MOEX live test timed out");
}
