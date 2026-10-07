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
    "aria-describedby": describedBy,
  }: {
    value?: number | string;
    onValueChange: (value: number | undefined) => void;
    "aria-label"?: string;
    "aria-describedby"?: string;
  }) => (
    <input
      aria-label={label}
      aria-describedby={describedBy}
      value={value ?? ""}
      onChange={(event) =>
        onValueChange(event.target.value === "" ? undefined : Number(event.target.value))
      }
    />
  ),
  useDateFormatting: () => ({ formatCalendarDate: (value: string) => value }),
  useAmountFormatting: () => ({
    formatAmount: (value: number, currency: string) => `${currency} ${value}`,
  }),
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
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
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
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
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
  expect(screen.getByText("Estimated payment USD 2100")).toBeInTheDocument();
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
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/first payment/i);
  // Terms the backend refuses are not submitted; the reason is already shown.
  expect(screen.getByRole("button", { name: "Add Liability" })).toBeDisabled();
  // More options opened for the refusal, and the user can still fold it.
  const more = screen.getByRole("button", { name: "More options" });
  expect(more).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(more);
  expect(more).toHaveAttribute("aria-expanded", "false");
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
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
  await screen.findByText(/300 payments/);
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "20" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("asks for no preview, and shows no error, until the terms are entered", async () => {
  show(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "400000" } });
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
  // Past the preview's debounce: the origination date is still missing.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(preview).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a refusal under the field it is about", async () => {
  preview.mockRejectedValue(new Error("LOAN_AMORTIZATION_INVALID"));
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
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "250" } });
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
  const alert = await screen.findByRole("alert");
  expect(alert.parentElement).toContainElement(screen.getByLabelText("Years"));
  // Screen readers announce the refusal with the field.
  expect(screen.getByLabelText("Years")).toHaveAccessibleDescription(alert.textContent ?? "");
});

it("lets a loan be added when the preview cannot reach the backend", async () => {
  preview.mockRejectedValue(new Error("Failed to fetch"));
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
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "5" } });
  await waitFor(() => expect(preview).toHaveBeenCalled());
  // Only a refusal from the loan rules blocks saving, and the raw error is not shown.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
});

it("needs the rate for an estimated loan", async () => {
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
  fireEvent.change(screen.getByLabelText("Years"), { target: { value: "20" } });
  // Left blank the rate would be 0%: nothing is previewed or submitted.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(preview).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Add Liability" })).toBeDisabled();
  // Its label no longer says "(optional)".
  expect(screen.getByText("Interest Rate (%)")).toBeInTheDocument();
  // A 0% loan is entered as 0.
  fireEvent.change(screen.getByLabelText("Interest Rate (%)"), { target: { value: "0" } });
  await waitFor(() => expect(preview).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "Add Liability" })).toBeEnabled());
});

it("folds the less common terms under More options", async () => {
  show(
    <AlternativeAssetQuickAddModal
      open
      onOpenChange={() => undefined}
      defaultKind={AlternativeAssetKind.LIABILITY}
      defaultName="Mortgage"
    />,
  );
  await screen.findByRole("combobox", { name: "Select Liability Type" });
  expect(screen.queryByText("First payment date")).toBeNull();
  const more = screen.getByRole("button", { name: "More options" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more);
  expect(more).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("First payment date")).toBeInTheDocument();
  expect(screen.getByText("Interest calculation")).toBeInTheDocument();
});
