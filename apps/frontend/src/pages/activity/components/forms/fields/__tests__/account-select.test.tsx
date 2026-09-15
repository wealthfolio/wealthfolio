import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  isEditing?: boolean;
}

function TestHarness({ defaultValues, accounts, isEditing }: TestHarnessProps) {
  const form = useForm<FormValues>({ defaultValues });
  const currency = form.watch("currency");

  return (
    <FormProvider {...form}>
      <AccountSelect<FormValues>
        name="accountId"
        accounts={accounts}
        currencyName="currency"
        isEditing={isEditing}
        {...{ fxRateName: "fxRate" as const }}
      />
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
  it.each(["EUR", "USD"])("invalidates only a changed account currency (%s)", (currency) => {
    render(
      <TestHarness
        accounts={[{ value: "old-account", label: "Old", currency }, ...accounts]}
        defaultValues={{ accountId: "old-account", currency: "GBP", fxRate: 1.2 }}
        isEditing
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent(currency === "USD" ? "1.2" : "null");
  });
  it.each([true, false])("handles an explicit account change with isEditing=%s", (isEditing) => {
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{ accountId: "acc-eur", currency: "EUR" }}
        isEditing={isEditing}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    expect(screen.getByTestId("account-select")).toHaveAttribute("data-value", "acc-usd");
    expect(screen.getByTestId("currency-value")).toHaveTextContent(isEditing ? "EUR" : "USD");
  });
  it("does not overwrite a prefilled currency when editing", async () => {
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{
          accountId: "acc-eur",
          currency: "USD",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("currency-value")).toHaveTextContent("USD");
    });
  });

  it("backfills currency when account is preselected and currency is empty", async () => {
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{
          accountId: "acc-eur",
          currency: "",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("currency-value")).toHaveTextContent("EUR");
    });
  });

  it("reflects programmatic account changes", async () => {
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{
          accountId: "acc-eur",
          currency: "EUR",
        }}
      />,
    );

    expect(screen.getByTestId("account-select")).toHaveAttribute("data-value", "acc-eur");

    screen.getByRole("button", { name: "Select USD account" }).click();

    await waitFor(() => {
      expect(screen.getByTestId("account-select")).toHaveAttribute("data-value", "acc-usd");
    });
  });
});
