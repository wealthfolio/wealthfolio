use std::collections::{HashMap, HashSet};

use super::assets_model::{Asset, AssetSpec, InstrumentType};

/// Validated bond identifiers from both current and legacy metadata locations.
/// Conflicting claims are retained so they can block inferred aliases.
#[derive(Default)]
pub(super) struct BondIdentityClaims {
    pub(super) groups: HashSet<String>,
    pub(super) isins: HashSet<String>,
}

impl BondIdentityClaims {
    pub(super) fn new(symbol: Option<&str>, metadata: Option<&serde_json::Value>) -> Self {
        let mut claims = Self::default();
        let values = [
            symbol,
            metadata
                .and_then(|m| m.pointer("/identifiers/isin"))
                .and_then(|v| v.as_str()),
            metadata
                .and_then(|m| m.pointer("/identifiers/cusip"))
                .and_then(|v| v.as_str()),
            metadata
                .and_then(|m| m.pointer("/bond/isin"))
                .and_then(|v| v.as_str()),
        ];
        for value in values.into_iter().flatten() {
            let value = value.trim().to_ascii_uppercase();
            if let Ok(isin) = crate::utils::isin::parse_isin(&value) {
                let group = if matches!(isin.country_code.as_str(), "US" | "CA" | "BM")
                    && crate::utils::cusip::parse_cusip(&isin.nsin).is_ok()
                {
                    isin.nsin
                } else {
                    value.clone()
                };
                claims.groups.insert(group);
                claims.isins.insert(value);
            } else if crate::utils::cusip::parse_cusip(&value).is_ok() {
                claims.groups.insert(value);
            }
        }
        claims
    }

