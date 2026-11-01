import { act, fireEvent, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh/settings.json";
import { AccountForm } from "./account-form";

const mutations = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("./use-account-mutations", () => ({
  useAccountMutations: () => ({
    createAccountMutation: { mutate: mutations.create },
    updateAccountMutation: { mutate: mutations.update, mutateAsync: mutations.update },
  }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: undefined }) }));

it("retranslates an already displayed account error without submitting again or resetting the draft", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { common: enCommon, settings: enSettings },
      zh: { common: zhCommon, settings: zhSettings },
    },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <Dialog open>
        <DialogContent>
          <AccountForm
            defaultValues={{
              name: "A",
              accountType: "SECURITIES",
              currency: "USD",
              trackingMode: "TRANSACTIONS",
            }}
          />
        </DialogContent>
      </Dialog>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByTestId("account-submit-button"));
  expect(await screen.findByText(enCommon.validation.accountNameMin)).toBeVisible();
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(zhCommon.validation.accountNameMin)).toBeVisible();
  expect(screen.queryByText(enCommon.validation.accountNameMin)).not.toBeInTheDocument();
  expect(screen.getByDisplayValue("A")).toBeInTheDocument();
  expect(mutations.create).not.toHaveBeenCalled();
  expect(mutations.update).not.toHaveBeenCalled();
});

it("retranslates the account-number limit error without resetting or submitting the draft again", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { common: enCommon, settings: enSettings },
      zh: { common: zhCommon, settings: zhSettings },
    },
  });
  const accountNumber = "9".repeat(65);
  render(
    <I18nextProvider i18n={i18n}>
      <Dialog open>
        <DialogContent>
          <AccountForm
            defaultValues={{
              name: "My account",
              accountNumber,
              accountType: "SECURITIES",
              currency: "USD",
              trackingMode: "TRANSACTIONS",
            }}
          />
        </DialogContent>
      </Dialog>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByTestId("account-submit-button"));
  expect(await screen.findByText(enCommon.validation.accountNumberMax)).toBeVisible();
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(zhCommon.validation.accountNumberMax)).toBeVisible();
  expect(screen.queryByText(enCommon.validation.accountNumberMax)).not.toBeInTheDocument();
  expect(screen.getByDisplayValue(accountNumber)).toBeInTheDocument();
  expect(screen.getByDisplayValue("My account")).toBeInTheDocument();
  expect(mutations.create).not.toHaveBeenCalled();
  expect(mutations.update).not.toHaveBeenCalled();
});
