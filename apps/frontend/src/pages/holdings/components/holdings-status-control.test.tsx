import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HoldingsStatusSegmentedControl } from "./holdings-status-control";

describe("HoldingsStatusSegmentedControl", () => {
  it("switches between open and closed as a single-select view", () => {
    const onChange = vi.fn();
    render(<HoldingsStatusSegmentedControl value={["open"]} onChange={onChange} />);

    expect(screen.getByRole("group", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Closed" }));

    expect(onChange).toHaveBeenCalledWith(["closed"]);
  });

  it("stays out of the toolbar when closed history is unavailable", () => {
    render(
      <HoldingsStatusSegmentedControl
        value={["open"]}
        onChange={vi.fn()}
        showClosedPositions={false}
      />,
    );

    expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
  });
});
