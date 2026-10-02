import type { ComponentProps } from "react";
import { act, render } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import { calculateLoan } from "@/adapters";
import type { LoanSheetEntry } from "../components/loan-event-sheet";
import type { LoanEvent } from "../lib/loan-events";
import { useLoanActions, type LoanActionCallbacks } from "./use-loan-actions";

const mocks = vi.hoisted(() => ({
  balanceSheet:
    vi.fn<
      (
        props: ComponentProps<
          typeof import("../components/loan-action-dialogs").LoanBalanceEventDialog
        >,
      ) => void
    >(),
  save: vi.fn(),
  remove: vi.fn(),
  metadata:
    vi.fn<(input: { assetId: string; metadata: Record<string, string> }) => Promise<void>>(),
  invalidate: vi.fn(),
  recalculate: vi.fn(),
  eventSheet:
    vi.fn<
      (
        props: ComponentProps<typeof import("../components/loan-event-sheet").LoanEventSheet>,
      ) => void
    >(),
  renewal:
    vi.fn<
      (
        props: ComponentProps<typeof import("../components/loan-action-dialogs").RenewLoanDialog>,
      ) => void
    >(),
  recalcSheet:
    vi.fn<
      (
        props: ComponentProps<
          typeof import("../components/loan-action-dialogs").RecalculateScheduleDialog
        >,
      ) => void
    >(),
}));
vi.mock("@/adapters", () => ({ calculateLoan: vi.fn(), recalculateLoan: mocks.recalculate }));
vi.mock("../../hooks/use-quote-mutations", () => ({
  useQuoteMutations: () => ({
    saveQuoteMutation: { mutateAsync: mocks.save },
    deleteQuoteMutation: { mutateAsync: mocks.remove },
    invalidateQuoteQueries: mocks.invalidate,
  }),
}));
vi.mock("./use-alternative-asset-mutations", () => ({
  useAlternativeAssetMutations: () => ({ updateMetadataMutation: { mutateAsync: mocks.metadata } }),
}));
vi.mock("./use-loan-calculation", async (original) => ({
  ...(await original<typeof import("./use-loan-calculation")>()),
  useLoanCalculation: () => ({
    data: { currentBalance: 500, frequency: "biweekly", annualRate: 4, interestMethod: "monthly" },
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
  CloseLoanDialog: () => null,
  LoanBalanceEventDialog: (
    props: ComponentProps<
      typeof import("../components/loan-action-dialogs").LoanBalanceEventDialog
    >,
  ) => {
    mocks.balanceSheet(props);
    return null;
  },
  RenewLoanDialog: (
    props: ComponentProps<typeof import("../components/loan-action-dialogs").RenewLoanDialog>,
  ) => {
    mocks.renewal(props);
    return null;
  },
  RecalculateScheduleDialog: (
    props: ComponentProps<
      typeof import("../components/loan-action-dialogs").RecalculateScheduleDialog
    >,
  ) => {
    mocks.recalcSheet(props);
    return null;
  },
}));

const quote = {
  id: "apr",
  timestamp: "2026-04-01T00:00:00Z",
  close: 500,
  notes: "loan_event|type=balance_correction",
} as Quote;
const correction = {
  type: "balance_correction",
  effectiveDate: "2026-04-01",
  balance: 500,
} as const;
const holding = {
  id: "loan",
  kind: "liability",
  currency: "CAD",
  metadata: {
    loan_projection: {
      version: 1,
      annualRate: 0,
      paymentAmount: 100,
      frequency: "monthly",
      firstPaymentDate: "2026-02-01",
      amortizationEndDate: "2027-01-01",
    },
    loan_events: [],
  },
} as unknown as AlternativeAssetHolding;
let actions: LoanActionCallbacks;
let availability: ReturnType<typeof useLoanActions>["availability"];
function Harness({ quotes = [quote] }: { quotes?: Quote[] }) {
  const result = useLoanActions(holding, quotes);
  actions = result.actions;
  availability = result.availability;
  return result.dialogs;
}
const edit = () => act(() => actions.editBalance(quote));
const save = (entry: LoanSheetEntry | null) => mocks.eventSheet.mock.lastCall![0].onSave(entry);
beforeEach(() => vi.clearAllMocks());

describe("loan action persistence", () => {
  it("does not mutate anything when a moved balance would overwrite another date", async () => {
    render(
      <Harness quotes={[quote, { ...quote, id: "mar", timestamp: "2026-03-01T00:00:00Z" }]} />,
    );
    edit();
    await expect(save({ ...correction, effectiveDate: "2026-03-01" })).rejects.toThrow(
      "already exists",
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it("deleting a balance removes only its quote", async () => {
    render(<Harness />);
    edit();
    await act(async () => {
      await save(null);
    });
    expect(mocks.remove).toHaveBeenCalledWith("apr");
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it("saves notes on a confirmation without touching loan events", async () => {
    render(<Harness />);
    edit();
    await act(async () => {
      await save({ ...correction, balance: 450, note: "Statement" });
    });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        close: 450,
        notes: "loan_event|type=balance_correction|note=Statement",
      }),
    );
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("does not inject today's cadence or interest method into a backdated renewal", async () => {
    render(<Harness />);
    await act(async () => {
      await mocks.renewal.mock.lastCall![0].onSubmit({
        effectiveDate: new Date(2026, 2, 10),
        annualRate: 3,
      });
    });
    const events = JSON.parse(mocks.metadata.mock.lastCall![0].metadata.loan_events) as LoanEvent[];
    const renewal = events.find((event: LoanEvent) => event.type === "renewal");
    expect(renewal).toEqual({ type: "renewal", effectiveDate: "2026-03-10", annualRate: 3 });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("records the renewal letter's balance as a confirmation before the new term", async () => {
    render(<Harness />);
    await act(async () => {
      await mocks.renewal.mock.lastCall![0].onSubmit({
        effectiveDate: new Date(2026, 2, 10),
        annualRate: 3,
        frequency: "biweekly",
        balance: 640,
      });
    });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: "2026-03-10T00:00:00Z",
        close: 640,
        notes: "loan_event|type=balance_correction",
      }),
    );
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.metadata.mock.invocationCallOrder[0],
    );
    const events = JSON.parse(mocks.metadata.mock.lastCall![0].metadata.loan_events) as LoanEvent[];
    expect(events).toContainEqual({
      type: "renewal",
      effectiveDate: "2026-03-10",
      annualRate: 3,
      frequency: "biweekly",
    });
  });
  it("persists the backend recalculation result instead of recalculating on the frontend", async () => {
    mocks.recalculate.mockResolvedValue({
      paymentAmount: 250,
      remainingPayments: 4,
      currentBalance: 1000,
    });
    render(<Harness />);
    await act(async () => {
      await mocks.recalcSheet.mock.lastCall![0].onSubmit(0, new Date(2026, 2, 1));
    });
    expect(mocks.recalculate).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: "2026-03-01", annualRate: 0 }),
    );
    const events = JSON.parse(mocks.metadata.mock.lastCall![0].metadata.loan_events) as LoanEvent[];
    expect(events).toContainEqual({
      type: "payment_change",
      effectiveDate: "2026-03-01",
      paymentAmount: 250,
    });
  });
});

it("adding an older renewal preserves the latest term's maturity", async () => {
  const previous = holding.metadata;
  holding.metadata = {
    ...previous,
    renewal_maturity_date: "2029-06-01",
    loan_events: [
      { type: "renewal", effectiveDate: "2026-06-01", annualRate: 4, termEndDate: "2029-06-01" },
    ],
  };
  try {
    render(<Harness />);
    await act(async () => {
      await mocks.renewal.mock.lastCall![0].onSubmit({
        effectiveDate: new Date(2025, 0, 1),
        annualRate: 3,
        termEndDate: new Date(2026, 5, 1),
      });
    });
    expect(mocks.metadata.mock.lastCall![0].metadata.renewal_maturity_date).toBe("2029-06-01");
  } finally {
    holding.metadata = previous;
  }
});

describe("new balance event date boundaries", () => {
  const submit = (mode: "extra_repayment" | "balance_correction") =>
    mocks.balanceSheet.mock.calls.filter(([props]) => props.mode === mode).at(-1)![0].onSubmit;

  it("treats a loan switched back to manual as manual despite its stored terms", async () => {
    const previous = holding.metadata;
    holding.metadata = { ...previous, sub_type: "mortgage", tracking_mode: "manual" };
    try {
      vi.mocked(calculateLoan).mockResolvedValue(null);
      render(<Harness />);
      expect(availability).toMatchObject({ renew: false, recalculate: false });
      await act(async () => {
        await submit("extra_repayment")(new Date(2026, 3, 2), 100);
      });
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({ close: 400, notes: "loan_event|type=extra_repayment" }),
      );
      expect(mocks.metadata).not.toHaveBeenCalled();
    } finally {
      holding.metadata = previous;
    }
  });

  it.each(["extra_repayment", "balance_correction"] as const)(
    "rejects %s before origination without writing anything",
    async (mode) => {
      const previous = holding.metadata;
      holding.metadata = { ...previous, origination_date: "2026-01-01" };
      try {
        vi.mocked(calculateLoan).mockResolvedValue(null);
        render(<Harness quotes={[]} />);
        await expect(submit(mode)(new Date(2025, 11, 31), 100)).rejects.toThrow();
        expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.metadata).not.toHaveBeenCalled();
      } finally {
        holding.metadata = previous;
      }
    },
  );

  it("uses the requested calendar day rather than the next UTC observation", async () => {
    vi.mocked(calculateLoan).mockResolvedValue(null);
    const previous = holding.metadata;
    holding.metadata = { tracking_mode: "manual" };
    try {
      render(
        <Harness
          quotes={[
            { ...quote, timestamp: "2026-02-01T00:00:00Z", close: 1200 },
            { ...quote, timestamp: "2026-03-01T00:00:00Z", close: 1000 },
          ]}
        />,
      );
      await submit("extra_repayment")(new Date(2026, 1, 28), 100);
      expect(mocks.save.mock.lastCall![0]).toMatchObject({ close: 1100 });
    } finally {
      holding.metadata = previous;
    }
  });

  it("does not use a future manual balance for an earlier repayment", async () => {
    vi.mocked(calculateLoan).mockResolvedValue(null);
    const previous = holding.metadata;
    holding.metadata = { tracking_mode: "manual" };
    try {
      render(<Harness quotes={[{ ...quote, timestamp: "2026-03-01T00:00:00Z", close: 1000 }]} />);
      await expect(submit("extra_repayment")(new Date(2026, 1, 28), 100)).rejects.toThrow();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.metadata).not.toHaveBeenCalled();
    } finally {
      holding.metadata = previous;
    }
  });

  it("does not turn unavailable automatic valuation into a manual opening quote", async () => {
    vi.mocked(calculateLoan).mockResolvedValue(null);
    render(<Harness quotes={[]} />);
    await expect(submit("extra_repayment")(new Date(2026, 1, 28), 100)).rejects.toThrow();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
});
