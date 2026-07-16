import { afterEach, describe, expect, it } from "vitest";
import {
  clearAddonRegistrations,
  getDynamicRoutes,
  registerAddonNavItem,
  registerAddonRoute,
  setInstalledAddonIds,
} from "./addons-runtime-context";

describe("addons runtime route policy", () => {
  afterEach(() => {
    for (const id of [
      "evil-addon",
      "swingfolio-addon",
      "goal-progress-tracker-addon",
      "foo",
      "foo-addon",
      "MyWidget-addon",
    ]) {
      clearAddonRegistrations(id);
    }
    setInstalledAddonIds([]);
  });

  it("allows routes under the add-on slug without the addon suffix", () => {
    registerAddonNavItem("swingfolio-addon", {
      id: "swingfolio",
      label: "Swingfolio",
      route: "/addons/swingfolio",
    });
    registerAddonRoute("swingfolio-addon", {
      path: "/addons/swingfolio/settings",
      routeId: "/addons/swingfolio/settings",
    });

    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          addonId: "swingfolio-addon",
          href: "/addons/swingfolio/settings",
        }),
      ]),
    );
  });

  it("allows a custom namespace on a first-come-first-served basis", () => {
    registerAddonNavItem("goal-progress-tracker-addon", {
      id: "goal-progress",
      label: "Goal Progress",
      route: "/addon/investment-target-tracker",
    });
    registerAddonRoute("goal-progress-tracker-addon", {
      path: "/addon/investment-target-tracker",
      routeId: "investment-target-tracker",
    });

    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          addonId: "goal-progress-tracker-addon",
          href: "/addon/investment-target-tracker",
        }),
      ]),
    );

    // Another add-on cannot take over an already-claimed namespace.
    expect(() =>
      registerAddonRoute("evil-addon", {
        path: "/addon/investment-target-tracker/steal",
        routeId: "steal",
      }),
    ).toThrow("cannot register route");
  });

  it("releases a claimed namespace when the add-on is unloaded", () => {
    registerAddonRoute("goal-progress-tracker-addon", {
      path: "/addon/investment-target-tracker",
      routeId: "investment-target-tracker",
    });
    clearAddonRegistrations("goal-progress-tracker-addon");

    registerAddonRoute("swingfolio-addon", {
      path: "/addon/investment-target-tracker",
      routeId: "reclaimed",
    });
    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ addonId: "swingfolio-addon" })]),
    );
  });

  it("reserves a peer add-on's slug namespace against squatting, regardless of load order", () => {
    // The installed registry knows swingfolio-addon exists (slug "swingfolio").
    setInstalledAddonIds(["swingfolio-addon", "evil-addon"]);

    // evil-addon loads first and tries to grab swingfolio's namespace.
    expect(() =>
      registerAddonRoute("evil-addon", {
        path: "/addon/swingfolio",
        routeId: "hijack",
      }),
    ).toThrow("cannot register route");

    // The legitimate owner can still register its own namespace.
    registerAddonRoute("swingfolio-addon", {
      path: "/addons/swingfolio",
      routeId: "home",
    });
    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ addonId: "swingfolio-addon", href: "/addons/swingfolio" }),
      ]),
    );
  });

  it("gives a bare-id add-on precedence over a suffixed peer for the shared slug", () => {
    // "foo" and "foo-addon" both resolve slug "foo"; exact-id ownership wins.
    setInstalledAddonIds(["foo", "foo-addon"]);

    registerAddonRoute("foo", { path: "/addon/foo", routeId: "own" });
    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ addonId: "foo", href: "/addon/foo" })]),
    );

    // The suffixed peer cannot co-own the "foo" slug.
    expect(() =>
      registerAddonRoute("foo-addon", { path: "/addon/foo", routeId: "shadow" }),
    ).toThrow("cannot register route");
  });

  it("blocks a different-cased squat of a reserved namespace", () => {
    setInstalledAddonIds(["MyWidget-addon", "evil-addon"]);

    // Router matching is case-insensitive; the reservation must be too.
    expect(() =>
      registerAddonRoute("evil-addon", { path: "/addon/mywidget", routeId: "hijack" }),
    ).toThrow("cannot register route");
  });

  it("still allows a genuinely custom namespace that no installed add-on owns", () => {
    setInstalledAddonIds(["goal-progress-tracker-addon", "evil-addon"]);

    // investment-target-tracker is nobody's identity → first-come-first-served.
    registerAddonRoute("goal-progress-tracker-addon", {
      path: "/addon/investment-target-tracker",
      routeId: "investment-target-tracker",
    });
    expect(getDynamicRoutes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ addonId: "goal-progress-tracker-addon" })]),
    );
  });

  it("blocks an add-on from self-authorizing another add-on namespace", () => {
    expect(() =>
      registerAddonNavItem("evil-addon", {
        id: "victim",
        label: "Victim",
        route: "/addon/victim-addon",
      }),
    ).toThrow("cannot register sidebar route");

    expect(() =>
      registerAddonRoute("evil-addon", {
        path: "/addon/victim-addon/dashboard",
        routeId: "/addon/victim-addon/dashboard",
      }),
    ).toThrow("cannot register route");
  });
});
