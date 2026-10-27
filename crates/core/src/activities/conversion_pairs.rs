//! Conversion pairs (engine rules R7.5): which `CONVERSION_OUT` and
//! `CONVERSION_IN` adjustments form one conversion. The portfolio engine pairs
//! posted rows with the same rule when it folds them; a table test keeps the
//! two in agreement. Core reads it to look up, edit and delete a conversion as
//! a pair, and to check one when both of its rows are written together.

use std::collections::HashMap;

use chrono::NaiveDate;
use chrono_tz::Tz;
use rust_decimal::Decimal;

use super::{
    is_cash_symbol, Activity, ActivityStatus, NewActivity, ACTIVITY_SUBTYPE_CONVERSION_IN,
    ACTIVITY_SUBTYPE_CONVERSION_OUT, ACTIVITY_TYPE_ADJUSTMENT,
};

/// One conversion: the row whose units leave and the row whose units arrive.
#[derive(Debug, Clone)]
pub struct ConversionPair {
    pub group_id: String,
    pub leaving: Activity,
    pub arriving: Activity,
}

impl ConversionPair {
    /// The other row of the pair, when `activity_id` is one of its rows.
    pub fn counterpart(&self, activity_id: &str) -> Option<&Activity> {
        if activity_id == self.leaving.id {
            Some(&self.arriving)
        } else if activity_id == self.arriving.id {
            Some(&self.leaving)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Leaving,
    Arriving,
}

/// The direction of a conversion row: an adjustment, by its effective type
/// trimmed as the engine reads it, with a conversion subtype in any accepted
/// spelling.
fn conversion_direction(activity: &Activity) -> Option<Direction> {
    if activity.effective_type().trim() != ACTIVITY_TYPE_ADJUSTMENT {
        return None;
    }
    let subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref())?;
    if subtype == ACTIVITY_SUBTYPE_CONVERSION_OUT {
        Some(Direction::Leaving)
    } else if subtype == ACTIVITY_SUBTYPE_CONVERSION_IN {
        Some(Direction::Arriving)
    } else {
        None
    }
}

/// Whether an activity is a row of a conversion.
pub fn is_conversion_row(activity: &Activity) -> bool {
    conversion_direction(activity).is_some()
}

/// A row's group id, trimmed as the engine reads it; a blank one is none.
fn group_of(activity: &Activity) -> Option<&str> {
    activity
        .source_group_id
        .as_deref()
        .map(str::trim)
        .filter(|group| !group.is_empty())
}

/// The conversions among some activities, by group. Rows pair only with rows
/// of the same status, so a posted pair is exactly what the engine folds, and
/// two drafts pair as a draft conversion.
#[derive(Debug, Clone, Default)]
pub struct ConversionPairResolution {
    pairs: Vec<ConversionPair>,
    pair_by_activity_id: HashMap<String, usize>,
    /// Conversion rows that do not form a pair, and why.
    invalid: HashMap<String, String>,
}

impl ConversionPairResolution {
    /// Resolves the conversions among `activities`, reading business days in
    /// `timezone` as the engine does.
    pub fn from_activities(activities: &[Activity], timezone: Tz) -> Self {
        let mut resolution = Self::default();
        let mut groups: HashMap<(&str, std::mem::Discriminant<ActivityStatus>), Vec<&Activity>> =
            HashMap::new();
        for activity in activities {
            match group_of(activity) {
                Some(group) => groups
                    .entry((group, std::mem::discriminant(&activity.status)))
                    .or_default()
                    .push(activity),
                None if is_conversion_row(activity) => {
                    resolution.invalid.insert(
                        activity.id.clone(),
                        "a conversion row must be linked to its other row by a group".into(),
                    );
                }
                None => {}
            }
        }
        for ((group, _), rows) in groups {
            if !rows.iter().any(|row| is_conversion_row(row)) {
                continue;
            }
            match build_conversion_pair(group, &rows, timezone) {
                Ok(pair) => {
                    let index = resolution.pairs.len();
                    resolution
                        .pair_by_activity_id
                        .insert(pair.leaving.id.clone(), index);
                    resolution
                        .pair_by_activity_id
                        .insert(pair.arriving.id.clone(), index);
                    resolution.pairs.push(pair);
                }
                Err(reason) => {
                    for row in rows {
                        resolution.invalid.insert(row.id.clone(), reason.clone());
                    }
                }
            }
        }
        resolution
    }

