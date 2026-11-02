import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { DividendForm } from "../dividend-form";
import { InterestForm } from "../interest-form";
import type { AccountSelectOption } from "../fields";

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: { baseCurrency: "USD" }, isLoading: false, error: null }),
}));

// Fields that write to the form, so the forms' calculation effects run, and
// a symbol picker that resolves the asset as crypto.
vi.mock("../fields", async () => {
  const { useFormContext } =
    await vi.importActual<typeof import("react-hook-form")>("react-hook-form");
  const NumberField = ({ name }: { name: string }) => {
    const { register } = useFormContext();
    return (
      <input
        data-testid={`input-${name}`}
        type="number"
        step="any"
        {...register(name, { valueAsNumber: true })}
      />
    );
  };
  return {
    AccountSelect: () => null,
    DatePicker: () => null,
    NotesInput: () => null,
    AdvancedOptionsSection: () => null,
    FormSection: ({
      action,
      children,
    }: {
      action?: React.ReactNode;
      children?: React.ReactNode;
    }) => (
      <div>
        {action}
        {children}
      </div>
    ),
    SymbolSearch: () => {
      const { setValue } = useFormContext();
      return (
        <button type="button" onClick={() => setValue("symbolInstrumentType", "CRYPTO")}>
          Pick crypto asset
        </button>
      );
    },
    AmountInput: NumberField,
    QuantityInput: NumberField,
    createValidatedSubmit: vi.fn((form, handler) => form.handleSubmit(handler)),
  };
});

const accounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Brokerage", currency: "USD", accountType: "SECURITIES" },
];

describe("income amount after picking a crypto asset", () => {
  it.each([
    [
      "reinvested dividend",
      () => (
        <DividendForm
          accounts={accounts}
          onSubmit={vi.fn()}
          defaultValues={{
            accountId: "acc-1",
            currency: "USD",
            subtype: ACTIVITY_SUBTYPES.DRIP,
          }}
        />
      ),
    ],
    [
      "staking reward",
      () => (
        <InterestForm
          accounts={accounts}
          onSubmit={vi.fn()}
          defaultValues={{
            accountId: "acc-1",
            currency: "USD",
            subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
          }}
        />
      ),
    ],
  ])("recalculates a %s exactly once the asset turns out to be crypto", async (_, form) => {
    const user = userEvent.setup();
    render(form());

    await user.type(screen.getByTestId("input-quantity"), "0.00123");
    await user.type(screen.getByTestId("input-unitPrice"), "61234.56");
    await waitFor(() => expect(screen.getByTestId("input-amount")).toHaveValue(75.32));

    await user.click(screen.getByRole("button", { name: "Pick crypto asset" }));

    await waitFor(() => expect(screen.getByTestId("input-amount")).toHaveValue(75.3185088));
  });
});
