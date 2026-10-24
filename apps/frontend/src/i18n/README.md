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

A locale code is public API — addons read it, and it is persisted per device —
so pick it deliberately before shipping. Five places have to agree:

1. `locales/<code>/` — one JSON file per namespace, complete parity with `en`.
2. `SUPPORTED_LOCALES` in `locales.ts`.
3. `locales` in `i18next.config.ts`.
4. `SUPPORTED_UI_LANGUAGES` in `crates/core/src/settings/settings_service.rs`,
   plus any alias normalization (`fr-CA` -> `fr`).
5. `addon-sandbox-i18n.ts`, if the locale should reach addon iframes.

### Right-to-left languages

Direction follows the UI language and nothing else: `i18n/direction.tsx` sets
`<html dir>` from `i18n.dir(language)`, and `AppDirectionProvider` (around
`App`) hands the same value to Base UI, so keyboard navigation, popup sides,
sliders and the data grid mirror with it. The formatting region never changes
direction. Add-on iframes receive it with the localization snapshot.

Styles use logical classes (`ms-*`, `pe-*`, `start-*`, `text-end`, `border-s`,
`rounded-e-*`) and `rtl:rotate-180` on icons that point forward or back. Keep a
physical class only where the side is meant literally: safe-area insets, chart
plot coordinates, centring with `left-1/2 -translate-x-1/2`.

Values and names keep their own direction inside right-to-left text. The
formatters wrap their output in Unicode isolates in a right-to-left document, so
`-$1,234.56` and `9:30 AM` stay intact; parsers drop the marks. Provider and
user text that can be clipped (asset names, symbols, notes) gets `dir="auto"` on
the clipping element with `rtl:text-right`; unclipped names are wrapped in
`<bdi>`. Chart plots stay left-to-right (`.recharts-surface` in `globals.css`).

To try right-to-left without shipping a language, development builds read
`?dir=rtl` on load and expose `__wealthfolioSetDirection("rtl" | "ltr" | null)`
in the console; neither exists in production builds and nothing is stored.

### Naming

Bare language codes (`fr`, `ja`) unless the language is written in more than one
script. Chinese is the case that matters: `zh` means Simplified (CLDR expands it
to `zh-Hans-CN`) and `zh-Hant` means Traditional. Name Chinese variants by
**script**, not region — one `zh-Hant` catalog serves Taiwan, Hong Kong and
Macau, and regional differences belong in `formattingRegion`, which is a
separate setting. A `zh-Hant-HK` catalog can be added later and will fall back
to `zh-Hant`; that path does not exist from a region-named `zh-TW`.

Fallback never crosses a script boundary: a missing `zh-Hant` string resolves to
`en`, not `zh`. Mixed glyphs read as broken, untranslated text reads as missing.

### Terminology

Each locale should carry a glossary test (see `traditional-chinese.test.ts`)
asserting the term the catalog standardises on and rejecting its alternates. Key
parity and a green suite do not catch a catalog that says "Return" three
different ways — only a glossary does.

Arabic plural messages may omit `{{count}}` in `_zero`, `_one`, and `_two` forms
when the wording already expresses the exact count. The translation checker
permits this only for English plural families, and still requires all other
placeholders and counts in `_few`, `_many`, and `_other`. Reusable fragments
such as loan durations use the nominative CLDR forms (`سنتان`, `شهران`), so
sentences that embed them place them as a subject or predicate, never after a
preposition. `arabic.test.ts` covers rendered counts, independent
interpolations, embedded durations, and financial terminology.

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
- **Traditional Chinese (`zh-Hant`)**: contributed in PR #1566, machine-seeded
  from the English source and reviewed for Taiwan financial terminology by a
  native speaker; intended for continued community review.
- **Vietnamese (`vi`)**: full-coverage translation of all 20 namespaces in
  standard Vietnamese financial and investment terminology (`Danh mục đầu tư`,
  `Giá trị tài sản ròng`, `Vị thế`, `Lãi/Lỗ`, `Hiệu suất`, `Giá vốn`, `Cổ tức`);
  intended for community review.

Non-English catalogs are machine-drafted and community-corrected. Terminology
reports are expected and welcome — file them as issues against the locale.
