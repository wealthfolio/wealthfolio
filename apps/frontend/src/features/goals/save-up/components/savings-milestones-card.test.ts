import type { SaveUpProjectionPointDTO } from "@/lib/types";
import { createFormatter } from "@wealthfolio/ui/lib/formatting";
import { describe, expect, it } from "vitest";

import { buildSavingsMilestones } from "./savings-milestones-card";

describe("buildSavingsMilestones", () => {
  it("formats milestone percentages with the formatting locale", () => {
    const projection = [{ date: "2026-12-31", nominal: 1_000 }] as SaveUpProjectionPointDTO[];
    const t = ((key: string) => key) as Parameters<typeof buildSavingsMilestones>[3];
    const formatting = createFormatter("fr-FR");

    const milestones = buildSavingsMilestones(projection, 1_000, 0, t, formatting);

    expect(milestones.map((milestone) => milestone.label)).toEqual([
      "25 %",
      "50 %",
      "75 %",
      "100 %",
    ]);
  });
});
