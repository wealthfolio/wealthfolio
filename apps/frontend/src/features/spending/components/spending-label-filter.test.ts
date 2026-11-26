import { describe, expect, it } from "vitest";

import { EMPTY_LABEL_SELECTION, toLabelFilter } from "./spending-label-filter";

describe("toLabelFilter", () => {
  it("is undefined when nothing is picked, so the request carries no filter", () => {
    expect(toLabelFilter(EMPTY_LABEL_SELECTION)).toBeUndefined();
  });

  it("turns payee and event type picks into request labels", () => {
    expect(
      toLabelFilter({
        only: new Set(["payee:shop-1"]),
        without: new Set(["eventType:travel", "payee:shop-2"]),
      }),
    ).toEqual({
      include: [{ kind: "category", taxonomyId: "payees", categoryId: "shop-1" }],
      exclude: [
        { kind: "eventType", eventTypeId: "travel" },
        { kind: "category", taxonomyId: "payees", categoryId: "shop-2" },
      ],
    });
  });

  it("gives the same request for the same picks in any order", () => {
    const a = toLabelFilter({ only: new Set(), without: new Set(["payee:b", "payee:a"]) });
    const b = toLabelFilter({ only: new Set(), without: new Set(["payee:a", "payee:b"]) });
    expect(a).toEqual(b);
  });

  it("keeps an id that itself contains a colon and drops an unknown kind", () => {
    expect(
      toLabelFilter({ only: new Set(["payee:a:b", "mystery:x", "payee:"]), without: new Set() }),
    ).toEqual({
      include: [{ kind: "category", taxonomyId: "payees", categoryId: "a:b" }],
      exclude: [],
    });
  });
  it("turns a single event pick into an event label", () => {
    expect(toLabelFilter({ only: new Set(["event:trip-9"]), without: new Set() })).toEqual({
      include: [{ kind: "event", eventId: "trip-9" }],
      exclude: [],
    });
  });
});
