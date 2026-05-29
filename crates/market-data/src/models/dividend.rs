//! Dividend event data returned by market data providers.

/// A cash dividend event from a market data provider.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DividendEvent {
    pub amount: f64,
    pub date: i64, // unix seconds
}
