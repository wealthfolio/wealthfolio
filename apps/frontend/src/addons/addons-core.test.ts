import { describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  getInstalledAddons: vi.fn(),
  loadAddon: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/adapters", () => adapters);

vi.mock("@/addons/addons-runtime-context", () => ({
  getDynamicNavItems: vi.fn(() => []),
  getDynamicRoutes: vi.fn(() => []),
  setInstalledAddonIds: vi.fn(),
}));

vi.mock("@/addons/contribution-registry", () => ({
  clearAllContributions: vi.fn(),
  ingestAddonContributions: vi.fn(),
}));

const iframeManager = vi.hoisted(() => ({
  hasRuntime: vi.fn(() => false),
  startAddon: vi.fn(),
  stopAllAddons: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/addons/iframe/addon-iframe-manager", () => ({ addonIframeManager: iframeManager }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { activateView } from "./activation-coordinator";
import { loadInstalledAddons, unloadAllAddons } from "./addons-core";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const manifest = {
  contributes: { routes: [{ id: "home" }] },
  enabled: true,
  id: "test-addon",
  main: "addon.js",
  name: "Test Addon",
  version: "1.0.0",
};

function extractedAddon(code: string) {
  return {
    files: [{ content: code, isMain: true, name: "addon.js" }],
    metadata: manifest,
  };
}

describe("addon reload generations", () => {
  it("prevents a pre-reload backend read from starting or publishing a runtime", async () => {
    const oldRead = deferred<ReturnType<typeof extractedAddon>>();
    const currentRead = deferred<ReturnType<typeof extractedAddon>>();
    adapters.getInstalledAddons.mockResolvedValue([
      { filePath: "/addons/test-addon", metadata: manifest },
    ]);
    adapters.loadAddon
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => currentRead.promise);
    iframeManager.startAddon.mockResolvedValue({ disable: vi.fn(() => Promise.resolve()) });

    await loadInstalledAddons();
    const oldActivation = activateView("test-addon");

    unloadAllAddons();
    await loadInstalledAddons();
    const currentActivation = activateView("test-addon");

    oldRead.resolve(extractedAddon("old code"));
    await Promise.resolve();
    await Promise.resolve();
    expect(iframeManager.startAddon).not.toHaveBeenCalled();

    currentRead.resolve(extractedAddon("current code"));
    await expect(Promise.all([oldActivation, currentActivation])).resolves.toEqual([true, true]);
    expect(iframeManager.startAddon).toHaveBeenCalledTimes(1);
    expect(iframeManager.startAddon).toHaveBeenCalledWith(
      expect.objectContaining({ code: "current code" }),
    );
  });
});
