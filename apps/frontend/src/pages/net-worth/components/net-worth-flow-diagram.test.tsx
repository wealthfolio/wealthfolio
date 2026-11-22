import { render, screen } from "@/test/render";
import { cloneElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { NetWorthFlow } from "./net-worth-flow-diagram";
import { flowDiagramLayout } from "./net-worth-flow-utils";
import type { ParsedNetWorth } from "./utils";

// jsdom has no layout, so give the real Sankey a fixed size instead of
// ResponsiveContainer's measured one.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<Record<string, unknown>> }) =>
    cloneElement(children, { width: 800, height: 600 }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-current-account-valuations", () => ({
  useCurrentAccountValuations: () => ({ currentAccountValuations: [], isLoading: false }),
}));

function flow(data: ParsedNetWorth, isIncomplete = false) {
  return render(
    <NetWorthFlow data={data} currency="USD" isIncomplete={isIncomplete} onSelect={vi.fn()} />,
  );
}

const solvent: ParsedNetWorth = {
  netWorth: 700,
  assets: { total: 1000, breakdown: [{ category: "cash", name: "Cash", value: 1000 }] },
  liabilities: {
    total: 300,
    breakdown: [{ category: "liabilities", name: "Loan", value: 300, assetId: "loan" }],
  },
};

describe("NetWorthFlow", () => {
  it("labels an incomplete total as a known subtotal, like the breakdown table", () => {
    flow(solvent, true);
    expect(screen.getByText("Known subtotal")).toBeInTheDocument();
    expect(screen.queryByText("Net Worth")).not.toBeInTheDocument();
  });

  it("labels a complete total as net worth", () => {
    flow(solvent);
    expect(screen.getByText("Net Worth")).toBeInTheDocument();
    expect(screen.queryByText("Known subtotal")).not.toBeInTheDocument();
  });

  it("shows each node's own amount, not the layout's larger link total", () => {
    // Debts exceed assets: Recharts sizes the Assets node by its 300 outflow.
    flow({
      netWorth: -200,
      assets: { total: 100, breakdown: [{ category: "cash", name: "Cash", value: 100 }] },
      liabilities: {
        total: 300,
        breakdown: [{ category: "liabilities", name: "Loan", value: 300, assetId: "loan" }],
      },
    });
    expect(screen.getByText("$100")).toBeInTheDocument();
    expect(screen.getAllByText("$300")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cash — $100" })).toBeInTheDocument();
  });
});

describe("flowDiagramLayout", () => {
  it.each([false, true])(
    "leaves room for visible ribbons beyond the row padding (mobile=%s)",
    (isMobile) => {
      for (let leadingCount = 1; leadingCount <= 80; leadingCount++) {
        const { height, rowPitch, margin } = flowDiagramLayout(leadingCount, isMobile);
        const plotHeight = height - margin.top - margin.bottom;
        const ribbonRoom = plotHeight - (leadingCount - 1) * rowPitch;
        expect(ribbonRoom, `${leadingCount} leading nodes`).toBeGreaterThanOrEqual(40);
      }
    },
  );
});
