import { afterEach, beforeEach, expect, it, vi } from "vitest";
interface ManifestIdentity {
  id: string;
}

const mocks = vi.hoisted(() => ({
  registerDevAddonManifest: vi.fn<(manifest: ManifestIdentity) => Promise<void>>(),
  unregisterDevAddonManifest: vi.fn<(addonId: string) => Promise<void>>(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/adapters", () => ({ ...mocks, loadAddonAsset: vi.fn() }));
vi.mock("./addons-core", () => ({ reloadAllAddons: vi.fn() }));
vi.mock("./contribution-registry", () => ({
  clearAddonContributions: vi.fn(),
  ingestAddonContributions: vi.fn(),
}));
vi.mock("./addons-runtime-context", () => ({
  clearAddonRegistrations: vi.fn(),
  createAddonHostAPI: vi.fn(),
  registerAddonNavItem: vi.fn(),
  registerAddonRoute: vi.fn(),
  removeAddonNavItem: vi.fn(),
  removeAddonRoute: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { addonDevManager } from "./addons-dev-mode";
import { addonIframeManager } from "./iframe/addon-iframe-manager";
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await addonIframeManager.stopAllAddons();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("coalesces overlapping dev loads without removing the active runtime authorization", async () => {
  const manifests = new Map<string, unknown>();
  const releases: (() => void)[] = [];
  mocks.registerDevAddonManifest.mockImplementation(async (manifest) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    manifests.set(manifest.id, manifest);
  });
  mocks.unregisterDevAddonManifest.mockImplementation((id) => {
    manifests.delete(id);
    return Promise.resolve();
  });
  const manifest = {
    id: "overlap-test",
    name: "Overlap",
    version: "1.0.0",
    main: "addon.js",
    permissions: [],
    network: { allowedHosts: ["dev.example.com"] },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? {}
              : {
                  generation: 1,
                  manifest,
                  assets: [],
                  files: [{ name: "addon.js", content: "export default () => {}", isMain: true }],
                },
          ),
          { status: 200 },
        ),
      ),
    ),
  );
  addonDevManager.registerDevServer({ id: manifest.id, name: manifest.name, port: 3001 });
  const first = addonDevManager.loadAddonFromDevServer(manifest.id);
  const second = addonDevManager.loadAddonFromDevServer(manifest.id);
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  // Rediscovery during loading must keep the server object the transaction updates.
  addonDevManager.registerDevServer({ id: manifest.id, name: manifest.name, port: 3001 });
  releases[0]();
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  const frame = document.querySelector("iframe")!;
  const params = new URLSearchParams(frame.name);
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        channel: "wealthfolio:addon-sandbox:v1",
        addonId: manifest.id,
        nonce: params.get("nonce"),
        type: "loaded",
      },
    }),
  );
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(addonIframeManager.hasRuntime(manifest.id)).toBe(true);
  expect(manifests.has(manifest.id)).toBe(true);
  expect(mocks.registerDevAddonManifest).toHaveBeenCalledTimes(1);
  expect(mocks.unregisterDevAddonManifest).not.toHaveBeenCalled();
  expect(
    addonDevManager.getStatus().servers.find((server) => server.id === manifest.id),
  ).toMatchObject({ status: "running", generation: 1 });
});

it("boots an unchanged package when a global reload joins a no-op hot reload", async () => {
  const manager = addonDevManager as unknown as {
    devServers: Map<string, unknown>;
    fetchRuntimePackage: (server: unknown) => Promise<unknown>;
    reloadAddon: (id: string) => Promise<void>;
  };
  const id = "noop-reload-review";
  manager.devServers.set(id, {
    id,
    name: id,
    url: "http://localhost:3001",
    port: 3001,
    status: "running",
    generation: 1,
  });
  // This is the state after global teardown: server still says running but no iframe remains.
  expect(addonIframeManager.hasRuntime(id)).toBe(false);
  let release!: (pkg: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const manifest = { id, name: id, version: "1.0.0", main: "addon.js", permissions: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? {}
              : {
                  generation: 1,
                  manifest,
                  assets: [],
                  files: [{ name: "addon.js", content: "export default () => {}", isMain: true }],
                },
          ),
          { status: 200 },
        ),
      ),
    ),
  );
  mocks.registerDevAddonManifest.mockResolvedValue(undefined);
  mocks.unregisterDevAddonManifest.mockResolvedValue(undefined);
  const fetchPackage = vi.spyOn(manager, "fetchRuntimePackage").mockReturnValueOnce(pending);
  const reload = manager.reloadAddon(id);
  await Promise.resolve();
  const initial = addonDevManager.loadAddonFromDevServer(id);
  release({ generation: 1 });
  await reload;
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  const frame = document.querySelector("iframe")!;
  const params = new URLSearchParams(frame.name);
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        channel: "wealthfolio:addon-sandbox:v1",
        addonId: id,
        nonce: params.get("nonce"),
        type: "loaded",
      },
    }),
  );
  expect(await initial).toBe(true);
  expect(addonIframeManager.hasRuntime(id)).toBe(true);
  fetchPackage.mockRestore();
  manager.devServers.delete(id);
});
