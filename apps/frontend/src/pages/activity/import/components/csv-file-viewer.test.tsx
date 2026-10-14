import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CSVFileViewer, type CSVLine } from "./csv-file-viewer";

vi.mock("@/adapters", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const data: CSVLine[] = Array.from({ length: 29 }, (_, id) => ({
  id,
  content: `synthetic-row-${id},${"long comment ".repeat(20)}`,
  isValid: true,
}));

describe("CSVFileViewer scroll ownership", () => {
  // Browser checks cover overflow geometry and the pinned status column.
  it("lets the height-capped CSV box own scrolling in both directions", () => {
    render(<CSVFileViewer data={data} maxHeight="300px" />);
    const table = screen.getByRole("table");
    const wrapper = table.parentElement!;
    const box = wrapper.parentElement!;
    expect(box).toHaveClass("overflow-auto", "[&>div]:overflow-visible");
    expect(box).toHaveStyle({ maxHeight: "300px" });
    expect(wrapper).toHaveClass("relative", "w-full", "overflow-auto");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(table.querySelector("tbody td")).toHaveClass("sticky", "left-0");
  });

  it("keeps short files and empty input in the same scroll box", () => {
    const { rerender } = render(<CSVFileViewer data={data.slice(0, 2)} />);
    expect(screen.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByRole("table").parentElement!.parentElement!).toHaveStyle({
      maxHeight: "400px",
    });
    rerender(<CSVFileViewer data={[]} />);
    expect(screen.getByText(/No content found/i)).toBeInTheDocument();
  });
});
