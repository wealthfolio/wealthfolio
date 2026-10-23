import { describe, expect, it } from "vitest";
import { stackTabsFor } from "./stack-config";

describe("stacked tabs from the navigation", () => {
  it("makes a tab of each destination, with / as the dashboard's first screen", () => {
    expect(stackTabsFor(["/dashboard", "/holdings"])).toEqual([
      { id: "dashboard", rootPath: "/dashboard", aliases: ["/"] },
      { id: "holdings", rootPath: "/holdings" },
    ]);
  });

  it("leaves the assistant out: its tool cards don't survive a hidden screen", () => {
    expect(stackTabsFor(["/dashboard", "/assistant"]).map((tab) => tab.id)).toEqual(["dashboard"]);
  });
});
