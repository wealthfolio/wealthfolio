import { useActivityCurrency } from "./use-activity-currency";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Controller, FormProvider, useForm } from "react-hook-form";
import { AccountSelect, type AccountSelectOption } from "../components/forms/fields/account-select";

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
  useActivityCurrency(form, accounts, { isEditing });
  const currency = form.watch("currency");

  return (
    <FormProvider {...form}>
      <AccountSelect<FormValues> name="accountId" accounts={accounts} />
      <button type="button" onClick={() => form.setValue("currency", "GBP", { shouldDirty: true })}>
        Change currency
      </button>
      <button type="button" onClick={() => form.setValue("fxRate", 1.5, { shouldDirty: true })}>
        Replace FX
      </button>
      <button
        type="button"
        onClick={() => form.reset({ accountId: "acc-usd", currency: "JPY", fxRate: 0.01 })}
      >
        Load another activity
      </button>
      <div data-testid="currency-value">{currency}</div>
      <output data-testid="fx-rate">{JSON.stringify(form.watch("fxRate"))}</output>
      <button type="button" onClick={() => form.setValue("accountId", "acc-eur")}>
        Return to EUR account
      </button>
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

describe("useActivityCurrency", () => {
  it("keeps FX invalidated after switching back, but retains a replacement entered afterward", () => {
    const defaults = { accountId: "acc-eur", currency: "GBP", fxRate: 1.2 };
    const { rerender } = render(
      <TestHarness accounts={accounts} isEditing defaultValues={defaults} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to EUR account" }));
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Replace FX" }));
    rerender(<TestHarness accounts={[...accounts]} isEditing defaultValues={defaults} />);
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.5");
  });

  it("invalidates an explicit currency change and keeps a subsequently entered rate", () => {
    render(
      <TestHarness
        accounts={accounts}
        isEditing
        defaultValues={{ accountId: "acc-usd", currency: "EUR", fxRate: 1.2 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("null");
    fireEvent.click(screen.getByRole("button", { name: "Replace FX" }));
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.5");
    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.5");
  });
  it("preserves a manually selected currency on new activities", () => {
    render(
      <TestHarness accounts={accounts} defaultValues={{ accountId: "acc-eur", currency: "EUR" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
  });
  it("retains the loaded FX rate on reset and then tracks changes from the new baseline", () => {
    render(
      <TestHarness
        accounts={accounts}
        isEditing
        defaultValues={{ accountId: "acc-eur", currency: "GBP", fxRate: 1.2 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load another activity" }));
    expect(screen.getByTestId("currency-value")).toHaveTextContent("JPY");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("0.01");
    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("null");
  });
  it("preserves a saved rate when account options arrive asynchronously", () => {
    const defaults = { accountId: "acc-eur", currency: "GBP", fxRate: 1.2 };
    const { rerender } = render(<TestHarness accounts={[]} isEditing defaultValues={defaults} />);
    rerender(<TestHarness accounts={accounts} isEditing defaultValues={defaults} />);
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.2");
    fireEvent.click(screen.getByRole("button", { name: "Choose USD account" }));
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("null");
  });
  it("backfills an empty currency when account options arrive asynchronously", () => {
    const defaults = { accountId: "acc-eur", currency: "" };
    const { rerender } = render(<TestHarness accounts={[]} defaultValues={defaults} />);
    rerender(<TestHarness accounts={accounts} defaultValues={defaults} />);
    expect(screen.getByTestId("currency-value")).toHaveTextContent("EUR");
  });

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