    pub fn pairs(&self) -> &[ConversionPair] {
        &self.pairs
    }

    pub fn pair_for_activity(&self, activity_id: &str) -> Option<&ConversionPair> {
        self.pair_by_activity_id
            .get(activity_id)
            .and_then(|index| self.pairs.get(*index))
    }

    /// Why a row of a conversion group does not form a pair, if it does not.
    pub fn invalid_reason(&self, activity_id: &str) -> Option<&str> {
        self.invalid.get(activity_id).map(String::as_str)
    }
}

/// The engine's rule (`normalize::build_conversion`): exactly one
/// `CONVERSION_OUT` and one `CONVERSION_IN` adjustment and nothing else, in
/// one account on one business day, with two different non-cash assets, units
/// on both rows and no fee or tax.
fn build_conversion_pair(
    group: &str,
    rows: &[&Activity],
    timezone: Tz,
) -> std::result::Result<ConversionPair, String> {
    let (leaving, arriving) = match rows {
        [first, second] => match (conversion_direction(first), conversion_direction(second)) {
            (Some(Direction::Leaving), Some(Direction::Arriving)) => (*first, *second),
            (Some(Direction::Arriving), Some(Direction::Leaving)) => (*second, *first),
            _ => {
                return Err(
                    "a conversion must be one CONVERSION_OUT row and one CONVERSION_IN row".into(),
                )
            }
        },
        _ => {
            return Err(format!(
                "a conversion must be two rows, and its group has {}",
                rows.len()
            ))
        }
    };
    if leaving.account_id != arriving.account_id {
        return Err("both rows of a conversion must be in one account".into());
    }
    let day = |activity: &Activity| -> NaiveDate {
        activity.activity_date.with_timezone(&timezone).date_naive()
    };
    if day(leaving) != day(arriving) {
        return Err("both rows of a conversion must be on one day".into());
    }
    let asset = |activity: &Activity| {
        activity
            .asset_id
            .as_deref()
            .filter(|asset| !is_cash_symbol(asset))
            .map(str::to_ascii_uppercase)
    };
    match (asset(leaving), asset(arriving)) {
        (Some(from), Some(to)) if from != to => {}
        _ => return Err("a conversion must exchange two different assets".into()),
    }
    let units = |activity: &Activity| activity.quantity.unwrap_or_default();
    if units(leaving).is_zero() || units(arriving).is_zero() {
        return Err("both rows of a conversion must have units".into());
    }
    let charged = |activity: &Activity| {
        !activity.fee.unwrap_or(Decimal::ZERO).is_zero()
            || !activity.tax.unwrap_or(Decimal::ZERO).is_zero()
    };
    if charged(leaving) || charged(arriving) {
        return Err("a conversion must not have a fee or tax".into());
    }
    Ok(ConversionPair {
        group_id: group.to_string(),
        leaving: leaving.clone(),
        arriving: arriving.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activities::ACTIVITY_TYPE_BUY;
    use crate::portfolio::coordinator::raw_activity;
    use chrono::{DateTime, TimeZone, Utc};
    use wealthfolio_portfolio_engine::model::{Currency, Policy, RawAccount, RawFacts};

    fn row(
        id: &str,
        subtype: &str,
        account: &str,
        asset: &str,
        at: DateTime<Utc>,
        group: Option<&str>,
    ) -> Activity {
        Activity {
            id: id.into(),
            account_id: account.into(),
            asset_id: Some(asset.into()),
            activity_type: ACTIVITY_TYPE_ADJUSTMENT.into(),
            activity_type_override: None,
            source_type: None,
            subtype: Some(subtype.into()),
            status: ActivityStatus::Posted,
            activity_date: at,
            settlement_date: None,
            quantity: Some(Decimal::new(10, 0)),
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".into(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: group.map(str::to_string),
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: at,
            updated_at: at,
        }
    }

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, day, hour, 0, 0)
            .single()
            .expect("valid instant")
    }

    #[test]
    fn pairs_one_leaving_and_one_arriving_row_of_a_group() {
        let leaving = row(
            "out",
            "CONVERSION_OUT",
            "a1",
            "FUND-A",
            at(2, 10),
            Some("g1"),
        );
        let arriving = row("in", "conversion-in", "a1", "FUND-B", at(2, 11), Some("g1"));
        let resolution =
            ConversionPairResolution::from_activities(&[arriving, leaving], chrono_tz::UTC);
        let pair = resolution.pair_for_activity("in").expect("pair");
        assert_eq!(pair.leaving.id, "out");
        assert_eq!(pair.arriving.id, "in");
        assert_eq!(pair.counterpart("out").map(|a| a.id.as_str()), Some("in"));
    }

    #[test]
    fn a_draft_row_does_not_pair_with_a_posted_one() {
        let leaving = row(
            "out",
            "CONVERSION_OUT",
            "a1",
            "FUND-A",
            at(2, 10),
            Some("g1"),
        );
        let mut arriving = row("in", "CONVERSION_IN", "a1", "FUND-B", at(2, 11), Some("g1"));
        arriving.status = ActivityStatus::Draft;
        let resolution = ConversionPairResolution::from_activities(
            &[leaving.clone(), arriving.clone()],
            chrono_tz::UTC,
        );
        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_reason("out").is_some());

        let mut leaving = leaving;
        leaving.status = ActivityStatus::Draft;
        let resolution =
            ConversionPairResolution::from_activities(&[leaving, arriving], chrono_tz::UTC);
        assert!(resolution.pair_for_activity("out").is_some());
    }

