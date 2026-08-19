import { fireEvent, render, screen } from "@/test/render";
import { describe, expect, it } from "vitest";

import type { AssetLotView } from "@/lib/types";

import { AssetLotsTable } from "./asset-lots-table";

const ctyLot: AssetLotView = {
  id: "cty-lot",
  accountId: "isa",
  accountName: "ISA",
  assetId: "CTY",
  source: "TRANSACTION_LOT",
  currency: "GBp",
  baseCurrency: "GBP",
  valuationCurrency: "GBP",
  quantity: 51,
  originalQuantity: 51,
  remainingQuantity: 51,
  costBasis: 28395.015,
  costBasisBase: 283.95015,
  unitCost: 556.765,
  fees: 0,
  taxes: 0,
  taxesBase: 0,
  valuationUnitCost: 5.56765,
  valuationCostBasis: 283.95015,
  fxRateToBase: 0.01,
  splitRatio: 1,
  contractMultiplier: 1,
  acquisitionDate: "2026-03-03",
  snapshotDate: null,
  isClosed: false,
  closeDate: null,
  disposalProceeds: null,
  disposalCostBasis: null,
  disposalCostBasisBase: null,
  realizedPnl: null,
  realizedPnlBase: null,
  valuationDisposalCostBasis: null,
  valuationRealizedPnl: null,
};

describe("AssetLotsTable", () => {
  it("uses valuation-normalized lot values for GBp lots", () => {
    render(<AssetLotsTable lots={[ctyLot]} currency="GBP" marketPrice={5.65} />);

    expect(screen.getAllByText("£283.95").length).toBeGreaterThan(0);
    expect(screen.getAllByText("£288.15").length).toBeGreaterThan(0);
    expect(screen.queryByText("£28,395.02")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand all/i }));

    expect(screen.getAllByText("£5.57").length).toBeGreaterThan(0);
    expect(screen.queryByText("£556.77")).not.toBeInTheDocument();
  });

  it("excludes lots without valuation cost from both cost and market aggregates", () => {
    render(
      <AssetLotsTable
        lots={[{ ...ctyLot, id: "cty-lot-without-valuation-cost", valuationCostBasis: null }]}
        currency="GBP"
        marketPrice={5.65}
      />,
    );

    expect(screen.getAllByText("£0.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("£288.15")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand all/i }));

    expect(screen.getAllByText("£288.15").length).toBeGreaterThan(0);
  });

  it("shows disposed cost basis and realized gain for closed lots", () => {
    render(
      <AssetLotsTable
        lots={[
          {
            ...ctyLot,
            id: "closed-cty-lot",
            quantity: 0,
            remainingQuantity: 0,
            costBasis: 0,
            valuationCostBasis: 0,
            isClosed: true,
            closeDate: "2026-04-10",
            disposalCostBasis: 28395.015,
            disposalCostBasisBase: 283.95015,
            realizedPnl: 2604.985,
            realizedPnlBase: 26.04985,
            valuationDisposalCostBasis: 283.95015,
            valuationRealizedPnl: 26.04985,
          },
        ]}
        currency="GBP"
        marketPrice={5.65}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /expand all/i }));

    expect(screen.getByText("Gain/Loss")).toBeInTheDocument();
    expect(screen.getAllByText("£283.95").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+26.05").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+9.17%").length).toBeGreaterThan(0);
  });
});
