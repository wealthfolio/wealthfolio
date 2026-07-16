//! Currency-conversion, asset-cache, and cash-total helpers for the holdings
//! calculator (`impl HoldingsCalculator`). All methods here either resolve FX
//! (preferring an activity's explicit `fx_rate`, falling back to the
//! `FxService`) or populate the per-run asset-fact cache.

use super::economics::{AssetCache, AssetPositionInfo};
use super::HoldingsCalculator;
use crate::activities::Activity;
use crate::errors::{CalculatorError, Error, Result};
use crate::portfolio::snapshot::LotBookBasis;
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, ShortabilityPolicy};
use chrono::{DateTime, NaiveDate, Utc};
use log::{debug, error, warn};
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Populates the asset cache for a given asset_id if not already present.
    pub(super) fn ensure_asset_cached(
        &self,
        asset_id: &str,
        activity_currency: &str,
        cache: &mut AssetCache,
    ) {
        if !asset_id.is_empty() && !cache.contains_key(asset_id) {
            let asset_info = self.get_position_info(asset_id).unwrap_or_else(|_| {
                warn!(
                    "Failed to get asset info for {}, using activity currency {} and multiplier 1",
                    asset_id, activity_currency
                );
                AssetPositionInfo::fallback(activity_currency)
            });
            cache.insert(asset_id.to_string(), asset_info);
        }
    }

    /// Converts an amount from activity currency to account currency.
    /// If the activity has a valid fx_rate (Some and not zero), uses it directly.
    /// Otherwise, falls back to the FxService for conversion.
    /// The fx_rate represents the rate to convert from activity currency to account currency.
    pub(super) fn convert_to_account_currency(
        &self,
        amount: Decimal,
        activity: &Activity,
        account_currency: &str,
        context: &str,
    ) -> Decimal {
        let activity_currency = &activity.currency;

        // If currencies are the same, no conversion needed
        if activity_currency == account_currency {
            return amount;
        }

        // Check if activity has a valid fx_rate (Some and not zero)
        if let Some(fx_rate) = activity.fx_rate {
            if fx_rate != Decimal::ZERO {
                // Use the provided fx_rate directly
                debug!(
                    "Using activity fx_rate {} for {} conversion {}->{} (activity {})",
                    fx_rate, context, activity_currency, account_currency, activity.id
                );
                return amount * fx_rate;
            }
        }

        // Fall back to FxService for conversion
        let activity_date = self.activity_local_date(activity);
        match self.fx_service.convert_currency_for_date(
            amount,
            activity_currency,
            account_currency,
            activity_date,
        ) {
            Ok(converted) => converted,
            Err(e) => {
                warn!(
                    "Holdings Calc ({} {}): Failed conversion {} {}->{} on {}: {}. Using original amount.",
                    context,
                    activity.id,
                    amount,
                    activity_currency,
                    account_currency,
                    activity_date,
                    e
                );
                amount // Fallback to original amount
            }
        }
    }

    /// Determines the cached asset facts needed to create and value a position.
    pub(super) fn get_position_info(&self, asset_id: &str) -> Result<AssetPositionInfo> {
        debug!("Getting position info for asset_id: {}", asset_id);
        match self.asset_repository.get_by_id(asset_id) {
            Ok(asset) => {
                let is_alternative = asset.is_alternative();
                let contract_multiplier = asset.contract_multiplier();
                let is_bond = asset.is_bond();
                let allows_negative_lots = ShortabilityPolicy::allows_negative_lots(&asset);
                let requires_explicit_short_intent =
                    ShortabilityPolicy::requires_explicit_short_intent(&asset);

                Ok(AssetPositionInfo {
                    currency: asset.quote_ccy,
                    is_alternative,
                    contract_multiplier,
                    is_bond,
                    allows_negative_lots,
                    requires_explicit_short_intent,
                })
            }
            Err(e) => {
                error!("Failed to get asset for asset_id '{}': {}", asset_id, e);
                Err(Error::Calculation(CalculatorError::Calculation(format!(
                    "Asset not found for id: {}",
                    asset_id
                ))))
            }
        }
    }

    /// Converts an amount from position currency to account currency.
    /// This is used for cost basis which is stored in position currency, not activity currency.
    /// When activity currency == position currency, uses activity's fx_rate if available.
    /// Otherwise, falls back to FxService with position currency.
    pub(super) fn convert_position_amount_to_account_currency(
        &self,
        amount: Decimal,
        position_currency: &str,
        activity: &Activity,
        account_currency: &str,
        context: &str,
    ) -> Decimal {
        // If position currency matches account currency, no conversion needed
        if position_currency == account_currency {
            return amount;
        }

        // If activity currency matches position currency, we can use activity's fx_rate
        if activity.currency == position_currency {
            if let Some(fx_rate) = activity.fx_rate {
                if fx_rate != Decimal::ZERO {
                    debug!(
                        "Using activity fx_rate {} for {} conversion {}->{} (activity {})",
                        fx_rate, context, position_currency, account_currency, activity.id
                    );
                    return amount * fx_rate;
                }
            }
        }

        // Fall back to FxService for conversion
        let activity_date = self.activity_local_date(activity);
        match self.fx_service.convert_currency_for_date(
            amount,
            position_currency,
            account_currency,
            activity_date,
        ) {
            Ok(converted) => converted,
            Err(e) => {
                warn!(
                    "Holdings Calc ({} {}): Failed conversion {} {}->{} on {}: {}. Using original amount.",
                    context,
                    activity.id,
                    amount,
                    position_currency,
                    account_currency,
                    activity_date,
                    e
                );
                amount // Fallback to original amount
            }
        }
    }

    pub(super) fn convert_activity_amount_to_position_currency(
        &self,
        amount: Decimal,
        activity: &Activity,
        position_currency: &str,
        account_currency: &str,
        context: &str,
    ) -> Result<Decimal> {
        if position_currency.is_empty() || position_currency == activity.currency {
            return Ok(amount);
        }

        let can_use_fx_rate =
            position_currency == account_currency || activity.currency == account_currency;
        if can_use_fx_rate {
            if let Some(fx_rate) = activity.fx_rate.filter(|r| *r != Decimal::ZERO) {
                debug!(
                    "Using activity fx_rate {} for {} conversion {} -> {} (activity {})",
                    fx_rate, context, activity.currency, position_currency, activity.id
                );
                return Ok(amount * fx_rate);
            }
        }

        let activity_date = self.activity_local_date(activity);
        self.fx_service
            .convert_currency_for_date(amount, &activity.currency, position_currency, activity_date)
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert {} from {} to {}: {}",
                    context, activity.currency, position_currency, e
                ))
                .into()
            })
    }

    /// Helper method to get/create position with asset currency caching.
    /// Uses cache to avoid repeated DB lookups for the same asset.
    /// Cache stores asset facts for each asset.
    pub(super) fn get_or_create_position_mut_cached<'a>(
        &self,
        state: &'a mut AccountStateSnapshot,
        asset_id: &str,
        activity_currency: &str,
        date: DateTime<Utc>,
        cache: &mut AssetCache,
    ) -> std::result::Result<&'a mut Position, CalculatorError> {
        if asset_id.is_empty() {
            return Err(CalculatorError::InvalidActivity(format!(
                "Invalid asset_id for position: {}",
                asset_id
            )));
        }

        self.ensure_asset_cached(asset_id, activity_currency, cache);

        let asset_info = cache
            .get(asset_id)
            .expect("asset cache should be populated before position creation");

        Ok(state
            .positions
            .entry(asset_id.to_string())
            .or_insert_with(|| {
                Position::new_with_alternative_flag(
                    state.account_id.clone(),
                    asset_id.to_string(),
                    asset_info.currency.clone(),
                    date,
                    asset_info.is_alternative,
                    asset_info.contract_multiplier,
                )
            }))
    }

    /// Converts unit_price, fee, and tax to position currency.
    /// Returns (converted_price, converted_fee, converted_tax, fx_rate_used).
    pub(super) fn convert_to_position_currency(
        &self,
        unit_price: Decimal,
        fee: Decimal,
        tax: Decimal,
        activity: &Activity,
        position_currency: &str,
        account_currency: &str,
    ) -> Result<(Decimal, Decimal, Decimal, Option<Decimal>)> {
        let activity_date = self.activity_local_date(activity);

        // Determine when we can use the activity's fx_rate for position currency conversion
        let can_use_fx_rate =
            position_currency == account_currency || activity.currency == account_currency;

        if can_use_fx_rate {
            if let Some(fx_rate) = activity.fx_rate.filter(|r| *r != Decimal::ZERO) {
                debug!(
                    "Using activity fx_rate {} for position currency conversion {} -> {} (activity {})",
                    fx_rate, activity.currency, position_currency, activity.id
                );
                return Ok((
                    unit_price * fx_rate,
                    fee * fx_rate,
                    tax * fx_rate,
                    Some(fx_rate),
                ));
            }
        }

        // Fall back to FxService
        let converted_price = self
            .fx_service
            .convert_currency_for_date(
                unit_price,
                &activity.currency,
                position_currency,
                activity_date,
            )
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert unit_price from {} to {}: {}",
                    activity.currency, position_currency, e
                ))
            })?;

        let converted_fee = self
            .fx_service
            .convert_currency_for_date(fee, &activity.currency, position_currency, activity_date)
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert fee from {} to {}: {}",
                    activity.currency, position_currency, e
                ))
            })?;
        let converted_tax = self
            .fx_service
            .convert_currency_for_date(tax, &activity.currency, position_currency, activity_date)
            .map_err(|e| {
                CalculatorError::CurrencyConversion(format!(
                    "Failed to convert tax from {} to {}: {}",
                    activity.currency, position_currency, e
                ))
            })?;

        // Calculate implied fx_rate for audit trail
        let fx_rate_used = if unit_price != Decimal::ZERO {
            Some(converted_price / unit_price)
        } else {
            None
        };

        Ok((converted_price, converted_fee, converted_tax, fx_rate_used))
    }

    /// Computes cash totals in account and base currencies.
    /// Called once at end of daily calculation per spec.
    pub(super) fn compute_cash_totals(
        &self,
        state: &mut AccountStateSnapshot,
        target_date: NaiveDate,
    ) {
        let account_currency = &state.currency;
        let base_ccy = self.base_currency.read().unwrap();

        let mut total_acct = Decimal::ZERO;
        let mut total_base = Decimal::ZERO;

        for (currency, &amount) in &state.cash_balances {
            // Convert to account currency
            if currency == account_currency {
                total_acct += amount;
            } else {
                match self.fx_service.convert_currency_for_date(
                    amount,
                    currency,
                    account_currency,
                    target_date,
                ) {
                    Ok(converted) => total_acct += converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert cash {} {} to account currency {}: {}. Using unconverted.",
                            amount, currency, account_currency, e
                        );
                        total_acct += amount;
                    }
                }
            }

            // Convert to base currency
            if currency == base_ccy.as_str() {
                total_base += amount;
            } else {
                match self.fx_service.convert_currency_for_date(
                    amount,
                    currency,
                    &base_ccy,
                    target_date,
                ) {
                    Ok(converted) => total_base += converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert cash {} {} to base currency {}: {}. Using unconverted.",
                            amount, currency, &base_ccy, e
                        );
                        total_base += amount;
                    }
                }
            }
        }

        state.cash_total_account_currency = total_acct;
        state.cash_total_base_currency = total_base;
    }
}

