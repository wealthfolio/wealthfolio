import type { ComponentProps, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanSheetEntry } from "../components/loan-event-sheet";
import type { LoanEvent } from "../lib/loan-events";
import { useLoanActions, type LoanActionCallbacks } from "./use-loan-actions";

type Dialogs = typeof import("../components/loan-action-dialogs");
const mocks = vi.hoisted(() => ({
  apply: vi.fn<(assetId: string, action: unknown) => Promise<void>>(),
  create: vi.fn<(activity: Record<string, unknown>) => Promise<{ id: string }>>(),
  link: vi.fn<(activityId: string, link: unknown) => Promise<void>>(),
  invalidateQuotes: vi.fn(),
  invalidateAssets: vi.fn(),
  toast: vi.fn(),
  balanceSheet: vi.fn<(props: ComponentProps<Dialogs["LoanBalanceEventDialog"]>) => void>(),
  closeSheet: vi.fn<(props: ComponentProps<Dialogs["CloseLoanDialog"]>) => void>(),
  recalcSheet: vi.fn<(props: ComponentProps<Dialogs["RecalculateScheduleDialog"]>) => void>(),
  eventSheet:
    vi.fn<
      (
        props: ComponentProps<typeof import("../components/loan-event-sheet").LoanEventSheet>,
      ) => void
    >(),
  renewal:
    vi.fn<
      (
        props: ComponentProps<typeof import("../components/renew-loan-dialog").RenewLoanDialog>,
      ) => void
    >(),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));
vi.mock("@/adapters", () => ({
  applyLoanAction: mocks.apply,
  createActivity: mocks.create,
  linkLoanPayment: mocks.link,
  calculateLoan: vi.fn(),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [
      { id: "chequing", name: "Chequing", accountType: "CASH", currency: "CAD", isActive: true },
      { id: "closed", name: "Closed", accountType: "CASH", currency: "CAD", isActive: false },
    ],
  }),
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));
vi.mock("../../hooks/use-quote-mutations", () => ({
  useQuoteMutations: () => ({ invalidateQuoteQueries: mocks.invalidateQuotes }),
}));
vi.mock("./use-alternative-asset-mutations", () => ({
  invalidateAlternativeAssetQueries: mocks.invalidateAssets,
}));
vi.mock("./use-loan-calculation", async (original) => ({
  ...(await original<typeof import("./use-loan-calculation")>()),
  useLoanCalculation: () => ({
    data: {
      calculationStartDate: "2026-01-01",
      currentBalance: 500,
      frequency: "biweekly",
      annualRate: 4,
      interestMethod: "monthly",
      rows: [],
    },
  }),
}));
vi.mock("../components/loan-event-sheet", () => ({
  LoanEventSheet: (
    props: ComponentProps<typeof import("../components/loan-event-sheet").LoanEventSheet>,
  ) => {
    mocks.eventSheet(props);
    return null;
  },
}));
vi.mock("../components/loan-action-dialogs", () => ({
  CloseLoanDialog: (props: ComponentProps<Dialogs["CloseLoanDialog"]>) => {
    mocks.closeSheet(props);
    return null;
  },
  LoanBalanceEventDialog: (props: ComponentProps<Dialogs["LoanBalanceEventDialog"]>) => {
    mocks.balanceSheet(props);
    return null;
  },
  RecalculateScheduleDialog: (props: ComponentProps<Dialogs["RecalculateScheduleDialog"]>) => {
    mocks.recalcSheet(props);
    return null;
  },
}));
vi.mock("../components/renew-loan-dialog", () => ({
  RenewLoanDialog: (
    props: ComponentProps<typeof import("../components/renew-loan-dialog").RenewLoanDialog>,
  ) => {
    mocks.renewal(props);
    return null;
  },
}));

const quote = {
  id: "apr",
  timestamp: "2026-04-01T00:00:00Z",
  close: 500,
  notes: "loan_event|type=balance_correction",
} as Quote;
const extra: LoanEvent = { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 100 };
const projection = {
  version: 1,
  annualRate: 0,
  paymentAmount: 100,
  frequency: "monthly",
  firstPaymentDate: "2026-02-01",
  amortizationEndDate: "2027-01-01",
};
const holding = (metadata: Record<string, unknown> = {}) =>
  ({
    id: "loan",
    kind: "liability",
    currency: "CAD",
    metadata: { loan_projection: projection, loan_events: [extra], ...metadata },
  }) as unknown as AlternativeAssetHolding;

