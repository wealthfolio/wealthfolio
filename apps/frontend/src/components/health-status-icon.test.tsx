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

function renderBadge() {
  return render(
    <MemoryRouter>
      <HealthStatusIndicator />
    </MemoryRouter>,
  );
}

describe("HealthStatusIndicator", () => {
  beforeEach(() => {
    health.status = { issueCounts: {} };
  });

  it("renders nothing without health issues", () => {
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it("links to Health Center when there are health issues", () => {
    health.status = { issueCounts: { ERROR: 2 } };
    renderBadge();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/health");
  });

  it("takes the colour of the most severe issue", () => {
    health.status = { issueCounts: { WARNING: 1, CRITICAL: 1 } };
    renderBadge();
    expect(screen.getByRole("link")).toHaveClass("text-destructive-subtle-foreground");
  });
});
