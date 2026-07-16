import { ADDON_ICON_NAMES } from "@wealthfolio/addon-sdk";
import { addonIcons, addonIconNames } from "@wealthfolio/ui/components/ui/addon-icons";
import { describe, expect, it } from "vitest";

// The SDK owns the canonical addon icon name list (the public, typed contract);
// @wealthfolio/ui owns the runtime name -> component registry. They must stay in
// sync — a name in one but not the other means either a type that renders the
// fallback or an icon no addon can name. This test fails loudly on drift.
describe("addon icon registry", () => {
  it("host registry matches the SDK's canonical name list", () => {
    expect([...addonIconNames].sort()).toEqual([...ADDON_ICON_NAMES].sort());
  });

  it("every registry entry is a renderable component", () => {
    for (const name of ADDON_ICON_NAMES) {
      expect(typeof addonIcons[name]).toBe("function");
    }
  });
});
