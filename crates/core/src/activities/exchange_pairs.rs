use std::collections::{HashMap, HashSet};

use super::{Activity, ACTIVITY_SUBTYPE_EXCHANGE_IN, ACTIVITY_SUBTYPE_EXCHANGE_OUT};

#[derive(Debug, Clone)]
pub struct ExchangePair {
    pub group_id: String,
    pub exchange_in: Activity,
    pub exchange_out: Activity,
}

impl ExchangePair {
    pub fn account_id(&self) -> &str {
        &self.exchange_in.account_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidExchangeGroup {
    pub group_id: String,
    pub activity_ids: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct ExchangePairResolution {
    pairs: Vec<ExchangePair>,
    invalid_groups: Vec<InvalidExchangeGroup>,
    pair_by_activity_id: HashMap<String, usize>,
    invalid_group_by_activity_id: HashMap<String, usize>,
    ungrouped_exchange_ids: HashSet<String>,
}

impl ExchangePairResolution {
    pub fn from_activities(activities: &[Activity]) -> Self {
        let mut grouped: HashMap<String, Vec<Activity>> = HashMap::new();
        let mut ungrouped_exchange_ids = HashSet::new();

        for activity in activities {
            if !is_exchange(activity) {
                continue;
            }

            match activity.source_group_id.as_deref() {
                Some(group_id) if !group_id.trim().is_empty() => {
                    grouped
                        .entry(group_id.to_string())
                        .or_default()
                        .push(activity.clone());
                }
                _ => {
                    ungrouped_exchange_ids.insert(activity.id.clone());
                }
            }
        }

        let mut pairs = Vec::new();
        let mut invalid_groups = Vec::new();

        for (group_id, group_activities) in grouped {
            match build_exchange_pair(&group_id, &group_activities) {
                Ok(pair) => pairs.push(pair),
                Err(reason) => invalid_groups.push(InvalidExchangeGroup {
                    group_id,
                    activity_ids: group_activities
                        .iter()
                        .map(|activity| activity.id.clone())
                        .collect(),
                    reason,
                }),
            }
        }

        let mut pair_by_activity_id = HashMap::new();
        for (index, pair) in pairs.iter().enumerate() {
            pair_by_activity_id.insert(pair.exchange_in.id.clone(), index);
            pair_by_activity_id.insert(pair.exchange_out.id.clone(), index);
        }

        let mut invalid_group_by_activity_id = HashMap::new();
        for (index, group) in invalid_groups.iter().enumerate() {
            for activity_id in &group.activity_ids {
                invalid_group_by_activity_id.insert(activity_id.clone(), index);
            }
        }

        Self {
            pairs,
            invalid_groups,
            pair_by_activity_id,
            invalid_group_by_activity_id,
            ungrouped_exchange_ids,
        }
    }

    pub fn pairs(&self) -> &[ExchangePair] {
        &self.pairs
    }

    pub fn invalid_groups(&self) -> &[InvalidExchangeGroup] {
        &self.invalid_groups
    }

    pub fn pair_for_activity(&self, activity_id: &str) -> Option<&ExchangePair> {
        self.pair_by_activity_id
            .get(activity_id)
            .and_then(|index| self.pairs.get(*index))
    }

    pub fn invalid_group_for_activity(&self, activity_id: &str) -> Option<&InvalidExchangeGroup> {
        self.invalid_group_by_activity_id
            .get(activity_id)
            .and_then(|index| self.invalid_groups.get(*index))
    }

    pub fn is_ungrouped_exchange(&self, activity_id: &str) -> bool {
        self.ungrouped_exchange_ids.contains(activity_id)
    }
}

fn is_exchange(activity: &Activity) -> bool {
    let Some(subtype) = activity.subtype.as_deref() else {
        return false;
    };
    activity.effective_type() == super::ACTIVITY_TYPE_ADJUSTMENT
        && (subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_EXCHANGE_IN)
            || subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_EXCHANGE_OUT))
}

fn is_exchange_in(activity: &Activity) -> bool {
    activity
        .subtype
        .as_deref()
        .is_some_and(|subtype| subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_EXCHANGE_IN))
}

fn is_exchange_out(activity: &Activity) -> bool {
    activity
        .subtype
        .as_deref()
        .is_some_and(|subtype| subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_EXCHANGE_OUT))
}

