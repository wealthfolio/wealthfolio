import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HoldingPerformancePercent } from "./holding-performance-percent";

vi.mock("@wealthfolio/ui", () => ({
  GainPercent: ({ value }: { value: number }) => <span>{`percent:${value}`}</span>,
}));

describe("HoldingPerformancePercent", () => {
  it("renders an unavailable marker instead of inventing zero percent", () => {
    const { rerender } = render(<HoldingPerformancePercent value={null} />);

    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.queryByText("percent:0")).not.toBeInTheDocument();

    rerender(<HoldingPerformancePercent value={0.1} />);
    expect(screen.getByText("percent:0.1")).toBeInTheDocument();
  });
});
