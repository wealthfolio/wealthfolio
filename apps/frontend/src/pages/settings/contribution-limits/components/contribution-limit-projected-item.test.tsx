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
        accounts={[]}
        onAdd={vi.fn()}
      />,
    );

    expect(screen.getByText("2028")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add TFSA for 2028 (No accounts selected)" }),
    ).toBeInTheDocument();
  });

  it("identifies otherwise identical projections by their account scopes", () => {
    const accounts = [
      { id: "a", name: "Alice TFSA" },
      { id: "b", name: "Bob TFSA" },
    ];
    const common = {
      groupName: "TFSA",
      contributionYear: 2028,
      limitAmount: 7000,
      isProjected: true,
    };
    const onAdd = vi.fn();
    render(
      <>
        <ContributionLimitProjectedItem
          limit={{ ...common, id: "a", accountIds: "a" }}
          accounts={accounts}
          onAdd={onAdd}
        />
        <ContributionLimitProjectedItem
          limit={{ ...common, id: "b", accountIds: "b" }}
          accounts={accounts}
          onAdd={onAdd}
        />
      </>,
    );
    expect(screen.getByText("Alice TFSA")).toBeInTheDocument();
    expect(screen.getByText("Bob TFSA")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add TFSA for 2028 (Alice TFSA)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add TFSA for 2028 (Bob TFSA)" }),
    ).toBeInTheDocument();
  });
});
