import { logger } from "@/adapters";
import { reloadAllAddons } from "@/addons/addons-core";
import type { AddonManifest } from "@wealthfolio/addon-sdk";
import { clearAddonContributions, ingestAddonContributions } from "./contribution-registry";
import { addonIframeManager, type AddonRuntimeHandle } from "./iframe/addon-iframe-manager";

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
  lastUpdated?: Date;
}

class AddonDevManager {
  private config: DevModeConfig;
  private devServers = new Map<string, AddonDevServer>();
  private devAddons = new Map<string, AddonRuntimeHandle>();
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

      // Load addon code from dev server
      const addonResponse = await fetch(`${devServer.url}/addon.js`);
      if (!addonResponse.ok) {
        throw new Error(`Failed to load addon code: ${addonResponse.status}`);
      }

      const addonCode = await addonResponse.text();

      // Load manifest
      const manifestResponse = await fetch(`${devServer.url}/manifest.json`);
      const manifest = manifestResponse.ok ? await manifestResponse.json() : null;

      // Execute addon code in development context
      await this.executeAddonCode(addonCode, manifest, addonId);

      // Dev addons don't flow through loadInstalledAddons, so ingest their
      // manifest contributions here — otherwise a scaffolded addon's declarative
      // sidebar link (contributes.links) never appears in dev mode, since the
      // new template registers only the route at runtime. Clear-then-ingest keeps
      // this idempotent across hot-reloads (a renamed/removed link doesn't linger).
      clearAddonContributions(addonId);
      if (manifest) {
        ingestAddonContributions(addonId, manifest as AddonManifest);
      }

      devServer.status = "running";
      devServer.lastUpdated = new Date();

      logger.info(`🚀 Loaded addon ${devServer.name} from dev server`);
      return true;
    } catch (error) {
      devServer.status = "error";
      logger.error(`❌ Failed to load addon from dev server: ${error}`);
      return false;
    }
  }

  /**
   * Execute addon code in a sandboxed environment
   */
  private async executeAddonCode(
    code: string,
    manifest: Partial<AddonManifest> | null,
    addonId: string,
  ): Promise<void> {
    try {
      const handle = await addonIframeManager.startAddon({
        addonId,
        code,
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
      logger.error(`Failed to execute addon code for ${addonId}: ${error}`);
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
      if (devServer.status !== "running") continue;

      try {
        const response = await fetch(`${devServer.url}/status`);
        if (response.ok) {
          const status = await response.json();

          if (status.lastModified && devServer.lastUpdated) {
            const lastModified = new Date(status.lastModified);
            if (lastModified > devServer.lastUpdated) {
              logger.info(`🔄 Detected changes in ${devServer.name}, auto-reloading...`);
              await this.reloadAddon(addonId);
            }
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
    try {
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

      // Small delay to ensure cleanup is complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reload from dev server
      const success = await this.loadAddonFromDevServer(addonId);

      if (success) {
        logger.info(`✅ Successfully hot-reloaded ${addonId}`);

        // Trigger navigation update to refresh the UI
        const { triggerNavigationUpdate } = await import("./addons-runtime-context");
        if (triggerNavigationUpdate) {
          triggerNavigationUpdate();
        }
      } else {
        logger.error(`❌ Failed to reload ${addonId}`);
      }
    } catch (error) {
      logger.error(`❌ Error during hot reload of ${addonId}: ${error}`);
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
          const data = JSON.parse(event.data) as { type?: string; addonId?: string };
          if (data.type === "addon-changed" && data.addonId) {
            this.reloadAddon(data.addonId);
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
