import { logger } from "@/adapters";
import { loadInstalledAddons, unloadAllAddons } from "@/addons/addons-core";

export const isAddonDevModeEnabled =
  import.meta.env.DEV &&
  (import.meta.env.MODE === "addon-dev" || import.meta.env.VITE_ENABLE_ADDON_DEV_MODE === "true");

/**
 * Loads all discovered addons with development mode support
 */
export async function loadAllAddons(): Promise<void> {
  try {
    // Check if we're in the dedicated addon development mode
    if (isAddonDevModeEnabled) {
      logger.info("🔧 Development mode detected, checking for dev servers...");

      // Dynamic import for development mode
      const { addonDevManager } = await import("./addons-dev-mode");

      // Force discovery of dev servers
      await addonDevManager.enableDevMode();

      const devStatus = addonDevManager.getStatus();
      if (devStatus.enabled && devStatus.servers.length > 0) {
        logger.info(`� Found ${devStatus.servers.length} development server(s), loading addons...`);

        const devLoadedIds = new Set<string>();
        for (const server of devStatus.servers) {
          const success = await addonDevManager.loadAddonFromDevServer(server.id);
          if (success) {
            devLoadedIds.add(server.id);
          }
        }

        logger.info(`✅ Loaded ${devLoadedIds.size} addon(s) from development servers`);

        // Also load installed addons that aren't in dev mode
        await loadInstalledAddons(devLoadedIds);
        return;
      } else {
        logger.info("🔍 No development servers found, falling back to installed addons");
      }
    } else if (import.meta.env.DEV) {
      logger.info(
        "ℹ️ Addon development mode skipped. Run `pnpm dev:addons` or set VITE_ENABLE_ADDON_DEV_MODE=true to enable it.",
      );
    }

    // Standard production loading
    await loadInstalledAddons();
  } catch (error) {
    logger.error(`❌ Failed to load addons: ${String(error)}`);
  }
}

/**
 * Reloads all addons (useful for development)
 */
export async function reloadAllAddons(): Promise<void> {
  unloadAllAddons();
  await loadAllAddons();
}

// Re-export functions from core for backward compatibility
export { debugAddonState, getLoadedAddons, unloadAllAddons } from "@/addons/addons-core";
