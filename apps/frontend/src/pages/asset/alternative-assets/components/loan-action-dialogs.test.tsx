import { fireEvent, render, screen, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { LoanBalanceEventDialog } from "./loan-action-dialogs";

const props = {
  open: true,
  mode: "extra_repayment" as const,
  currentBalance: 1000,
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
});
