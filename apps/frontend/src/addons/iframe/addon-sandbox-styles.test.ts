// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeAddonDom } from "@/test/fake-addon-dom";
import {
  clearAddonStyles,
  createCssModuleSource,
  installAddonCssFiles,
  installAddonStyle,
  isCssFile,
} from "./addon-sandbox-styles";

function addonStyleElements() {
  return Array.from(
    document.head.querySelectorAll<HTMLStyleElement>("style[data-wealthfolio-addon-style]"),
  );
}

afterEach(() => {
  clearAddonStyles();
});

describe("addon sandbox styles", () => {
  beforeEach(() => {
    installFakeAddonDom();
  });

  it("detects css assets case-insensitively", () => {
    expect(isCssFile("dist/style.css")).toBe(true);
    expect(isCssFile("dist/theme.CSS")).toBe(true);
    expect(isCssFile("dist/addon.js")).toBe(false);
  });

  it("injects extracted addon css files and ignores non-css files", () => {
    installAddonCssFiles([
      { content: "export default {}", isMain: true, name: "dist/addon.js" },
      { content: ".addon-card { color: red; }", name: "dist/style.css" },
    ]);

    const styles = addonStyleElements();
    expect(styles).toHaveLength(1);
    expect(styles[0]?.getAttribute("data-wealthfolio-addon-style")).toBe("dist/style.css");
    expect(styles[0]?.textContent).toContain(".addon-card");
  });

  it("upserts css imports without duplicating style tags", () => {
    installAddonStyle("dist/style.css", ".addon-card { color: red; }");
    installAddonStyle("dist/style.css", ".addon-card { color: green; }");

    const styles = addonStyleElements();
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("green");
  });

  it("creates a side-effect module for native css imports", () => {
    const source = createCssModuleSource("dist/style.css", ".addon-card { color: red; }");

    expect(source).toContain("__wealthfolioInstallAddonStyle");
    expect(source).toContain("dist/style.css");
    expect(source).toContain("export default css");
  });
});
