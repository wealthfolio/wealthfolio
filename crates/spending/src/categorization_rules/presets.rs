//! Rule presets — country-specific JSON bundles of categorization rules that
//! the user can seed into their DB on first run. Files live in
//! `crates/spending/seeds/presets/{country}.json` and are embedded at compile
//! time via `include_str!`.
//!
//! Each preset has:
//!   - a stable `presetId` (e.g. "us", "ca", "gb")
//!   - a `presetVersion` (used by future diff/update flows)
//!   - rules with their own stable `key` so we can identify them across versions
//!   - a `categoryKey` that resolves to a seeded category at import time

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Shape of a `*.json` preset file on disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreset {
    pub preset_id: String,
    pub preset_version: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    pub rules: Vec<PresetRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetRule {
    pub key: String,
    pub name: String,
    pub pattern: String,
    pub match_type: String,
    /// Seeded category key (e.g. "food_groceries"). Resolved to (taxonomy_id, category_id) at import time.
    pub category_key: String,
    #[serde(default)]
    pub priority: i32,
    /// Restricts the rule to one activity type (e.g. "WITHDRAWAL"), so merchant
    /// rules skip refunds and income rules skip spending. Matches any type when omitted.
    #[serde(default)]
    pub activity_type: Option<String>,
}

/// Light-weight summary returned to the UI for picker rendering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePresetSummary {
    pub preset_id: String,
    pub preset_version: String,
    pub name: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub rule_count: usize,
    /// True iff the user already has at least one rule from this preset installed.
    pub installed: bool,
    /// The version of the user's installed copy (NULL if `installed=false`).
    pub installed_version: Option<String>,
}

/// Result returned from `import_preset`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPresetResult {
    pub preset_id: String,
    pub preset_version: String,
    pub added: usize,
    /// Existing unmodified preset rules upgraded to this preset version.
    pub updated: usize,
    /// Already-installed rules (matched by `preset_id` + `preset_rule_key`).
    pub skipped_existing: usize,
    /// Rules whose `categoryKey` could not be resolved to a seeded category.
    pub skipped_unknown_category: usize,
    pub total: usize,
}

/// Result returned from `remove_preset`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePresetResult {
    pub preset_id: String,
    /// Number of preset rules deleted (unmodified rules).
    pub removed: usize,
    /// Number of preset rules detached (user-modified — kept as standalone rules).
    pub kept_modified: usize,
}

/// Compile-embedded preset JSONs. Add new countries by dropping a JSON file
/// in `crates/spending/seeds/presets/` and adding an entry here.
const PRESET_JSONS: &[(&str, &str)] = &[
    ("us", include_str!("../../seeds/presets/us.json")),
    ("ca", include_str!("../../seeds/presets/ca.json")),
    ("gb", include_str!("../../seeds/presets/gb.json")),
    ("es", include_str!("../../seeds/presets/es.json")),
    ("de", include_str!("../../seeds/presets/de.json")),
    ("fr", include_str!("../../seeds/presets/fr.json")),
    ("nl", include_str!("../../seeds/presets/nl.json")),
    ("au", include_str!("../../seeds/presets/au.json")),
    ("nz", include_str!("../../seeds/presets/nz.json")),
    ("se", include_str!("../../seeds/presets/se.json")),
    ("it", include_str!("../../seeds/presets/it.json")),
];

/// Parse all bundled presets. Bad JSON (or schema-mismatched files) is logged
/// and skipped — never panics so a single broken preset can't take down the app.
pub fn load_all_presets() -> Vec<RulePreset> {
    PRESET_JSONS
        .iter()
        .filter_map(
            |(id, json)| match serde_json::from_str::<RulePreset>(json) {
                Ok(p) => Some(p),
                Err(e) => {
                    log::warn!("Failed to parse rule preset '{id}': {e}");
                    None
                }
            },
        )
        .collect()
}

pub fn load_preset(preset_id: &str) -> Option<RulePreset> {
    PRESET_JSONS
        .iter()
        .find(|(id, _)| *id == preset_id)
        .and_then(|(_, json)| serde_json::from_str(json).ok())
}

/// Build a "preset_id" → max(installed_version) lookup so the picker can mark
/// installed presets and surface the version users have.
pub fn installed_versions<'a>(
    rules: impl Iterator<Item = (&'a Option<String>, &'a Option<String>)>,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::<String, String>::new();
    for (preset_id, preset_version) in rules {
        if let (Some(id), Some(version)) = (preset_id, preset_version) {
            // Last-write wins; presets are typically uniform per preset_id so this is fine.
            out.insert(id.clone(), version.clone());
        }
    }
    out
}

