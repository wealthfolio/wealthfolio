import {
  isDesktop,
  logger,
  registerDevAddonManifest,
  unregisterDevAddonManifest,
} from "@/adapters";
import { reloadAllAddons } from "@/addons/addons-core";
import type { AddonManifest } from "@wealthfolio/addon-sdk";
import type { AddonAsset, AddonFile } from "@/adapters/types";
import { clearAddonContributions, ingestAddonContributions } from "./contribution-registry";
import { addonIframeManager, type AddonRuntimeHandle } from "./iframe/addon-iframe-manager";

/**
 * Registers (or clears) the dev-server addon's manifest with the Tauri backend so the
 * brokered network API (`ctx.api.network.request`) can resolve permissions and approved
 * hosts for it. Dev-server addons are never written to the installed addons directory,
 * so without this the backend has no record of them at all — desktop-only since it's a
 * Tauri command, and failures are logged, not thrown, so a missing/older host build
 * degrades to "networking doesn't work in dev mode" rather than breaking addon loading.
 */
async function syncDevAddonManifest(
  addonId: string,
  manifest: Partial<AddonManifest> | null,
): Promise<void> {
  if (!isDesktop) return;
  try {
    if (manifest) {
      await registerDevAddonManifest(addonId, JSON.stringify(manifest));
    } else {
      await unregisterDevAddonManifest(addonId);
    }
  } catch (error) {
    logger.warn(`Failed to sync dev addon manifest for ${addonId}: ${String(error)}`);
  }
}

interface DevModeConfig {
  enabled: boolean;
  watchPaths: string[];
  pollInterval: number;
  autoReload: boolean;
}

interface AddonDevServer {
  id: string;
  name: string;
  url: string;
  port: number;
  status: "running" | "stopped" | "error";
  generation?: number;
}

interface DevRuntimePackage {
  assets: AddonAsset[];
  files: AddonFile[];
  generation: number;
  manifest: Partial<AddonManifest> | null;
}

interface DevRuntimeStatus {
  buildInProgress?: boolean;
  generation?: number;
}

export function shouldReloadDevelopmentAddon(
  status: DevRuntimeStatus,
  currentGeneration: number | undefined,
): boolean {
  return (
    status.buildInProgress !== true &&
    typeof status.generation === "number" &&
    Number.isSafeInteger(status.generation) &&
    status.generation > (currentGeneration ?? 0)
  );
}

export function getDevelopmentRuntimePackageError(status: number, detail: string): string {
  if (status === 404 || status === 405) {
    return (
      "Development server does not support Wealthfolio 3.7 runtime packages. " +
      "Upgrade @wealthfolio/addon-dev-tools to version 3.7.0 or newer."
    );
  }

  return `Failed to load development addon package: ${detail}`;
}

class AddonDevManager {
  private config: DevModeConfig;
  private devServers = new Map<string, AddonDevServer>();
  private devAddons = new Map<string, AddonRuntimeHandle>();
  private reloadsInProgress = new Set<string>();
  private watchInterval: number | null = null;
  private eventSource: EventSource | null = null;

  constructor() {
    this.config = {
      enabled: import.meta.env.DEV || false,
      watchPaths: [],
      pollInterval: 1000,
      autoReload: true,
    };

    // Note: Auto-discovery is now done lazily when enableDevMode() is called
    // This prevents side effects during module import
  }

