import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateISO } from "@/lib/utils";
import { RenewLoanDialog, type LoanRenewalInput } from "./renew-loan-dialog";

const adapters = vi.hoisted(() => ({
  recalculate: vi.fn().mockResolvedValue(null),
  payments: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/adapters", () => ({
  recalculateLoan: adapters.recalculate,
  calculateLoan: vi.fn(),
  getLoanPayments: adapters.payments,
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
  onOpenChange: vi.fn(),
  assetId: "loan",
  currency: "USD",
  interestRate: 4,
  metadata: {
    loan_projection: {
      version: 1,
      annualRate: 4,
      paymentAmount: 1000,
      frequency: "monthly",
      firstPaymentDate: "2026-02-01",
      amortizationEndDate: "2046-01-01",
    },
  },
  quoteHistory: [],
  maturity: null,
  mortgage: true,
  today: formatDateISO(new Date()),
  onSubmit: vi.fn(),
};

describe("renewal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the settings day when the stored maturity is unreadable", async () => {
    const today = "2026-03-01";
    const onSubmit = vi
      .fn<(renewal: LoanRenewalInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    const client = new QueryClient();
    render(
      <RenewLoanDialog
        {...props}
        maturity={new Date("invalid")}
        today={today}
        onSubmit={onSubmit}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Renew mortgage" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(formatDateISO(onSubmit.mock.calls[0][0].effectiveDate)).toBe(today);
  });

  it("estimates nothing without the loan's payments when reading them fails", async () => {
    adapters.payments.mockRejectedValueOnce(new Error("offline"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RenewLoanDialog {...props} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(adapters.payments).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        client.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" }),
      ).toHaveLength(1),
    );
    expect(adapters.recalculate).not.toHaveBeenCalled();
  });

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
        today={formatDateISO(new Date())}
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

  it("refuses a payment of zero instead of keeping the current one", () => {
    const client = new QueryClient();
    render(<RenewLoanDialog {...props} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const submit = screen.getByRole("button", { name: "Renew mortgage" });
    const payment = screen.getByLabelText("Payment", { selector: "input" });
    fireEvent.change(payment, { target: { value: "0" } });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // An empty field keeps the current payment.
    fireEvent.change(payment, { target: { value: "" } });
    expect(submit).toBeEnabled();
  });
});
