import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AlternativeAssetKind } from "@/lib/types";
import { AlternativeAssetQuickAddModal } from "./alternative-asset-quick-add-modal";

const create = vi.hoisted(() => vi.fn().mockResolvedValue({ assetId: "created" }));
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
  QuantityInput: () => null,
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
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label="Type" value={value} onChange={(event) => onValueChange(event.target.value)}>
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
    expect(await screen.findByRole("combobox")).toHaveValue(defaultLiabilityType ?? "mortgage");
    fireEvent.change(screen.getAllByLabelText("Amount")[0], { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "liability",
          metadata: { sub_type: defaultLiabilityType ?? "mortgage" },
        }),
      ),
    );
  },
);
