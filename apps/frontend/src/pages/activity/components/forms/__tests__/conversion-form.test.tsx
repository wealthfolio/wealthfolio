import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversionForm, conversionFormSchema } from "../conversion-form";
import type { AccountSelectOption } from "../fields";

const holdings = vi.hoisted(() => ({
  quantity: 10,
  others: [] as { id: string; instrument: { id: string; symbol: string }; quantity: number }[],
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({
    holdings: [
      ...holdings.others,
      { id: "h-1", instrument: { id: "asset-a", symbol: "FUNDA" }, quantity: holdings.quantity },
    ],
    isLoading: false,
  }),
}));

vi.mock("../fields", () => ({
  AccountSelect: ({ name }: { name: string }) => <select data-testid={`select-${name}`} />,
  SymbolSearch: ({ name, label }: { name: string; label?: string }) => (
    <input data-testid={`symbol-search-${name}`} aria-label={label} />
  ),
  DatePicker: ({ name }: { name: string }) => <div data-testid={`date-picker-${name}`} />,
  QuantityInput: ({ name }: { name: string }) => <input data-testid={`input-${name}`} />,
  NotesInput: ({ name }: { name: string }) => <textarea data-testid={`textarea-${name}`} />,
  FormSection: ({ title, children }: { title?: string; children?: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  createValidatedSubmit: vi.fn((_form, handler) => handler),
}));

const accounts: AccountSelectOption[] = [{ value: "acc-1", label: "Broker", currency: "EUR" }];

const valid = {
  accountId: "acc-1",
  activityDate: new Date("2026-02-03T00:00:00Z"),
  fromAssetId: "FUNDA",
  fromExistingAssetId: "asset-a",
  fromQuantity: 25,
  toAssetId: "FUNDB",
  toExistingAssetId: "asset-b",
  toQuantity: 40,
};

describe("conversion form schema", () => {
  it("accepts one asset leaving and another arriving", () => {
    expect(conversionFormSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["two existing assets sharing a symbol", { toAssetId: "FUNDA", toExistingAssetId: "asset-c" }],
    [
      "a new listing of the symbol on another venue",
      { toAssetId: "FUNDA", toExistingAssetId: null, toExchangeMic: "XLON" },
    ],
  ])("accepts %s", (_case, to) => {
    expect(conversionFormSchema.safeParse({ ...valid, ...to }).success).toBe(true);
  });

  it.each([
    ["the same symbol", { toAssetId: "funda", toExistingAssetId: null }],
    ["the same asset", { toAssetId: "OTHER", toExistingAssetId: "asset-a" }],
  ])("refuses converting into %s", (_case, to) => {
    const result = conversionFormSchema.safeParse({ ...valid, ...to });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["toAssetId"]);
  });

  it.each(["fromQuantity", "toQuantity"])("requires units on both sides (%s)", (field) => {
    expect(conversionFormSchema.safeParse({ ...valid, [field]: 0 }).success).toBe(false);
  });
});

describe("ConversionForm", () => {
  it("warns, without blocking, when more units leave than the account holds today", () => {
    holdings.quantity = 10;
    render(<ConversionForm accounts={accounts} defaultValues={valid} onSubmit={vi.fn()} />);
    expect(
      screen.getByText(/You are converting 25 units, but this account holds 10 today/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add Fund Conversion/ })).not.toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows no warning when the account holds the units", () => {
    holdings.quantity = 30;
    render(<ConversionForm accounts={accounts} defaultValues={valid} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/You are converting/)).toBeNull();
  });

  it("counts the units of the asset picked, not of another listing of its symbol", () => {
    holdings.quantity = 10;
    holdings.others = [
      { id: "h-x", instrument: { id: "asset-x", symbol: "FUNDA" }, quantity: 100 },
    ];
    render(<ConversionForm accounts={accounts} defaultValues={valid} onSubmit={vi.fn()} />);
    holdings.others = [];
    expect(
      screen.getByText(/You are converting 25 units, but this account holds 10 today/),
    ).toBeTruthy();
  });
});
