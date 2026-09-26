import { render, screen, waitFor } from "@/test/render";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportBrokerIssue } from "./report-broker-issue";

const { reportMock, errorToastMock } = vi.hoisted(() => ({
  reportMock: vi.fn(),
  errorToastMock: vi.fn(),
}));
vi.mock("@/adapters", () => ({ reportBrokerActivityIssue: reportMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: errorToastMock } }));

beforeEach(() => {
  reportMock.mockReset();
  errorToastMock.mockReset();
});

describe("ReportBrokerIssue", () => {
  it("requires explicit consent and sends only the selected account-level issue", async () => {
    const user = userEvent.setup();
    reportMock.mockResolvedValue(undefined);
    render(<ReportBrokerIssue providerAccountId="provider-account-id" accountName="Retirement" />);

    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    const send = screen.getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();
    expect(screen.getByText("Retirement")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox"));
    await user.click(send);

    await waitFor(() => expect(reportMock).toHaveBeenCalledTimes(1));
    expect(reportMock).toHaveBeenCalledWith({
      consent: true,
      provider: "snaptrade",
      accountId: "provider-account-id",
      issueKind: "missing_activity",
      features: { assetClass: "unknown" },
    });
  });

  it("requires a different expected type for a wrong-type report", async () => {
    const user = userEvent.setup();
    const activity = {
      activityType: ActivityType.DIVIDEND,
      amount: "12",
      quantity: null,
      assetSymbol: "",
      metadata: {},
    } as ActivityDetails;
    render(
      <ReportBrokerIssue
        providerAccountId="provider-account-id"
        accountName="Retirement"
        activity={activity}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("clears consent when the dialog is closed without sending", async () => {
    const user = userEvent.setup();
    render(<ReportBrokerIssue providerAccountId="provider-account-id" accountName="Retirement" />);

    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
  });

  it("clears consent when report-relevant activity data changes", async () => {
    const user = userEvent.setup();
    const activity = {
      id: "activity-1",
      activityType: ActivityType.DIVIDEND,
      amount: "12",
      quantity: null,
      assetSymbol: "ABC",
      metadata: {},
    } as ActivityDetails;
    const { rerender } = render(
      <ReportBrokerIssue
        providerAccountId="provider-account-id"
        accountName="Retirement"
        activity={activity}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();

    rerender(
      <ReportBrokerIssue
        providerAccountId="provider-account-id"
        accountName="Retirement"
        activity={{ ...activity, activityType: ActivityType.BUY, assetSymbol: "XYZ" }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  });

  it("explains when an old or shared account cannot submit a report", async () => {
    const user = userEvent.setup();
    reportMock.mockRejectedValue(new Error("API error 404: Brokerage account not found"));
    render(<ReportBrokerIssue providerAccountId="provider-account-id" accountName="Retirement" />);

    await user.click(screen.getByRole("button", { name: "Report import issue" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(errorToastMock).toHaveBeenCalledWith(
        "This account is unavailable or its owner needs to report the issue.",
      ),
    );
  });
});
