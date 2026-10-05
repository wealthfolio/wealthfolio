use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use rust_decimal::Decimal;

use super::{
    activities_constants::is_cash_symbol, Activity, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT,
};

fn transfer_pair_tolerance() -> Decimal {
    Decimal::new(1, 6)
}

#[derive(Debug, Clone)]
pub struct TransferPair {
    pub group_id: String,
    pub transfer_in: Activity,
    pub transfer_out: Activity,
}

impl TransferPair {
    pub fn counterparty_account_id(&self, activity_id: &str) -> Option<&str> {
        if activity_id == self.transfer_in.id {
            Some(self.transfer_out.account_id.as_str())
        } else if activity_id == self.transfer_out.id {
            Some(self.transfer_in.account_id.as_str())
        } else {
            None
        }
    }

    pub fn both_accounts_in_scope(&self, scope_account_ids: &HashSet<String>) -> bool {
        scope_account_ids.contains(&self.transfer_in.account_id)
            && scope_account_ids.contains(&self.transfer_out.account_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransferGroup {
    pub group_id: String,
    pub activity_ids: Vec<String>,
    pub reason: String,
}

/// Where a transfer stands with its other side, from the pairs it resolves.
/// The Health Center and the unlinked-transfer scan read it, each picking the
/// states it cares about. Spending's link badge and the internal-pair lookup
/// behind the transfer editor still decide on their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferLinkState {
    /// Paired with its other side.
    Linked,
    /// Paired, but a leg is still marked as moving money into or out of the
    /// portfolio, which contradicts the pair.
    LinkedButMarkedExternal,
    /// Not paired, and marked as moving money into or out of the portfolio.
    /// Imports mark transfers this way unless the source says they are
    /// internal, and unlinking does too, so one may still have a side to link.
    External,
    /// Not paired and not marked external: its other side is missing.
    NeedsCounterpart,
    /// In a link group that does not resolve to one pair, such as a group left
    /// with one leg after the other was deleted. Not marked external.
    BrokenLink,
}

impl TransferLinkState {
    /// Whether the transfer has no linked other side.
    pub fn is_unlinked(self) -> bool {
        matches!(
            self,
            Self::NeedsCounterpart | Self::BrokenLink | Self::External
        )
    }
}

#[derive(Debug, Clone, Default)]
pub struct TransferPairResolution {
    pairs: Vec<TransferPair>,
    invalid_groups: Vec<InvalidTransferGroup>,
    pair_by_activity_id: HashMap<String, usize>,
    invalid_group_by_activity_id: HashMap<String, usize>,
    ungrouped_transfer_ids: HashSet<String>,
}

impl TransferPairResolution {
    pub fn from_activities(activities: &[Activity]) -> Self {
        let mut grouped: HashMap<String, Vec<Activity>> = HashMap::new();
        let mut ungrouped_transfer_ids = HashSet::new();

        for activity in activities {
            if !is_transfer(activity) {
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
                    ungrouped_transfer_ids.insert(activity.id.clone());
                }
            }
        }

        let mut pairs = Vec::new();
        let mut invalid_groups = Vec::new();

        for (group_id, group_activities) in grouped {
            match build_transfer_pair(&group_id, &group_activities) {
                Ok(pair) => pairs.push(pair),
                Err(reason) => invalid_groups.push(InvalidTransferGroup {
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
            pair_by_activity_id.insert(pair.transfer_in.id.clone(), index);
            pair_by_activity_id.insert(pair.transfer_out.id.clone(), index);
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
            ungrouped_transfer_ids,
        }
    }

    pub fn pairs(&self) -> &[TransferPair] {
        &self.pairs
    }

    pub fn invalid_groups(&self) -> &[InvalidTransferGroup] {
        &self.invalid_groups
    }

    pub fn pair_for_activity(&self, activity_id: &str) -> Option<&TransferPair> {
        self.pair_by_activity_id
            .get(activity_id)
            .and_then(|index| self.pairs.get(*index))
    }

    pub fn invalid_group_for_activity(&self, activity_id: &str) -> Option<&InvalidTransferGroup> {
        self.invalid_group_by_activity_id
            .get(activity_id)
            .and_then(|index| self.invalid_groups.get(*index))
    }

    pub fn is_ungrouped_transfer(&self, activity_id: &str) -> bool {
        self.ungrouped_transfer_ids.contains(activity_id)
    }

    /// The link state of `activity`, one of the activities the resolution was
    /// built from; `None` when it is not a transfer.
    pub fn link_state(&self, activity: &Activity) -> Option<TransferLinkState> {
        if !is_transfer(activity) {
            return None;
        }
        let external = activity.is_external_transfer();
        Some(if self.pair_for_activity(&activity.id).is_some() {
            if external {
                TransferLinkState::LinkedButMarkedExternal
            } else {
                TransferLinkState::Linked
            }
        } else if external {
            TransferLinkState::External
        } else if self.invalid_group_for_activity(&activity.id).is_some() {
            TransferLinkState::BrokenLink
        } else {
            TransferLinkState::NeedsCounterpart
        })
    }
}

fn is_transfer(activity: &Activity) -> bool {
    matches!(
        activity.effective_type(),
        ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
    )
}

fn non_cash_transfer_asset_key(activity: &Activity) -> Option<String> {
    activity
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|asset_id| !asset_id.is_empty() && !is_cash_symbol(asset_id))
        .map(str::to_uppercase)
}

fn is_cash_transfer(activity: &Activity) -> bool {
    non_cash_transfer_asset_key(activity).is_none()
}

fn has_positive_cash_amount(activity: &Activity) -> bool {
    activity.amount.is_some_and(|amount| !amount.is_zero())
}

pub fn is_same_account_cash_fx_conversion(transfer_in: &Activity, transfer_out: &Activity) -> bool {
    transfer_in.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
        && transfer_out.effective_type() == ACTIVITY_TYPE_TRANSFER_OUT
        && transfer_in.account_id == transfer_out.account_id
        && is_cash_transfer(transfer_in)
        && is_cash_transfer(transfer_out)
        && has_positive_cash_amount(transfer_in)
        && has_positive_cash_amount(transfer_out)
        && !transfer_in
            .currency
            .trim()
            .eq_ignore_ascii_case(transfer_out.currency.trim())
}

fn has_imported_fx_pair_metadata(
    activity: &Activity,
    source_currency: &str,
    destination_currency: &str,
    source_amount: Decimal,
    destination_amount: Decimal,
) -> bool {
    let Some(metadata) = activity.metadata.as_ref() else {
        return false;
    };
    if metadata
        .pointer("/flow/is_external")
        .and_then(serde_json::Value::as_bool)
        != Some(false)
    {
        return false;
    }

    let Some(fx) = metadata.get("fx") else {
        return false;
    };
    let metadata_amount_matches = |key: &str, expected: Decimal| {
        fx.get(key)
            .and_then(serde_json::Value::as_str)
            .and_then(|value| Decimal::from_str(value).ok())
            .is_some_and(|value| value == expected)
    };

    fx.get("rateSource").and_then(serde_json::Value::as_str) == Some("implied_from_import")
        && fx
            .get("sourceCurrency")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|currency| currency.eq_ignore_ascii_case(source_currency))
        && fx
            .get("destinationCurrency")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|currency| currency.eq_ignore_ascii_case(destination_currency))
        && metadata_amount_matches("sourceAmount", source_amount)
        && metadata_amount_matches("destinationAmount", destination_amount)
}

/// Returns true only for a complete same-account cash FX pair carrying the
/// internal-flow metadata written by the import linker. Structural pairing
/// alone is deliberately insufficient for contribution-neutral accounting.
pub fn is_contribution_neutral_same_account_cash_fx_conversion(
    transfer_in: &Activity,
    transfer_out: &Activity,
) -> bool {
    if !is_same_account_cash_fx_conversion(transfer_in, transfer_out) {
        return false;
    }

    let Some(in_group_id) = transfer_in
        .source_group_id
        .as_deref()
        .map(str::trim)
        .filter(|group_id| !group_id.is_empty())
    else {
        return false;
    };
    let Some(out_group_id) = transfer_out
        .source_group_id
        .as_deref()
        .map(str::trim)
        .filter(|group_id| !group_id.is_empty())
    else {
        return false;
    };
    if in_group_id != out_group_id {
        return false;
    }

    let Some(source_amount) = transfer_out.amount.map(|amount| amount.abs()) else {
        return false;
    };
    let Some(destination_amount) = transfer_in.amount.map(|amount| amount.abs()) else {
        return false;
    };

    [transfer_in, transfer_out].iter().all(|activity| {
        has_imported_fx_pair_metadata(
            activity,
            &transfer_out.currency,
            &transfer_in.currency,
            source_amount,
            destination_amount,
        )
    })
}

fn build_transfer_pair(group_id: &str, activities: &[Activity]) -> Result<TransferPair, String> {
    if activities.len() != 2 {
        return Err(format!(
            "expected exactly two transfer legs, found {}",
            activities.len()
        ));
    }

    let transfer_in: Vec<_> = activities
        .iter()
        .filter(|activity| activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN)
        .collect();
    let transfer_out: Vec<_> = activities
        .iter()
        .filter(|activity| activity.effective_type() == ACTIVITY_TYPE_TRANSFER_OUT)
        .collect();

    if transfer_in.len() != 1 || transfer_out.len() != 1 {
        return Err(format!(
            "expected one TRANSFER_IN and one TRANSFER_OUT, found {} in and {} out",
            transfer_in.len(),
            transfer_out.len()
        ));
    }

    let transfer_in = transfer_in[0];
    let transfer_out = transfer_out[0];

    if transfer_in.account_id == transfer_out.account_id
        && !is_same_account_cash_fx_conversion(transfer_in, transfer_out)
    {
        return Err(
            "same-account transfer legs must be cash FX conversions with different currencies"
                .to_string(),
        );
    }

    validate_asset_shape(transfer_in, transfer_out)?;

    Ok(TransferPair {
        group_id: group_id.to_string(),
        transfer_in: transfer_in.clone(),
        transfer_out: transfer_out.clone(),
    })
}

fn validate_asset_shape(transfer_in: &Activity, transfer_out: &Activity) -> Result<(), String> {
    let in_asset = non_cash_transfer_asset_key(transfer_in);
    let out_asset = non_cash_transfer_asset_key(transfer_out);
    if in_asset.is_none() && out_asset.is_none() {
        return Ok(());
    }

    if in_asset != out_asset {
        return Err("security transfer legs use different assets".to_string());
    }

    match (transfer_in.quantity, transfer_out.quantity) {
        (Some(in_qty), Some(out_qty))
            if (in_qty.abs() - out_qty.abs()).abs() <= transfer_pair_tolerance() =>
        {
            Ok(())
        }
        (Some(_), Some(_)) => Err("security transfer legs use different quantities".to_string()),
        _ => Err("security transfer legs must both include quantity".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn activity(
        id: &str,
        activity_type: &str,
        account_id: &str,
        group_id: Option<&str>,
        currency: &str,
    ) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: super::super::ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::ONE),
            fee: None,
            tax: None,
            currency: currency.to_string(),
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

    fn marked_external(mut activity: Activity) -> Activity {
        activity.metadata = Some(serde_json::json!({ "flow": { "is_external": true } }));
        activity
    }

    #[test]
    fn link_state_covers_every_case() {
        let activities = [
            activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD"),
            activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a2", Some("g1"), "USD"),
            marked_external(activity(
                "ext-out",
                ACTIVITY_TYPE_TRANSFER_OUT,
                "a1",
                Some("g2"),
                "USD",
            )),
            activity("ext-in", ACTIVITY_TYPE_TRANSFER_IN, "a2", Some("g2"), "USD"),
            marked_external(activity(
                "outside",
                ACTIVITY_TYPE_TRANSFER_IN,
                "a1",
                None,
                "USD",
            )),
            activity("lonely", ACTIVITY_TYPE_TRANSFER_OUT, "a1", None, "USD"),
            activity("orphan", ACTIVITY_TYPE_TRANSFER_IN, "a2", Some("g3"), "USD"),
            marked_external(activity(
                "orphan-ext",
                ACTIVITY_TYPE_TRANSFER_IN,
                "a2",
                Some("g4"),
                "USD",
            )),
            activity("deposit", "DEPOSIT", "a1", None, "USD"),
        ];
        let resolution = TransferPairResolution::from_activities(&activities);
        let states: Vec<_> = activities
            .iter()
            .map(|activity| resolution.link_state(activity))
            .collect();
        assert_eq!(
            states,
            vec![
                Some(TransferLinkState::Linked),
                Some(TransferLinkState::Linked),
                Some(TransferLinkState::LinkedButMarkedExternal),
                Some(TransferLinkState::Linked),
                Some(TransferLinkState::External),
                Some(TransferLinkState::NeedsCounterpart),
                Some(TransferLinkState::BrokenLink),
                Some(TransferLinkState::External),
                None,
            ]
        );
        let unlinked: Vec<_> = states
            .iter()
            .flatten()
            .map(|state| state.is_unlinked())
            .collect();
        assert_eq!(
            unlinked,
            vec![false, false, false, false, true, true, true, true]
        );
    }

    #[test]
    fn same_group_opposite_transfers_in_different_accounts_is_valid_pair() {
        let resolution = TransferPairResolution::from_activities(&[
            activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD"),
            activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a2", Some("g1"), "USD"),
        ]);

        assert_eq!(resolution.pairs().len(), 1);
        assert_eq!(
            resolution
                .pair_for_activity("out")
                .and_then(|pair| pair.counterparty_account_id("out")),
            Some("a2")
        );
    }

    #[test]
    fn same_account_cash_fx_group_is_valid_pair() {
        let resolution = TransferPairResolution::from_activities(&[
            activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD"),
            activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "CAD"),
        ]);

        assert_eq!(resolution.pairs().len(), 1);
        assert!(resolution.invalid_group_for_activity("out").is_none());
        assert_eq!(
            resolution
                .pair_for_activity("out")
                .and_then(|pair| pair.counterparty_account_id("out")),
            Some("a1")
        );
    }

    #[test]
    fn imported_same_account_cash_fx_pair_is_contribution_neutral() {
        let mut transfer_out = activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD");
        transfer_out.amount = Some(Decimal::new(2433, 2));
        let mut transfer_in = activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "CAD");
        transfer_in.amount = Some(Decimal::new(3293, 2));
        let metadata = serde_json::json!({
            "flow": { "is_external": false },
            "fx": {
                "sourceCurrency": "USD",
                "destinationCurrency": "CAD",
                "sourceAmount": "24.33",
                "destinationAmount": "32.93",
                "impliedRate": "1.3534730785039046444718454583",
                "rateSource": "implied_from_import"
            }
        });
        transfer_out.metadata = Some(metadata.clone());
        transfer_in.metadata = Some(metadata);

        assert!(is_contribution_neutral_same_account_cash_fx_conversion(
            &transfer_in,
            &transfer_out
        ));
    }

