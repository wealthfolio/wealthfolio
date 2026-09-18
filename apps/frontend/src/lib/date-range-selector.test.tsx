import { DateRangeSelector } from "@wealthfolio/ui/components/common/date-range-selector";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("DateRangeSelector calendar anchor", () => {
  it("uses the supplied day when choosing a preset", () => {
    const onChange = vi.fn();
    render(<DateRangeSelector value={undefined} onChange={onChange} asOf={new Date(2027, 0, 1)} />);
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    expect(onChange).toHaveBeenLastCalledWith({
      from: new Date(2026, 11, 1),
      to: new Date(2027, 0, 1),
    });
  });
});
