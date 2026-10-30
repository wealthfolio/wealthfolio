import { getPerformanceDateRangeForRequest } from "@/lib/performance-date-range";
import { fireEvent, render, screen, within } from "@/test/render";
import { DateRangeSelector, DirectionProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mobile: false }));
vi.mock("@wealthfolio/ui/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.mobile,
}));

const asOf = new Date(2026, 2, 10);
const inception = new Date(2020, 3, 6);
const allTimeRange = { from: new Date(1970, 0, 1), to: asOf };

function calendarDay(date: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[data-day="${date}"]`);
  expect(button).not.toBeNull();
  return button!;
}

async function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Choose custom date range" }));
  return screen.findByRole("dialog");
}

describe("DateRangeSelector all-time display", () => {
  for (const mobile of [false, true]) {
    for (const direction of ["ltr", "rtl"] as const) {
      it(`anchors ${mobile ? "mobile" : "desktop"} ALL at inception in ${direction}`, async () => {
        mocks.mobile = mobile;
        const onChange = vi.fn();
        render(
          <DirectionProvider direction={direction}>
            <DateRangeSelector
              value={allTimeRange}
              onChange={onChange}
              asOf={asOf}
              allTimeFrom={inception}
            />
          </DirectionProvider>,
        );
        const dialog = await openPicker();
        expect(within(dialog).getByText("April 2020")).toBeInTheDocument();
        expect(calendarDay("2020-04-06")).toHaveAttribute("data-range-start", "true");
        expect(onChange).not.toHaveBeenCalled();
        if (mobile) {
          expect(within(dialog).getByText(/Apr 6, 2020/)).toBeInTheDocument();
          expect(within(dialog).getByText(/Mar 10, 2026/)).toBeInTheDocument();
          fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
          expect(onChange).toHaveBeenCalledWith(allTimeRange);
          expect(getPerformanceDateRangeForRequest(onChange.mock.calls[0][0])).toBeUndefined();
        }
      });
    }
  }

  it("restores the ALL sentinel on mobile Clear -> Done from a bounded range", async () => {
    mocks.mobile = true;
    const onChange = vi.fn();
    render(
      <DateRangeSelector
        value={{ from: new Date(2025, 0, 1), to: asOf }}
        onChange={onChange}
        asOf={asOf}
        allTimeFrom={inception}
      />,
    );
    const dialog = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledWith(allTimeRange);
    expect(getPerformanceDateRangeForRequest(onChange.mock.calls[0][0])).toBeUndefined();
  });

  it.each([undefined, { from: allTimeRange.from, to: new Date(2026, 2, 9) }])(
    "recognizes an all-time selection independently of its stored end date: %s",
    async (value) => {
      mocks.mobile = false;
      render(
        <DateRangeSelector value={value} onChange={vi.fn()} asOf={asOf} allTimeFrom={inception} />,
      );
      const dialog = await openPicker();
      expect(within(dialog).getByText("April 2020")).toBeInTheDocument();
      expect(calendarDay("2020-04-06")).toHaveAttribute("data-range-start", "true");
    },
  );

  it("reanchors an open ALL calendar when inception loads", async () => {
    mocks.mobile = true;
    const onChange = vi.fn();
    const { rerender } = render(
      <DateRangeSelector value={allTimeRange} onChange={onChange} asOf={asOf} />,
    );
    const dialog = await openPicker();
    expect(within(dialog).getByText("March 2026")).toBeInTheDocument();
    rerender(
      <DateRangeSelector
        value={allTimeRange}
        onChange={onChange}
        asOf={asOf}
        allTimeFrom={inception}
      />,
    );
    expect(within(dialog).getByText("April 2020")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledWith(allTimeRange);
  });

  it("preserves an edited mobile draft when the display anchor changes", async () => {
    mocks.mobile = true;
    const onChange = vi.fn();
    const { rerender } = render(
      <DateRangeSelector
        value={allTimeRange}
        onChange={onChange}
        asOf={asOf}
        allTimeFrom={inception}
      />,
    );
    const dialog = await openPicker();
    fireEvent.click(calendarDay("2020-04-12"));
    expect(onChange).not.toHaveBeenCalled();
    rerender(
      <DateRangeSelector
        value={allTimeRange}
        onChange={onChange}
        asOf={asOf}
        allTimeFrom={new Date(2019, 0, 1)}
      />,
    );
    expect(within(dialog).getByText("April 2020")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledWith({ from: inception, to: new Date(2020, 3, 12) });
    expect(getPerformanceDateRangeForRequest(onChange.mock.calls[0][0])).toBeDefined();
  });

  it("discards mobile draft edits when the picker is dismissed", async () => {
    mocks.mobile = true;
    const onChange = vi.fn();
    render(
      <DateRangeSelector
        value={allTimeRange}
        onChange={onChange}
        asOf={asOf}
        allTimeFrom={inception}
      />,
    );
    const dialog = await openPicker();
    fireEvent.click(calendarDay("2020-04-12"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onChange).not.toHaveBeenCalled();
    const reopened = await openPicker();
    expect(calendarDay("2020-04-06")).toHaveAttribute("data-range-start", "true");
    fireEvent.click(within(reopened).getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledWith(allTimeRange);
  });
});
