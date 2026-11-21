import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AllocationTarget, DriftReport } from "@/lib/types";
import { render, screen } from "@/test/render";

import { OverviewTab } from "./overview-tab";

const SENTINEL = "__individual_securities__";

const { useTaxonomyMock } = vi.hoisted(() => ({
  useTaxonomyMock: vi.fn((_id: string | null) => ({ data: undefined })),
}));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: useTaxonomyMock }));
vi.mock("./current-vs-target-card", () => ({
  CurrentVsTargetCard: ({ taxonomyLabel }: { taxonomyLabel: string }) => (
    <div>current vs target: {taxonomyLabel}</div>
  ),
}));
vi.mock("./drift-drivers-card", () => ({
  DriftDriversCard: ({ statusDescription }: { statusDescription: string }) => (
    <div>drivers: {statusDescription}</div>
  ),
}));
vi.mock("./holdings-table", () => ({ HoldingsTable: () => null }));

const report = {
  targetId: "target-1",
  scopeType: "all",
  totalValue: 1000,
  baseCurrency: "USD",
  maxDriftBps: 0,
  outOfBandCount: 2,
  deployableCash: 0,
  rows: [],
} as DriftReport;

const target = (overrides: Partial<AllocationTarget>) =>
  ({
    id: "target-1",
    name: "Stocks",
    bandType: "absolute",
    driftBandBps: 100,
    ...overrides,
  }) as AllocationTarget;

describe("OverviewTab", () => {
  beforeEach(() => useTaxonomyMock.mockClear());

  it("does not load a taxonomy for an asset target and speaks of securities", () => {
    render(
      <OverviewTab
        report={report}
        taxonomyId={SENTINEL}
        target={target({ taxonomyId: SENTINEL, targetType: "asset" })}
      />,
    );
    expect(useTaxonomyMock).not.toHaveBeenCalledWith(SENTINEL);
    expect(useTaxonomyMock).toHaveBeenCalledWith(null);
    expect(screen.getByText("current vs target: Individual securities")).toBeInTheDocument();
    expect(screen.getByText(/2 securities outside target/)).toBeInTheDocument();
  });

  it("loads the taxonomy of a category target", () => {
    render(
      <OverviewTab
        report={report}
        taxonomyId="asset_classes"
        target={target({ taxonomyId: "asset_classes", targetType: "category" })}
      />,
    );
    expect(useTaxonomyMock).toHaveBeenCalledWith("asset_classes");
  });
});
