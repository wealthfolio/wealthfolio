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
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getHealthStatus: adapters.getHealthStatus,
  dismissHealthIssue: adapters.dismissHealthIssue,
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

function status(issues: HealthIssue[]): HealthStatus {
  return {
    overallSeverity: issues.length ? "WARNING" : "INFO",
    issueCounts: issues.length ? { WARNING: issues.length } : {},
    issues,
    checkedAt: "2026-11-11T00:00:00Z",
    isStale: false,
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
});
