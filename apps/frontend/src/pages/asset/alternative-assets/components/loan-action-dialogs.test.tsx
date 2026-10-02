import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { Quote } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { LoanBalanceEventDialog, RenewLoanDialog } from "./loan-action-dialogs";

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

const props = {
  open: true,
  mode: "extra_repayment" as const,
  currentBalance: 1000,
  currency: "USD",
  onOpenChange: vi.fn(),
  onSubmit: vi.fn().mockResolvedValue(undefined),
};

describe("extra repayment validation", () => {
  it("does not show an error for the untouched initial amount", () => {
    render(<LoanBalanceEventDialog {...props} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record Repayment" })).toBeDisabled();
  });

  it("validates on blur and clears the error when the amount becomes valid", () => {
    render(<LoanBalanceEventDialog {...props} />);
    const input = screen.getByLabelText("Repayment Amount");
    fireEvent.focus(input);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "100" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record Repayment" })).toBeEnabled();
  });

  it("resets validation when reopened", () => {
    const { rerender } = render(<LoanBalanceEventDialog {...props} />);
    fireEvent.blur(screen.getByLabelText("Repayment Amount"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<LoanBalanceEventDialog {...props} open={false} />);
    rerender(<LoanBalanceEventDialog {...props} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a submission error and clears it after editing", async () => {
    render(
      <LoanBalanceEventDialog
        {...props}
        onSubmit={vi.fn().mockRejectedValue(new Error("Balance changed"))}
      />,
    );
    const input = screen.getByLabelText("Repayment Amount");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Repayment" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Balance changed"));
    fireEvent.change(input, { target: { value: "50" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when a recorded balance on or after the date will override the repayment", () => {
    const balance = (date: string) =>
      ({ id: date, timestamp: `${date}T00:00:00Z`, close: 500_000 }) as Quote;
    const { rerender } = render(
      <LoanBalanceEventDialog {...props} confirmations={[balance("2020-01-01")]} />,
    );
    expect(screen.queryByText(/takes priority/)).not.toBeInTheDocument();
    rerender(
      <LoanBalanceEventDialog {...props} confirmations={[balance(formatDateISO(new Date()))]} />,
    );
    expect(screen.getByText(/takes priority/)).toHaveTextContent("500,000");
  });
});

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