let actions: LoanActionCallbacks;
let availability: ReturnType<typeof useLoanActions>["availability"];
function Harness({ loan }: { loan: AlternativeAssetHolding }) {
  const result = useLoanActions(loan, [quote]);
  actions = result.actions;
  availability = result.availability;
  return result.dialogs;
}
const show = (loan = holding()) =>
  render(<Harness loan={loan} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    ),
  });
const sent = () => mocks.apply.mock.lastCall;
const saveSheet = (entry: LoanSheetEntry | null) =>
  mocks.eventSheet.mock.lastCall![0].onSave(entry);
const balanceSubmit = (mode: "extra_repayment" | "balance_correction") =>
  mocks.balanceSheet.mock.calls.filter(([props]) => props.mode === mode).at(-1)![0].onSubmit;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apply.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ id: "withdrawal" });
  mocks.link.mockResolvedValue(undefined);
});

describe("loan actions are single backend calls", () => {
  it("edits a recorded balance and refreshes balances and holdings", async () => {
    show();
    act(() => actions.editBalance(quote));
    await act(async () => {
      await saveSheet({
        type: "balance_correction",
        effectiveDate: "2026-04-15",
        balance: 450,
        note: "Statement",
      });
    });
    expect(sent()).toEqual([
      "loan",
      {
        type: "edit_balance",
        quoteId: "apr",
        replacement: { date: "2026-04-15", balance: 450, note: "Statement" },
      },
    ]);
    expect(mocks.invalidateAssets).toHaveBeenCalled();
    expect(mocks.invalidateQuotes).toHaveBeenCalled();
  });

  it("deletes a balance without a replacement", async () => {
    show();
    act(() => actions.editBalance(quote));
    await act(async () => {
      await saveSheet(null);
    });
    expect(sent()).toEqual(["loan", { type: "edit_balance", quoteId: "apr", replacement: null }]);
  });

  it("passes a refusal back to the sheet without refreshing anything", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("LOAN_BALANCE_DATE_TAKEN"));
    show();
    act(() => actions.editBalance(quote));
    await expect(
      saveSheet({ type: "balance_correction", effectiveDate: "2026-03-01", balance: 450 }),
    ).rejects.toThrow("LOAN_BALANCE_DATE_TAKEN");
    expect(mocks.invalidateAssets).not.toHaveBeenCalled();
  });

  it("reloads the loan when its copy was stale", async () => {
    mocks.apply.mockRejectedValueOnce("LOAN_EVENT_CHANGED");
    show();
    act(() => actions.editEvent(0));
    await expect(saveSheet({ ...extra, amount: 150 })).rejects.toBe("LOAN_EVENT_CHANGED");
    expect(mocks.invalidateAssets).toHaveBeenCalled();
    expect(mocks.invalidateQuotes).toHaveBeenCalled();
  });

  it("names the edited event by position and stored value", async () => {
    show();
    act(() => actions.editEvent(0));
    const replacement = { ...extra, amount: 150 };
    await act(async () => {
      await saveSheet(replacement);
    });
    expect(sent()).toEqual([
      "loan",
      { type: "edit_event", index: 0, original: extra, replacement },
    ]);
  });

  it("sends a renewal with only what the dialog stated", async () => {
    show(holding({ sub_type: "mortgage" }));
    await act(async () => {
      await mocks.renewal.mock.lastCall![0].onSubmit({
        effectiveDate: new Date(2026, 2, 10),
        annualRate: 3,
      });
    });
    expect(sent()).toEqual(["loan", { type: "renew", date: "2026-03-10", annualRate: 3 }]);
    await act(async () => {
      await mocks.renewal.mock.lastCall![0].onSubmit({
        effectiveDate: new Date(2026, 2, 10),
        annualRate: 3,
        frequency: "biweekly",
        paymentAmount: 300,
        termEndDate: new Date(2029, 2, 10),
        balance: 640,
      });
    });
    expect(sent()).toEqual([
      "loan",
      {
        type: "renew",
        date: "2026-03-10",
        annualRate: 3,
        frequency: "biweekly",
        paymentAmount: 300,
        termEndDate: "2029-03-10",
        balance: 640,
      },
    ]);
  });

  it("sends recalculation, confirmation and repayment on their calendar day", async () => {
    show();
    await act(async () => {
      await mocks.recalcSheet.mock.lastCall![0].onSubmit(0, new Date(2026, 2, 1));
    });
    expect(sent()).toEqual(["loan", { type: "recalculate", date: "2026-03-01", annualRate: 0 }]);
    await act(async () => {
      await balanceSubmit("balance_correction")(new Date(2026, 3, 2), 480);
    });
    expect(sent()).toEqual(["loan", { type: "confirm_balance", date: "2026-04-02", balance: 480 }]);
    await act(async () => {
      await balanceSubmit("extra_repayment")(new Date(2026, 3, 2), 100);
    });
    expect(sent()).toEqual(["loan", { type: "extra_repayment", date: "2026-04-02", amount: 100 }]);
  });

  it("reports a refused closure, which has no inline error", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("LOAN_CLOSURE_DATE_INVALID"));
    show();
    await act(async () => {
      await mocks.closeSheet.mock.lastCall![0].onSubmit(new Date(2026, 5, 1));
    });
    expect(sent()).toEqual(["loan", { type: "close", date: "2026-06-01" }]);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "The closure date must be between origination and today.",
      variant: "destructive",
    });
  });
});

