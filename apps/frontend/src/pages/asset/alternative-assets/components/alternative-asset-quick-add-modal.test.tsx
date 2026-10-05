import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AlternativeAssetKind } from "@/lib/types";
import { AlternativeAssetQuickAddModal } from "./alternative-asset-quick-add-modal";

const create = vi.hoisted(() => vi.fn().mockResolvedValue({ assetId: "created" }));
const preview = vi.hoisted(() => vi.fn());
vi.mock("@/adapters", () => ({ previewLoanTerms: preview }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
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

beforeEach(() => {
  create.mockClear();
  preview.mockReset().mockResolvedValue({
    firstPaymentDate: "2025-07-01",
    lastPaymentDate: "2050-06-01",
    paymentCount: 300,
    paymentAmount: 2100,
  });
});

const show = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

it.each([undefined, "auto_loan"])(
  "saves the displayed liability type without touching the selector (preset %s)",
  async (defaultLiabilityType) => {
    show(
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
          metadata: { sub_type: defaultLiabilityType ?? "mortgage" },
          // A manual loan keeps only its amounts; the backend stores them.
          loan: { originalAmount: 500000, interestRate: undefined },
        }),
      ),
    );
  },
);

it("keeps the property's purchase date as a chained mortgage's origination date", async () => {
  show(
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
        loan: expect.objectContaining({ originationDate: "2025-06-01" }),
      }),
    ),
  );
});

it("shows the schedule the backend previews, and sends the loan as entered", async () => {
  show(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
      defaultOriginationDate={new Date(2025, 5, 1)}
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "400000" } });
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "25" } });
  await waitFor(() =>
    expect(preview).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({
        originalAmount: 400000,
        originationDate: "2025-06-01",
        schedule: expect.objectContaining({ frequency: "monthly", amortizationMonths: 300 }),
      }),
    ),
  );
  expect(await screen.findByText(/300 payments/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  const request = create.mock.lastCall![0];
  // No schedule maths here: the payment is left for the backend to solve.
  expect(request.loan.schedule).not.toHaveProperty("paymentAmount");
  expect(request.metadata).toEqual({ sub_type: "mortgage" });
});

it("shows a refusal from the backend preview", async () => {
  preview.mockRejectedValue(new Error("LOAN_FIRST_PAYMENT_BEFORE_ORIGINATION"));
  show(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
      defaultOriginationDate={new Date(2025, 5, 1)}
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "400000" } });
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "25" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/first payment/i);
  // Terms the backend refuses are not submitted; the reason is already shown.
  expect(screen.getByRole("button", { name: "Add Liability" })).toBeDisabled();
});

it("clears a save refusal once the form changes", async () => {
  create.mockRejectedValueOnce(new Error("LOAN_AMORTIZATION_INVALID"));
  show(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
      defaultOriginationDate={new Date(2025, 5, 1)}
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "400000" } });
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "25" } });
  await screen.findByText(/300 payments/);
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "20" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
