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

        let mail_results = provider.search("MAIL").await.unwrap();
        assert!(mail_results
            .iter()
            .any(|r| r.symbol == "MAIL" && r.exchange_mic.as_deref() == Some("MISX")));
        let profile = provider.get_profile("AFLT").await.unwrap();
        assert_eq!(profile.currency.as_deref(), Some("RUB"));
        assert!(
            profile.country.is_none(),
            "do not infer domicile from listing venue"
        );
        let splits = provider
            .get_splits(
                &context("VTBR"),
                symbol("VTBR"),
                Utc.with_ymd_and_hms(2024, 7, 1, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2024, 7, 31, 0, 0, 0).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(splits.len(), 1);
        assert_eq!(splits[0].ratio, Decimal::new(2, 4));
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

        // A one-day request spanning the whole UTC day returns that day only.
        let day = provider
            .get_historical_quotes(
                &context("AFLT"),
                symbol("AFLT"),
                Utc.with_ymd_and_hms(2020, 2, 26, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2020, 2, 26, 23, 59, 59).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(day.len(), 1);
        assert_eq!(day[0].timestamp.date_naive().to_string(), "2020-02-26");

        // Before the 2013 move to T+ settlement, shares traded on EQBR.
        let t0 = provider
            .get_historical_quotes(
                &context("AFLT"),
                symbol("AFLT"),
                Utc.with_ymd_and_hms(2010, 3, 1, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2010, 3, 31, 0, 0, 0).unwrap(),
            )
            .await
            .unwrap();
        assert!(t0.len() >= 20, "got {} bars", t0.len());

        assert!(provider
            .get_latest_quote(&context("NOSUCHSECID"), symbol("NOSUCHSECID"))
            .await
            .is_err());
    })
    .await
    .expect("MOEX live test timed out");
}
