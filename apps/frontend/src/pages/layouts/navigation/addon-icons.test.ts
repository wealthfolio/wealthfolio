import { ADDON_ICON_NAMES } from "@wealthfolio/addon-sdk";
import { addonIcons, addonIconNames } from "@wealthfolio/ui/components/ui/addon-icons";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { resolveNavigationIcon } from "./navigation-icons";

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

describe("addon SVG data URL icons", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#000"/></svg>';

  it("draws a data URL as a mask with quotes and # encoded", () => {
    const { container } = render(resolveNavigationIcon(`data:image/svg+xml,${svg}`, "h-5 w-5"));
    const span = container.querySelector("span");
    expect(span?.getAttribute("style")).toContain("%22http://www.w3.org/2000/svg%22");
    expect(span?.getAttribute("style")).toContain("fill=%22%23000%22");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders the fallback for an oversized data URL", () => {
    const { container } = render(
      resolveNavigationIcon(`data:image/svg+xml,${svg}${" ".repeat(9000)}`, "h-5 w-5"),
    );
    expect(container.querySelector("span")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
