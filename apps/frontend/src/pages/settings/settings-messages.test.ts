import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en/settings.json";
import zh from "@/i18n/locales/zh/settings.json";
import ar from "@/i18n/locales/ar/settings.json";

describe("settings message catalogs", () => {
  it("localizes notifications and interpolates names and diagnostics without changing them", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "zh", fallbackLng: false, resources: { zh: { settings: zh } } });
    expect(i18n.t("settings:messages.account.created")).toBe("账户创建成功。");
    expect(i18n.t("settings:messages.addonInstalled", { name: "Custom Addon" })).toBe(
      "Custom Addon 已安装并启用。",
    );
    expect(
      i18n.t("settings:messages.exchange.addingFailed", { error: "Original diagnostic 123" }),
    ).toContain("Original diagnostic 123");
    expect(i18n.t("settings:messages.auditRemoved", { count: 2 })).toBe("已移除 2 条记录。");
  });
  it("uses locale plural forms for audit and update counts", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: false,
      resources: { en: { settings: en }, ar: { settings: ar } },
    });
    expect(i18n.t("settings:messages.auditRemoved", { count: 1 })).toBe("1 entry removed.");
    expect(i18n.t("settings:messages.addonUpdates", { count: 2 })).toBe(
      "2 addons have updates available.",
    );
    await i18n.changeLanguage("ar");
    expect(i18n.t("settings:messages.auditRemoved", { count: 2 })).toBe("تمت إزالة سجلين.");
    expect(i18n.t("settings:messages.addonUpdates", { count: 3 })).toContain("3");
  });
});
