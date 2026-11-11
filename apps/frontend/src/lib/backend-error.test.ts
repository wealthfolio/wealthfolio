import globalI18n, { createInstance } from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import en from "@/i18n/locales/en/common.json";
import fr from "@/i18n/locales/fr/common.json";
import ar from "@/i18n/locales/ar/common.json";
import enAsset from "@/i18n/locales/en/asset.json";
import {
  isLoanRefusal,
  isStaleLoanError,
  loanErrorText,
} from "@/pages/asset/alternative-assets/components/loan-error-text";
import {
  BackendError,
  backendError,
  backendErrorText,
  CONNECT_REBIND_REQUIRED,
} from "./backend-error";

const privateMessage = "FAKE-KEY-2531 /private/portfolio.db SELECT account_balance";

afterEach(async () => {
  await globalI18n.changeLanguage("en");
});

describe("public backend errors", () => {
  it.each([
    "Profile operations are running. Wait for them to finish and try again.",
    "Connect account change is in progress. Try again.",
    `PROFILE_BUSY: ${privateMessage}`,
    { errorCode: "PROFILE_BUSY", message: privateMessage },
  ])("keeps reviewed profile busy guidance without diagnostic text (%s)", (cause) => {
    const error = backendError(cause);
    expect(error?.errorCode).toBe("PROFILE_BUSY");
    expect(error?.message).toBe(en.profiles.errors.busy);
    expect(String(error)).not.toContain("FAKE-KEY");
  });
  it.each(["BACKUP_REAUTHENTICATION_REQUIRED", "BACKUP_MANUAL_LIMIT"])(
    "preserves reviewed backup codes without private suffixes (%s)",
    (code) => {
      for (const payload of [
        `${code}: ${privateMessage}`,
        `API error (409): ${code}: ${privateMessage}`,
        new Error(`API error (403): ${code}: ${privateMessage}`),
        { errorCode: code, message: privateMessage },
      ]) {
        const error = backendError(payload);
        expect(error?.errorCode).toBe(code);
        expect(String(error)).not.toContain("FAKE-KEY");
        expect(JSON.stringify(error)).not.toContain("/private");
      }
      expect(backendError(`API error (409): ${code}_OTHER: ${privateMessage}`)).toBeUndefined();
      expect(backendError(`${privateMessage}: ${code}`)).toBeUndefined();
    },
  );

  it.each(["custom_provider_code_reserved", "custom_provider_in_use"])(
    "translates actionable validation without interpolating data (%s)",
    async (errorCode) => {
      const i18n = createInstance();
      await i18n.init({
        lng: "en",
        resources: { en: { common: en }, fr: { common: fr }, ar: { common: ar } },
      });
      const key =
        errorCode === "custom_provider_in_use"
          ? "customProviderInUse"
          : "customProviderCodeReserved";
      const error = backendError({ errorCode, message: privateMessage });
      expect(backendErrorText(error, i18n.t)).toBe(en.backendErrors[key]);
      await i18n.changeLanguage("fr");
      expect(backendErrorText(error, i18n.t)).toBe(fr.backendErrors[key]);
      await i18n.changeLanguage("ar");
      expect(backendErrorText(error, i18n.t)).toBe(ar.backendErrors[key]);
      expect(String(error)).not.toContain("FAKE-KEY");
    },
  );
  it.each([
    ["ADDON_MANIFEST_MISSING", "addonManifestMissing"],
    ["ADDON_MAIN_FILE_MISSING", "addonMainFileMissing"],
    ["ADDON_NEEDS_NEWER_VERSION", "addonNeedsNewerVersion"],
    ["QUOTE_CURRENCY_REQUIRED", "quoteCurrencyRequired"],
  ] as const)("names the refusal the user can act on (%s)", async (errorCode, key) => {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { common: en }, ar: { common: ar } },
    });
    // The web envelope and the code desktop commands send.
    for (const cause of [{ errorCode, message: privateMessage }, errorCode]) {
      const error = backendError(cause);
      expect(error?.errorCode).toBe(errorCode);
      expect(backendErrorText(error, i18n.t)).toBe(en.backendErrors[key]);
      expect(String(error)).not.toContain("FAKE-KEY");
    }
    await i18n.changeLanguage("ar");
    expect(backendErrorText(errorCode, i18n.t)).toBe(ar.backendErrors[key]);
  });

  it.each([false, true])("retains only the reviewed outcome metadata (%s)", (outcomeUnknown) => {
    const error = backendError({
      message: privateMessage,
      outcomeUnknown,
      privateDetail: privateMessage,
    });
    expect(error?.outcomeUnknown).toBe(outcomeUnknown);
    expect(error?.errorCode).toBe("internal_error");
    expect(JSON.stringify(error)).not.toContain("FAKE-KEY");
    expect(error).not.toHaveProperty("privateDetail");
  });

  it("preserves the Connect control code independently of its translated message", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "fr", resources: { fr: { common: fr } } });
    for (const payload of [
      { errorCode: CONNECT_REBIND_REQUIRED, message: privateMessage },
      `${CONNECT_REBIND_REQUIRED}: ${privateMessage}`,
      new Error(`${CONNECT_REBIND_REQUIRED}: ${privateMessage}`),
    ]) {
      const error = backendError(payload);
      expect(error?.errorCode).toBe(CONNECT_REBIND_REQUIRED);
      expect(backendErrorText(error, i18n.t)).toBe(fr.profiles.errors.rebind);
      expect(backendErrorText(error, i18n.t)).not.toContain(CONNECT_REBIND_REQUIRED);
      expect(String(error)).not.toContain("FAKE-KEY");
    }
    expect(backendError(`${CONNECT_REBIND_REQUIRED}_OTHER: ${privateMessage}`)).toBeUndefined();
  });
  it("keeps legacy Error.message consumers localized without replacing the cached error", async () => {
    globalI18n.addResourceBundle("fr", "common", fr, true, true);
    const error = new BackendError("provider_unavailable");
    expect(error.message).toBe(en.backendErrors.providerUnavailable);
    await globalI18n.changeLanguage("fr");
    expect(error.message).toBe(fr.backendErrors.providerUnavailable);
    expect(error.errorCode).toBe("provider_unavailable");
  });
  it("shows only the translated message when a view turns the error into text", () => {
    const error = new BackendError("provider_unavailable");
    expect(String(error)).toBe(en.backendErrors.providerUnavailable);
    expect(`${error}`).toBe(en.backendErrors.providerUnavailable);
  });
  it("preserves loan refusal behavior and translations without exposing unknown diagnostics", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { common: en, asset: enAsset } } });
    const error = backendError({ errorCode: "LOAN_EVENT_CHANGED", message: privateMessage });
    expect(isLoanRefusal(error)).toBe(true);
    expect(isStaleLoanError(error)).toBe(true);
    expect(loanErrorText(i18n.t, error, "common:backendErrors.internal")).toBe(
      i18n.t("asset:loanEvents.changed"),
    );
    expect(loanErrorText(i18n.t, new Error(privateMessage), "common:backendErrors.internal")).toBe(
      en.backendErrors.internal,
    );
    expect(isLoanRefusal(new Error("constructor"))).toBe(false);
    expect(
      loanErrorText(i18n.t, new Error("asset:FAKE-KEY-2531"), "common:backendErrors.internal"),
    ).toBe(en.backendErrors.internal);
  });
  it.each([
    { code: 400, errorCode: "provider_unavailable", message: privateMessage },
    { errorCode: "provider_unavailable", message: privateMessage },
    { ServiceError: { errorCode: "provider_unavailable", message: privateMessage } },
  ])("normalizes web and desktop payloads without retaining private text", (payload) => {
    const error = backendError(payload);
    expect(error).toBeInstanceOf(BackendError);
    expect(error?.errorCode).toBe("provider_unavailable");
    expect(String(error)).not.toContain("FAKE-KEY-2531");
    expect(JSON.stringify(error)).not.toContain("/private");
    expect(error).not.toHaveProperty("cause");
  });

  it("translates the same retained error in the current language", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      resources: { en: { common: en }, fr: { common: fr }, ar: { common: ar } },
    });
    const error = backendError({ errorCode: "provider_unavailable", message: privateMessage });
    expect(backendErrorText(error, i18n.t)).toBe(en.backendErrors.providerUnavailable);
    await i18n.changeLanguage("fr");
    expect(backendErrorText(error, i18n.t)).toBe(fr.backendErrors.providerUnavailable);
    await i18n.changeLanguage("ar");
    expect(i18n.dir()).toBe("rtl");
    expect(backendErrorText(error, i18n.t)).toBe(ar.backendErrors.providerUnavailable);
  });

  it("uses a translated generic fallback for unknown codes and legacy raw text", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "fr", resources: { fr: { common: fr } } });
    for (const error of [
      { errorCode: "future_error", message: privateMessage },
      { errorCode: "__proto__", message: privateMessage },
      new Error(privateMessage),
      privateMessage,
    ]) {
      expect(backendErrorText(error, i18n.t)).toBe(fr.backendErrors.internal);
    }
  });
});
