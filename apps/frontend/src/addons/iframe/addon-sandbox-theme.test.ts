// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeAddonDom } from "@/test/fake-addon-dom";
import { applyHostTheme, collectAddonThemeSnapshot } from "./addon-sandbox-theme";

afterEach(() => {
  applyHostTheme({ cssVariables: {} });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.body.className = "";
  document.body.removeAttribute("style");
});

describe("addon sandbox theme bridge", () => {
  beforeEach(() => {
    installFakeAddonDom();
  });

  it("collects app mode, font, color scheme, and css variables from the host document", () => {
    document.documentElement.classList.add("overflow-x-hidden", "dark");
    document.documentElement.style.colorScheme = "dark";
    document.documentElement.style.setProperty("--background", "black");
    document.documentElement.style.setProperty("--foreground", "white");
    document.body.classList.add("overflow-x-hidden", "font-serif");
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    document.body.style.color = "rgb(255, 255, 255)";
    document.body.style.fontFamily = "Merriweather, serif";

    const theme = collectAddonThemeSnapshot();

    expect(theme.backgroundColor).toBe("rgb(0, 0, 0)");
    expect(theme.themeClass).toBe("dark");
    expect(theme.colorScheme).toBe("dark");
    expect(theme.foregroundColor).toBe("rgb(255, 255, 255)");
    expect(theme.fontClass).toBe("font-serif");
    expect(theme.fontFamily).toContain("Merriweather");
    expect(theme.cssVariables).toMatchObject({
      "--background": "black",
      "--foreground": "white",
    });
  });

  it("applies host theme updates and removes stale host css variables", () => {
    document.documentElement.classList.add("dark", "app-lockdown");
    document.body.classList.add("font-mono");

    applyHostTheme({
      colorScheme: "light",
      cssVariables: { "--background": "white", "--old-token": "remove-me" },
      fontClass: "font-sans",
      fontFamily: "Inter, sans-serif",
      themeClass: "light",
    });
    applyHostTheme({
      colorScheme: "dark",
      cssVariables: { "--background": "black" },
      fontClass: "font-serif",
      fontFamily: "Merriweather, serif",
      themeClass: "dark",
    });

    expect(document.documentElement.classList.contains("app-lockdown")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("black");
    expect(document.documentElement.style.getPropertyValue("--old-token")).toBe("");
    expect(document.body.classList.contains("font-mono")).toBe(false);
    expect(document.body.classList.contains("font-serif")).toBe(true);
    expect(document.body.style.fontFamily).toContain("Merriweather");
  });
});
