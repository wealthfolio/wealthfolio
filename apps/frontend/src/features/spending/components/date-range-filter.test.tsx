import { fireEvent, render, screen } from "@/test/render";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DateRangeFilter } from "./date-range-filter";

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: string;
    variant?: string;
    size?: string;
    className?: string;
  }) => <button onClick={onClick}>{children}</button>,
  Calendar: () => <div data-testid="calendar" />,
  Icons: {
    PlusCircle: () => <span data-testid="plus-circle-icon" />,
  },
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  Separator: () => <span data-testid="separator" />,
}));

describe("DateRangeFilter", () => {
  it("shows and clears to-only ranges", () => {
    const onChange = vi.fn();

    render(
      <DateRangeFilter value={{ from: undefined, to: new Date(2026, 5, 4) }} onChange={onChange} />,
    );

    expect(screen.getByText("Until Jun 4, 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
