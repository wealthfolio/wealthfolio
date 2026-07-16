import { describe, expect, it } from "vitest";

import {
  canDistributeSplitCents,
  distributeEvenlyCents,
  distributeRemainingCents,
} from "./split-utils";

describe("split utils", () => {
  it("distributes remaining cents evenly and keeps the exact total", () => {
    expect(distributeRemainingCents(12000, 0, 3)).toEqual([4000, 4000, 4000]);
  });

  it("places rounding cents on the earliest empty lines", () => {
    expect(distributeRemainingCents(10000, 0, 3)).toEqual([3334, 3333, 3333]);
  });

  it("only distributes the unassigned remainder", () => {
    expect(distributeRemainingCents(12000, 8000, 2)).toEqual([2000, 2000]);
  });

  it("returns zeroes when there is no positive remainder", () => {
    expect(distributeRemainingCents(10000, 10001, 2)).toEqual([0, 0]);
  });

  it("distributes a full amount evenly across all lines", () => {
    expect(distributeEvenlyCents(7727, 2)).toEqual([3864, 3863]);
  });

  it("allows rebalancing after adding an empty line to a fully assigned split", () => {
    expect(canDistributeSplitCents(7727, 7727, 1, 2)).toBe(true);
  });

  it("allows distribution when every split line is empty", () => {
    expect(canDistributeSplitCents(7727, 0, 2, 2)).toBe(true);
  });
});
