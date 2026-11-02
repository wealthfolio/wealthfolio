import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HistoryChartMarkerShape, lineColorAt } from "./history-chart-marker";

// The chart's tooltip, hover dot and single-point dot read the same rule.
describe("lineColorAt", () => {
  it("is the line's colour at or above zero and the loss colour below", () => {
    expect(lineColorAt(120, "var(--investments)")).toBe("var(--investments)");
    expect(lineColorAt(0, "var(--investments)")).toBe("var(--investments)");
    expect(lineColorAt(-0.01, "var(--investments)")).toBe("var(--loss)");
    expect(lineColorAt(120)).toBe("var(--gain)");
  });
});

function snapshotColor(props: { value: number; color?: string }) {
  const { container } = render(
    <svg>
      <HistoryChartMarkerShape cx={10} cy={10} variant="snapshot" {...props} />
    </svg>,
  );
  return container.querySelector("g")?.style.color;
}

describe("HistoryChartMarkerShape snapshot dot", () => {
  it("takes the chart line's colour at or above zero", () => {
    expect(snapshotColor({ value: 120, color: "var(--investments)" })).toBe("var(--investments)");
    expect(snapshotColor({ value: 0, color: "var(--investments)" })).toBe("var(--investments)");
  });

  it("is the loss colour below zero, whatever the line's colour", () => {
    expect(snapshotColor({ value: -5, color: "var(--investments)" })).toBe("var(--loss)");
  });

  it("defaults to the gain colour", () => {
    expect(snapshotColor({ value: 120 })).toBe("var(--gain)");
  });
});
