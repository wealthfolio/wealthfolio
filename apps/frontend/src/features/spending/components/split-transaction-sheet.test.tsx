import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { Activity } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TransactionRowVM } from "../lib/transactions-helpers";
import { SplitTransactionSheet } from "./split-transaction-sheet";

vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("./quick-categorize-popover", () => ({ QuickCategorizePopover: () => null }));

function splitRow(amount: string, currency: string, splitAmounts: string[]) {
  return {
    activity: {
      id: "activity-1",
      amount,
      currency,
      notes: "Groceries",
      cashFlowBucket: "spending",
      splits: splitAmounts.map((splitAmount, index) => ({
        id: `split-${index}`,
        taxonomyId: "spending_categories",
        categoryId: "food",
        amount: splitAmount,
        note: null,
        sortOrder: index,
      })),
    },
    category: { id: "food", taxonomyId: "spending_categories" },
    splitCount: splitAmounts.length,
    needsReview: false,
  } as unknown as TransactionRowVM;
}

function renderSheet(row: TransactionRowVM, locale = "DE") {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <FormattingProvider locale={locale}>
      <SplitTransactionSheet
        open
        row={row}
        categories={new Map()}
        isSaving={false}
        onOpenChange={vi.fn()}
        onSave={onSave}
        onClear={vi.fn()}
      />
    </FormattingProvider>,
  );
  return onSave;
}

function savedAmounts(onSave: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSave).toHaveBeenCalledOnce();
  const [, splits] = onSave.mock.calls[0] as [string, { amount: string }[]];
  return splits.map((split) => split.amount);
}

describe("SplitTransactionSheet", () => {
  it("formats the total and remaining amounts for the formatting region", () => {
    renderSheet(splitRow("1234.5", "EUR", ["1000"]));

    expect(screen.getByText(/1\.234,50\s€/)).toBeInTheDocument();
    expect(screen.getByText(/^234,50\sEUR$/)).toBeInTheDocument();
  });

  it("keeps cents for currencies without minor units", () => {
    renderSheet(splitRow("1000.33", "JPY", ["333.34", "333.33", "333"]));

    expect(screen.getByText(/1\.000,33\s¥/)).toBeInTheDocument();
    expect(screen.getByText(/^0,66\sJPY$/)).toBeInTheDocument();
  });

  it("splits a total that isn't a whole number of cents in a three-decimal currency", () => {
    const onSave = renderSheet(splitRow("-1.235", "KWD", []), "en-US");

    expect(screen.getByText("Remaining of KWD 1.235")).toBeInTheDocument();
    expect(savedAmounts(onSave)).toEqual(["1.235"]);
  });

  it.each([
    ["KWD", "1.235", ["1.000", "0.235"], ["1.000", "0.235"]],
    ["KWD", "1.000", ["0.333", "0.333", "0.334"], ["0.333", "0.333", "0.334"]],
    ["KWD", "10.000", ["3.333", "6.667"], ["3.333", "6.667"]],
    ["KWD", "10.000", ["3.33", "6.67"], ["3.330", "6.670"]],
    ["USD", "12.34", ["12.34"], ["12.34"]],
    ["JPY", "1000", ["333", "667"], ["333.00", "667.00"]],
  ])("sends %s %s split as %j with the amounts entered", (currency, total, lines, sent) => {
    const onSave = renderSheet(splitRow(total, currency, lines), "en-US");

    expect(savedAmounts(onSave)).toEqual(sent);
  });

  it("distributes a three-decimal total in its minor units", () => {
    const onSave = renderSheet(splitRow("1.235", "KWD", ["1.235", "0"]), "en-US");

    fireEvent.click(screen.getByRole("button", { name: "Distribute evenly" }));

    expect(savedAmounts(onSave)).toEqual(["0.618", "0.617"]);
  });

  it("limits split lines to the decimals they are summed in", async () => {
    const user = userEvent.setup();
    renderSheet(splitRow("10", "KWD", ["10"]), "en-US");
    const [line] = screen.getAllByRole("textbox");

    await user.clear(line);
    await user.type(line, "3.3337");

    expect(line).toHaveValue("3.333");
    expect(screen.getByText(/^6\.667\sKWD$/)).toBeInTheDocument();
  });

  it("keeps edited split lines when its phone screen is shown again", async () => {
    // A phone screen kept under another one is a hidden <Activity>, whose
    // effects run again when it is shown.
    const user = userEvent.setup();
    const row = splitRow("10", "USD", ["10"]);
    const view = (hidden: boolean) => (
      <FormattingProvider locale="en-US">
        <Activity mode={hidden ? "hidden" : "visible"}>
          <SplitTransactionSheet
            open
            row={row}
            categories={new Map()}
            isSaving={false}
            onOpenChange={vi.fn()}
            onSave={vi.fn()}
            onClear={vi.fn()}
          />
        </Activity>
      </FormattingProvider>
    );
    const { rerender } = render(view(false));
    const [line] = screen.getAllByRole("textbox");
    await user.clear(line);
    await user.type(line, "4");

    rerender(view(true));
    rerender(view(false));

    expect(screen.getAllByRole("textbox")[0]).toHaveValue("4");
  });
});
