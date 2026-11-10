//! FX (Foreign Exchange) module - domain models, services, and traits.

pub mod currency;
pub mod currency_converter;
mod fx_errors;
mod fx_model;
mod fx_service;
mod fx_traits;

pub use currency::{
    denormalization_multiplier, get_normalization_rule, is_crypto_currency, normalize_amount,
    normalize_currency_code,
};
pub use currency_converter::CurrencyConverter;
pub use fx_errors::FxError;
pub use fx_model::{
    ExchangeRate, ExchangeRateDateBatchRequest, ExchangeRateDateQuery, ExchangeRateDateResult,
    FxContext, NewExchangeRate,
};
pub use fx_service::FxService;
pub use fx_traits::{FxRepositoryTrait, FxServiceTrait};