/// Set of (preset_id, preset_rule_key) pairs the user already has installed.
pub fn installed_rule_keys<'a>(
    rules: impl Iterator<Item = (&'a Option<String>, &'a Option<String>)>,
) -> HashSet<(String, String)> {
    rules
        .filter_map(|(p, k)| match (p, k) {
            (Some(p), Some(k)) => Some((p.clone(), k.clone())),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categorization_rules::{match_rules, CategorizationRule, RuleMatchType};
    use chrono::Utc;
    use wealthfolio_core::activities::ActivityType;

    fn match_preset(preset_id: &str, notes: &str) -> Option<String> {
        match_preset_as(preset_id, notes, "WITHDRAWAL")
    }

    fn match_preset_as(preset_id: &str, notes: &str, activity_type: &str) -> Option<String> {
        match_installed_presets(&[preset_id], notes, activity_type)
    }

    /// Matches against several presets installed in the given order. On equal
    /// priority the rule installed first wins, as `list` orders rules by
    /// priority, then creation time.
    fn match_installed_presets(
        preset_ids: &[&str],
        notes: &str,
        activity_type: &str,
    ) -> Option<String> {
        let rules = preset_ids
            .iter()
            .flat_map(|preset_id| preset_rules(preset_id))
            .collect::<Vec<_>>();
        match_rules(&rules, notes, activity_type, "account", None)
            .and_then(|matched| matched.rule.category_id.clone())
    }

    fn preset_rules(preset_id: &str) -> Vec<CategorizationRule> {
        let now = Utc::now().naive_utc();
        load_preset(preset_id)
            .expect("preset should load")
            .rules
            .into_iter()
            .map(|rule| CategorizationRule {
                id: rule.key,
                name: rule.name,
                pattern: rule.pattern,
                match_type: RuleMatchType::try_parse(&rule.match_type)
                    .expect("preset match type should be valid"),
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some(rule.category_key),
                activity_type: rule.activity_type,
                amount_op: None,
                amount_value: None,
                amount_value2: None,
                priority: rule.priority,
                is_global: true,
                account_id: None,
                preset_id: Some(preset_id.to_string()),
                preset_rule_key: None,
                preset_version: None,
                preset_modified: false,
                created_at: now,
                updated_at: now,
            })
            .collect()
    }

    fn match_swedish_preset(notes: &str) -> Option<String> {
        match_preset("se", notes)
    }

    #[test]
    fn french_bakeries_do_not_match_electronics_retailer() {
        for notes in ["CB BOULANGERIE DU CENTRE", "CB BOULANGERIE ANGE"] {
            assert_eq!(
                match_preset("fr", notes).as_deref(),
                Some("food_coffee"),
                "{notes}"
            );
        }
        assert_eq!(
            match_preset("fr", "CB BOULANGER").as_deref(),
            Some("shopping_electronics")
        );
    }

    #[test]
    fn french_transaction_descriptors_do_not_match_action_retailer() {
        for (notes, category) in [
            ("TRANSACTION AMAZON", "shopping_online"),
            ("TRANSACTION MCDONALDS", "food_restaurants"),
            ("CB ACTION", "shopping_home"),
        ] {
            assert_eq!(
                match_preset("fr", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
        assert_eq!(match_preset("fr", "TRANSACTION 123"), None);
    }

    #[test]
    fn french_additional_merchants_match_specific_categories() {
        for (notes, category) in [
            ("cb naturalia paris", "groceries"),
            ("CB La Vie Claire", "groceries"),
            ("PRLV HELLOFRESH", "groceries"),
            ("CB HELLO FRESH", "groceries"),
            ("CB QUITOQUE", "groceries"),
            ("CB FLIXBUS", "transport_public"),
            ("CB BLABLACAR BUS", "transport_public"),
            ("CB BLABLACARBUS", "transport_public"),
            ("CB OUIBUS", "transport_public"),
            ("CB BIOGROUP LCD", "health_medical"),
            ("CB CERBALLIANCE", "health_medical"),
        ] {
            assert_eq!(
                match_preset("fr", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn french_additional_merchants_require_complete_names() {
        for notes in [
            "NATURALIANA",
            "LA VIE CLAIREMENT",
            "HELLOFRESHNESS",
            "QUITOQUETTE",
            "FLIXBUSINESS",
            "BLABLACAR BUSINESS",
            "BLABLACAR",
            "OUIBUSINESS",
            "BIOGROUPAGE",
            "CERBALLIANCES",
        ] {
            assert_eq!(match_preset("fr", notes), None, "{notes}");
        }
    }

    #[test]
    fn dutch_merchants_match_specific_categories() {
        for (notes, category) in [
            ("BEA, Betaalpas ALBERT HEIJN 1234,PAS123", "groceries"),
            ("Jumbo Utrecht", "groceries"),
            ("NS GROEP IZ NS REIZIGERS", "transport_public"),
            ("Q-Park Nederland", "transport_parking"),
            ("Eneco Services", "housing_utilities"),
            ("Gemeentelijke belastingen Amsterdam", "housing_utilities"),
            ("Zilveren Kruis Zorgverzekeringen", "health_insurance"),
            ("Ziggo Services BV", "bills_internet"),
            ("Thuisbezorgd.nl", "food_delivery"),
            ("Kosten OranjePakket", "fees_bank"),
            ("Coolblue BV", "shopping_electronics"),
            ("Basic-Fit Nederland", "health_fitness"),
            ("NS-Utrecht Centraal 123 UTRECHT NLD", "transport_public"),
            ("Rabobank Hypotheken", "housing_rent"),
            ("BENU Apotheken", "health_pharmacy"),
            ("AH to go Schiphol", "groceries"),
        ] {
            assert_eq!(
                match_preset("nl", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn dutch_merchants_require_complete_names() {
        for notes in [
            "JUMBOREE",
            "SPARTA ROTTERDAM",
            "TRANSACTION 123",
            "PICNICTAFEL",
            "HUUR FIETS",
            "GAMMASTRALING",
            "Example BV SCHIPHOL RIJK",
        ] {
            assert_eq!(match_preset("nl", notes), None, "{notes}");
        }
    }

    #[test]
    fn german_merchants_match_specific_categories() {
        for (notes, category) in [
            ("VISA REWE Markt GmbH", "groceries"),
            ("NETTO MARKEN-DISCOUNT", "groceries"),
            ("PENNY.Markt GmbH", "groceries"),
            ("DB Vertrieb GmbH", "transport_public"),
            ("Stadtwerke Muenster GmbH", "housing_utilities"),
            (
                "ARD ZDF Deutschlandradio Beitragsservice",
                "housing_utilities",
            ),
            ("Techniker Krankenkasse", "health_insurance"),
            ("Telekom Deutschland GmbH", "bills_phone"),
            ("Lieferando.de", "food_delivery"),
            ("Entgelt fuer Kontofuehrung", "fees_bank"),
            ("dm-drogerie markt", "health_pharmacy"),
            ("Baeckerei Mueller", "food_coffee"),
            ("Vodafone Kabel Deutschland GmbH", "bills_internet"),
            ("EnBW mobility+ AG", "transport_gas"),
            ("Burger King Flughafen Muenchen", "food_restaurants"),
            ("H&M Flughafen Frankfurt", "shopping_clothing"),
            ("Entgelt fuer Girocard", "fees_bank"),
        ] {
            assert_eq!(
                match_preset("de", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn german_merchants_require_complete_names() {
        for notes in [
            "NETTOBETRAG",
            "Netto 123,45 EUR",
            "PENNYWISE",
            "OTTO MUELLER",
            "DEPOT WERTPAPIERE",
            "ROLLER LEIHE",
            "REWEB DESIGN",
            "Kiosk Flughafen Hamburg",
            "Entgelt fuer Stellplatz",
        ] {
            assert_eq!(match_preset("de", notes), None, "{notes}");
        }
    }

    #[test]
    fn italian_merchants_match_specific_categories() {
        for (notes, category) in [
            ("PAGAMENTO POS ESSELUNGA MILANO", "groceries"),
            ("Conad — PAGAMENTO CARTA 1234", "groceries"),
            ("LIDL ITALIA 0342", "groceries"),
            ("ENI STATION A1 SUD", "transport_gas"),
            ("ENI PLENITUDE — BOLLETTA LUCE", "housing_utilities"),
            ("ADDEBITO SDD ENEL ENERGIA", "housing_utilities"),
            ("ILIAD ITALIA RICARICA", "bills_phone"),
            ("ADDEBITO SDD TIM S.P.A.", "bills_phone"),
            ("FASTWEB SPA FATTURA", "bills_internet"),
            ("NETFLIX.COM", "entertainment_streaming"),
            ("AMAZON PRIME VIDEO", "entertainment_streaming"),
            ("AMAZON EU SARL", "shopping_online"),
            ("GLOVO MILANO", "food_delivery"),
            ("UBER EATS", "food_delivery"),
            ("UBER TRIP", "transport_rideshare"),
            ("TRENITALIA FRECCIAROSSA", "transport_public"),
            ("ITALOTRENO MILANO", "transport_public"),
            ("AUTOSTRADE PER L'ITALIA", "transport_parking"),
            ("TELEPASS SPA", "transport_parking"),
            ("FARMACIA COMUNALE 3", "health_pharmacy"),
            ("BAR ROMA", "food_coffee"),
            ("PIZZERIA DA MARIO", "food_restaurants"),
            ("IKEA ITALIA RETAIL", "shopping_home"),
            ("MEDIAWORLD ONLINE", "shopping_electronics"),
            ("ZALANDO SE", "shopping_clothing"),
            ("DECATHLON ITALIA", "entertainment_sports"),
            ("RYANAIR DAC", "travel"),
            ("BOOKING.COM HOTEL", "travel"),
            ("AFFITTO OTTOBRE", "housing_rent"),
            ("RATA MUTUO 10/2026", "housing_rent"),
            ("PAGOPA COMUNE DI MILANO TARI", "fees"),
        ] {
            assert_eq!(
                match_preset("it", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn italian_sky_wifi_outranks_streaming() {
        for (notes, category) in [
            ("ADDEBITO SDD SKY WIFI", "bills_internet"),
            ("SkyWifi FATTURA", "bills_internet"),
            ("ADDEBITO SDD SKY ITALIA", "entertainment_streaming"),
            ("NETFLIX.COM", "entertainment_streaming"),
            ("FASTWEB MOBILE RICARICA", "bills_phone"),
            ("FASTWEB SPA FATTURA", "bills_internet"),
        ] {
            assert_eq!(
                match_preset("it", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn italian_eni_gas_outranks_fuel() {
        for (notes, category) in [
            ("ADDEBITO SDD ENI GAS E LUCE", "housing_utilities"),
            ("Eni Gas FATTURA", "housing_utilities"),
            ("ENI PLENITUDE BOLLETTA LUCE", "housing_utilities"),
            ("ENI STATION A1 SUD", "transport_gas"),
            ("ENI GASOLIO", "transport_gas"),
        ] {
            assert_eq!(
                match_preset("it", notes).as_deref(),
                Some(category),
                "{notes}"
            );
        }
    }

    #[test]
    fn italian_rules_respect_activity_types() {
        for (notes, activity_type, category) in [
            ("AGENZIA ENTRATE — PAGAMENTO F24", "TAX", "fees"),
            ("IMPOSTA DI BOLLO E/C", "TAX", "fees"),
            ("CANONE MENSILE CONTO", "FEE", "fees_bank"),
            ("INTERESSI DEBITORI", "FEE", "fees_interest"),
            ("ACME SRL — STIPENDIO OTTOBRE", "DEPOSIT", "income_salary"),
            ("INPS PENSIONE OTTOBRE", "DEPOSIT", "income_other"),
            ("RIMBORSO IRPEF 730", "DEPOSIT", "income_tax_refund"),
            ("AMAZON — RIMBORSO ORDINE", "DEPOSIT", "income_refunds"),
            ("RIMBORSO SKY WIFI", "DEPOSIT", "income_refunds"),
            ("RIMBORSO ENI GAS E LUCE", "DEPOSIT", "income_refunds"),
            ("INTERESSI CREDITORI", "INTEREST", "income_interest"),
        ] {
            assert_eq!(
                match_preset_as("it", notes, activity_type).as_deref(),
                Some(category),
                "{notes} ({activity_type})"
            );
        }
        // Merchant rules leave money coming in alone, and income rules never
        // file spending.
        assert_eq!(match_preset_as("it", "CONAD", "DEPOSIT"), None);
        for notes in ["SKY WIFI", "SKYWIFI", "ENI GAS E LUCE"] {
            assert_eq!(match_preset_as("it", notes, "DEPOSIT"), None, "{notes}");
        }
        assert_eq!(match_preset("it", "ACME SRL — STIPENDIO OTTOBRE"), None);
    }

    #[test]
    fn italian_merchants_outrank_us_personal_care_when_both_presets_are_installed() {
        // Most Italian company names end in "SpA", and the US personal care rule
        // matches `spa\b` (and `ulta\b`) on any activity type.
        for installed in [["us", "it"], ["it", "us"]] {
            for (notes, category) in [
                ("ESSELUNGA SPA MILANO", "groceries"),
                ("TELEPASS SPA", "transport_parking"),
                ("TRENITALIA SPA", "transport_public"),
                ("AUTOGRILL SPA", "food_restaurants"),
                ("BAR CENTRALE SPA", "food_coffee"),
                ("VIRGIN ACTIVE ITALIA SPA", "health_fitness"),
                ("PAGAMENTO MULTA", "fees"),
                // US spas and salons still file under personal care.
                ("SERENITY DAY SPA", "personal"),
                ("BLISS SPA NYC", "personal"),
                ("GREAT CLIPS #123", "personal"),
            ] {
                assert_eq!(
                    match_installed_presets(&installed, notes, "WITHDRAWAL").as_deref(),
                    Some(category),
                    "{notes} with {installed:?} installed"
                );
            }
        }
    }

    #[test]
    fn italian_merchants_require_complete_names() {
        for notes in [
            "BONIFICO A MARIO ROSSI",
            "BONIFICO A DOTT. MARIO ROSSI",
            "BONIFICO A TIM ROSSI",
            "BONIFICO A ITALO BIANCHI",
            "GIROCONTO RISPARMI",
            "ENIGMISTICA",
            "SPOKEN ENGLISH SCHOOL SRL",
        ] {
            assert_eq!(match_preset("it", notes), None, "{notes}");
        }
    }

    #[test]
    fn bundled_presets_have_unique_keys_and_valid_regexes() {
        for preset_id in [
            "us", "ca", "gb", "es", "de", "fr", "nl", "au", "nz", "se", "it",
        ] {
            let preset = load_preset(preset_id).expect("preset should load");
            assert_eq!(preset.preset_id, preset_id);
            assert!(!preset.rules.is_empty(), "preset {preset_id} has no rules");

            let mut keys = HashSet::new();
            for rule in &preset.rules {
                assert!(
                    keys.insert(rule.key.as_str()),
                    "duplicate preset rule key {} in {}",
                    rule.key,
                    preset.preset_id
                );
                assert!(
                    !rule.category_key.trim().is_empty(),
                    "rule {} has an empty categoryKey",
                    rule.key
                );
                assert!(
                    RuleMatchType::try_parse(&rule.match_type).is_some(),
                    "unknown matchType {} in preset {} rule {}",
                    rule.match_type,
                    preset.preset_id,
                    rule.key
                );
                if let Some(activity_type) = &rule.activity_type {
                    assert!(
                        activity_type.parse::<ActivityType>().is_ok(),
                        "unknown activityType {} in preset {} rule {}",
                        activity_type,
                        preset.preset_id,
                        rule.key
                    );
                }
                if rule.match_type == "regex" {
                    crate::categorization_rules::compile_regex_pattern(&rule.pattern)
                        .unwrap_or_else(|err| {
                            panic!(
                                "invalid regex in preset {} rule {}: {}",
                                preset.preset_id, rule.key, err
                            )
                        });
                }
            }
        }
    }

    #[test]
    fn swedish_preset_prioritizes_specific_categories() {
        assert_eq!(
            match_swedish_preset("STUDENTKÅRAVGIFT"),
            Some("education".to_string())
        );
        assert_eq!(
            match_swedish_preset("UPPSALA STUDENTKÅR"),
            Some("food_restaurants".to_string())
        );
        assert_eq!(
            match_swedish_preset("TELIA MÅNADSAVGIFT"),
            Some("bills_phone".to_string())
        );
        assert_eq!(
            match_swedish_preset("MÅNADSAVGIFT"),
            Some("fees_bank".to_string())
        );
        assert_eq!(
            match_swedish_preset("TACO BAR"),
            Some("food_restaurants".to_string())
        );
        assert_eq!(
            match_swedish_preset("LOKALA BAR"),
            Some("food_alcohol".to_string())
        );
        assert_eq!(
            match_swedish_preset("UPPSALA KOMMUN VATTEN OCH AVLOPP"),
            Some("housing_utilities".to_string())
        );
        assert_eq!(
            match_swedish_preset("UPPSALA KOMMUN"),
            Some("fees".to_string())
        );
    }

    #[test]
    fn swedish_transit_requires_a_transit_descriptor() {
        assert_eq!(match_swedish_preset("REGION UPPSALA"), None);
        assert_eq!(
            match_swedish_preset("UL, REGION UPPSALA"),
            Some("transport_public".to_string())
        );
    }
}
