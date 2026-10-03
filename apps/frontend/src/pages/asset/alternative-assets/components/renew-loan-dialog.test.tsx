import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { RenewLoanDialog } from "./renew-loan-dialog";

vi.mock("@/adapters", () => ({
  recalculateLoan: vi.fn().mockResolvedValue(null),
  calculateLoan: vi.fn(),
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  ResponsiveSelect: ({
    value,
    onValueChange,
    options,
    "aria-label": label,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    "aria-label"?: string;
  }) => (
    <select
      aria-label={label}
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

describe("renewal", () => {
  it("asks for the payment when the renewal changes the frequency", () => {
    const client = new QueryClient();
    render(
      <RenewLoanDialog
        open
        onOpenChange={vi.fn()}
        assetId="loan"
        currency="USD"
        interestRate={4}
        metadata={{
          loan_projection: {
            version: 1,
            annualRate: 4,
            paymentAmount: 1000,
            frequency: "monthly",
            firstPaymentDate: "2026-02-01",
            amortizationEndDate: "2046-01-01",
          },
        }}
        quoteHistory={[]}
        maturity={null}
        mortgage
        onSubmit={vi.fn()}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    const submit = screen.getByRole("button", { name: "Renew mortgage" });
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Payment frequency" }), {
      target: { value: "biweekly" },
    });
    expect(screen.getByText("Enter the payment for the new frequency.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });
});
