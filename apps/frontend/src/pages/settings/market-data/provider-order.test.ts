import { describe, expect, it } from "vitest";

import { moveProvider } from "./provider-order";

const providers = (...entries: [string, number][]) =>
  entries.map(([id, priority]) => ({ id, priority }));

describe("moveProvider", () => {
  it("swaps the priorities of two neighbours", () => {
    const ordered = providers(["YAHOO", 1], ["US_TREASURY_CALC", 10], ["BOERSE_FRANKFURT", 11]);

    expect(moveProvider(ordered, 2, -1)).toEqual([
      { id: "BOERSE_FRANKFURT", priority: 10 },
      { id: "US_TREASURY_CALC", priority: 11 },
    ]);
    expect(moveProvider(ordered, 0, 1)).toEqual([
      { id: "US_TREASURY_CALC", priority: 1 },
      { id: "YAHOO", priority: 10 },
    ]);
  });

  it("separates providers that share a priority", () => {
    const ordered = providers(["A", 1], ["B", 1], ["C", 1]);

    // A stays first; C moves above B, and each gets its own priority.
    expect(moveProvider(ordered, 2, -1)).toEqual([
      { id: "C", priority: 2 },
      { id: "B", priority: 3 },
    ]);
  });

  it("raises later providers only as far as the new order needs", () => {
    const ordered = providers(["A", 1], ["B", 10], ["C", 10], ["D", 12]);

    // B and C tie at 10; D lands between them at 11 and C moves to 12.
    expect(moveProvider(ordered, 3, -1)).toEqual([
      { id: "D", priority: 11 },
      { id: "C", priority: 12 },
    ]);
  });

  it("changes nothing past either end", () => {
    const ordered = providers(["A", 1], ["B", 2]);

    expect(moveProvider(ordered, 0, -1)).toEqual([]);
    expect(moveProvider(ordered, 1, 1)).toEqual([]);
  });
});