  /**
   * Auto-discover running development servers
   */
  private async discoverDevServers(): Promise<void> {
    const commonPorts = [3001];

    logger.info("🔍 Auto-discovering addon development servers...");

    for (const port of commonPorts) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`http://localhost:${port}/health`, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          // Try to get manifest to identify the addon
          try {
            const manifestResponse = await fetch(`http://localhost:${port}/manifest.json`);
            if (manifestResponse.ok) {
              const manifest = (await manifestResponse.json()) as {
                id: string;
                name: string;
              };

              this.registerDevServer({
                id: manifest.id,
                name: manifest.name,
                port: port,
              });

              logger.info(`✅ Discovered dev server: ${manifest.name} on port ${port}`);
            }
          } catch (_manifestError) {
            // No manifest, might not be an addon server
          }
        }
      } catch (_error) {
        // Server not running on this port, continue
      }
    }
  }

  /**
   * Enable development mode with hot reloading
   */
  async enableDevMode(): Promise<void> {
    if (!this.config.enabled) {
      logger.info("🔧 Enabling addon development mode...");
      this.config.enabled = true;
    }

    // Always re-discover servers when explicitly enabling
    await this.discoverDevServers();

    // Start file watching
    this.startWatching();

    // Setup hot reload endpoint
    this.setupHotReloadServer();

    // Add dev tools to context
    this.injectDevTools();

    logger.info("✅ Addon development mode enabled");
  }

  /**
   * Disable development mode
   */
  disableDevMode(): void {
    if (this.config.enabled) {
      logger.info("🔧 Disabling addon development mode...");
      this.config.enabled = false;

      this.stopWatching();
      this.cleanup();

      logger.info("✅ Addon development mode disabled");
    }
  }

  /**
   * Register a development server for an addon
   */
  registerDevServer(addon: { id: string; name: string; port: number }): void {
    const devServer: AddonDevServer = {
      id: addon.id,
      name: addon.name,
      url: `http://localhost:${addon.port}`,
      port: addon.port,
      status: "stopped",
    };

    this.devServers.set(addon.id, devServer);
    logger.info(`📝 Registered dev server for ${addon.name} at port ${addon.port}`);
  }

  /**
   * Load addon from development server
   */
  async loadAddonFromDevServer(addonId: string): Promise<boolean> {
    const devServer = this.devServers.get(addonId);
    if (!devServer) {
      logger.error(`No dev server registered for addon: ${addonId}`);
      return false;
    }

    try {
      // Check if dev server is running
      const response = await fetch(`${devServer.url}/health`);
      if (!response.ok) {
        throw new Error(`Dev server not responding: ${response.status}`);
      }

      const runtimePackage = await this.fetchRuntimePackage(devServer);
      await this.activateRuntimePackage(devServer, runtimePackage);

      logger.info(`🚀 Loaded addon ${devServer.name} from dev server`);
      return true;
    } catch (error) {
      devServer.status = "error";
      logger.error(`❌ Failed to load addon from dev server: ${String(error)}`);
      return false;
    }
  }

  private async fetchRuntimePackage(devServer: AddonDevServer): Promise<DevRuntimePackage> {
    const response = await fetch(`${devServer.url}/runtime-package`, { cache: "no-store" });
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") detail = body.error;
      } catch {
        // Keep the HTTP status text for non-JSON development server errors.
      }
      throw new Error(getDevelopmentRuntimePackageError(response.status, detail));
    }

    const runtimePackage = (await response.json()) as DevRuntimePackage;
    if (
      !Number.isSafeInteger(runtimePackage.generation) ||
      runtimePackage.generation < 1 ||
      !Array.isArray(runtimePackage.assets) ||
      !Array.isArray(runtimePackage.files) ||
      !runtimePackage.files.some((file) => file.isMain)
    ) {
      throw new Error("Development server returned an invalid runtime package");
    }
    return runtimePackage;
  }

  private async activateRuntimePackage(
    devServer: AddonDevServer,
    runtimePackage: DevRuntimePackage,
  ): Promise<void> {
    const mainFile = runtimePackage.files.find((file) => file.isMain);
    if (!mainFile) {
      throw new Error("Development runtime package has no addon entry point");
    }

    // Record the attempted generation before execution so a broken build is
    // retried only after the dev server publishes another generation.
    devServer.generation = runtimePackage.generation;
    await this.executeAddonCode(
      mainFile.content,
      runtimePackage.manifest,
      devServer.id,
      runtimePackage.files,
      runtimePackage.assets,
      devServer.url,
      runtimePackage.generation,
    );

    // Let the backend know about this addon's manifest so brokered network requests
    // can be resolved for it (see syncDevAddonManifest for why this is needed).
    await syncDevAddonManifest(devServer.id, runtimePackage.manifest);

    // Dev addons don't flow through loadInstalledAddons, so ingest their
    // manifest contributions here. Clear-then-ingest keeps this idempotent.
    clearAddonContributions(devServer.id);
    if (runtimePackage.manifest) {
      ingestAddonContributions(devServer.id, runtimePackage.manifest as AddonManifest);
    }

    devServer.status = "running";
  }

  /**
   * Execute addon code in a sandboxed environment
   */
  private async executeAddonCode(
    code: string,
    manifest: Partial<AddonManifest> | null,
    addonId: string,
    files: AddonFile[],
    assets: AddonAsset[],
    devServerUrl: string,
    generation: number,
  ): Promise<void> {
    try {
      const handle = await addonIframeManager.startAddon({
        addonId,
        assets,
        code,
        files,
        loadAsset: async (assetId) => {
          const assetUrl = new URL(`/runtime-assets/${encodeURIComponent(assetId)}`, devServerUrl);
          assetUrl.searchParams.set("generation", String(generation));
          const response = await fetch(assetUrl, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(`Failed to load development addon asset: ${response.status}`);
          }
          return response.blob();
        },
        manifest: {
          id: addonId,
          name: manifest?.name ?? addonId,
          version: manifest?.version ?? "0.0.0-dev",
          ...manifest,
        },
        permissions: manifest?.permissions,
      });
      this.devAddons.set(addonId, handle);
    } catch (error) {
      logger.error(`Failed to execute addon code for ${addonId}: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Start file watching for hot reload
   */
  private startWatching(): void {
    if (this.watchInterval) return;

    // Use polling for simplicity - could be enhanced with native file watchers
    this.watchInterval = window.setInterval(() => {
      this.checkForUpdates();
    }, this.config.pollInterval);
  }

  /**
   * Stop file watching
   */
  private stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  /**
   * Check for updates from dev servers
   */
  private async checkForUpdates(): Promise<void> {
    for (const [addonId, devServer] of this.devServers) {
      if (devServer.status === "stopped") continue;

      try {
        const response = await fetch(`${devServer.url}/status`);
        if (response.ok) {
          const status = (await response.json()) as DevRuntimeStatus;
          if (shouldReloadDevelopmentAddon(status, devServer.generation)) {
            logger.info(`🔄 Detected changes in ${devServer.name}, auto-reloading...`);
            await this.reloadAddon(addonId);
          }
        }
      } catch (_error) {
        // Silent fail for polling - dev server might be down
      }
    }
  }

  /**
   * Reload a specific addon
   */
  private async reloadAddon(addonId: string): Promise<void> {
    if (this.reloadsInProgress.has(addonId)) return;
    this.reloadsInProgress.add(addonId);

    let unloaded = false;
    try {
      const devServer = this.devServers.get(addonId);
      if (!devServer) {
        throw new Error(`No dev server registered for addon: ${addonId}`);
      }
      const runtimePackage = await this.fetchRuntimePackage(devServer);
      if (runtimePackage.generation <= (devServer.generation ?? 0)) {
        return;
      }

      // Clean up existing instance
      if (this.devAddons.has(addonId)) {
        const instance = this.devAddons.get(addonId);
        if (instance) {
          logger.info(`🧹 Cleaning up old instance of ${addonId}`);
          await instance.disable();
        }
        this.devAddons.delete(addonId);
      }

      // Also clean up from the main addon loader
      const { unloadAddon } = await import("./addons-core");
      if (unloadAddon) {
        unloadAddon(addonId);
      }
      unloaded = true;

      // Small delay to ensure cleanup is complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      await this.activateRuntimePackage(devServer, runtimePackage);
      logger.info(`✅ Successfully hot-reloaded ${addonId}`);

      // Trigger navigation update to refresh the UI
      const { triggerNavigationUpdate } = await import("./addons-runtime-context");
      if (triggerNavigationUpdate) {
        triggerNavigationUpdate();
      }
    } catch (error) {
      const devServer = this.devServers.get(addonId);
      if (devServer && unloaded) devServer.status = "error";
      logger.error(`❌ Error during hot reload of ${addonId}: ${String(error)}`);
    } finally {
      this.reloadsInProgress.delete(addonId);
    }
  }

  /**
   * Setup hot reload server connection
   */
  private setupHotReloadServer(): void {
    // Connect to hot reload server if available
    if (typeof EventSource !== "undefined") {
      try {
        this.eventSource = new EventSource("http://localhost:3001/addon-updates");

        this.eventSource.onmessage = (event) => {
          const rawData = typeof event.data === "string" ? event.data : "";
          const data: unknown = JSON.parse(rawData);
          if (data && typeof data === "object") {
            const update = data as Record<string, unknown>;
            if (update.type === "addon-changed" && typeof update.addonId === "string") {
              void this.reloadAddon(update.addonId);
            }
          }
        };

        this.eventSource.onerror = () => {
          // Hot reload server not available - that's fine
        };
      } catch (_error) {
        // EventSource not available or failed
      }
    }
  }

  /**
   * Inject development tools into addon context
   */
  private injectDevTools(): void {
    // Add development-specific APIs to a generic context
    const devCtx = {};
    (
      devCtx as unknown as {
        dev?: {
          reload: () => Promise<void> | void;
          listServers: () => unknown[];
          enableAutoReload: () => void;
          disableAutoReload: () => void;
        };
      }
    ).dev = {
      reload: () => reloadAllAddons(),
      listServers: () => Array.from(this.devServers.values()),
      enableAutoReload: () => {
        this.config.autoReload = true;
      },
      disableAutoReload: () => {
        this.config.autoReload = false;
      },
    };
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    for (const [addonId, instance] of this.devAddons) {
      void instance.disable();
      // Drop the durable nav/routes ingested on load so disabling dev mode
      // doesn't leave a stale sidebar entry behind.
      clearAddonContributions(addonId);
      void syncDevAddonManifest(addonId, null);
    }
    this.devAddons.clear();
  }

  /**
   * Manually discover and register development servers
   */
  async discoverAndRegister(): Promise<void> {
    await this.discoverDevServers();
  }

  /**
   * Get development status
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      servers: Array.from(this.devServers.values()),
      autoReload: this.config.autoReload,
    };
  }

  /**
   * Toggle development mode on/off
   */
  toggleDevMode(): boolean {
    if (this.config.enabled) {
      this.disableDevMode();
    } else {
      this.enableDevMode();
    }
    return this.config.enabled;
  }

  /**
   * Check if development mode is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Force disable development mode (for manual control)
   */
  forceDisable(): void {
    if (this.config.enabled) {
      logger.info("🔧 Force disabling addon development mode...");
      this.disableDevMode();
    }
  }

  /**
   * Force enable development mode (for manual control)
   */
  forceEnable(): void {
    if (!this.config.enabled && import.meta.env.DEV) {
      logger.info("🔧 Force enabling addon development mode...");
      this.enableDevMode();
    }
  }
}

// Global instance
export const addonDevManager = new AddonDevManager();

// Note: Development mode initialization is now done explicitly in main.tsx
// to avoid side effects during module imports

// Make debugging tools available globally in development mode
if (import.meta.env.DEV) {
  Object.defineProperties(globalThis, {
    __ADDON_DEV__: {
      configurable: true,
      enumerable: false,
      value: addonDevManager,
      writable: false,
    },
    discoverAddons: {
      configurable: true,
      enumerable: false,
      value: () => addonDevManager.discoverAndRegister(),
      writable: false,
    },
    reloadAddons: {
      configurable: true,
      enumerable: false,
      value: () => reloadAllAddons(),
      writable: false,
    },
  });
}
