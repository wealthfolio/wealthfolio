# Addon Localization

Wealthfolio addons run inside a sandboxed iframe that follows the host app's
language and regional formatting settings. This page covers the two halves of
localization: **formatting** (numbers, currencies, dates — region-driven) and
**translation** (your addon's own strings — language-driven).

Both follow the user's settings automatically and update live when the user
changes them — no reload, no listeners to wire up.

The sandbox localization runtime described here ships with Wealthfolio 3.8.
Addons that use these APIs must set both `sdkVersion` and
`minWealthfolioVersion` to `3.8.0` or newer.

## Region formatting (numbers, currencies, dates)

The host separates the UI **language** from the **formatting region**: a user
may read the UI in French while formatting amounts as `en-US`. Never hardcode
`toLocaleString()` locales or format patterns — use the formatting hooks from
`@wealthfolio/ui`, which are wired to the user's settings inside the sandbox:

```tsx
import {
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
  useLocalizationSettings,
} from "@wealthfolio/ui";

function HoldingRow({ value, currency, asOf }: Props) {
  const { formatAmount } = useAmountFormatting();
  const { formatDate } = useDateFormatting();
  const { formatPercent } = useNumberFormatting();

  return (
    <div>
      {formatAmount(value, currency)} — {formatDate(asOf)} —{" "}
      {formatPercent(0.042)}
    </div>
  );
}
```

Highlights of the API:

- `useAmountFormatting()` — `formatAmount`, `formatPrice`,
  `formatCompactAmount`, `formatRoundedAmount`, `formatCurrencySymbol`,
  `currencyFractionDigits`, and `currencyLocale` (hosts newer than 3.10.0).
  These follow the user's per-currency formats, so an amount in a currency with
  its own format uses that region instead of the global one. When you format an
  amount yourself, use `currencyLocale(currency)` as its locale.
- `useNumberFormatting()` — `formatPercent`, `formatQuantity`, `formatDecimal`,
  `decimalSeparator`, `groupSeparator`, and locale-aware `parseNumber` for
  inputs
- `useDateFormatting()` — `formatDate`, `formatDateTime`, `formatTime`,
  calendar-date and range variants, and locale-aware `parseDate`
- `useLocalizationSettings()` — the raw `{ locale, uiLocale, timezone }` if you
  need to make a decision yourself

## Translating your addon's strings

Register your translations once in `enable()`, then use the hook in components:

```tsx
import {
  registerTranslations,
  useAddonTranslation,
} from "@wealthfolio/addon-sdk";

export default function enable(ctx: AddonContext) {
  registerTranslations({
    en: {
      title: "Dividend Forecast",
      greeting: "Hello {{name}}",
      holdings_one: "{{count}} holding",
      holdings_other: "{{count}} holdings",
    },
    fr: {
      title: "Prévision de dividendes",
      greeting: "Bonjour {{name}}",
    },
  });

  // ... register routes / sidebar items
}

function Title() {
  const { t, language } = useAddonTranslation();
  return <h1 lang={language}>{t("title")}</h1>;
}
```

Behavior and rules:

- **Keys are private to your addon.** Your resources live in an addon-scoped
  namespace; you cannot read or overwrite the host's strings, and other addons
  cannot see yours.
- **Language follows the host.** There is no API to change the language from an
  addon — the UI language is a user setting. `language` from the hook tells you
  the current host locale code: `en`, `fr`, `de`, `es`, `pt`, `zh`, `zh-Hant`,
  `ja`, `ko`, `it`.

  Note that these are **not** all bare language codes. `zh-Hant` (Traditional
  Chinese) carries a script subtag, so `language.split("-")[0]` is not a safe
  way to key a lookup table — it collapses Traditional and Simplified onto the
  same `zh`. Compare against the full code, and register a `zh-Hant` bundle
  separately from `zh`. A missing `zh-Hant` string falls back to your `en`
  bundle, never to `zh`: Simplified glyphs in a Traditional UI read as broken
  rather than untranslated.

  Regional aliases normalize to the host's supported language. For example,
  `fr-CA` becomes `fr`, while `zh-TW`, `zh-HK`, and `zh-MO` become `zh-Hant`.
  Invalid language keys are ignored with a warning.

- **Fallback is your `en` bundle.** If the current language is missing a key (or
  the whole bundle), lookup falls back to your `en` resources; if that is
  missing too, the key itself is rendered. Always ship a complete `en` bundle.
- **Interpolation and plurals** use standard i18next syntax: `{{name}}`
  placeholders, and `_one` / `_other` plural suffixes driven by
  `t('holdings', { count })`. `$t()` nesting inside translation values is
  disabled, and language-resolution options (`lng`, `fallbackLng`) are ignored —
  the host language always wins.
- Components re-render automatically on language changes and on (late)
  `registerTranslations` calls, but registering in `enable()` before the first
  render avoids a flash of untranslated keys.

### Languages beyond the host's set

Registering languages the host does not support is harmless — they are stored
but never resolved, because the sandbox language can only ever be one of the
host-supported codes above.

If your addon genuinely needs its own localization stack (ICU messages, its own
language switcher, a language the host lacks), bundle your own copy of
`i18next` + `react-i18next` inside the addon instead of using this API. That is
fully supported: your bundled instance is private to your addon's iframe. Note
that the sandbox blocks network requests, so lazy-loading backends will not work
— bundle your resources statically.

## What the host does NOT provide

- `react-i18next` / `i18next` are not host dependencies — do not add them to
  your build's `external` list; bundle them if you need them directly.
- There is no way to read the host's translation catalog (`ui:*` keys) or to
  change the app language from an addon.
