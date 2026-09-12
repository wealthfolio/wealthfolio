import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  isDesktop: true,
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  registerDevAddonManifest: vi.fn(),
  unregisterDevAddonManifest: vi.fn(),
}));

vi.mock("@/adapters", () => adapters);

const iframeManager = vi.hoisted(() => ({ startAddon: vi.fn() }));

vi.mock("./iframe/addon-iframe-manager", () => ({ addonIframeManager: iframeManager }));

import {
  addonDevManager,
  getDevelopmentRuntimePackageError,
  shouldReloadDevelopmentAddon,
} from "./addons-dev-mode";

describe("shouldReloadDevelopmentAddon", () => {
  it("waits for a newer completed package generation", () => {
    expect(shouldReloadDevelopmentAddon({ buildInProgress: true, generation: 2 }, 1)).toBe(false);
    expect(shouldReloadDevelopmentAddon({ buildInProgress: false, generation: 1 }, 1)).toBe(false);
    expect(shouldReloadDevelopmentAddon({ buildInProgress: false, generation: 2 }, 1)).toBe(true);
  });

  it("rejects missing and invalid generations", () => {
    expect(shouldReloadDevelopmentAddon({ buildInProgress: false }, 1)).toBe(false);
    expect(
      shouldReloadDevelopmentAddon({ buildInProgress: false, generation: Number.NaN }, 1),
    ).toBe(false);
  });
});

describe("getDevelopmentRuntimePackageError", () => {
  it.each([404, 405])(
    "explains how to upgrade an incompatible development server (%s)",
    (status) => {
      expect(getDevelopmentRuntimePackageError(status, "Not Found")).toBe(
        "Development server does not support Wealthfolio 3.7 runtime packages. " +
          "Upgrade @wealthfolio/addon-dev-tools to version 3.7.0 or newer.",
      );
    },
  );

  it("preserves the server detail for other failures", () => {
    expect(getDevelopmentRuntimePackageError(500, "Build failed")).toBe(
      "Failed to load development addon package: Build failed",
    );
  });
});

describe("development addon reloads", () => {
  it("coalesces overlapping reload requests for the same addon", async () => {
    const manager = addonDevManager as unknown as {
      devServers: Map<string, unknown>;
      fetchRuntimePackage: (server: unknown) => Promise<unknown>;
      reloadAddon: (addonId: string) => Promise<void>;
    };
    const addonId = "reload-coalescing-test";
    manager.devServers.set(addonId, {
      id: addonId,
      name: "Reload coalescing test",
      port: 3001,
      status: "running",
      url: "http://localhost:3001",
    });

    let rejectPackage!: (error: Error) => void;
    const pendingPackage = new Promise<never>((_resolve, reject) => {
      rejectPackage = reject;
    });
    const fetchRuntimePackage = vi
      .spyOn(manager, "fetchRuntimePackage")
      .mockReturnValue(pendingPackage);

    const firstReload = manager.reloadAddon(addonId);
    const overlappingReload = manager.reloadAddon(addonId);
    expect(fetchRuntimePackage).toHaveBeenCalledTimes(1);

    rejectPackage(new Error("test reload failure"));
    await Promise.all([firstReload, overlappingReload]);

    await manager.reloadAddon(addonId);
    expect(fetchRuntimePackage).toHaveBeenCalledTimes(2);

    fetchRuntimePackage.mockRestore();
    manager.devServers.delete(addonId);
  });
});

describe("dev-server addon manifest sync with the network broker", () => {
  const addonId = "dev-addon";
  interface TestRuntimePackage {
    assets: never[];
    files: { isMain: boolean; content: string }[];
    generation: number;
    manifest: { id: string; name: string; version: string };
  }

  const runtimePackage: TestRuntimePackage = {
    assets: [],
    files: [{ isMain: true, content: "console.log('addon')" }],
    generation: 1,
    manifest: { id: addonId, name: "Dev Addon", version: "1.0.0" },
  };

  const manager = addonDevManager as unknown as {
    devServers: Map<
      string,
      { id: string; name: string; port: number; status: string; url: string }
    >;
    devAddons: Map<string, { disable: () => Promise<void> }>;
    activateRuntimePackage: (
      devServer: { id: string; name: string; port: number; status: string; url: string },
      runtimePackage: TestRuntimePackage,
    ) => Promise<void>;
    cleanup: () => void;
  };

  beforeEach(() => {
    adapters.isDesktop = true;
    adapters.registerDevAddonManifest.mockReset().mockResolvedValue(undefined);
    adapters.unregisterDevAddonManifest.mockReset().mockResolvedValue(undefined);
    adapters.logger.warn.mockReset();
    iframeManager.startAddon
      .mockReset()
      .mockResolvedValue({ disable: vi.fn().mockResolvedValue(undefined) });
    manager.devServers.set(addonId, {
      id: addonId,
      name: "Dev Addon",
      port: 3001,
      status: "stopped",
      url: "http://localhost:3001",
    });
  });

  afterEach(() => {
    manager.devServers.delete(addonId);
    manager.devAddons.delete(addonId);
  });

  it("registers the dev server's manifest with the backend on activation", async () => {
    await manager.activateRuntimePackage(manager.devServers.get(addonId)!, runtimePackage);

    expect(adapters.registerDevAddonManifest).toHaveBeenCalledWith(
      addonId,
      JSON.stringify(runtimePackage.manifest),
    );
  });

  it("logs and does not fail activation if registering the manifest fails", async () => {
    adapters.registerDevAddonManifest.mockRejectedValue(new Error("backend unavailable"));

    await expect(
      manager.activateRuntimePackage(manager.devServers.get(addonId)!, runtimePackage),
    ).resolves.toBeUndefined();
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to sync dev addon manifest for dev-addon"),
    );
  });

  it("unregisters the manifest during cleanup", async () => {
    await manager.activateRuntimePackage(manager.devServers.get(addonId)!, runtimePackage);
    adapters.registerDevAddonManifest.mockClear();

    manager.cleanup();
    await vi.waitFor(() => {
      expect(adapters.unregisterDevAddonManifest).toHaveBeenCalledWith(addonId);
    });
  });
});