    pub(super) fn unique_group(&self) -> Option<&String> {
        (self.groups.len() == 1 && self.isins.len() <= 1)
            .then(|| self.groups.iter().next())
            .flatten()
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BondAliasResolution {
    /// Explicit or matched asset ID; absent when the input needs a new asset.
    pub asset_id: Option<String>,
    /// Canonicalize a new asset or retain this identifier on a matched asset.
    pub validated_isin: Option<String>,
}

impl BondAliasResolution {
    pub(crate) fn apply_to_spec(&self, spec: &mut AssetSpec) {
        if let Some(id) = &self.asset_id {
            spec.id = Some(id.clone());
        } else if spec.id.is_none() {
            if let Some(isin) = &self.validated_isin {
                spec.instrument_symbol = Some(isin.clone());
                spec.display_code = Some(isin.clone());
            }
        }
    }

    pub(super) fn matched_isin(&self) -> Option<(&str, &str)> {
        Some((self.asset_id.as_deref()?, self.validated_isin.as_deref()?))
    }
}

/// Resolve only unambiguous bond aliases, considering the whole batch before
/// assigning any asset IDs. Exact identities and explicit IDs retain precedence.
/// Return one decision per input; callers choose whether to apply or persist it.
pub(crate) fn resolve_bond_aliases(
    specs: &[AssetSpec],
    existing_assets: &[Asset],
) -> Vec<BondAliasResolution> {
    let stored: Vec<_> = existing_assets
        .iter()
        .filter(|a| a.instrument_type == Some(InstrumentType::Bond))
        .map(|a| {
            (
                a,
                BondIdentityClaims::new(a.instrument_symbol.as_deref(), a.metadata.as_ref()),
            )
        })
        .collect();
    let incoming: Vec<_> = specs
        .iter()
        .map(|spec| {
            if spec.instrument_type == Some(InstrumentType::Bond) {
                BondIdentityClaims::new(spec.instrument_symbol.as_deref(), spec.metadata.as_ref())
            } else {
                BondIdentityClaims::default()
            }
        })
        .collect();
    let mut isins_by_group: HashMap<String, HashSet<String>> = HashMap::new();
    let mut conflicting_groups = HashSet::new();
    for claims in stored.iter().map(|(_, c)| c).chain(&incoming) {
        for group in &claims.groups {
            isins_by_group
                .entry(group.clone())
                .or_default()
                .extend(claims.isins.iter().cloned());
            if claims.unique_group().is_none() {
                conflicting_groups.insert(group.clone());
            }
        }
    }
    specs
        .iter()
        .zip(&incoming)
        .map(|(spec, claims)| {
            if spec.instrument_type != Some(InstrumentType::Bond) {
                return BondAliasResolution::default();
            }
            let mut result = BondAliasResolution {
                asset_id: spec.id.clone(),
                ..Default::default()
            };
            if result.asset_id.is_none() {
                if let Some(key) = spec.instrument_key() {
                    result.asset_id = stored
                        .iter()
                        .find(|(asset, _)| asset.instrument_key.as_deref() == Some(&key))
                        .map(|(asset, _)| asset.id.clone());
                }
            }
            let Some(group) = claims.unique_group() else {
                return result;
            };
            let Some(isins) = isins_by_group.get(group) else {
                return result;
            };
            if conflicting_groups.contains(group) || isins.len() > 1 {
                return result;
            }
            if let Some(id) = &result.asset_id {
                if isins.len() == 1
                    && stored.iter().any(|(asset, stored_claims)| {
                        &asset.id == id && stored_claims.unique_group() == Some(group)
                    })
                {
                    result.validated_isin = isins.iter().next().cloned();
                }
                return result;
            }
            let candidates: Vec<_> = stored
                .iter()
                .filter(|(_, stored_claims)| stored_claims.unique_group() == Some(group))
                .collect();
            match candidates.as_slice() {
                [(asset, _)] => {
                    result.asset_id = Some(asset.id.clone());
                    result.validated_isin = isins.iter().next().cloned();
                }
                [] if isins.len() == 1 => {
                    result.validated_isin = isins.iter().next().cloned();
                }
                _ => {}
            }
            result
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_bond_aliases;
    use crate::assets::{Asset, AssetSpec, InstrumentType};

    fn bond_spec_for(symbol: &str) -> AssetSpec {
        AssetSpec::market_instrument(
            symbol.into(),
            symbol.into(),
            None,
            InstrumentType::Bond,
            "USD".into(),
        )
    }

    fn apply_bond_aliases(specs: &mut [AssetSpec], assets: &[Asset]) {
        let resolutions = resolve_bond_aliases(specs, assets);
        for (spec, resolution) in specs.iter_mut().zip(resolutions) {
            resolution.apply_to_spec(spec);
        }
    }

    #[test]
    fn bond_conflicting_isins_cannot_bridge_through_stored_cusip() {
        let cusip = "135087D27";
        let ca = crate::utils::cusip::cusip_to_isin(cusip, "CA");
        let us = crate::utils::cusip::cusip_to_isin(cusip, "US");
        let stored = Asset {
            id: "stored".into(),
            instrument_type: Some(InstrumentType::Bond),
            instrument_symbol: Some(cusip.into()),
            instrument_key: Some(format!("BOND:{cusip}")),
            ..Default::default()
        };
        for symbols in [[&ca, &us], [&us, &ca]] {
            let mut specs = symbols.map(|symbol| bond_spec_for(symbol));
            apply_bond_aliases(&mut specs, std::slice::from_ref(&stored));
            assert!(specs.iter().all(|spec| spec.id.is_none()));
        }
        let mut exact = vec![bond_spec_for(cusip), bond_spec_for(&ca), bond_spec_for(&us)];
        exact[1].id = Some("explicit".into());
        apply_bond_aliases(&mut exact, &[stored]);
        assert_eq!(exact[0].id.as_deref(), Some("stored"));
        assert_eq!(exact[1].id.as_deref(), Some("explicit"));
        assert!(exact[2].id.is_none());
    }

    #[test]
    fn bond_aliases_use_metadata_and_reject_conflicting_or_duplicate_candidates() {
        let cusip = "135087D27";
        let isin = crate::utils::cusip::cusip_to_isin(cusip, "CA");
        for metadata in [
            serde_json::json!({"bond": {"isin": isin}}),
            serde_json::json!({"identifiers": {"isin": isin}}),
        ] {
            let stored = Asset {
                id: "stored".into(),
                instrument_type: Some(InstrumentType::Bond),
                instrument_symbol: Some("BROKER-ID".into()),
                metadata: Some(metadata),
                ..Default::default()
            };
            let mut specs = vec![bond_spec_for(cusip)];
            apply_bond_aliases(&mut specs, std::slice::from_ref(&stored));
            assert_eq!(specs[0].id.as_deref(), Some("stored"));
            let mut conflict = stored.clone();
            conflict.metadata.as_mut().unwrap()["identifiers"] =
                serde_json::json!({"isin": "US912810TH14"});
            // Keep both contradictory claims even for the identifiers-only fixture.
            conflict.metadata.as_mut().unwrap()["bond"] = serde_json::json!({"isin": isin});
            let mut specs = vec![bond_spec_for(cusip)];
            apply_bond_aliases(&mut specs, &[conflict]);
            assert!(specs[0].id.is_none());
            let duplicate = Asset {
                id: "duplicate".into(),
                ..stored.clone()
            };
            apply_bond_aliases(&mut specs, &[stored, duplicate]);
            assert!(specs[0].id.is_none());
        }
        for symbols in [[cusip, isin.as_str()], [isin.as_str(), cusip]] {
            let mut specs = symbols.map(bond_spec_for);
            apply_bond_aliases(&mut specs, &[]);
            assert_eq!(specs[0].instrument_key(), specs[1].instrument_key());
        }
    }

    #[test]
    fn conflicting_batch_isins_are_not_retained_on_an_existing_cusip() {
        let cusip = "135087D27";
        let stored = Asset {
            id: "stored".into(),
            instrument_type: Some(InstrumentType::Bond),
            instrument_symbol: Some(cusip.into()),
            instrument_key: Some(format!("BOND:{cusip}")),
            ..Default::default()
        };
        let specs = ["US", "CA"].map(|country| {
            let mut spec = bond_spec_for(&crate::utils::cusip::cusip_to_isin(cusip, country));
            spec.id = Some("stored".into());
            spec
        });
        let resolutions = resolve_bond_aliases(&specs, &[stored]);
        assert!(resolutions
            .iter()
            .all(|result| result.validated_isin.is_none()));
    }

    #[test]
    fn bond_aliases_resolve_unique_existing_and_incoming_isins() {
        let cusip = "135087D27";
        let isin = crate::utils::cusip::cusip_to_isin(cusip, "CA");
        let bond = Asset {
            id: "stored-bond".into(),
            instrument_type: Some(InstrumentType::Bond),
            instrument_symbol: Some(isin.clone()),
            instrument_key: Some(format!("BOND:{isin}")),
            quote_ccy: "CAD".into(),
            ..Default::default()
        };
        let make_spec = |symbol: &str| {
            AssetSpec::market_instrument(
                symbol.into(),
                symbol.into(),
                None,
                InstrumentType::Bond,
                "USD".into(),
            )
        };

        let mut existing = vec![make_spec(cusip)];
        apply_bond_aliases(&mut existing, std::slice::from_ref(&bond));
        assert_eq!(existing[0].id.as_deref(), Some("stored-bond"));
        assert_eq!(existing[0].quote_ccy, "USD");

        let mut incoming = vec![make_spec(cusip), make_spec(&isin), make_spec(&isin)];
        apply_bond_aliases(&mut incoming, &[]);
        assert_eq!(incoming[0].instrument_key(), incoming[1].instrument_key());
        assert_eq!(
            incoming[0].instrument_key().as_deref(),
            Some(format!("BOND:{isin}").as_str())
        );

        let other_isin = crate::utils::cusip::cusip_to_isin(cusip, "US");
        let mut ambiguous = vec![make_spec(cusip), make_spec(&isin), make_spec(&other_isin)];
        apply_bond_aliases(&mut ambiguous, &[]);
        assert_eq!(ambiguous[0].instrument_symbol.as_deref(), Some(cusip));

        let conflicting = Asset {
            id: "other-bond".into(),
            instrument_symbol: Some(other_isin),
            instrument_key: None,
            ..bond.clone()
        };
        let mut ambiguous_existing = vec![make_spec(cusip)];
        apply_bond_aliases(&mut ambiguous_existing, &[bond, conflicting]);
        assert_eq!(ambiguous_existing[0].id, None);

        let exact_asset = Asset {
            id: "stored-cusip".into(),
            instrument_type: Some(InstrumentType::Bond),
            instrument_symbol: Some(cusip.into()),
            instrument_key: Some(format!("BOND:{cusip}")),
            ..Default::default()
        };
        let mut exact = vec![make_spec(cusip), make_spec(&isin)];
        apply_bond_aliases(&mut exact, &[exact_asset]);
        assert_eq!(exact[0].id.as_deref(), Some("stored-cusip"));
    }
}
