import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Controller, FormProvider, useForm } from "react-hook-form";
import { AccountSelect, type AccountSelectOption } from "../account-select";

vi.mock("@wealthfolio/ui", () => ({
  FormControl: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FormField: ({
    control,
    name,
    render,
  }: {
    control: unknown;
    name: string;
    render: (props: { field: Record<string, unknown> }) => React.ReactNode;
  }) => <Controller control={control as never} name={name as never} render={render as never} />,
  FormItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FormLabel: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  FormMessage: () => null,
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-testid="account-select" data-value={value}>
      <button type="button" onClick={() => onValueChange?.("acc-usd")}>
        Choose USD account
      </button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

interface FormValues {
  accountId: string;
  currency: string;
  fxRate?: number | null;
}

interface TestHarnessProps {
  defaultValues: FormValues;
  accounts: AccountSelectOption[];
}

function TestHarness({ defaultValues, accounts }: TestHarnessProps) {
  const form = useForm<FormValues>({ defaultValues });
  const currency = form.watch("currency");

  return (
    <FormProvider {...form}>
      <AccountSelect<FormValues> name="accountId" accounts={accounts} />
      <div data-testid="currency-value">{currency}</div>
      <output data-testid="fx-rate">{JSON.stringify(form.watch("fxRate"))}</output>
      <button type="button" onClick={() => form.setValue("accountId", "acc-usd")}>
        Select USD account
      </button>
    </FormProvider>
  );
}

const accounts: AccountSelectOption[] = [
  { value: "acc-eur", label: "EUR Account", currency: "EUR" },
  { value: "acc-usd", label: "USD Account", currency: "USD" },
];

describe("AccountSelect", () => {
  it("changes only the account, leaving currency and FX to the activity form", () => {
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{ accountId: "acc-eur", currency: "GBP", fxRate: 1.2 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    expect(screen.getByTestId("account-select")).toHaveAttribute("data-value", "acc-usd");
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.2");
  });
  it("does not fill currency on mount", () => {
    render(
      <TestHarness accounts={accounts} defaultValues={{ accountId: "acc-eur", currency: "" }} />,
    );
    expect(screen.getByTestId("currency-value")).toBeEmptyDOMElement();
  });
});
