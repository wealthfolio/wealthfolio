import { describe, expect, it, vi } from "vitest";

vi.mock("@/adapters", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/addons/addons-runtime-context", () => ({
  clearAddonRegistrations: vi.fn(),
  createAddonHostAPI: vi.fn(),
  registerAddonNavItem: vi.fn(),
  registerAddonRoute: vi.fn(),
  removeAddonNavItem: vi.fn(),
  removeAddonRoute: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { AddonIframeManager } from "./addon-iframe-manager";

const input = {
  addonId: "test-addon",
  code: "export default () => undefined",
  manifest: { id: "test-addon", name: "Test Addon", version: "1.0.0" },
};

describe("AddonIframeManager", () => {
  it("rejects a stale boot before it can touch the current runtime", async () => {
    const manager = new AddonIframeManager();
    const isCurrent = vi.fn(() => false);

    await expect(manager.startAddon({ ...input, isCurrent })).rejects.toMatchObject({
      name: "AddonLoadCancelled",
    });
    expect(isCurrent).toHaveBeenCalledTimes(1);
  });

  it("checks the generation again after awaiting runtime teardown", async () => {
    const manager = new AddonIframeManager();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    await expect(manager.startAddon({ ...input, isCurrent })).rejects.toMatchObject({
      name: "AddonLoadCancelled",
    });
    expect(isCurrent).toHaveBeenCalledTimes(2);
  });

  it("hides stale warm content when the next route render fails", () => {
    const manager = new AddonIframeManager();
    const routeStatusListener = vi.fn();
    const iframeStyle = {
      height: "600px",
      pointerEvents: "auto",
      visibility: "visible",
      width: "800px",
    };
    const runtime = {
      activeRoute: {
        location: { hash: "", params: {}, pathname: "/addons/test-addon/next", search: "" },
        routeId: "next",
      },
      activeRouteRequestId: "request-1",
      addonId: "test-addon",
      iframe: { style: iframeStyle },
      lastRenderedRouteKey: "previous-route",
      routeStatusListeners: new Set([routeStatusListener]),
    };

    const internals = manager as unknown as {
      handleRouteRenderError: (runtime: unknown, message: unknown) => void;
    };
    internals.handleRouteRenderError(runtime, {
      error: "Route component failed",
      requestId: "request-1",
    });

    expect(runtime.lastRenderedRouteKey).toBeUndefined();
    expect(iframeStyle).toMatchObject({
      height: "0",
      pointerEvents: "none",
      visibility: "hidden",
      width: "0",
    });
    expect(routeStatusListener).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Route component failed", status: "error" }),
    );
  });
});
