import { render } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SaveUpProjectionPointDTO } from "@/lib/types";
import { SaveUpProjectionCard } from "./save-up-projection-card";

// jsdom has no layout: give the chart a fixed size so it draws its paths.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
            width: 600,
            height: 300,
          })
        : null,
  };
});

function point(date: string, nominal: number, needed: number): SaveUpProjectionPointDTO {
  return {
    date,
    nominal,
    optimistic: nominal,
    pessimistic: nominal,
    target: needed,
    needed,
    range: [nominal, nominal],
  };
}

// An at-risk goal: nothing saved on 2026-01-01, 1,000 a month at 0%, 3,001 needed by 2026-04-01.
// The projection is below the needed line at every point.
const atRisk = [
  point("2026-01-01", 0, 1),
  point("2026-01-31", 1_000, 1_001),
  point("2026-02-28", 2_000, 2_001),
  point("2026-03-31", 3_000, 3_001),
  point("2026-04-01", 3_000, 3_001),
];

describe("SaveUpProjectionCard", () => {
  it("draws the projection and the needed line with straight segments", () => {
    const { container } = render(
      <FormattingProvider locale="en-US" timezone="UTC">
        <SaveUpProjectionCard data={atRisk} currency="USD" isHidden={false} annualReturn={0} />
      </FormattingProvider>,
    );

    const curves = [...container.querySelectorAll(".recharts-area-curve, .recharts-line-curve")];
    expect(curves.length).toBeGreaterThanOrEqual(2);
    // Straight segments keep the projection on the same side of the needed line
    // between points. Smooth curves (cubic "C" commands) can cross it.
    for (const curve of curves) {
      expect(curve.getAttribute("d")).toMatch(/^M[^C]*$/);
    }
  });
});
