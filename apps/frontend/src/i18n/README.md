# Internationalization (i18n)

Wealthfolio uses [i18next](https://www.i18next.com/) +
[react-i18next](https://react.i18next.com/).

## Layout

```
src/i18n/
  i18n.ts        # runtime init (lazy-loads locale JSON, no browser auto-detect)
  locales.ts     # SUPPORTED_LOCALES, NAMESPACES, DEFAULT_LOCALE  (single source of truth)
  locales/
    en/<ns>.json # source language (canonical keys)
    fr/<ns>.json
    de/<ns>.json
```

Namespaces (one JSON file each): `common`, `dashboard`, `holdings`, `activity`,
`performance`, `account`, `settings`, `goals`, `income`.

## Using translations in code

Keys are referenced with the fully-qualified `namespace:key` form so the default
hook works everywhere:

```tsx
import { useTranslation } from "react-i18next";

function Example() {
  const { t } = useTranslation();
  return <h1>{t("settings:title")}</h1>;
}
```

Interpolation uses i18next's `{{var}}` syntax:
`t("common:activities_count", { count })`.

## Language selection

Language is an **explicit, stored user setting** (`Settings.language`), not
browser-detected. It is chosen during onboarding and in Settings → General, and
persisted through the normal settings pipeline (stored per-device, like `theme`
and `baseCurrency` — device-sync is not enabled for it). The settings provider
applies it via `i18n.changeLanguage()` on load and on change. Default is `en`;
missing keys in fr/de fall back to `en`.

## Maintenance (i18next-cli)

Config: `apps/frontend/i18next.config.ts`.

```bash
pnpm --filter frontend i18n:status   # coverage per namespace/locale
pnpm --filter frontend i18n:extract  # sync JSON with t() keys used in code
pnpm --filter frontend i18n:lint     # find remaining hardcoded strings
pnpm --filter frontend i18n:types    # generate typed keys
```

`extract` never removes unreferenced keys (`removeUnusedKeys: false`) so
community-contributed translations are preserved.

## Adding a language

1. Add a `locales/<code>/` folder with the namespace JSON files.
2. Add an entry to `SUPPORTED_LOCALES` in `locales.ts` and `locales` in
   `i18next.config.ts`.
3. Add the code to `SUPPORTED_UI_LANGUAGES` in
   `crates/core/src/settings/settings_service.rs` so the backend persists it.
4. Add the locale's `ui.json` to `src/addons/iframe/addon-sandbox-i18n.ts`.
5. Check `new Intl.PluralRules("<code>").resolvedOptions().pluralCategories`. A
   locale with a `many` category (fr, es, pt, it) needs a `_many` form for every
   plural stem — i18next echoes the raw key back when the form is missing.
6. If the language has its own number/date conventions, add a formatting region:
   `FORMATTING_REGIONS` + `FORMATTING_REGION_LOCALES` in
   `packages/ui/src/lib/formatting.ts`, `SUPPORTED_FORMATTING_REGIONS` in
   `settings_service.rs`, the two region pickers, and a
   `settings:formattingRegion.options.*` label in every locale.

## Provenance of current translations

- **English keys + French**: adapted from PR #416 (namespaced structure, 100%
  FR), with single-brace `{var}` interpolation converted to i18next `{{var}}`.
- **German**: value-joined from PR #845 by matching English source text onto the
  English keys (~65% auto-coverage); the remainder falls back to English and is
  filled by AI draft + community review. See `scripts/i18n-remap.mjs`.
- **Korean**: AI-drafted, full-coverage translation of all namespaces against
  the English source keys, using standard Korean financial/investment
  terminology; intended for community review.
- **Italian**: community contribution (PR #1588), full coverage of all
  namespaces, reviewed against the terminology already used by the French and
  Spanish sets (`Posizioni`, `Classe di attività`, `Costo di carico`) and
  Italian sentence case; `_many` plural forms are required because Italian has a
  CLDR `many` category. Intended for continued community review.
- **Portuguese (pt-BR)**: community contribution (PR #1533), full coverage of
  all namespaces in Brazilian Portuguese. Terminology follows Brazilian market
  usage — `Posições`, `Carteira`, `Custo de aquisição`, `Rentabilidade`, `L/P`,
  `Valores mobiliários`, `Aportes`, `Desdobramento de ações` — and Brazilian
  punctuation (`"..."`, never `«...»`). `_many` plural forms are required
  because Portuguese has a CLDR `many` category. Intended for continued
  community review.