fn build_exchange_pair(group_id: &str, activities: &[Activity]) -> Result<ExchangePair, String> {
    if activities.len() != 2 {
        return Err(format!(
            "expected exactly two exchange legs, found {}",
            activities.len()
        ));
    }

    let exchange_in: Vec<_> = activities.iter().filter(|a| is_exchange_in(a)).collect();
    let exchange_out: Vec<_> = activities.iter().filter(|a| is_exchange_out(a)).collect();

    if exchange_in.len() != 1 || exchange_out.len() != 1 {
        return Err(format!(
            "expected one EXCHANGE_IN and one EXCHANGE_OUT, found {} in and {} out",
            exchange_in.len(),
            exchange_out.len()
        ));
    }

    let exchange_in = exchange_in[0];
    let exchange_out = exchange_out[0];

    if exchange_in.account_id != exchange_out.account_id {
        return Err("exchange legs must be in the same account".to_string());
    }

    for (label, activity) in [("EXCHANGE_IN", exchange_in), ("EXCHANGE_OUT", exchange_out)] {
        let has_asset = activity
            .asset_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty());
        let has_quantity = activity.quantity.is_some_and(|qty| !qty.is_zero());
        if !has_asset || !has_quantity {
            return Err(format!("{} leg must have an asset and quantity", label));
        }
    }

    Ok(ExchangePair {
        group_id: group_id.to_string(),
        exchange_in: exchange_in.clone(),
        exchange_out: exchange_out.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use rust_decimal::Decimal;

    fn activity(
        id: &str,
        subtype: &str,
        account_id: &str,
        group_id: Option<&str>,
        asset_id: Option<&str>,
        quantity: Option<Decimal>,
    ) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.map(str::to_string),
            activity_type: super::super::ACTIVITY_TYPE_ADJUSTMENT.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: Some(subtype.to_string()),
            status: super::super::ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity,
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: group_id.map(str::to_string),
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn same_account_different_assets_is_valid_pair() {
        let resolution = ExchangePairResolution::from_activities(&[
            activity(
                "out",
                ACTIVITY_SUBTYPE_EXCHANGE_OUT,
                "a1",
                Some("g1"),
                Some("FUND_A"),
                Some(Decimal::new(10, 0)),
            ),
            activity(
                "in",
                ACTIVITY_SUBTYPE_EXCHANGE_IN,
                "a1",
                Some("g1"),
                Some("FUND_B"),
                Some(Decimal::new(5, 0)),
            ),
        ]);

        assert_eq!(resolution.pairs().len(), 1);
        assert_eq!(
            resolution.pair_for_activity("out").unwrap().account_id(),
            "a1"
        );
        assert!(resolution.invalid_group_for_activity("out").is_none());
    }

    #[test]
    fn different_accounts_is_invalid_not_pair() {
        let resolution = ExchangePairResolution::from_activities(&[
            activity(
                "out",
                ACTIVITY_SUBTYPE_EXCHANGE_OUT,
                "a1",
                Some("g1"),
                Some("FUND_A"),
                Some(Decimal::new(10, 0)),
            ),
            activity(
                "in",
                ACTIVITY_SUBTYPE_EXCHANGE_IN,
                "a2",
                Some("g1"),
                Some("FUND_B"),
                Some(Decimal::new(5, 0)),
            ),
        ]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }

    #[test]
    fn missing_quantity_is_invalid_not_pair() {
        let resolution = ExchangePairResolution::from_activities(&[
            activity(
                "out",
                ACTIVITY_SUBTYPE_EXCHANGE_OUT,
                "a1",
                Some("g1"),
                Some("FUND_A"),
                None,
            ),
            activity(
                "in",
                ACTIVITY_SUBTYPE_EXCHANGE_IN,
                "a1",
                Some("g1"),
                Some("FUND_B"),
                Some(Decimal::new(5, 0)),
            ),
        ]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }

    #[test]
    fn one_leg_group_is_invalid_not_pair() {
        let resolution = ExchangePairResolution::from_activities(&[activity(
            "out",
            ACTIVITY_SUBTYPE_EXCHANGE_OUT,
            "a1",
            Some("g1"),
            Some("FUND_A"),
            Some(Decimal::new(10, 0)),
        )]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }

    #[test]
    fn ungrouped_exchange_leg_is_tracked() {
        let resolution = ExchangePairResolution::from_activities(&[activity(
            "out",
            ACTIVITY_SUBTYPE_EXCHANGE_OUT,
            "a1",
            None,
            Some("FUND_A"),
            Some(Decimal::new(10, 0)),
        )]);

        assert!(resolution.is_ungrouped_exchange("out"));
        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_none());
    }
}
