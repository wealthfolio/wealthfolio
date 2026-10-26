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

  it("highlights no preset for a custom range", () => {
    render(
      <DateRangeSelector
        value={{ from: new Date(2026, 8, 1), to: new Date(2026, 8, 30) }}
        onChange={vi.fn()}
        asOf={new Date(2027, 0, 1)}
        hiddenRanges={["1D"]}
      />,
    );
    for (const label of ["1W", "1M", "1Y", "ALL"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }
  });
});
