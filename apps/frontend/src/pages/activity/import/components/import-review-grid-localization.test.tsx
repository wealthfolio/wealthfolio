import { act, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import en from "@/i18n/locales/en/activity.json";
import zh from "@/i18n/locales/zh/activity.json";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import { validateDraft } from "../utils/draft-utils";
import type { DraftActivity } from "../context";
import { ImportReviewGrid } from "./import-review-grid";

const searchTicker = vi.hoisted(() => vi.fn());
vi.mock("@/adapters", () => ({ searchTicker }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/components/create-custom-asset-dialog", () => ({ CreateCustomAssetDialog: () => null }));
// Keep real DataGrid and memoized DataGridRow; only supply jsdom viewport geometry.
vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 36,
        end: (index + 1) * 36,
        size: 36,
        lane: 0,
      })),
    getTotalSize: () => count * 36,
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    // Expose real status-cell content without jsdom pointer/portal positioning.
    TooltipContent: ({ children }: ComponentProps<typeof actual.TooltipContent>) => (
      <div role="tooltip">{children}</div>
    ),
  };
});

it("retranslates one validated draft in the real review component without changing raw errors or revalidating", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { activity: en, common: enCommon },
      zh: { activity: zh, common: zhCommon },
    },
  });
  const input = {
    activityDate: "",
    activityType: "DEPOSIT",
    currency: "USD",
    accountId: "account-1",
    amount: "10",
  };
  const validation = validateDraft(input); // Exactly once; the same object survives both switches.
  const raw = "activity:validation.currency_is_required";
  const draft: DraftActivity = {
    ...input,
    ...validation,
    rowIndex: 0,
    rawRow: [],
    isEdited: false,
    errors: { ...validation.errors, activityDate: [...validation.errors.activityDate, raw] },
  };
  const original = structuredClone(draft);
  const onDraftUpdate = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ImportReviewGrid
        drafts={[draft]}
        selectedRows={[0]}
        onSelectionChange={vi.fn()}
        onDraftUpdate={onDraftUpdate}
      />
    </I18nextProvider>,
  );
  const tooltip = await screen.findByRole("tooltip");
  for (const [language, message] of [
    ["en", en.validation.date_is_required],
    ["zh", zh.validation.date_is_required],
    ["en", en.validation.date_is_required],
  ]) {
    await act(() => i18n.changeLanguage(language));
    expect(tooltip).toHaveTextContent(message);
    expect(tooltip).toHaveTextContent(raw);
    expect(
      screen.getByRole("checkbox", {
        name: i18n.t("activity:import.columns.selectRow"),
      }),
    ).toBeChecked();
    expect(document.querySelector('[data-cell-state="error"]')).toHaveAttribute(
      "title",
      `${message}\n${raw}`,
    );
  }
  expect(draft).toEqual(original);
  expect(onDraftUpdate).not.toHaveBeenCalled();
  expect(searchTicker).not.toHaveBeenCalled();
});
