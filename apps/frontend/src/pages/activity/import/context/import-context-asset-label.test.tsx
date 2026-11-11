import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";

vi.mock("@/adapters", () => ({
  checkActivitiesImport: vi.fn(),
  previewImportAssets: vi.fn(),
  logger: { error: vi.fn() },
}));

const fundRow: DraftActivity = {
  rowIndex: 0,
  isEdited: false,
  rawRow: [],
  activityDate: "2026-01-01",
  activityType: "BUY",
  symbol: "122639",
  currency: "INR",
  accountId: "account-1",
  instrumentType: "EQUITY",
  instrumentTypeLabel: "MUTUALFUND",
  quoteMode: "MARKET",
  status: "valid",
  errors: {},
  warnings: {},
};

function renderContext() {
  let context!: ReturnType<typeof useImportContext>;
  function Probe() {
    context = useImportContext();
    return null;
  }
  render(
    <ImportProvider>
      <Probe />
    </ImportProvider>,
  );
  act(() => context.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: [fundRow] }));
  return () => context;
}

it.each([
  ["a pricing change", { quoteMode: "MANUAL" }, "MUTUALFUND"],
  ["an unchanged symbol", { symbol: "122639" }, "MUTUALFUND"],
  ["a symbol change", { symbol: "OTHER" }, undefined],
  ["an instrument type change", { instrumentType: "BOND" }, undefined],
] as const)(
  "keeps a row's quote type only while its asset is unchanged (%s)",
  (_, updates, label) => {
    const context = renderContext();

    act(() =>
      context().dispatch({
        type: "UPDATE_DRAFT",
        payload: { rowIndex: 0, updates: { ...updates } },
      }),
    );

    expect(context().state.draftActivities[0].instrumentTypeLabel).toBe(label);
  },
);
