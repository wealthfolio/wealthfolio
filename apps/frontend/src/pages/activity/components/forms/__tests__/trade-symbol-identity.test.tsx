import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { InstrumentType, QuoteMode } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { ACTIVITY_FORM_CONFIG } from "../../../config/activity-form-config";
import type { AccountSelectOption } from "../fields";
import { BuyForm } from "../buy-form";
import { SellForm } from "../sell-form";

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: { baseCurrency: "USD" }, isLoading: false, error: null }),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({ holdings: [], isLoading: false }),
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  resolveSymbolQuote: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/components/ticker-search", () => ({
  __esModule: true,
  default: () => <div data-testid="symbol-search" />,
}));

// Every field but the symbol is a stand-in; the symbol field is the real one.
vi.mock("../fields", async () => {
  const { useFormContext } =
    await vi.importActual<typeof import("react-hook-form")>("react-hook-form");
  const { SymbolSearch } =
    await vi.importActual<typeof import("../fields/symbol-search")>("../fields/symbol-search");
  const Empty = () => null;
  const Group = ({
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
  );

  return {
    SymbolSearch,
    AccountSelect: Empty,
    DatePicker: Empty,
    AmountInput: Empty,
    ChargeLinesField: Empty,
    QuantityInput: Empty,
    TradeTotalInput: Empty,
    AssetTypeSelector: Empty,
    OptionContractFields: Empty,
    PositionIntentSelector: Empty,
    StockTradeIntentSelector: Empty,
    AdvancedOptionsSection: Group,
    FormSection: Group,
    NotesInput: ({ name }: { name: string }) => {
      const { register } = useFormContext();
      return <textarea data-testid="notes" {...register(name)} />;
    },
    createValidatedSubmit: vi.fn((form, handler) => form.handleSubmit(handler)),
  };
});

const accounts: AccountSelectOption[] = [{ value: "acc-1", label: "Brokerage", currency: "CAD" }];

// A manually priced USD equity, bought in a CAD account.
const storedActivity: Partial<ActivityDetails> = {
  accountId: "acc-1",
  date: new Date("2026-05-11T16:00:00Z"),
  assetId: "asset-retypeold",
  assetSymbol: "RETYPEOLD",
  assetQuoteMode: QuoteMode.MANUAL,
  instrumentType: InstrumentType.EQUITY,
  assetQuoteCcy: "USD",
  exchangeMic: "XTSE",
  currency: "CAD",
  quantity: "1",
  unitPrice: "2",
  amount: "2",
};

const storedIdentity = {
  assetId: "RETYPEOLD",
  exchangeMic: "XTSE",
  symbolInstrumentType: InstrumentType.EQUITY,
  symbolQuoteCcy: "USD",
  quoteMode: QuoteMode.MANUAL,
  currency: "CAD",
};

type TradeForm = ComponentType<{
  accounts: AccountSelectOption[];
  defaultValues?: object;
  onSubmit: (data: Record<string, unknown>) => void;
  isEditing?: boolean;
}>;

const forms = [
  ["BUY", BuyForm as unknown as TradeForm],
  ["SELL", SellForm as unknown as TradeForm],
] as const;

function renderEdit(type: "BUY" | "SELL", Form: TradeForm) {
  const onSubmit = vi.fn();
  render(
    <Form
      accounts={accounts}
      defaultValues={ACTIVITY_FORM_CONFIG[type].getDefaults(storedActivity, accounts)}
      onSubmit={onSubmit}
      isEditing
    />,
  );
  return onSubmit;
}

async function submitted(onSubmit: ReturnType<typeof vi.fn>) {
  await userEvent.click(screen.getByRole("button", { name: /update/i }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0][0] as Record<string, unknown>;
}

describe("trade edits with a manually priced symbol", () => {
  it.each(forms)("%s keeps the stored identity on an unchanged save", async (type, Form) => {
    const onSubmit = renderEdit(type, Form);

    expect(screen.getByTestId("symbol-input")).toHaveValue("RETYPEOLD");
    expect(await submitted(onSubmit)).toMatchObject(storedIdentity);
  });

  it.each(forms)("%s keeps the stored identity on a notes-only edit", async (type, Form) => {
    const onSubmit = renderEdit(type, Form);

    await userEvent.type(screen.getByTestId("notes"), "checked");

    expect(await submitted(onSubmit)).toMatchObject({ ...storedIdentity, comment: "checked" });
  });

  it.each(forms)("%s drops the stored identity for a typed symbol", async (type, Form) => {
    const onSubmit = renderEdit(type, Form);

    await userEvent.clear(screen.getByTestId("symbol-input"));
    await userEvent.type(screen.getByTestId("symbol-input"), "BTC");

    const data = await submitted(onSubmit);
    expect(data).toMatchObject({
      assetId: "BTC",
      quoteMode: QuoteMode.MANUAL,
      currency: "CAD",
      // The form's existing fallback for a symbol without a quote currency.
      symbolQuoteCcy: "CAD",
    });
    expect(data.symbolInstrumentType).toBeUndefined();
    expect(data.exchangeMic).toBeUndefined();
    expect(data.existingAssetId).toBeUndefined();
  });
});
