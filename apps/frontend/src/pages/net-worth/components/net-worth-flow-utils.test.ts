import { describe, expect, it } from "vitest";

import type { ParsedNetWorth } from "./utils";
import { buildNetWorthFlowGraph, MAX_VISIBLE_LEAVES, type FlowLeafNode } from "./net-worth-flow-utils";

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
});