    #[test]
    fn a_business_day_is_read_in_the_timezone() {
        // 23:00 and 01:00 UTC are the same day in New York and two in UTC.
        let leaving = row(
            "out",
            "CONVERSION_OUT",
            "a1",
            "FUND-A",
            at(2, 23),
            Some("g1"),
        );
        let arriving = row("in", "CONVERSION_IN", "a1", "FUND-B", at(3, 1), Some("g1"));
        let rows = [leaving, arriving];
        let new_york: Tz = "America/New_York".parse().expect("timezone");
        assert!(ConversionPairResolution::from_activities(&rows, new_york)
            .pair_for_activity("out")
            .is_some());
        assert!(
            ConversionPairResolution::from_activities(&rows, chrono_tz::UTC)
                .pair_for_activity("out")
                .is_none()
        );
    }

    /// Core's rule and the engine's pairing agree on every combination of
    /// account, day, assets, units, charges, subtypes, type override, group
    /// size and status.
    #[test]
    fn core_rule_agrees_with_the_engine_pairing() {
        let timezone: Tz = "America/New_York".parse().expect("timezone");
        let mut compared = 0;
        for in_account in ["a1", "a2"] {
            for in_at in [at(2, 15), at(3, 1), at(3, 15)] {
                for (out_asset, in_asset) in [
                    ("FUND-A", "FUND-B"),
                    ("FUND-A", "fund-a"),
                    ("FUND-A", "$CASH-USD"),
                ] {
                    for in_units in [Decimal::new(4, 0), Decimal::ZERO] {
                        for out_fee in [None, Some(Decimal::ZERO), Some(Decimal::ONE)] {
                            for in_subtype in
                                ["CONVERSION_IN", "CONVERSION_OUT", "RETURN_OF_CAPITAL"]
                            {
                                for (in_type, in_override) in [
                                    (ACTIVITY_TYPE_ADJUSTMENT, None),
                                    (ACTIVITY_TYPE_ADJUSTMENT, Some(ACTIVITY_TYPE_BUY)),
                                    (" ADJUSTMENT ", None),
                                ] {
                                    // A padded group id is the same group to both.
                                    for (extra_row, in_group) in [
                                        (false, "g1"),
                                        (true, "g1"),
                                        (false, " g1 "),
                                        (true, " g1 "),
                                    ] {
                                        for in_status in
                                            [ActivityStatus::Posted, ActivityStatus::Draft]
                                        {
                                            let leaving = {
                                                let mut leaving = row(
                                                    "out",
                                                    "CONVERSION_OUT",
                                                    "a1",
                                                    out_asset,
                                                    at(2, 15),
                                                    Some("g1"),
                                                );
                                                leaving.fee = out_fee;
                                                leaving
                                            };
                                            let arriving = {
                                                let mut arriving = row(
                                                    "in",
                                                    in_subtype,
                                                    in_account,
                                                    in_asset,
                                                    in_at,
                                                    Some(in_group),
                                                );
                                                arriving.quantity = Some(in_units);
                                                arriving.activity_type = in_type.to_string();
                                                arriving.activity_type_override =
                                                    in_override.map(str::to_string);
                                                arriving.status = in_status.clone();
                                                arriving
                                            };
                                            let mut rows = vec![leaving, arriving];
                                            if extra_row {
                                                let mut extra = row(
                                                    "extra",
                                                    "",
                                                    "a1",
                                                    "FUND-C",
                                                    at(2, 16),
                                                    Some("g1"),
                                                );
                                                extra.subtype = None;
                                                rows.push(extra);
                                            }

                                            let core = ConversionPairResolution::from_activities(
                                                &rows, timezone,
                                            )
                                            .pair_for_activity("out")
                                            .is_some();

                                            let raw = RawFacts {
                                                policy: Policy::new(
                                                    Currency::parse("USD").expect("currency"),
                                                    timezone,
                                                    NaiveDate::from_ymd_opt(2026, 4, 30)
                                                        .expect("as-of date"),
                                                ),
                                                accounts: ["a1", "a2"]
                                                    .into_iter()
                                                    .map(|id| RawAccount {
                                                        id: id.into(),
                                                        currency: "USD".into(),
                                                        account_type: "SECURITIES".into(),
                                                        tracking_mode: "TRANSACTIONS".into(),
                                                        is_archived: false,
                                                        cost_basis_method: None,
                                                    })
                                                    .collect(),
                                                assets: Vec::new(),
                                                activities: rows.iter().map(raw_activity).collect(),
                                                quotes: Vec::new(),
                                                fx_rates: Vec::new(),
                                                observed_snapshots: Vec::new(),
                                            };
                                            let normalized =
                                                wealthfolio_portfolio_engine::normalize(raw)
                                                    .expect("normalize");
                                            let engine = normalized
                                                .facts
                                                .conversions()
                                                .pair_for(
                                                    &wealthfolio_portfolio_engine::model::ActivityId::new(
                                                        "out",
                                                    ),
                                                )
                                                .is_some();

                                            // Drafts never reach the engine: a posted row
                                            // agrees with it, a draft pair is core's alone.
                                            if in_status == ActivityStatus::Posted {
                                                let case = format!(
                                                    "{in_account} {in_at} {out_asset}/{in_asset} units {in_units} fee {out_fee:?} {in_subtype} {in_type:?} {in_override:?} extra {extra_row} group {in_group:?}"
                                                );
                                                assert_eq!(core, engine, "{case}");
                                                compared += 1;
                                            } else {
                                                assert!(
                                                    !core,
                                                    "a posted row never pairs with a draft"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(compared, 2 * 3 * 3 * 2 * 3 * 3 * 3 * 4);
    }
}
