import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { PlannerInput } from "./rebalance-tab";
import { EligibleHoldingsSelector } from "./eligible-holdings-selector";
import { getEligibleHoldings, groupEligibleHoldings } from "./eligible-holdings";

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

function holding(
  assetId: string,
  symbol: string,
  name: string,
  instrumentType?: string,
  holdingType: Holding["holdingType"] = HoldingType.SECURITY,
  currency = "USD",
  exchangeMic?: string,
): Holding {
  return {
    id: `${assetId}-${symbol}`,
    accountId: "account-1",
    holdingType,
    instrument: {
      id: assetId,
      symbol,
      name,
      currency,
      quoteMode: "MARKET",
      exchangeMic,
      instrumentType,
    },
  } as Holding;
}

function Harness({ holdings }: { holdings: Holding[] }) {
  const [excludedAssetIds, setExcludedAssetIds] = useState<Set<string>>(new Set());
  return (
    <EligibleHoldingsSelector
      holdings={holdings}
      excludedAssetIds={excludedAssetIds}
      onToggle={(assetId) =>
        setExcludedAssetIds((previous) => {
          const next = new Set(previous);
          if (next.has(assetId)) next.delete(assetId);
          else next.add(assetId);
          return next;
        })
      }
      onSelectAll={() => setExcludedAssetIds(new Set())}
      onClear={() =>
        setExcludedAssetIds(new Set(getEligibleHoldings(holdings).map((row) => row.assetId)))
      }
    />
  );
}

describe("EligibleHoldingsSelector", () => {
  const holdings = [
    holding("asset-bond", "BND", "Bond fund", "BOND"),
    holding("asset-vti", "VTI", "Vanguard Total Stock", "EQUITY"),
    holding("asset-vti", "VTI", "Vanguard Total Stock", "EQUITY", HoldingType.SECURITY),
    holding("asset-unknown", "MYST", "Mystery asset"),
    holding("cash-usd", "USD", "Cash", undefined, HoldingType.CASH),
  ];

  it("selects each unique non-cash instrument initially and groups it by type", () => {
    render(<Harness holdings={holdings} />);

    expect(screen.getByRole("button", { name: /Eligible holdings/ })).toHaveTextContent(
      "All holdings selected",
    );

    expect(groupEligibleHoldings(getEligibleHoldings(holdings)).map((group) => group.key)).toEqual([
      "EQUITY",
      "BOND",
      "OTHER",
    ]);

    expect(screen.queryByText("Equity")).not.toBeInTheDocument();
  });

  it("announces selection state on the trigger and rows", async () => {
    const user = userEvent.setup();
    render(<Harness holdings={holdings} />);

    expect(
      screen.getByRole("button", { name: /Eligible holdings.*All holdings selected/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Eligible holdings.*All holdings selected/i }),
    );
    const vti = screen.getByRole("option", { name: /VTI.*selected/i });
    expect(vti).toHaveAccessibleName(/selected/i);

    await user.click(vti);
    expect(screen.getByRole("option", { name: /VTI.*not selected/i })).toBeInTheDocument();
  });

  it("opens grouped rows, searches by name, and toggles individual holdings", async () => {
    const user = userEvent.setup();
    render(<Harness holdings={holdings} />);
    await user.click(screen.getByRole("button", { name: /Eligible holdings/ }));

    expect(screen.getByText("Equity")).not.toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByText("Bond")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search holdings");
    await user.type(search, "Vanguard");
    expect(screen.getByText("VTI")).toBeInTheDocument();
    expect(screen.queryByText("BND")).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /VTI.*Vanguard Total Stock/i }));
    expect(screen.getByRole("button", { name: /Eligible holdings/ })).toHaveTextContent(
      "2 of 3 selected",
    );
  });

  it("disambiguates duplicate labels and reaches each row from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        holdings={[
          holding("asset-xnas", "ABC", "Acme Corp", "EQUITY", HoldingType.SECURITY, "USD", "XNAS"),
          holding("asset-xtse", "ABC", "Acme Corp", "EQUITY", HoldingType.SECURITY, "CAD", "XTSE"),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Eligible holdings/ }));
    expect(
      screen.getByRole("option", { name: /ABC.*Acme Corp.*XNAS.*USD.*selected/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /ABC.*Acme Corp.*XTSE.*CAD.*selected/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("XNAS · USD")).toBeInTheDocument();
    expect(screen.getByText("XTSE · CAD")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);

    await user.click(screen.getByPlaceholderText("Search holdings"));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(
      screen.getByRole("option", { name: /ABC.*Acme Corp.*XTSE.*CAD.*not selected/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Eligible holdings/ })).toHaveTextContent(
      "1 of 2 selected",
    );
  });

  it("supports Clear and Select all and explains the empty state", async () => {
    const user = userEvent.setup();
    render(<Harness holdings={holdings} />);
    await user.click(screen.getByRole("button", { name: /Eligible holdings/ }));
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByRole("button", { name: /Eligible holdings/ })).toHaveTextContent(
      "0 of 3 selected",
    );
    expect(
      screen.getByText("Select at least one holding to calculate a plan."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: /Eligible holdings/ })).toHaveTextContent(
      "All holdings selected",
    );
  });

  it("disables Calculate and Enter when no holding is eligible", () => {
    const onCalculate = vi.fn();
    render(
      <PlannerInput
        description=""
        cashValue="100"
        availableCash={100}
        currency="USD"
        onCashChange={vi.fn()}
        onCalculate={onCalculate}
        hasPlan={false}
        isCalculating={false}
        isSourceLoading={false}
        hasEligibleHoldings={false}
        eligibleHoldingsSelector={<p>Select at least one holding to calculate a plan.</p>}
      />,
    );

    const calculate = screen.getByRole("button", { name: "Calculate plan" });
    expect(calculate).toBeDisabled();
    expect(
      screen.getByText("Select at least one holding to calculate a plan."),
    ).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onCalculate).not.toHaveBeenCalled();
  });
});
