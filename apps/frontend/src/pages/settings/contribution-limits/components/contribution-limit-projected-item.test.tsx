import { render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { ContributionLimitProjectedItem } from "./contribution-limit-projected-item";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "CAD" } }),
}));

describe("ContributionLimitProjectedItem", () => {
  it("shows the year it is projected for", () => {
    render(
      <ContributionLimitProjectedItem
        limit={{
          id: "projected:limit1:2028",
          groupName: "TFSA",
          contributionYear: 2028,
          limitAmount: 7000,
          isRecurring: true,
          isProjected: true,
          sourceLimitId: "limit1",
          sourceYear: 2026,
        }}
        onAdd={vi.fn()}
      />,
    );

    expect(screen.getByText("2028")).toBeInTheDocument();
  });
});
