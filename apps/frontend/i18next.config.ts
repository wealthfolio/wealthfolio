import { defineConfig } from "i18next-cli";

// Config for `i18next-cli` (extract / status / lint / types / instrument).
// Keep `locales` in sync with SUPPORTED_LOCALES in src/i18n/locales.ts.
export default defineConfig({
  locales: ["en", "fr", "de"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    // Preserve keys that exist in the JSON but aren't (yet) referenced in code,
    // so community-contributed translations are never dropped by an extract run.
    removeUnusedKeys: false,
  },
});
