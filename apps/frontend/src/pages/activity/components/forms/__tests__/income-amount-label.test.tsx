import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { DividendForm } from "../dividend-form";
import { InterestForm } from "../interest-form";
import type { AccountSelectOption } from "../fields";

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: { baseCurrency: "USD" }, isLoading: false, error: null }),
}));

// Amount fields render their label and help text, so the test sees what the
// form asks the user to enter.
vi.mock("../fields", () => {
  const AmountField = ({
    name,
    label,
    labelHelpText,
  }: {
    name: string;
    label: string;
    labelHelpText?: string;
  }) => (
    <div data-testid={`field-${name}`}>
      <span>{label}</span>
      {labelHelpText && <span>{labelHelpText}</span>}
    </div>
  );
  return {
    AccountSelect: () => null,
    DatePicker: () => null,
    NotesInput: () => null,
    AdvancedOptionsSection: () => null,
    SymbolSearch: () => null,
    FormSection: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    AmountInput: AmountField,
    QuantityInput: AmountField,
    createValidatedSubmit: vi.fn((form, handler) => form.handleSubmit(handler)),
  };
});

const accounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Brokerage", currency: "USD", accountType: "SECURITIES" },
  { value: "card-1", label: "Card", currency: "USD", accountType: "CREDIT_CARD" },
];

function renderIncome(form: "dividend" | "interest", subtype: string | null, accountId = "acc-1") {
  const defaultValues = { accountId, currency: "USD", subtype };
  render(
    form === "dividend" ? (
      <DividendForm accounts={accounts} onSubmit={vi.fn()} defaultValues={defaultValues} />
    ) : (
      <InterestForm accounts={accounts} onSubmit={vi.fn()} defaultValues={defaultValues} />
    ),
  );
  return screen.getByTestId("field-amount");
}

describe("income amount label", () => {
  it.each(["dividend", "interest"] as const)(
    "asks a cash %s for the amount received after fees and taxes",
    (form) => {
      const amount = renderIncome(form, null);

      expect(amount).toHaveTextContent("Received amount");
      expect(amount).toHaveTextContent("Final cash received, after fees and taxes.");
    },
  );

  it.each([
    ["dividend", ACTIVITY_SUBTYPES.DRIP, "Dividend amount"],
    ["dividend", ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND, "Dividend amount"],
    ["interest", ACTIVITY_SUBTYPES.STAKING_REWARD, "Interest amount"],
  ] as const)("keeps the value label for a %s paid as %s", (form, subtype, label) => {
    const amount = renderIncome(form, subtype);

    expect(amount).toHaveTextContent(label);
    expect(amount).not.toHaveTextContent("Final cash received");
  });

  it("does not call credit-card interest, a charge, an amount received", () => {
    const amount = renderIncome("interest", null, "card-1");

    expect(amount).toHaveTextContent("Amount");
    expect(amount).not.toHaveTextContent("Received amount");
    expect(amount).not.toHaveTextContent("Final cash received");
  });
});
