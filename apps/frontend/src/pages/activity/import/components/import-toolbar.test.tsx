import { act, render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { expect, it, vi } from "vitest";
import enActivity from "@/i18n/locales/en/activity.json";
import zhActivity from "@/i18n/locales/zh/activity.json";
import enUi from "@/i18n/locales/en/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import { ImportToolbar } from "./import-toolbar";

vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));

async function toolbar(direction: "ltr" | "rtl" = "ltr", lng = "zh") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: {
      en: { activity: enActivity, ui: enUi },
      zh: { activity: zhActivity, ui: zhUi },
    },
  });
  const onSetCurrency = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <DirectionProvider direction={direction}>
        <ImportToolbar
          selectedCount={1}
          onSkip={vi.fn()}
          onUnskip={vi.fn()}
          onSetCurrency={onSetCurrency}
          onSetAccount={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </DirectionProvider>
    </I18nextProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: i18n.t("activity:import.reviewToolbar.currency"),
    }),
  );
  await screen.findByRole("menu");
  return { i18n, onSetCurrency, user };
}

it.each(["ltr", "rtl"] as const)(
  "updates an open currency menu on language changes in %s",
  async (direction) => {
    const { i18n, onSetCurrency } = await toolbar(direction, "en");
    expect(
      await screen.findByRole("menuitem", { name: /CNY.*Chinese\/Yuan renminbi/ }),
    ).toBeInTheDocument();
    await act(() => i18n.changeLanguage("zh"));
    expect(await screen.findByRole("menuitem", { name: /CNY.*人民币/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /GBp.*英国便士/ })).toBeInTheDocument();
    expect(onSetCurrency).not.toHaveBeenCalled();
  },
);

it.each(["人民币", "Chinese/Yuan", "cny"])(
  "finds currencies by localized name, English name or code: %s",
  async (query) => {
    const { i18n, onSetCurrency, user } = await toolbar();
    await user.type(
      screen.getByPlaceholderText(i18n.t("activity:import.reviewToolbar.searchCurrencies")),
      query,
    );
    await user.click(await screen.findByRole("menuitem", { name: /CNY.*人民币/ }));
    expect(onSetCurrency).toHaveBeenCalledExactlyOnceWith("CNY");
  },
);

it("searches translated quote units without changing their case-sensitive codes", async () => {
  const { i18n, onSetCurrency, user } = await toolbar();
  await user.type(
    screen.getByPlaceholderText(i18n.t("activity:import.reviewToolbar.searchCurrencies")),
    "英国便士",
  );
  await user.click(await screen.findByRole("menuitem", { name: /GBp.*英国便士/ }));
  expect(onSetCurrency).toHaveBeenCalledExactlyOnceWith("GBp");
});