impl HoldingsCalculator {
    pub(super) fn lot_book_basis_for_activity(
        &self,
        activity: &Activity,
        position_currency: &str,
        account_currency: &str,
    ) -> LotBookBasis {
        let acquisition_local_date = self.activity_local_date(activity);
        let base_currency = self.base_currency.read().unwrap().clone();
        let explicit_position_to_account =
            Self::explicit_position_to_account_rate(activity, position_currency, account_currency);

        let fx_rate_to_account = if position_currency == account_currency {
            Some(Decimal::ONE)
        } else {
            explicit_position_to_account.or_else(|| {
                self.fx_rate_for_basis(
                    position_currency,
                    account_currency,
                    acquisition_local_date,
                    &activity.id,
                )
            })
        };

        let fx_rate_to_base = if position_currency == base_currency {
            Some(Decimal::ONE)
        } else if let Some(explicit_rate) = explicit_position_to_account {
            if account_currency == base_currency {
                Some(explicit_rate)
            } else {
                self.fx_rate_for_basis(
                    account_currency,
                    &base_currency,
                    acquisition_local_date,
                    &activity.id,
                )
                .map(|account_to_base| explicit_rate * account_to_base)
            }
        } else {
            self.fx_rate_for_basis(
                position_currency,
                &base_currency,
                acquisition_local_date,
                &activity.id,
            )
        };

        LotBookBasis {
            acquisition_local_date: Some(acquisition_local_date),
            fx_rate_to_account,
            account_currency: Some(account_currency.to_string()),
            fx_rate_to_base,
            base_currency: Some(base_currency),
        }
    }

    pub(super) fn explicit_position_to_account_rate(
        activity: &Activity,
        position_currency: &str,
        account_currency: &str,
    ) -> Option<Decimal> {
        if position_currency == account_currency {
            return Some(Decimal::ONE);
        }

        let fx_rate = activity.fx_rate.filter(|rate| !rate.is_zero())?;
        if activity.currency == position_currency {
            return Some(fx_rate);
        }

        if activity.currency == account_currency {
            return Some(Decimal::ONE / fx_rate);
        }

        None
    }

    pub(super) fn fx_rate_for_basis(
        &self,
        from_currency: &str,
        to_currency: &str,
        date: NaiveDate,
        activity_id: &str,
    ) -> Option<Decimal> {
        match self.fx_service.convert_currency_for_date(
            Decimal::ONE,
            from_currency,
            to_currency,
            date,
        ) {
            Ok(rate) => Some(rate),
            Err(e) => {
                warn!(
                    "Holdings Calc (Lot Basis {}): Failed FX rate {}->{} on {}: {}.",
                    activity_id, from_currency, to_currency, date, e
                );
                None
            }
        }
    }
}
