//! Cross-account internal transfer accounting helpers.
//!
//! Paired TRANSFER_IN/TRANSFER_OUT activities sharing a `source_group_id`
//! represent money moving between the user's own accounts. At the per-account
//! level each leg is treated as an external flow (deposit or withdrawal); at
//! the portfolio level those legs must net to zero so they don't inflate
//! `net_contribution`.
//!
//! This module computes the per-date adjustment (in base currency) needed to
//! cancel paired internal transfers when aggregating per-account valuations
//! into a portfolio total.

use std::collections::HashMap;

use chrono::NaiveDate;
use log::warn;
use rust_decimal::Decimal;

use crate::activities::{
    Activity, ActivityRepositoryTrait, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
};
use crate::errors::Result;
use crate::fx::FxServiceTrait;
use crate::portfolio::performance::{classify_flow_for_scope, FlowType, PerformanceScope};
use crate::utils::time_utils::activity_date_in_user_timezone;

/// Returns per-date adjustments (base currency) that, when subtracted from a
/// naïve sum of per-account `net_contribution` values, cancel the double-count
/// caused by paired internal transfers.
///
/// The map contains only dates with at least one paired transfer; callers that
/// need a cumulative running total should accumulate across sorted dates.
pub fn internal_transfer_adjustments_by_date_base(
    activity_repository: &dyn ActivityRepositoryTrait,
    fx_service: &dyn FxServiceTrait,
    account_ids: &[String],
    base_currency: &str,
    timezone: &str,
) -> Result<HashMap<NaiveDate, Decimal>> {
    let activities = activity_repository.get_activities_by_account_ids(account_ids)?;

    let mut grouped: HashMap<String, Vec<Activity>> = HashMap::new();
    for activity in activities {
        if activity.source_group_id.is_none() {
            continue;
        }

        let activity_type = activity.activity_type.as_str();
        if activity_type != ACTIVITY_TYPE_TRANSFER_IN
            && activity_type != ACTIVITY_TYPE_TRANSFER_OUT
        {
            continue;
        }

        if classify_flow_for_scope(&activity, PerformanceScope::Portfolio) == FlowType::External {
            continue;
        }

        if let Some(group_id) = activity.source_group_id.clone() {
            grouped.entry(group_id).or_default().push(activity);
        }
    }

    let mut adjustments_by_date: HashMap<NaiveDate, Decimal> = HashMap::new();

    for (_group_id, group_activities) in grouped {
        let has_in = group_activities
            .iter()
            .any(|a| a.activity_type == ACTIVITY_TYPE_TRANSFER_IN);
        let has_out = group_activities
            .iter()
            .any(|a| a.activity_type == ACTIVITY_TYPE_TRANSFER_OUT);

        if !(has_in && has_out) {
            continue;
        }

        for activity in group_activities {
            let amount = if let Some(amount) = activity.amount {
                amount
            } else if let (Some(quantity), Some(unit_price)) =
                (activity.quantity, activity.unit_price)
            {
                quantity * unit_price
            } else {
                Decimal::ZERO
            };

            if amount.is_zero() {
                continue;
            }

            let activity_date = activity_date_in_user_timezone(activity.activity_date, timezone);
            let amount_base = if activity.currency == base_currency {
                amount
            } else {
                match fx_service.convert_currency_for_date(
                    amount,
                    &activity.currency,
                    base_currency,
                    activity_date,
                ) {
                    Ok(converted) => converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert transfer amount {} {} to base {} on {}: {}. Using unconverted.",
                            amount, activity.currency, base_currency, activity_date, e
                        );
                        amount
                    }
                }
            };

            let signed_amount = if activity.activity_type == ACTIVITY_TYPE_TRANSFER_IN {
                amount_base
            } else {
                -amount_base
            };

            *adjustments_by_date
                .entry(activity_date)
                .or_insert(Decimal::ZERO) += signed_amount;
        }
    }

    Ok(adjustments_by_date)
}

