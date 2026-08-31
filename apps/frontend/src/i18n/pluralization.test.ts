import deActivity from "./locales/de/activity.json";
import enActivity from "./locales/en/activity.json";
import esActivity from "./locales/es/activity.json";
import frActivity from "./locales/fr/activity.json";
import itActivity from "./locales/it/activity.json";
import deCommon from "./locales/de/common.json";
import enCommon from "./locales/en/common.json";
import esCommon from "./locales/es/common.json";
import frCommon from "./locales/fr/common.json";
import itCommon from "./locales/it/common.json";
import jaCommon from "./locales/ja/common.json";
import koCommon from "./locales/ko/common.json";
import zhCommon from "./locales/zh/common.json";
import i18next from "i18next";
import { describe, expect, it } from "vitest";

const resources = {
  de: { activity: deActivity },
  en: { activity: enActivity },
  es: { activity: esActivity },
  fr: { activity: frActivity },
  it: { activity: itActivity },
};

describe("singular translations", () => {
  it.each([
    ["en", "There are issues with 1 activity entry."],
    ["fr", "Il y a des problèmes avec 1 entrée d'activité."],
    ["de", "Es gibt Probleme mit 1 Aktivitätseintrag."],
    ["es", "Hay problemas con 1 entrada de actividad."],
    ["it", "È presente un problema con 1 voce di movimento."],
  ])("uses the singular activity form for %s", async (locale, expected) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "activity",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      lng: locale,
      ns: ["activity"],
      resources,
    });

    expect(i18n.t("activity:import.validationAlert.issuesTitle", { count: 1 })).toBe(expected);
  });
});

describe("global event translations", () => {
  it.each([
    ["en", enCommon],
    ["fr", frCommon],
    ["de", deCommon],
    ["es", esCommon],
    ["ja", jaCommon],
    ["ko", koCommon],
    ["zh", zhCommon],
    ["it", itCommon],
  ])("resolves asset-count messages for %s", async (locale, common) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "common",
      fallbackLng: false,
      interpolation: { escapeValue: false },
      lng: locale,
      ns: ["common"],
      resources: { [locale]: { common } },
    });

    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 1 })).not.toContain(
      "globalEvents",
    );
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 2 })).not.toContain(
      "globalEvents",
    );
    // `it` resolves the CLDR `many` category at exact millions; a missing or
    // empty `_many` form would render an empty string here.
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 1_000_000 })).not.toBe("");
  });
});
