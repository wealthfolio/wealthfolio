import { act, render, screen } from "@testing-library/react";
import { PERMISSION_CATEGORIES } from "@wealthfolio/addon-sdk";
import { createInstance, type TFunction } from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh/settings.json";
import type { Permission } from "@/adapters";
import { PermissionCategoriesDisplay } from "./permission-categories-display";
import { getFunctionDisplayName } from "./addon-function-names";

const permission = (category: string, name: string): Permission => ({
  category,
  functions: [{ name, isDeclared: true, isDetected: true }],
  purpose: "User supplied purpose",
});

describe("permission presentation localization", () => {
  it("translates known descriptions, switches language and preserves technical names", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "zh",
      fallbackLng: "en",
      resources: {
        en: { settings: enSettings },
        zh: { settings: zhSettings },
      },
    });
    const permissions = [
      permission("accounts", "getAll"),
      permission("market-data", "syncHistory"),
      permission("custom", "userFunction"),
    ];
    render(
      <I18nextProvider i18n={i18n}>
        <PermissionCategoriesDisplay permissions={permissions} />
      </I18nextProvider>,
    );
    expect(screen.getByText("账户管理")).toBeInTheDocument();
    expect(screen.getByText("访问账户信息和设置")).toBeInTheDocument();
    expect(screen.getByText("查看所有账户")).toHaveAttribute("title", "getAll");
    expect(screen.getByText("下载历史价格")).toHaveAttribute("title", "syncHistory");
    expect(screen.getByText("userFunction")).toBeInTheDocument();
    expect(screen.getByText("User supplied purpose")).toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByText("Account Management")).toBeInTheDocument();
    expect(screen.getByText("View all accounts")).toBeInTheDocument();
    expect(permissions[0].category).toBe("accounts");
    expect(permissions[0].functions[0].name).toBe("getAll");
  });

  it("preserves unknown function names and English callers without a translator", () => {
    expect(getFunctionDisplayName("accounts", "getAll")).toBe("View all accounts");
    expect(getFunctionDisplayName("custom", "myOperation")).toBe("myOperation");
  });

  it("has a translated display name for every permission category and function", () => {
    const missing = PERMISSION_CATEGORIES.flatMap((category) =>
      category.functions
        .filter((name) => getFunctionDisplayName(category.id, name) === name)
        .map((name) => `${category.id}.${name}`),
    );
    expect(missing).toEqual([]);

    const keyOf = ((key: string) => key) as unknown as TFunction;
    const untranslated = PERMISSION_CATEGORIES.flatMap((category) =>
      category.functions
        .map((name) => getFunctionDisplayName(category.id, name, keyOf))
        .filter(
          (key) =>
            !(
              key.replace("settings:addonPermissions.functions.", "") in
              enSettings.addonPermissions.functions
            ),
        ),
    );
    expect(untranslated).toEqual([]);

    const untranslatedCategories = PERMISSION_CATEGORIES.map((category) => category.id).filter(
      (id) => !(id in enSettings.addonPermissions.categories),
    );
    expect(untranslatedCategories).toEqual([]);
  });
});
