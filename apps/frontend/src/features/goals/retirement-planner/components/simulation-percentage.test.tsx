import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { SimulationPercentage } from "./simulation-percentage";
import { simulationReferenceBand } from "../lib/simulation-reference";
import { findTooltip, queryTooltip } from "@/test/tooltip";

function renderPercentage(rate: number, plannerMode: "fire" | "traditional" = "fire") {
  return render(
    <TooltipProvider delay={0}>
      <SimulationPercentage rate={rate} plannerMode={plannerMode} />
    </TooltipProvider>,
  );
}

describe("simulation reference bands", () => {
  it.each([
    [0, "low"],
    [0.7449, "low"],
    [0.745, "middle"],
    [0.75, "middle"],
    [0.8949, "middle"],
    [0.895, "high"],
    [0.9, "high"],
    [1, "high"],
  ] as const)("uses displayed rounding for %s", (rate, expected) => {
    expect(simulationReferenceBand(rate)).toBe(expected);
  });

  it("shows 90% in the upper band when the result rounds up", () => {
    renderPercentage(0.895);
    expect(screen.getByRole("button", { name: "90%" })).toHaveClass("dark:text-green-400");
  });

  it("opens on tap and explains FIRE criteria without a safety rating", async () => {
    renderPercentage(0.65);
    fireEvent.click(screen.getByRole("button", { name: "65%" }));
    const tooltip = await findTooltip();
    expect(tooltip).toHaveTextContent("essential spending");
    expect(tooltip).toHaveTextContent("also reach financial independence");
    expect(tooltip).toHaveTextContent("not real-world probabilities");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(queryTooltip()).not.toBeInTheDocument());
  });

  it("opens on keyboard focus and omits FIRE criteria in Traditional mode", async () => {
    renderPercentage(0.8, "traditional");
    fireEvent.focus(screen.getByRole("button", { name: "80%" }));
    const tooltip = await findTooltip();
    expect(tooltip).toHaveTextContent("80%");
    expect(tooltip).not.toHaveTextContent("financial independence");
  });
});
