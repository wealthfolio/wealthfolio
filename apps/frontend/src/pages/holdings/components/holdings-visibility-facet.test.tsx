import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HoldingsVisibilityFacet } from "./holdings-visibility-filter";

vi.mock("@wealthfolio/ui", () => ({
  FacetedFilter: ({ options }: { options: { value: string; label: string }[] }) => (
    <div>
      {options.map((option) => (
        <span key={option.value}>{option.label}</span>
      ))}
    </div>
  ),
}));

describe("HoldingsVisibilityFacet", () => {
  it("hides closed positions when the account cannot provide closed history", () => {
    render(
      <HoldingsVisibilityFacet value={["open"]} onChange={vi.fn()} showClosedPositions={false} />,
    );

    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.queryByText("Closed")).not.toBeInTheDocument();
  });
});
