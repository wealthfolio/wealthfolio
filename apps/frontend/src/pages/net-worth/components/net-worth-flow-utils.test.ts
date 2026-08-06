import { describe, expect, it } from "vitest";

import type { BreakdownEntry, ParsedNetWorth } from "./utils";
import {
  buildNetWorthFlowGraph,
  MAX_VISIBLE_LEAVES,
  shortenLeafName,
  type FlowLeafNode,
} from "./net-worth-flow-utils";

const labels = {
  assets: "Assets",
  netWorth: "Net Worth",
  debts: "Debts",
  otherHoldings: (count: number) => `${count} smaller holdings`,
  unattributed: "Other",
};

function netWorth(overrides: Partial<ParsedNetWorth>): ParsedNetWorth {
  return {
    netWorth: 0,
    assets: { total: 0, breakdown: [] },
    liabilities: { total: 0, breakdown: [] },
    ...overrides,
  };
}

describe("buildNetWorthFlowGraph", () => {
  it("returns null when there are no assets", () => {
    expect(buildNetWorthFlowGraph(netWorth({}), labels)).toBeNull();
  });

  it("links leaves through their category into Assets and Net Worth", () => {
    const data = netWorth({
      netWorth: 900,
      assets: {
        total: 900,
        breakdown: [
          {
            category: "properties",
            name: "Real Estate",
            value: 900,
            children: [
              { category: "properties", name: "House A", value: 500 },
              { category: "properties", name: "House B", value: 400 },
            ],
          },
        ],
      },
    });

    const graph = buildNetWorthFlowGraph(data, labels);
    expect(graph).not.toBeNull();
    const { nodes, links } = graph!;

    const houseA = nodes.find((n) => n.name === "House A")!;
    const category = nodes.find((n) => n.kind === "category")!;
    const assets = nodes.find((n) => n.kind === "assets")!;
    const netWorthNode = nodes.find((n) => n.kind === "net-worth")!;

    const idx = (n: (typeof nodes)[number]) => nodes.indexOf(n);
    expect(links).toContainEqual(
      expect.objectContaining({ source: idx(houseA), target: idx(category), value: 500 }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ source: idx(category), target: idx(assets), value: 900 }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ source: idx(assets), target: idx(netWorthNode), value: 900 }),
    );
  });

  it("skips the leaf layer for a category with no itemized children", () => {
    const data = netWorth({
      netWorth: 100,
      assets: { total: 100, breakdown: [{ category: "cash", name: "Cash", value: 100 }] },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    expect(graph.nodes.some((n) => n.kind === "leaf" || n.kind === "bucket")).toBe(false);
    expect(graph.nodes.some((n) => n.kind === "category" && n.name === "Cash")).toBe(true);
  });

  it("buckets holdings beyond MAX_VISIBLE_LEAVES and the bucket sums exactly", () => {
    const children = Array.from({ length: 8 }, (_, i) => ({
      category: "investments",
      name: `Account ${i}`,
      value: (i + 1) * 10, // 10..80, total 360
    }));
    const data = netWorth({
      netWorth: 360,
      assets: {
        total: 360,
        breakdown: [{ category: "investments", name: "Investments", value: 360, children }],
      },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    const leaves = graph.nodes.filter((n) => n.kind === "leaf" || n.kind === "bucket") as FlowLeafNode[];
    const bucket = leaves.find((n) => n.kind === "bucket")!;

    // MAX_VISIBLE_LEAVES - 1 individual leaves shown, the rest folded into one bucket.
    expect(leaves.filter((n) => n.kind === "leaf")).toHaveLength(MAX_VISIBLE_LEAVES - 1);
    expect(bucket.bucketedCount).toBe(8 - (MAX_VISIBLE_LEAVES - 1));

    // Bucket contains the smallest holdings and sums to exactly their total.
    const smallest = children.slice(0, 8 - (MAX_VISIBLE_LEAVES - 1)).reduce((s, c) => s + c.value, 0);
    expect(bucket.value).toBe(smallest);

    // Every leaf/bucket value sums to the category total — nothing dropped.
    const leafTotal = leaves.reduce((sum, n) => sum + n.value, 0);
    expect(leafTotal).toBeCloseTo(360, 6);
  });

  it("does not bucket when a category has MAX_VISIBLE_LEAVES or fewer holdings", () => {
    const children = [
      { category: "properties", name: "A", value: 1 },
      { category: "properties", name: "B", value: 1 },
      { category: "properties", name: "C", value: 1 },
    ];
    const data = netWorth({
      netWorth: 3,
      assets: { total: 3, breakdown: [{ category: "properties", name: "Real Estate", value: 3, children }] },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    const leaves = graph.nodes.filter((n) => n.kind === "leaf" || n.kind === "bucket");
    expect(leaves).toHaveLength(3);
    expect(leaves.every((n) => n.kind === "leaf")).toBe(true);
  });

  it("surfaces an unattributed remainder rather than dropping it", () => {
    const data = netWorth({
      netWorth: 100,
      assets: {
        total: 100,
        breakdown: [
          {
            category: "otherAssets",
            name: "Other Assets",
            value: 100,
            children: [{ category: "otherAssets", name: "Item", value: 70 }],
          },
        ],
      },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    const unattributed = graph.nodes.find((n) => n.name === "Other") as FlowLeafNode | undefined;
    expect(unattributed).toBeDefined();
    expect(unattributed!.value).toBeCloseTo(30, 6);
  });

  it("adds a Debts branch off Assets, sized to the liabilities total", () => {
    const data = netWorth({
      netWorth: 700,
      assets: { total: 1000, breakdown: [{ category: "cash", name: "Cash", value: 1000 }] },
      liabilities: { total: 300, breakdown: [{ category: "liabilities", name: "Loan", value: 300 }] },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    const assets = graph.nodes.find((n) => n.kind === "assets")!;
    const debts = graph.nodes.find((n) => n.kind === "debts")!;
    expect(debts.value).toBe(300);
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        source: graph.nodes.indexOf(assets),
        target: graph.nodes.indexOf(debts),
        value: 300,
      }),
    );
  });

  it("omits the Net Worth branch rather than drawing a negative flow", () => {
    const data = netWorth({
      netWorth: -200,
      assets: { total: 100, breakdown: [{ category: "cash", name: "Cash", value: 100 }] },
      liabilities: { total: 300, breakdown: [{ category: "liabilities", name: "Loan", value: 300 }] },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    expect(graph.nodes.some((n) => n.kind === "net-worth")).toBe(false);
    expect(graph.nodes.some((n) => n.kind === "debts")).toBe(true);
  });

  it("ignores zero-value categories", () => {
    const data = netWorth({
      netWorth: 100,
      assets: {
        total: 100,
        breakdown: [
          { category: "cash", name: "Cash", value: 100 },
          { category: "vehicles", name: "Car Collection", value: 0 },
        ],
      },
    });

    const graph = buildNetWorthFlowGraph(data, labels)!;
    expect(graph.nodes.some((n) => n.name === "Car Collection")).toBe(false);
  });

  describe("investmentAccounts", () => {
    function investmentData(total: number): ParsedNetWorth {
      return netWorth({
        netWorth: total,
        assets: {
          total,
          // The backend never populates Investments' children — this is the
          // real shape net-worth-content.tsx hands the graph builder.
          breakdown: [{ category: "investments", name: "Investments", value: total }],
        },
      });
    }

    it("fans Investments in by account when provided, sorted by value descending", () => {
      const accounts: BreakdownEntry[] = [
        { category: "investments", name: "Roth IRA", value: 200, assetId: "acc-1" },
        { category: "investments", name: "Personal Investments – 119", value: 500, assetId: "acc-2" },
        { category: "investments", name: "Parametrics", value: 300, assetId: "acc-3" },
      ];
      const graph = buildNetWorthFlowGraph(investmentData(1000), labels, accounts)!;
      const leaves = graph.nodes.filter((n) => n.kind === "leaf") as FlowLeafNode[];

      expect(leaves.map((n) => n.name)).toEqual(["Personal Investments – 119", "Parametrics", "Roth IRA"]);
    });

    it("sums investment account leaves exactly to the Investments category total", () => {
      const accounts: BreakdownEntry[] = [
        { category: "investments", name: "Roth IRA", value: 200.11, assetId: "acc-1" },
        { category: "investments", name: "Brokerage", value: 500.22, assetId: "acc-2" },
      ];
      const graph = buildNetWorthFlowGraph(investmentData(700.33), labels, accounts)!;
      const leaves = graph.nodes.filter((n) => n.kind === "leaf" || n.kind === "bucket") as FlowLeafNode[];

      const leafTotal = leaves.reduce((sum, n) => sum + n.value, 0);
      expect(leafTotal).toBeCloseTo(700.33, 6);
    });

    it("adds a balancing leaf when accounts undercount the category total", () => {
      const accounts: BreakdownEntry[] = [
        { category: "investments", name: "Roth IRA", value: 200, assetId: "acc-1" },
      ];
      const graph = buildNetWorthFlowGraph(investmentData(1000), labels, accounts)!;
      const leaves = graph.nodes.filter((n) => n.kind === "leaf") as FlowLeafNode[];

      const balancing = leaves.find((n) => n.name === labels.unattributed);
      expect(balancing).toBeDefined();
      expect(balancing!.value).toBeCloseTo(800, 6);
      const leafTotal = leaves.reduce((sum, n) => sum + n.value, 0);
      expect(leafTotal).toBeCloseTo(1000, 6);
    });

    it("buckets accounts beyond MAX_VISIBLE_LEAVES the same way other categories do", () => {
      const accounts: BreakdownEntry[] = Array.from({ length: 20 }, (_, i) => ({
        category: "investments",
        name: `Account ${i}`,
        value: (i + 1) * 100,
        assetId: `acc-${i}`,
      }));
      const total = accounts.reduce((sum, a) => sum + a.value, 0);
      const graph = buildNetWorthFlowGraph(investmentData(total), labels, accounts)!;
      const leaves = graph.nodes.filter((n) => n.kind === "leaf" || n.kind === "bucket") as FlowLeafNode[];

      expect(leaves.filter((n) => n.kind === "leaf")).toHaveLength(MAX_VISIBLE_LEAVES - 1);
      expect(leaves.some((n) => n.kind === "bucket")).toBe(true);
      const leafTotal = leaves.reduce((sum, n) => sum + n.value, 0);
      expect(leafTotal).toBeCloseTo(total, 6);
    });

    it("falls back to the flat Investments node when accounts overcount the category total", () => {
      const accounts: BreakdownEntry[] = [
        { category: "investments", name: "Roth IRA", value: 900, assetId: "acc-1" },
        { category: "investments", name: "Brokerage", value: 500, assetId: "acc-2" },
      ];
      // Accounts sum to 1400, but the net-worth snapshot says 1000 — never fudge.
      const graph = buildNetWorthFlowGraph(investmentData(1000), labels, accounts)!;
      expect(graph.nodes.some((n) => n.kind === "leaf" || n.kind === "bucket")).toBe(false);
      expect(graph.nodes.some((n) => n.kind === "category" && n.name === "Investments")).toBe(true);
    });

    it("falls back to the flat Investments node when no account data is supplied", () => {
      const graph = buildNetWorthFlowGraph(investmentData(1000), labels)!;
      expect(graph.nodes.some((n) => n.kind === "leaf" || n.kind === "bucket")).toBe(false);
    });
  });
});

describe("shortenLeafName", () => {
  it("drops a trailing parenthetical suffix", () => {
    expect(shortenLeafName("FundersClub ($236K Basis)")).toBe("FundersClub");
  });

  it("drops a trailing parenthetical and a trailing date suffix together", () => {
    expect(shortenLeafName("FundersClub ($236K Basis) - 12/31/2024")).toBe("FundersClub");
  });

  it("leaves an ordinary name untouched", () => {
    expect(shortenLeafName("Roth IRA")).toBe("Roth IRA");
  });

  it("never returns an empty string", () => {
    expect(shortenLeafName("(100%)")).toBe("(100%)");
  });
});
