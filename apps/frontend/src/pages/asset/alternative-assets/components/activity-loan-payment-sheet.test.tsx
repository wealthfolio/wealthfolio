import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetails } from "@/lib/types";
import { ActivityLoanPaymentSheet } from "./activity-loan-payment-sheet";

const mocks = vi.hoisted(() => ({
  link: vi.fn<(activityId: string, link: unknown) => Promise<void>>(),
}));
vi.mock("@/adapters", () => ({ linkLoanPayment: mocks.link }));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [
      { id: "chequing", name: "Chequing", accountType: "CASH" },
      { id: "card", name: "Card", accountType: "CREDIT_CARD" },
    ],
  }),
}));
const projection = {
  version: 1,
  annualRate: 4,
  paymentAmount: 100,
  frequency: "monthly",
  firstPaymentDate: "2026-02-01",
};
vi.mock("@/hooks/use-alternative-assets", () => ({
  useAlternativeHoldings: () => ({
    data: [
      {
        id: "mortgage",
        name: "Mortgage",
        kind: "LIABILITY",
        currency: "CAD",
        metadata: { loan_projection: projection },
      },
      { id: "manual", name: "Manual", kind: "LIABILITY", currency: "CAD", metadata: {} },
      {
        id: "usd",
        name: "US loan",
        kind: "LIABILITY",
        currency: "USD",
        metadata: { loan_projection: projection },
      },
    ],
  }),
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
      <option value="" />
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const withdrawal = (overrides: Partial<ActivityDetails> = {}) =>
  ({
    id: "act",
    activityType: "WITHDRAWAL",
    accountId: "chequing",
    currency: "CAD",
    amount: "600",
    date: "2026-03-01T12:00:00Z",
    ...overrides,
  }) as unknown as ActivityDetails;

const show = (activity: ActivityDetails, onChanged = vi.fn()) =>
  render(
    <ActivityLoanPaymentSheet
      activity={activity}
      open
      onOpenChange={vi.fn()}
      onChanged={onChanged}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.link.mockResolvedValue(undefined);
});

describe("linking a withdrawal from its account", () => {
  it("offers calculated loans in the withdrawal's currency and links as extra", async () => {
    show(withdrawal());
    const loan = screen.getByRole("combobox", { name: "Loan" });
    expect([...loan.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "",
      "Mortgage",
    ]);
    fireEvent.change(loan, { target: { value: "mortgage" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Counts toward" }), {
      target: { value: "extra" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(mocks.link).toHaveBeenCalledWith("act", {
        type: "link",
        loanId: "mortgage",
        appliesTo: "extra",
      }),
    );
  });

  it("unlinks a withdrawal already counted on a loan and reports the change", async () => {
    const onChanged = vi.fn();
    show(withdrawal({ metadata: { loan_payment: { loan_id: "mortgage" } } }), onChanged);
    expect(screen.getByText("Counted as a payment on Mortgage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.link).toHaveBeenCalledWith("act", { type: "unlink" });
  });

  it("explains that only cash accounts pay loans", () => {
    show(withdrawal({ accountId: "card" }));
    expect(screen.queryByRole("combobox", { name: "Loan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link" })).not.toBeInTheDocument();
  });

  it("shows a refusal from the backend", async () => {
    mocks.link.mockRejectedValueOnce("LOAN_PAYMENT_NOT_ELIGIBLE");
    const onChanged = vi.fn();
    show(withdrawal(), onChanged);
    fireEvent.change(screen.getByRole("combobox", { name: "Loan" }), {
      target: { value: "mortgage" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a posted withdrawal from a cash account",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("offers to replace an extra repayment recorded for the same money", async () => {
    mocks.link.mockRejectedValueOnce("LOAN_PAYMENT_DUPLICATES_EVENT");
    const onChanged = vi.fn();
    show(withdrawal(), onChanged);
    fireEvent.change(screen.getByRole("combobox", { name: "Loan" }), {
      target: { value: "mortgage" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this withdrawal instead" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.link).toHaveBeenLastCalledWith("act", {
      type: "link",
      loanId: "mortgage",
      replaceEvent: true,
    });
  });

  it("drops the replace offer once the link it answers changes", async () => {
    mocks.link.mockRejectedValueOnce("LOAN_PAYMENT_DUPLICATES_EVENT");
    show(withdrawal());
    const loan = screen.getByRole("combobox", { name: "Loan" });
    fireEvent.change(loan, { target: { value: "mortgage" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByRole("button", { name: "Use this withdrawal instead" });
    fireEvent.change(loan, { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "Use this withdrawal instead" })).toBeNull();
  });
});
