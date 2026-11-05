import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthStatusIndicator } from "./health-status-icon";

const health = vi.hoisted(() => ({
  status: undefined as { issueCounts: Record<string, number> } | undefined,
}));
vi.mock("@/hooks/use-health", () => ({
  useHealthStatus: () => ({ data: health.status, isLoading: false }),
}));

function renderBadge(figureNotice?: React.ReactNode) {
  return render(
    <MemoryRouter>
      <HealthStatusIndicator figureNotice={figureNotice} />
    </MemoryRouter>,
  );
}

describe("HealthStatusIndicator", () => {
  beforeEach(() => {
    health.status = { issueCounts: {} };
  });

  it("renders nothing without health issues or a figure notice", () => {
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it("links to Health Center when there are health issues", () => {
    health.status = { issueCounts: { ERROR: 2 } };
    renderBadge();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/health");
  });

  it("shows a figure notice alone as a warning badge that does not navigate", () => {
    const { container } = renderBadge(<p>Stale valuations</p>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // Keyboard and screen-reader users can still reach it.
    expect(screen.getByRole("button", { name: /data status/i })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("text-warning-subtle-foreground");
  });

  it("keeps the health severity colour when both are present", () => {
    health.status = { issueCounts: { CRITICAL: 1 } };
    renderBadge(<p>Stale valuations</p>);
    expect(screen.getByRole("link")).toHaveClass("text-destructive-subtle-foreground");
  });
});
