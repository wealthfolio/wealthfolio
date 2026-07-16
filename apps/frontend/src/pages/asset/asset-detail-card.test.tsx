import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AssetDetailCard from "./asset-detail-card";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({
    isBalanceHidden: false,
    toggleBalanceVisibility: vi.fn(),
  }),
}));

describe("AssetDetailCard", () => {
  it("renders income, total P&L, and total return rows", () => {
    render(
      <AssetDetailCard
        assetData={{
          numShares: 10,
          marketValue: 1250,
          costBasis: 1000,
          averagePrice: 100,
          portfolioPercent: 0.25,
          todaysReturn: 5,
          todaysReturnPercent: 0.004,
          unrealizedPnl: 200,
          unrealizedPnlPercent: 0.2,
          realizedPnl: 50,
          realizedPnlPercent: 0.1,
          income: 25,
          fxEffect: null,
          priceReturnPercent: 0.12,
          totalPnl: 250,
          totalPnlPercent: 0.25,
          totalReturn: 275,
          totalReturnPercent: 0.275,
          currency: "USD",
          baseCurrency: "USD",
          quoteCurrency: null,
          quote: null,
        }}
      />,
    );

    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.queryByText("FX effect")).not.toBeInTheDocument();
    expect(screen.getByText("Total P&L")).toBeInTheDocument();
    expect(screen.getByText("Total Return")).toBeInTheDocument();
  });

  it.each([
    { currency: "USD", baseCurrency: "USD", fxEffect: 25, visible: false },
    { currency: "USD", baseCurrency: "CAD", fxEffect: 0, visible: true },
    { currency: "USD", baseCurrency: "CAD", fxEffect: 25, visible: true },
  ])(
    "renders the FX row only for available foreign-currency effects: $currency/$baseCurrency at $fxEffect",
    ({ currency, baseCurrency, fxEffect, visible }) => {
      render(
        <AssetDetailCard
          assetData={{
            numShares: 10,
            marketValue: 1250,
            costBasis: 1000,
            averagePrice: 100,
            portfolioPercent: 0.25,
            todaysReturn: null,
            todaysReturnPercent: null,
            unrealizedPnl: 200,
            unrealizedPnlPercent: 0.2,
            realizedPnl: null,
            realizedPnlPercent: null,
            income: 0,
            fxEffect,
            priceReturnPercent: 0.12,
            totalPnl: 200,
            totalPnlPercent: 0.2,
            totalReturn: 200,
            totalReturnPercent: 0.2,
            currency,
            baseCurrency,
            quoteCurrency: null,
            quote: null,
          }}
        />,
      );

      if (visible) {
        expect(screen.getByText("FX effect")).toBeInTheDocument();
      } else {
        expect(screen.queryByText("FX effect")).not.toBeInTheDocument();
      }
    },
  );

  it("uses option-specific quantity and average-cost labels", () => {
    render(
      <AssetDetailCard
        assetData={{
          numShares: 2,
          marketValue: 250,
          costBasis: 200,
          averagePrice: 1,
          portfolioPercent: 0.01,
          todaysReturn: null,
          todaysReturnPercent: null,
          unrealizedPnl: 50,
          unrealizedPnlPercent: 0.25,
          realizedPnl: null,
          realizedPnlPercent: null,
          income: 0,
          fxEffect: null,
          priceReturnPercent: null,
          totalPnl: 50,
          totalPnlPercent: 0.25,
          totalReturn: 50,
          totalReturnPercent: 0.25,
          currency: "USD",
          baseCurrency: "USD",
          quoteCurrency: null,
          quote: null,
          optionSpec: {
            right: "CALL",
            strike: 100,
            expiration: "2026-12-18",
          },
        }}
      />,
    );

    expect(screen.getByText("contracts")).toBeInTheDocument();
    expect(screen.getByText("Average premium")).toBeInTheDocument();
  });
});
