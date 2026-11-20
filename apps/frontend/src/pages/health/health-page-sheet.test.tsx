import type { HealthIssue, HealthStatus } from "@/lib/types";
import { render, screen, waitFor, within } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HealthPage from "./health-page";

const adapters = vi.hoisted(() => ({
  getHealthStatus: vi.fn(),
  dismissHealthIssue: vi.fn(),
  restoreHealthIssue: vi.fn(),
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getHealthStatus: adapters.getHealthStatus,
  dismissHealthIssue: adapters.dismissHealthIssue,
  restoreHealthIssue: adapters.restoreHealthIssue,
}));

vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ isAuthenticated: true, statusLoading: false }),
}));

// The confirm popover is exercised elsewhere; here its button confirms directly
// and shows whether a dismiss is still saving.
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  ActionConfirm: ({
    button,
    handleConfirm,
    isPending,
  }: {
    button: ReactNode;
    handleConfirm: () => void;
    isPending?: boolean;
  }) => (
    <span data-testid="dismiss-confirm" aria-busy={isPending} onClick={handleConfirm}>
      {button}
    </span>
  ),
}));

const issue: HealthIssue = {
  id: "manual_valuation:stale:abc",
  severity: "WARNING",
  category: "PRICE_STALENESS",
  title: "Valuation not updated for Old Barn",
  message: "Some manually valued assets haven't been updated in over 90 days.",
  affectedCount: 1,
  dataHash: "abc",
  timestamp: "2026-11-11T00:00:00Z",
};

function status(issues: HealthIssue[], dismissedIssues: HealthIssue[] = []): HealthStatus {
  return {
    overallSeverity: issues.length ? "WARNING" : "INFO",
    issueCounts: issues.length ? { WARNING: issues.length } : {},
    issues,
    checkedAt: "2026-11-11T00:00:00Z",
    isStale: false,
    dismissedIssues,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/health"]}>
        <HealthPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HealthPage issue sheet", () => {
  beforeEach(() => {
    adapters.getHealthStatus.mockReset();
    adapters.dismissHealthIssue.mockReset();
    adapters.restoreHealthIssue.mockReset();
  });

  it("closes the sheet once its issue is dismissed", async () => {
    const user = userEvent.setup();
    adapters.getHealthStatus.mockResolvedValueOnce(status([issue])).mockResolvedValue(status([]));
    adapters.dismissHealthIssue.mockResolvedValue(undefined);
    renderPage();

    await user.click(await screen.findByText(issue.title));
    const sheet = await screen.findByRole("dialog");
    await user.click(
      Array.from(sheet.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );

    expect(adapters.dismissHealthIssue).toHaveBeenCalledWith(issue.id, issue.dataHash);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps another issue's sheet open when an earlier dismiss finishes", async () => {
    const user = userEvent.setup();
    const other: HealthIssue = {
      ...issue,
      id: "manual_valuation:stale:def",
      title: "Valuation not updated for New Shed",
      dataHash: "def",
    };
    adapters.getHealthStatus.mockResolvedValue(status([issue, other]));
    let finishDismiss = () => {};
    adapters.dismissHealthIssue.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDismiss = resolve;
      }),
    );
    renderPage();

    await user.click(await screen.findByText(issue.title));
    const sheet = await screen.findByRole("dialog");
    await user.click(
      Array.from(sheet.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByText(other.title));
    const otherSheet = await screen.findByRole("dialog");
    expect(within(otherSheet).getByTestId("dismiss-confirm")).toHaveAttribute("aria-busy", "true");

    finishDismiss();
    await waitFor(() =>
      expect(within(otherSheet).getByTestId("dismiss-confirm")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(other.title);
  });

  it("keeps the sheet open when the dismiss fails", async () => {
    const user = userEvent.setup();
    adapters.getHealthStatus.mockResolvedValue(status([issue]));
    adapters.dismissHealthIssue.mockRejectedValue(new Error("offline"));
    renderPage();

    await user.click(await screen.findByText(issue.title));
    const sheet = await screen.findByRole("dialog");
    await user.click(
      Array.from(sheet.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );

    await waitFor(() => expect(adapters.dismissHealthIssue).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("doesn't call the data clean while an issue is dismissed, and lists it on request", async () => {
    const user = userEvent.setup();
    adapters.getHealthStatus.mockResolvedValue(status([], [issue]));
    renderPage();

    expect(await screen.findByText("No open issues")).toBeInTheDocument();
    expect(screen.queryByText("Your Data Looks Great")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 1 dismissed issue" }));

    expect(screen.getByText(issue.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1\s*Dismissed/ })).toBeInTheDocument();
  });

  it("restores a dismissed issue from its row and from its sheet", async () => {
    const user = userEvent.setup();
    adapters.getHealthStatus.mockResolvedValue(status([], [issue]));
    adapters.restoreHealthIssue.mockResolvedValue(undefined);
    renderPage();

    await user.click(await screen.findByRole("button", { name: /1\s*Dismissed/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(adapters.restoreHealthIssue.mock.calls[0]?.[0]).toBe(issue.id);

    await user.click(screen.getByText(issue.title));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/It comes back if its data changes/)).toBeInTheDocument();
    expect(within(sheet).queryByTestId("dismiss-confirm")).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Restore" }));
    expect(adapters.restoreHealthIssue).toHaveBeenCalledTimes(2);
  });

  it("goes back to the open issues once the last dismissed one is restored", async () => {
    const user = userEvent.setup();
    adapters.getHealthStatus
      .mockResolvedValueOnce(status([], [issue]))
      .mockResolvedValue(status([issue]));
    adapters.restoreHealthIssue.mockResolvedValue(undefined);
    renderPage();

    await user.click(await screen.findByRole("button", { name: /1\s*Dismissed/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Dismissed/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(issue.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("stays on the open issues when one is dismissed after the Dismissed view emptied", async () => {
    const user = userEvent.setup();
    const other: HealthIssue = {
      ...issue,
      id: "manual_valuation:stale:def",
      title: "Valuation not updated for New Shed",
      dataHash: "def",
    };
    adapters.getHealthStatus
      .mockResolvedValueOnce(status([other], [issue]))
      .mockResolvedValueOnce(status([issue, other]))
      .mockResolvedValue(status([other], [issue]));
    adapters.restoreHealthIssue.mockResolvedValue(undefined);
    adapters.dismissHealthIssue.mockResolvedValue(undefined);
    renderPage();

    await user.click(await screen.findByRole("button", { name: /1\s*Dismissed/ }));
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Dismissed/ })).not.toBeInTheDocument(),
    );

    await user.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(await screen.findByRole("button", { name: /1\s*Dismissed/ })).toBeInTheDocument();
    expect(screen.getByText(other.title)).toBeInTheDocument();
    expect(screen.queryByText(issue.title)).not.toBeInTheDocument();
  });
});
