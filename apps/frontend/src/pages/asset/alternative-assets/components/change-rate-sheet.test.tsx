import { fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateISO } from "@/lib/utils";
import { ChangeRateSheet, type LoanRateChangeInput } from "./change-rate-sheet";

const metadata = {
  loan_projection: {
    version: 1,
    annualRate: 4,
    paymentAmount: 1000,
    frequency: "monthly",
    firstPaymentDate: "2026-02-01",
    amortizationEndDate: "2046-01-01",
  },
  loan_events: [{ type: "rate_change", effectiveDate: "2026-03-01", annualRate: 4.5 }],
};

const today = formatDateISO(new Date());

const open = (
  onSubmit = vi.fn<(change: LoanRateChangeInput) => Promise<void>>().mockResolvedValue(undefined),
  loan: Record<string, unknown> = metadata,
  settingsToday = formatDateISO(new Date()),
) => {
  render(
    <ChangeRateSheet
      open
      onOpenChange={vi.fn()}
      metadata={loan}
      today={settingsToday}
      onSubmit={onSubmit}
    />,
  );
  return {
    onSubmit,
    save: screen.getByRole("button", { name: "Change interest rate" }),
    rate: screen.getByLabelText("Interest rate", { selector: "input" }),
    payment: screen.getByLabelText("Payment", { selector: "input" }),
  };
};

describe("change interest rate", () => {
  it("records nothing until the rate or the payment changes", () => {
    const { save, rate, payment } = open();
    expect(screen.getByText("Rate on this date: 4.5%")).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(rate, { target: { value: "5.1" } });
    expect(save).toBeEnabled();
    fireEvent.change(rate, { target: { value: "4.5" } });
    expect(save).toBeDisabled();
    fireEvent.change(payment, { target: { value: "1050" } });
    expect(save).toBeEnabled();
  });

  it("starts from a rate already changed on today's date", () => {
    // Saved on the device's date, which can be a day ahead of the settings
    // timezone, so the calculation may still report the earlier rate.
    const changedToday = {
      ...metadata,
      loan_events: [
        ...metadata.loan_events,
        { type: "rate_change", effectiveDate: formatDateISO(new Date()), annualRate: 5.25 },
      ],
    };
    const { save, rate } = open(undefined, changedToday);
    expect(rate).toHaveValue("5.25");
    expect(screen.getByText("Rate on this date: 5.25%")).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("keeps a precise rate exact while the loan updates", () => {
    // Quick Add, Recalculate and the event editor can store more than three decimals.
    const precise = {
      ...metadata,
      loan_events: [{ type: "rate_change", effectiveDate: "2026-03-01", annualRate: 5.3125 }],
    };
    const props = { open: true, onOpenChange: vi.fn(), onSubmit: vi.fn(), today };
    const { rerender } = render(<ChangeRateSheet {...props} metadata={precise} />);
    rerender(<ChangeRateSheet {...props} metadata={{ ...precise }} />);
    expect(screen.getByLabelText("Interest rate", { selector: "input" })).toHaveValue("5.3125");
    expect(screen.getByText("Rate on this date: 5.3125%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change interest rate" })).toBeDisabled();
  });

  it("starts a fresh draft each time it opens", () => {
    const props = { onOpenChange: vi.fn(), onSubmit: vi.fn(), metadata, today };
    const rate = () => screen.getByLabelText("Interest rate", { selector: "input" });
    const { rerender } = render(<ChangeRateSheet {...props} open={false} />);
    rerender(<ChangeRateSheet {...props} open />);
    expect(rate()).toHaveValue("4.5");
    fireEvent.change(rate(), { target: { value: "5.1" } });
    rerender(<ChangeRateSheet {...props} open={false} />);
    rerender(<ChangeRateSheet {...props} open />);
    expect(rate()).toHaveValue("4.5");
  });

  it("keeps a draft when the loan changes while the sheet is open", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const props = { open: true, onOpenChange: vi.fn(), onSubmit, today };
    const { rerender } = render(<ChangeRateSheet {...props} metadata={metadata} />);
    fireEvent.change(screen.getByLabelText("Interest rate", { selector: "input" }), {
      target: { value: "5.1" },
    });
    fireEvent.change(screen.getByLabelText("Payment", { selector: "input" }), {
      target: { value: "1050" },
    });
    // Another device syncs an unrelated event onto the loan.
    const synced = {
      ...metadata,
      loan_events: [
        ...metadata.loan_events,
        { type: "extra_repayment", effectiveDate: "2026-04-01", amount: 100 },
      ],
    };
    rerender(<ChangeRateSheet {...props} metadata={synced} />);
    fireEvent.click(screen.getByRole("button", { name: "Change interest rate" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ annualRate: 5.1, paymentAmount: 1050 });
  });

  it("refuses a payment of zero instead of keeping the current one", () => {
    const { save, rate, payment } = open();
    fireEvent.change(rate, { target: { value: "5.1" } });
    fireEvent.change(payment, { target: { value: "0" } });
    expect(save).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(payment, { target: { value: "" } });
    expect(save).toBeEnabled();
  });

  it("takes a rate in sixteenths of a point", async () => {
    const { onSubmit, save, rate } = open();
    fireEvent.change(rate, { target: { value: "6.0625" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ annualRate: 6.0625 });
  });

  it("keeps the current payment unless one is entered", async () => {
    const { onSubmit, save, rate } = open();
    fireEvent.change(rate, { target: { value: "5.1" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ annualRate: 5.1 });
    expect(onSubmit.mock.lastCall![0].paymentAmount).toBeUndefined();
  });

  it("sends the payment from the lender's letter", async () => {
    const { onSubmit, save, rate, payment } = open();
    fireEvent.change(rate, { target: { value: "5.1" } });
    fireEvent.change(payment, { target: { value: "1050" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ annualRate: 5.1, paymentAmount: 1050 });
  });

  it("shows why a change was refused", async () => {
    const { save, rate } = open(vi.fn().mockRejectedValue(new Error("LOAN_INVALID")));
    fireEvent.change(rate, { target: { value: "5.1" } });
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the date and values.");
  });
});

// The backend dates a rate change by today in the settings timezone, which can be
// a day behind or ahead of the browser's date.
describe("change interest rate in the settings timezone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 2, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dates the change on the settings day when the browser is a day ahead", async () => {
    const { onSubmit, save, rate } = open(undefined, metadata, "2026-11-01");
    fireEvent.change(rate, { target: { value: "5.1" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(formatDateISO(onSubmit.mock.calls[0][0].effectiveDate)).toBe("2026-11-01");
  });

  it("refuses the browser's date when it is after the settings day", async () => {
    const user = userEvent.setup();
    const { save, rate } = open(undefined, metadata, "2026-11-01");
    fireEvent.change(rate, { target: { value: "5.1" } });
    expect(save).toBeEnabled();
    // The sheet focuses its first control, the date's month, a frame after it
    // opens; a click on the day before then loses its focus to the month.
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: /month/i })).toHaveFocus());
    await user.click(screen.getByRole("spinbutton", { name: /day/i }));
    await user.keyboard("02");
    await user.tab();
    expect(save).toBeDisabled();
  });

  it("accepts the settings day when the browser is a day behind", async () => {
    const { onSubmit, save, rate } = open(undefined, metadata, "2026-11-03");
    fireEvent.change(rate, { target: { value: "5.1" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(formatDateISO(onSubmit.mock.calls[0][0].effectiveDate)).toBe("2026-11-03");
  });
});
