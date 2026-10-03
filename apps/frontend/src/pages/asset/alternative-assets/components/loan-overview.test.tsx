import { fireEvent, render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import type { AlternativeAssetHolding } from "@/lib/types";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";
import { LoanOverview, MortgageOverview } from "./loan-overview";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));
vi.mock("./loan-timeline", () => ({ LoanTimeline: () => null }));
vi.mock("@/hooks/use-alternative-assets", () => ({ useLinkedLiabilities: () => ({ data: [] }) }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

const holding = (extra: Record<string, unknown> = {}) =>
  ({
    id: "loan",
    kind: "liability",
    currency: "USD",
    marketValue: -900,
    metadata: {
      sub_type: "mortgage",
      origination_date: "2025-01-01",
      original_amount: "1000",
      loan_projection: {
        version: 1,
        annualRate: 2,
        paymentAmount: 100,
        frequency: "monthly",
        firstPaymentDate: "2025-02-01",
        amortizationEndDate: "2045-01-01",
      },
      ...extra,
    },
  }) as unknown as AlternativeAssetHolding;
const row = (date: string, balance: number) => ({
  date,
  balance,
  openingBalance: balance + 99,
  payment: 100,
  principal: 99,
  interest: 1,
  confirmed: false,
  balanceAdjustment: 0,
  extraPayment: 0,
  scheduledPayment: true,
});
const calculation = (payoffDate = "2045-01-01"): LoanCalculation => ({
  currentBalance: 900,
  annualRate: 2,
  paymentAmount: 100,
  frequency: "monthly",
  interestMethod: "nominal_periodic",
  calculationStartDate: "2025-01-01",
  rows: [row("2040-01-01", 99), row(payoffDate, 0)],
  remainingPayments: 2,
  interestToDate: 10,
  projectedInterest: 2,
  residualBalance: 0,
  residualInterest: 0,
  payoffDate,
  allocations: [],
  instalments: [],
  paymentSuggestion: null,
});
const actions = {
  renew: vi.fn(),
  confirmBalance: vi.fn(),
  editEvent: vi.fn(),
} as unknown as LoanActionCallbacks;

describe("loan overview", () => {
  it("shows a mortgage without a renewal date as one loan term", () => {
    const onEdit = vi.fn();
    render(
      <MortgageOverview
        holding={holding()}
        calculation={calculation()}
        quotes={[]}
        actions={actions}
        onEdit={onEdit}
      />,
      { wrapper: TooltipProvider },
    );
    expect(screen.queryByTestId("loan-term-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("loan-summary-header")).toHaveTextContent("Loan term");
    fireEvent.click(screen.getByRole("button", { name: "Add renewal date" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("shows the current term once a renewal date is set", () => {
    render(
      <MortgageOverview
        holding={holding({ renewal_maturity_date: "2040-06-01" })}
        calculation={calculation()}
        quotes={[]}
        actions={actions}
        onEdit={vi.fn()}
      />,
      { wrapper: TooltipProvider },
    );
    expect(screen.getByTestId("loan-term-card")).toBeInTheDocument();
    expect(screen.getByTestId("loan-summary-header")).toHaveTextContent("Current term");
    expect(screen.queryByRole("button", { name: "Add renewal date" })).not.toBeInTheDocument();
  });

  it("shows the original payoff only when the estimate differs from it", () => {
    const view = (payoff?: string) => (
      <LoanOverview
        holding={holding({ sub_type: "auto" })}
        calculation={calculation(payoff)}
        quotes={[]}
        actions={actions}
        onEdit={vi.fn()}
      />
    );
    const { rerender } = render(view(), { wrapper: TooltipProvider });
    expect(screen.queryByText("Original payoff")).not.toBeInTheDocument();
    // Only mortgages renew.
    expect(screen.queryByRole("button", { name: "Add renewal date" })).not.toBeInTheDocument();
    rerender(view("2043-01-01"));
    expect(screen.getByText("Original payoff")).toBeInTheDocument();
  });
});
