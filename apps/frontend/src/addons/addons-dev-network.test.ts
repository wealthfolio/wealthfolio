import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ManifestIdentity {
  id: string;
}

interface RuntimeInput {
  code: string;
}

const mocks = vi.hoisted(() => ({
  getInstalledAddons: vi.fn(),
  loadAddon: vi.fn(),
  registerDevAddonManifest: vi.fn<(manifest: ManifestIdentity) => Promise<void>>(),
  unregisterDevAddonManifest: vi.fn<(addonId: string) => Promise<void>>(),
  startAddon: vi.fn<(input: RuntimeInput) => Promise<{ disable(): Promise<void> }>>(),
  stopAddon: vi.fn().mockResolvedValue(undefined),
  stopAllAddons: vi.fn().mockResolvedValue(undefined),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/adapters", () => mocks);
vi.mock("@/addons/addons-runtime-context", () => ({
  getDynamicNavItems: vi.fn(() => []),
  getDynamicRoutes: vi.fn(() => []),
  setInstalledAddonIds: vi.fn(),
  triggerNavigationUpdate: vi.fn(),
  scopedKey: (addonId: string, id: string) => `${addonId}:${id}`,
  toRouterPath: (href: string) => href.replace(/^\//, ""),
}));
vi.mock("@/addons/iframe/addon-iframe-manager", () => ({
  addonIframeManager: { ...mocks, hasRuntime: vi.fn(() => false) },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { addonDevManager } from "./addons-dev-mode";
import { unloadAllAddons } from "./addons-core";
import { clearAllContributions, getDurableNavItems } from "./contribution-registry";

const devManifest = {
  id: "dev-network-test",
  name: "Dev network test",
  version: "1.0.0",
  main: "addon.js",
  permissions: [],
  network: { allowedHosts: ["dev.example.com"] },
  contributes: {
    routes: [{ id: "home", path: "" }],
    links: { sidebar: [{ route: "home", label: "Dev network test" }] },
  },
};
const installedManifest = {
  ...devManifest,
  contributes: undefined,
  network: { allowedHosts: ["installed.example.com"], approvedHosts: ["installed.example.com"] },
  enabled: true,
};
const runtimePackage = {
  generation: 1,
  manifest: devManifest,
  assets: [],
  files: [{ name: "addon.js", content: "dev code", isMain: true }],
};

beforeEach(() => {
  unloadAllAddons();
  clearAllContributions();
  vi.clearAllMocks();
  mocks.registerDevAddonManifest.mockReset();
  mocks.unregisterDevAddonManifest.mockReset();
  vi.stubEnv("VITE_ENABLE_ADDON_DEV_MODE", "true");
  vi.spyOn(addonDevManager, "enableDevMode").mockResolvedValue();
  addonDevManager.registerDevServer({ id: devManifest.id, name: devManifest.name, port: 3001 });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify(url.endsWith("/health") ? {} : runtimePackage), {
          status: 200,
        }),
      ),
    ),
  );
  mocks.getInstalledAddons.mockResolvedValue([
    { filePath: "/addons/dev-network-test", metadata: installedManifest },
  ]);
  mocks.loadAddon.mockResolvedValue({
    metadata: installedManifest,
    assets: [],
    files: [{ name: "addon.js", content: "installed code", isMain: true }],
  });
  mocks.startAddon.mockResolvedValue({ disable: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("dev addon network authorization lifecycle", () => {
  it("keeps the dev runtime and its contributions when an installed copy has the same id", async () => {
    const { loadAllAddons } = await import("./addons-loader");
    await loadAllAddons();
    expect(mocks.startAddon.mock.calls.map(([input]) => input.code)).toEqual(["dev code"]);
    expect(mocks.loadAddon).not.toHaveBeenCalled();
    expect(getDurableNavItems()).toEqual([
      expect.objectContaining({ addonId: devManifest.id, title: devManifest.name }),
    ]);
  });

  it("removes dev authorization before falling back to installed code after activation fails", async () => {
    const manifests = new Map<string, unknown>();
    mocks.registerDevAddonManifest.mockImplementation((manifest) => {
      manifests.set(manifest.id, manifest);
      return Promise.resolve();
    });
    mocks.unregisterDevAddonManifest.mockImplementation((addonId) => {
      manifests.delete(addonId);
      return Promise.resolve();
    });
    mocks.startAddon.mockRejectedValueOnce(new Error("Dev activation failed"));
    mocks.loadAddon.mockImplementation(() => {
      expect(manifests.has(devManifest.id)).toBe(false);
      return Promise.resolve({
        metadata: installedManifest,
        assets: [],
        files: [{ name: "addon.js", content: "installed code", isMain: true }],
      });
    });
    const { loadAllAddons } = await import("./addons-loader");
    await loadAllAddons();
    expect(mocks.loadAddon).toHaveBeenCalledWith(devManifest.id);
    expect(mocks.startAddon.mock.calls.map(([input]) => input.code)).toEqual([
      "dev code",
      "installed code",
    ]);
    expect(manifests.size).toBe(0);
  });
});
