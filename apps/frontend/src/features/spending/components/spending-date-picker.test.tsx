import { render, screen, fireEvent } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect } from "vitest";
import { SpendingDatePicker } from "./spending-date-picker";

function setup(customRange?: { from: Date; to: Date }, customMonth: string | null = null) {
  const onCustomMonthChange = vi.fn();
  const onCustomRangeChange = vi.fn();
  render(
    <SpendingDatePicker
      customMonth={customMonth}
      customRange={customRange}
      maxMonth="2026-08"
      onCustomMonthChange={onCustomMonthChange}
      onCustomRangeChange={onCustomRangeChange}
    />,
  );
  return { user: userEvent.setup(), onCustomMonthChange, onCustomRangeChange };
}

const range = { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) };
const open = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Select dates" }));

// Role queries scan the open two-month range calendar, so on shared CI runners
// a test can exceed the default 5s.
describe("SpendingDatePicker", { timeout: 15_000 }, () => {
  it("selects a completed year, pages older years, and clears the year intent", async () => {
    const user = userEvent.setup();
    const onYear = vi.fn();
    const onMonth = vi.fn();
    render(
      <SpendingDatePicker
        customMonth={null}
        customYear={2025}
        maxYear={2025}
        maxMonth="2026-08"
        onCustomMonthChange={onMonth}
        onCustomYearChange={onYear}
      />,
    );
    await open(user);
    expect(screen.getByRole("button", { name: "2025" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "2026" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Earlier years" }));
    expect(screen.getByRole("button", { name: "Earlier years" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "2016" }));
    expect(onYear).toHaveBeenCalledWith(2016);
    expect(onMonth).not.toHaveBeenCalled();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onYear).toHaveBeenLastCalledWith(null);
  });

  it("shows the selected period on the picker and restores focus after browsing", async () => {
    const user = userEvent.setup();
    render(
      <SpendingDatePicker
        customMonth={null}
        customYear={2025}
        maxYear={2025}
        maxMonth="2026-08"
        onCustomMonthChange={vi.fn()}
        onCustomYearChange={vi.fn()}
        selectionLabel="2025"
      />,
    );
    const trigger = screen.getByRole("button", { name: "2025, Select dates" });
    await user.click(trigger);
    expect(screen.queryByRole("button", { name: "Previous period" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Previous period" })).not.toBeInTheDocument();
  });

  it("browses months within the selected year when switching modes", async () => {
    const user = userEvent.setup();
    const onMonth = vi.fn();
    render(
      <SpendingDatePicker
        customMonth={null}
        customYear={2024}
        maxYear={2025}
        maxMonth="2026-08"
        onCustomMonthChange={onMonth}
        onCustomYearChange={vi.fn()}
      />,
    );
    await open(user);
    await user.click(screen.getByRole("button", { name: /^Month$/ }));
    expect(screen.getByRole("button", { name: "January" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "February" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "February" }));
    expect(onMonth).toHaveBeenCalledWith("2024-02");
  });
  it("selects a month immediately through the existing picker", async () => {
    const { user, onCustomMonthChange } = setup();
    await open(user);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose custom dates" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "July" }));
    expect(onCustomMonthChange).toHaveBeenCalledWith("2026-07");
    expect(screen.queryByRole("button", { name: "Choose custom dates" })).not.toBeInTheDocument();
  });

  it("requires complete ordered dates, accepts a single day, and applies only on Apply", async () => {
    const { user, onCustomRangeChange } = setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Choose custom dates" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-06-10" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-06-09" } });
    expect(screen.getByRole("alert")).toHaveTextContent("End date must be on or after start date");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-06-10" } });
    expect(onCustomRangeChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onCustomRangeChange).toHaveBeenCalledWith({
      from: new Date(2025, 5, 10),
      to: new Date(2025, 5, 10),
    });
  });

  it("reopens the active range and discards cancelled edits", async () => {
    const { user, onCustomRangeChange } = setup(range);
    await open(user);
    expect(screen.getByRole("button", { name: "Choose a month" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-02-01" } });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCustomRangeChange).not.toHaveBeenCalled();
    await open(user);
    expect(screen.getByLabelText("Start date")).toHaveValue("2025-01-01");
  });

  it("uses one switching link and preserves draft dates when switching back", async () => {
    const { user } = setup(range);
    await open(user);
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-02-01" } });
    await user.click(screen.getByRole("button", { name: "Choose a month" }));
    expect(screen.queryByRole("button", { name: "Choose a month" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose custom dates" }));
    expect(screen.getByLabelText("Start date")).toHaveValue("2025-02-01");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("clears the active custom range", async () => {
    const { user, onCustomRangeChange, onCustomMonthChange } = setup(range);
    await open(user);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onCustomRangeChange).toHaveBeenCalledWith(undefined);
    expect(onCustomMonthChange).not.toHaveBeenCalled();
  });

  it("seeds range fields from a selected month", async () => {
    const { user } = setup(undefined, "2024-02");
    await open(user);
    expect(screen.getByRole("button", { name: "February" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Choose custom dates" }));
    expect(screen.getByLabelText("Start date")).toHaveValue("2024-02-01");
    expect(screen.getByLabelText("End date")).toHaveValue("2024-02-29");
  });
});
