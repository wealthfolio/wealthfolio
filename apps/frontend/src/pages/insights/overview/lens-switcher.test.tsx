import { fireEvent, render, screen } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LensSwitcher } from "./lens-switcher";

const lenses = ["Allocation", "Accounts", "Sectors", "Regions"].map((label) => ({
  key: label.toLowerCase(),
  label,
}));

// jsdom has no layout: give every view 80px, "More" 70px and the row 300px.
function mockLayout(rowWidth: number) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.textContent?.includes("More") ? 70 : 80;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(rowWidth);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSwitcher(activeKey = "allocation", onSelect = vi.fn()) {
  render(
    <LensSwitcher lenses={lenses} activeKey={activeKey} onSelect={onSelect} aria-label="Views" />,
  );
  const group = screen.getByRole("group", { name: "Views" });
  return { onSelect, row: () => [...group.querySelectorAll("button")].map((b) => b.textContent) };
}

describe("LensSwitcher", () => {
  it("shows every view when layout cannot be measured", () => {
    const { row } = renderSwitcher();
    expect(row()).toEqual(["Allocation", "Accounts", "Sectors", "Regions"]);
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
  });

  it("keeps the views that fit beside More", () => {
    mockLayout(300);
    const { row } = renderSwitcher();
    expect(row()).toEqual(["Allocation", "Accounts"]);
    expect(screen.getByRole("button", { name: /More/ })).toBeInTheDocument();
  });

  it("keeps the selected view in the row when it would overflow", () => {
    mockLayout(300);
    const { row } = renderSwitcher("regions");
    expect(row()).toEqual(["Allocation", "Regions"]);
    expect(screen.getByRole("button", { name: "Regions" })).toHaveAttribute("aria-pressed", "true");
  });

  it("drops More when every view fits", () => {
    mockLayout(400);
    const { row } = renderSwitcher();
    expect(row()).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
  });

  it("selects a view from the row", () => {
    const { onSelect } = renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: "Sectors" }));
    expect(onSelect).toHaveBeenCalledWith("sectors");
  });
});
