import { defineConfig } from "i18next-cli";

// Config for `i18next-cli` (extract / status / lint / types / instrument).
// Keep `locales` in sync with SUPPORTED_LOCALES in src/i18n/locales.ts.
export default defineConfig({
  locales: ["en", "fr", "de", "es", "pt", "zh", "zh-Hant", "ja", "ko", "it"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    // Tests contain mocks and addon-private `t()` calls that do not belong to
    // the host translation catalog.
    ignore: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**/*.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    // Preserve keys that exist in the JSON but aren't (yet) referenced in code,
    // so community-contributed translations are never dropped by an extract run.
    removeUnusedKeys: false,
  },
});