    #[test]
    fn structural_same_account_cash_fx_pair_without_import_metadata_is_not_neutral() {
        let transfer_out = activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD");
        let transfer_in = activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "CAD");

        assert!(is_same_account_cash_fx_conversion(
            &transfer_in,
            &transfer_out
        ));
        assert!(!is_contribution_neutral_same_account_cash_fx_conversion(
            &transfer_in,
            &transfer_out
        ));
    }

    #[test]
    fn same_account_cash_fx_group_with_cash_placeholder_assets_is_valid_pair() {
        let mut transfer_out = activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD");
        transfer_out.asset_id = Some("$CASH-USD".to_string());
        let mut transfer_in = activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "CAD");
        transfer_in.asset_id = Some("CASH:CAD".to_string());

        let resolution = TransferPairResolution::from_activities(&[transfer_out, transfer_in]);

        assert_eq!(resolution.pairs().len(), 1);
        assert!(resolution.invalid_group_for_activity("out").is_none());
    }

    #[test]
    fn same_account_same_currency_cash_group_is_invalid_not_pair() {
        let resolution = TransferPairResolution::from_activities(&[
            activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD"),
            activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "USD"),
        ]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }

    #[test]
    fn same_account_security_group_is_invalid_not_pair() {
        let mut transfer_out = activity("out", ACTIVITY_TYPE_TRANSFER_OUT, "a1", Some("g1"), "USD");
        transfer_out.asset_id = Some("AAPL".to_string());
        transfer_out.quantity = Some(Decimal::ONE);
        let mut transfer_in = activity("in", ACTIVITY_TYPE_TRANSFER_IN, "a1", Some("g1"), "CAD");
        transfer_in.asset_id = Some("AAPL".to_string());
        transfer_in.quantity = Some(Decimal::ONE);

        let resolution = TransferPairResolution::from_activities(&[transfer_out, transfer_in]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }

    #[test]
    fn one_leg_group_is_invalid_not_pair() {
        let resolution = TransferPairResolution::from_activities(&[activity(
            "out",
            ACTIVITY_TYPE_TRANSFER_OUT,
            "a1",
            Some("g1"),
            "USD",
        )]);

        assert!(resolution.pair_for_activity("out").is_none());
        assert!(resolution.invalid_group_for_activity("out").is_some());
    }
}