it("treats a loan switched back to manual as manual despite its stored terms", () => {
  show(holding({ sub_type: "mortgage", tracking_mode: "manual" }));
  expect(availability).toMatchObject({ renew: false, recalculate: false });
});

it("records a suggested payment change as one action", async () => {
  show();
  await act(async () => {
    await actions.changePayment("2026-03-01", 110);
  });
  expect(sent()).toEqual([
    "loan",
    { type: "change_payment", date: "2026-03-01", paymentAmount: 110 },
  ]);
});

describe("extra repayments from the paid from account", () => {
  it("records the withdrawal and links it as extra principal instead of an event", async () => {
    show(holding({ payment_account_id: "chequing" }));
    expect(
      mocks.balanceSheet.mock.calls.filter(([props]) => props.mode === "extra_repayment").at(-1)![0]
        .paidFrom,
    ).toBe("Chequing");
    await act(async () => {
      await balanceSubmit("extra_repayment")(new Date(2026, 3, 2), 100);
    });
    expect(mocks.create).toHaveBeenCalledWith({
      accountId: "chequing",
      activityType: "WITHDRAWAL",
      activityDate: "2026-04-02",
      amount: 100,
      currency: "CAD",
    });
    expect(mocks.link).toHaveBeenCalledWith("withdrawal", {
      type: "link",
      loanId: "loan",
      appliesTo: "extra",
      escrow: 0,
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses a repayment before the loan's history starts without recording a withdrawal", async () => {
    show(holding({ payment_account_id: "chequing" }));
    await expect(balanceSubmit("extra_repayment")(new Date(2025, 11, 15), 100)).rejects.toThrow(
      "LOAN_INVALID",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("refuses an extra repayment already recorded without recording a withdrawal", async () => {
    show(holding({ payment_account_id: "chequing" }));
    await expect(balanceSubmit("extra_repayment")(new Date(2026, 2, 1), 100)).rejects.toThrow(
      "LOAN_EXTRA_ALREADY_RECORDED",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("records an event once the paid from account no longer qualifies", async () => {
    show(holding({ payment_account_id: "closed" }));
    expect(
      mocks.balanceSheet.mock.calls.filter(([props]) => props.mode === "extra_repayment").at(-1)![0]
        .paidFrom,
    ).toBeUndefined();
    await act(async () => {
      await balanceSubmit("extra_repayment")(new Date(2026, 3, 2), 100);
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(sent()).toEqual(["loan", { type: "extra_repayment", date: "2026-04-02", amount: 100 }]);
  });

  it("keeps recording an event for a manual loan", async () => {
    show(holding({ payment_account_id: "chequing", tracking_mode: "manual" }));
    await act(async () => {
      await balanceSubmit("extra_repayment")(new Date(2026, 3, 2), 100);
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(sent()).toEqual(["loan", { type: "extra_repayment", date: "2026-04-02", amount: 100 }]);
  });
});
