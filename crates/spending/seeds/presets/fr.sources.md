# French preset sources

The additions in preset version `2026-10.1` were checked on 2026-10-08. The
category mappings below are inferred from the merchants' own descriptions of
their services. They are not a bank-validated corpus of statement labels.

| Rule key                      | Category           | Evidence                                                                                                                                                                                                                 |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fr.groceries.organic_chains` | `groceries`        | [Naturalia](https://www.naturalia.fr/courses-bio-en-ligne) and [La Vie Claire](https://www.lavieclaire.com/) sell groceries.                                                                                             |
| `fr.groceries.meal_kits`      | `groceries`        | [HelloFresh](https://www.hellofresh.fr/about/nosvaleursdurables) and [Quitoque](https://www.quitoque.fr/) deliver ingredients to cook at home.                                                                           |
| `fr.public_transit.coaches`   | `transport_public` | [FlixBus](https://www.flixbus.fr/bus/france) and [BlaBlaCar Bus](https://www.blablacar.fr/bus) operate coach services. [Ouibus is a former name of BlaBlaCar Bus](https://www.blablacar.fr/l/ouibus-devient-blablabus/). |
| `fr.medical.laboratories`     | `health_medical`   | [Biogroup](https://biogroup.fr/) and [Cerballiance](https://www.cerballiance.fr/fr) provide medical laboratory services.                                                                                                 |

Public French categorization examples were used to discover candidates:

- [Rapport-SG-OpenClaw](https://github.com/lbarreteau/Rapport-SG-OpenClaw/blob/b5d3214343581c6578a054a675828f3ce632232e/sg_report/categorize.py)
  lists Naturalia, La Vie Claire, HelloFresh, Quitoque, Biogroup and
  Cerballiance.
- [Dashboard-Perso](https://github.com/Augustin1305/Dashboard-Perso/blob/360437087d430cfcb2731937597eae70e143e669/config/category_rules.yaml)
  lists Naturalia and FlixBus.

The regexes are independently written and use complete merchant names. Bare
`BLABLACAR` is excluded because the [platform](https://www.blablacar.fr/) sells
carpool, bus and train trips. Payment intermediaries and bank names alone do not
identify a spending category and were not added.

Regression tests use synthetic descriptions with card/direct-debit prefixes,
case variations and longer words that must not match. They exercise the
production matcher and its compiled regex size limit; they do not establish
coverage across French banks.
