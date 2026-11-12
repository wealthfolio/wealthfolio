import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { DividendForm } from "../dividend-form";
import { InterestForm } from "../interest-form";
import type { AccountSelectOption } from "../fields";

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: { baseCurrency: "USD" }, isLoading: false, error: null }),
}));

// Amount fields that show the form's value and report the user's own edits,
// as AmountInput does, so the forms' before-tax linking runs for real.
vi.mock("../fields", async () => {
  const { useController } =
    await vi.importActual<typeof import("react-hook-form")>("react-hook-form");
  const AmountField = ({
    name,
    label,
    onValueChange,
  }: {
    name: string;
    label: string;
    onValueChange?: (value: number | undefined) => void;
  }) => {
    const { field, fieldState } = useController({ name });
    return (
      <div>
        <input
          aria-label={label}
          value={field.value ?? ""}
          onChange={(event) => {
            const value = event.target.value === "" ? undefined : Number(event.target.value);
            field.onChange(value);
            onValueChange?.(value);
          }}
        />
        {fieldState.error && <p role="alert">{fieldState.error.message}</p>}
      </div>
    );
  };
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

const beforeTax = () => screen.getByLabelText("Amount before tax");
const tax = () => screen.getByLabelText("Withholding tax");
const received = () => screen.getByLabelText("Received amount");
const enter = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

function renderDividend(defaultValues: Record<string, unknown> = {}, onSubmit = vi.fn()) {
  render(
    <DividendForm
      accounts={accounts}
      onSubmit={onSubmit}
      defaultValues={{ accountId: "acc-1", symbol: "AAPL", currency: "USD", ...defaultValues }}
    />,
  );
  return onSubmit;
}

describe("dividend amount before tax", () => {
  it("works out and saves the received amount", async () => {
    const onSubmit = renderDividend();

    enter(beforeTax(), "100");
    enter(tax(), "15");
    expect(received()).toHaveValue("85");

    await userEvent.click(screen.getByRole("button", { name: /add dividend/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 85, tax: 15 });
  });

  it("subtracts exactly", () => {
    renderDividend();

    enter(beforeTax(), "2.63");
    enter(tax(), "0.33");

    expect(received()).toHaveValue("2.3");
  });

  it("keeps a typed received amount and works out the amount before tax", () => {
    renderDividend();

    enter(received(), "85");
    enter(tax(), "15");

    expect(received()).toHaveValue("85");
    expect(beforeTax()).toHaveValue("100");
  });

  it("rebuilds the amount before tax when a saved dividend is edited", async () => {
    renderDividend({ amount: 85, tax: 15 });

    await waitFor(() => expect(beforeTax()).toHaveValue("100"));
    enter(tax(), "10");

    expect(received()).toHaveValue("90");
  });

  it("does the same for a return of capital", async () => {
    renderDividend({ subtype: ACTIVITY_SUBTYPES.RETURN_OF_CAPITAL, amount: 45, tax: 5 });

    await waitFor(() => expect(beforeTax()).toHaveValue("50"));
  });

  it("rejects a tax above the amount before tax", async () => {
    const onSubmit = renderDividend();

    enter(beforeTax(), "10");
    enter(tax(), "15");
    expect(received()).toHaveValue("0");

    await userEvent.click(screen.getByRole("button", { name: /add dividend/i }));
    expect(
      await screen.findByText("Tax and fees can't be more than the amount before tax."),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([ACTIVITY_SUBTYPES.DRIP, ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND])(
    "leaves a %s dividend's amount as it is",
    (subtype) => {
      renderDividend({ subtype, amount: 50, tax: 5 });

      expect(screen.queryByLabelText("Amount before tax")).toBeNull();
      expect(screen.getByLabelText("Dividend amount")).toHaveValue("50");
    },
  );
});

describe("interest amount before tax", () => {
  function renderInterest(defaultValues: Record<string, unknown> = {}) {
    render(
      <InterestForm
        accounts={accounts}
        onSubmit={vi.fn()}
        defaultValues={{ accountId: "acc-1", currency: "USD", ...defaultValues }}
      />,
    );
  }

  it("works out the received interest", () => {
    renderInterest();

    enter(beforeTax(), "2.63");
    enter(tax(), "0.33");

    expect(received()).toHaveValue("2.3");
  });

  it("leaves staking rewards as they are", () => {
    renderInterest({ subtype: ACTIVITY_SUBTYPES.STAKING_REWARD, amount: 5 });
    expect(screen.queryByLabelText("Amount before tax")).toBeNull();
  });

  it("leaves credit-card interest as it is", () => {
    renderInterest({ accountId: "card-1", amount: 12, tax: 1 });

    expect(screen.queryByLabelText("Amount before tax")).toBeNull();
    expect(screen.getByLabelText("Amount")).toHaveValue("12");
  });
});
