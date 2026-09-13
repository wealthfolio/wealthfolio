import { describe, expect, it } from "vitest";
import type { Quote } from "@/lib/types";
import {
  buildLoanSchedule,
  calculateBalanceAfterPayments,
  calculateMonthlyPayment,
  calculateRemainingPaymentCount,
  getObsoleteFutureQuoteIds,
  getRemainingScheduleWindow,
  splitLoanScheduleForPersistence,
} from "./loan-schedule";

const quote = (id: string, day: string, notes?: string): Quote => ({
  id,
  assetId: "loan",
  timestamp: `${day}T00:00:00Z`,
  createdAt: `${day}T00:00:00Z`,
  dataSource: "MANUAL",
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  adjclose: 100,
  volume: 0,
  currency: "EUR",
  notes,
});

describe("loan schedule replacement", () => {
  it("calculates zero-rate and positive-rate payments", () => {
    expect(calculateMonthlyPayment(1_200, 0, 12)).toBe(100);
    expect(calculateMonthlyPayment(100_000, 3.6, 240)).toBeCloseTo(585.11, 2);
  });

  it("calculates a shortened duration and rejects a payment below monthly interest", () => {
    expect(calculateRemainingPaymentCount(10_000, 0, 500)).toBe(20);
    expect(calculateRemainingPaymentCount(100_000, 12, 500)).toBeNull();
  });

  it("keeps the requested installment when reducing duration", () => {
    const schedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 1_000,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 1, 1),
      monthlyPayment: 400,
    });

    expect(schedule.map(({ close }) => close)).toEqual([600, 200, 0]);
  });

  it("builds a replacement schedule ending at zero", () => {
    const schedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 1_200,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 1, 1),
    });

    expect(schedule.map(({ date, close }) => ({ date, close }))).toEqual([
      { date: "2026-02-01", close: 800 },
      { date: "2026-03-01", close: 400 },
      { date: "2026-04-01", close: 0 },
    ]);
    expect(schedule.every(({ notes }) => notes === "loan_schedule")).toBe(true);
  });

  it("separates the zero payoff quote from batch-importable values", () => {
    const schedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 1_200,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 1, 1),
    });
    const { importableQuotes, payoffQuote } = splitLoanScheduleForPersistence(schedule);

    expect(importableQuotes.map((quote) => quote.close)).toEqual([800, 400]);
    expect(payoffQuote).toMatchObject({ date: "2026-04-01", close: 0 });
  });

  it("preserves end-of-month payment dates", () => {
    const schedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 300,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2025, 1, 28),
    });

    expect(schedule.map((entry) => entry.date)).toEqual(["2025-02-28", "2025-03-31", "2025-04-30"]);
    expect(schedule.at(-1)?.close).toBe(0);
  });

  it("starts a schedule after a later real balance without generating contradictory history", () => {
    const originationDate = new Date(2026, 0, 1);
    const balanceDate = new Date(2026, 8, 9);
    const endDate = new Date(2031, 0, 1);
    const window = getRemainingScheduleWindow(originationDate, balanceDate, endDate);

    expect(window).not.toBeNull();
    expect(window?.firstPaymentDate).toEqual(new Date(2026, 9, 1));
    expect(window?.paymentCount).toBe(52);

    const payment = calculateMonthlyPayment(20_000, 3, window?.paymentCount ?? 0);
    expect(payment).toBeCloseTo(410.64, 2);

    const schedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 20_000,
      annualRate: 3,
      paymentCount: window?.paymentCount ?? 0,
      firstPaymentDate: window?.firstPaymentDate ?? balanceDate,
    });
    expect(schedule[0]?.date).toBe("2026-10-01");
    expect(schedule[0]?.close).toBeLessThan(20_000);
    expect(schedule.at(-1)).toMatchObject({ date: "2031-01-01", close: 0 });
  });

  it("derives the theoretical balance when balance date is after origination", () => {
    const window = getRemainingScheduleWindow(
      new Date(2026, 0, 1),
      new Date(2026, 8, 9),
      new Date(2031, 0, 1),
    );
    const totalPaymentCount = 60;
    const completedPaymentCount = totalPaymentCount - (window?.paymentCount ?? 0);

    expect(completedPaymentCount).toBe(8);
    expect(calculateBalanceAfterPayments(20_000, 3, totalPaymentCount, completedPaymentCount)).toBe(
      17_503.24,
    );
  });

  it("generates every historical payment before a later balance date", () => {
    const balanceDay = "2026-09-09";
    const history = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 20_000,
      annualRate: 3,
      paymentCount: 60,
      firstPaymentDate: new Date(2026, 1, 1),
    }).filter((quote) => quote.date < balanceDay);

    expect(history.map((quote) => quote.date)).toEqual([
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
    expect(history.at(-1)?.close).toBe(17_503.24);
  });

  it("does not overwrite an explicit balance entered on a payment date", () => {
    const balanceDay = "2026-09-01";
    const history = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 20_000,
      annualRate: 3,
      paymentCount: 60,
      firstPaymentDate: new Date(2026, 1, 1),
    }).filter((quote) => quote.date < balanceDay);

    expect(history.at(-1)?.date).toBe("2026-08-01");
    expect(history.some((quote) => quote.date === balanceDay)).toBe(false);
  });

  it("keeps the original contractual precision after an automatically calculated balance", () => {
    const contractualSchedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 20_000,
      annualRate: 3,
      paymentCount: 60,
      firstPaymentDate: new Date(2026, 1, 1),
    });

    expect(contractualSchedule.find((quote) => quote.date === "2026-10-01")?.close).toBe(17_187.63);
  });

  it("uses the last contractual date only once for an automatic balance", () => {
    const originationDate = new Date(2026, 0, 1);
    const completedPaymentCount = 8;
    const automaticBalanceDate = new Date(
      originationDate.getFullYear(),
      originationDate.getMonth() + completedPaymentCount,
      originationDate.getDate(),
    );
    const contractualSchedule = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 20_000,
      annualRate: 3,
      paymentCount: 60,
      firstPaymentDate: new Date(2026, 1, 1),
    });
    const automaticBalanceDay = "2026-09-01";
    const importedDates = contractualSchedule
      .filter((quote) => quote.date !== automaticBalanceDay)
      .map((quote) => quote.date)
      .concat(automaticBalanceDay);

    expect(automaticBalanceDate).toEqual(new Date(2026, 8, 1));
    expect(importedDates.filter((date) => date === automaticBalanceDay)).toHaveLength(1);
  });

  it("keeps the original balance before the first payment and reaches zero at maturity", () => {
    expect(calculateBalanceAfterPayments(20_000, 3, 60, 0)).toBe(20_000);
    expect(calculateBalanceAfterPayments(20_000, 3, 60, 60)).toBe(0);
  });

  it("keeps overwritten dates and removes only obsolete future dates", () => {
    const replacement = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 200,
      annualRate: 0,
      paymentCount: 2,
      firstPaymentDate: new Date(2026, 2, 1),
    });
    const existing = [
      quote("past", "2026-01-01"),
      quote("effective", "2026-02-15"),
      quote("overwritten", "2026-03-01", "loan_schedule"),
      quote("obsolete", "2026-05-01", "loan_schedule"),
      quote("manual", "2026-06-01"),
    ];

    expect(getObsoleteFutureQuoteIds(existing, new Date(2026, 1, 15), replacement)).toEqual([
      "obsolete",
    ]);
  });

  it("includes every contractual payment through the maturity month", () => {
    const window = getRemainingScheduleWindow(
      new Date(2026, 0, 1),
      new Date(2026, 8, 9),
      new Date(2031, 0, 1),
    );

    expect(window?.firstPaymentDate).toEqual(new Date(2026, 9, 1));
    expect(window?.paymentCount).toBe(52);
    expect(calculateMonthlyPayment(15_503.24, 3, window?.paymentCount ?? 0)).toBeCloseTo(318.31, 2);
  });
});
