import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AlternativeAssetKind } from "@/lib/types";
import { AlternativeAssetQuickAddModal } from "./alternative-asset-quick-add-modal";

const create = vi.hoisted(() => vi.fn().mockResolvedValue({ assetId: "created" }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
// The backend solves the payment; the form's own rules are what is tested here.
vi.mock("../lib/loan-schedule", () => ({
  initialLoanProjection: async (_metadata: unknown, projection: unknown) => projection,
}));
vi.mock("../hooks/use-alternative-asset-mutations", () => ({
  useAlternativeAssetMutations: () => ({
    createMutation: { mutateAsync: create, isPending: false },
  }),
}));
vi.mock("@wealthfolio/ui", () => ({
  CurrencyInput: () => null,
  DatePickerInput: () => null,
  QuantityInput: ({
    value,
    onValueChange,
    "aria-label": label,
  }: {
    value?: number | string;
    onValueChange: (value: number | undefined) => void;
    "aria-label"?: string;
  }) => (
    <input
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onValueChange(Number(event.target.value) || undefined)}
    />
  ),
  useDateFormatting: () => ({ formatCalendarDate: (value: string) => value }),
  MoneyInput: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <input
      aria-label="Amount"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  ),
  ResponsiveSelect: ({
    value,
    onValueChange,
    options,
    sheetTitle,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    sheetTitle?: string;
  }) => (
    <select
      aria-label={sheetTitle}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

beforeEach(() => create.mockClear());

it.each([undefined, "auto_loan"])(
  "saves the displayed liability type without touching the selector (preset %s)",
  async (defaultLiabilityType) => {
    render(
      <AlternativeAssetQuickAddModal
        open
        onOpenChange={() => undefined}
        defaultKind={AlternativeAssetKind.LIABILITY}
        defaultName="Loan"
        defaultLiabilityType={defaultLiabilityType}
      />,
    );
    expect(await screen.findByRole("combobox", { name: "Select Liability Type" })).toHaveValue(
      defaultLiabilityType ?? "mortgage",
    );
    // Track the balance manually so the loan terms stay optional.
    fireEvent.click(screen.getByRole("switch", { name: "Estimate balance from payments" }));
    fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "liability",
          metadata: {
            sub_type: defaultLiabilityType ?? "mortgage",
            tracking_mode: "manual",
            original_amount: "500000",
          },
        }),
      ),
    );
  },
);

it("keeps the property's purchase date as a chained mortgage's origination date", async () => {
  render(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
      defaultOriginationDate={new Date(2025, 5, 1)}
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  // Only the amount and term are entered; the origination date comes from the property.
  fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "400000" } });
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ origination_date: "2025-06-01" }),
      }),
    ),
  );
});
