import { logger, getInstalledAddons, loadAddon as loadAddonRuntime } from "@/adapters";
import {
  getDynamicNavItems,
  getDynamicRoutes,
  setInstalledAddonIds,
} from "@/addons/addons-runtime-context";
import { clearAllContributions, ingestAddonContributions } from "@/addons/contribution-registry";
import {
  getActivationEpoch,
  invalidateActivations,
  isActivationEpochCurrent,
  isPinned,
  publishActivationEpoch,
  registerActivatable,
  resetActivations,
} from "@/addons/activation-coordinator";
import { addonIframeManager, type AddonRuntimeHandle } from "@/addons/iframe/addon-iframe-manager";
import { toast } from "sonner";
import type { AddonManifest } from "@wealthfolio/addon-sdk";
import { HOST_DEPENDENCIES, SDK_VERSION } from "@wealthfolio/addon-sdk";

interface AddonFile {
  path: string;
  manifestPath: string;
  manifest: AddonManifest;
}

// Store loaded addons for cleanup
const loadedAddons = new Map<string, AddonRuntimeHandle>();
const loadedAddonIds = new Set<string>(); // Prevent re-loading already processed addons

function formatAddonError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function notifyAddonLoadError(addonFile: AddonFile, error: unknown) {
  // Deliberate cancellations (addon stopped/reloaded mid-load) are not
  // failures the user needs to see.
  if (error instanceof Error && error.name === "AddonLoadCancelled") {
    return;
  }
  toast.error("Add-on failed to load", {
    description: `${addonFile.manifest.name || addonFile.manifest.id}: ${formatAddonError(error)}`,
    duration: 15000,
  });
}

/**
 * Discovers all available addons using Tauri commands
 */
async function discoverAddons(): Promise<AddonFile[]> {
  try {
    const installedAddons = await getInstalledAddons();
    const addonFiles: AddonFile[] = [];

    for (const addon of installedAddons) {
      // Create AddonFile structure from InstalledAddon
      // Note: filePath from Tauri represents the addon directory, not the specific file
      addonFiles.push({
        path: `${addon.filePath}/${addon.metadata.main}`, // Construct the main file path
        manifestPath: `${addon.filePath}/manifest.json`, // Construct manifest path
        manifest: addon.metadata,
      });
    }

    return addonFiles;
  } catch (error) {
    logger.error(`Failed to discover addons: ${String(error)}`);
    return [];
  }
}

/**
 * Validates if an addon is compatible with the current SDK version
 */
function validateAddonCompatibility(manifest: AddonManifest): boolean {
  // Be lenient in web mode: warn on mismatch but allow load.
  // Future: implement proper semver compatibility if needed.
  if (manifest.sdkVersion && manifest.sdkVersion !== SDK_VERSION) {
    logger.warn(
      `Addon ${manifest.id} declares SDK ${manifest.sdkVersion}; host is ${SDK_VERSION}. Proceeding with caution.`,
    );
  }
  for (const dependencyName of Object.keys(manifest.hostDependencies ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(HOST_DEPENDENCIES, dependencyName)) {
      logger.warn(
        `Addon ${manifest.id} declares unsupported host dependency '${dependencyName}'. It may need to bundle that package.`,
      );
    }
  }
  return true;
}

/**
 * Loads a single addon using Tauri commands
 */
async function loadAddon(addonFile: AddonFile, activationEpoch: number): Promise<boolean> {
  try {
    if (!isActivationEpochCurrent(activationEpoch)) {
      return false;
    }

    // Dedup guard: skip only when the addon is loaded AND its runtime actually
    // exists. Some stop paths (e.g. a late loadError after a sandbox
    // self-reload) tear the runtime down without clearing loadedAddonIds —
    // treating that as "already loaded" would make every re-activation
    // (self-heal, Retry) a silent no-op with no runtime behind it.
    if (loadedAddonIds.has(addonFile.manifest.id)) {
      if (addonIframeManager.hasRuntime(addonFile.manifest.id)) {
        logger.warn(
          `Addon "${addonFile.manifest.name}" (ID: ${addonFile.manifest.id}) already loaded in this session. Skipping duplicate load.`,
        );
        return true;
      }
      logger.warn(
        `Addon "${addonFile.manifest.id}" is marked loaded but has no runtime — rebooting.`,
      );
      loadedAddonIds.delete(addonFile.manifest.id);
    }

    // Validate compatibility
    if (!validateAddonCompatibility(addonFile.manifest)) {
      logger.error(`Addon ${addonFile.manifest.id} is not compatible`);
      return false;
    }

    // Load addon using Tauri command instead of direct file access
    // Load addon for runtime execution using Tauri command
    const extractedAddon = await loadAddonRuntime(addonFile.manifest.id);
    if (!isActivationEpochCurrent(activationEpoch)) {
      return false;
    }

    // Find the main file from the extracted addon files
    const mainFile = extractedAddon.files.find((file) => file.isMain);
    if (!mainFile) {
      logger.error(
        `Main file not found for addon ${addonFile.manifest.id}. Available files: ${extractedAddon.files.map((f) => f.name).join(", ")}`,
      );
      return false;
    }

    let addonCode = mainFile.content;

    // Strip source map references to prevent blob URL loading errors
    // Source maps can't be loaded from blob: URLs and cause console errors
    addonCode = addonCode.replace(/\/\/# sourceMappingURL=.*/g, "");

    // Extract permission data directly from manifest (already processed by Rust backend)
    const permissions = extractedAddon.metadata.permissions ?? [];
    const detectedFunctions = permissions.flatMap((p) =>
      p.functions.filter((f) => f.isDetected).map((f) => f.name),
    );
    const detectedCategories = [
      ...new Set(
        permissions
          .filter((p) => p.functions.some((f) => f.isDeclared || f.isDetected))
          .map((p) => p.category),
      ),
    ];

    logger.info(
      `Permissions for addon ${extractedAddon.metadata.id}: functions=[${detectedFunctions.join(",")}], categories=[${detectedCategories.join(",")}]`,
    );

    const handle = await addonIframeManager.startAddon({
      addonId: extractedAddon.metadata.id,
      code: addonCode,
      files: extractedAddon.files,
      manifest: extractedAddon.metadata,
      permissions,
      isCurrent: () => isActivationEpochCurrent(activationEpoch),
    });

    if (!isActivationEpochCurrent(activationEpoch)) {
      await handle.disable();
      return false;
    }

    loadedAddons.set(extractedAddon.metadata.id, handle);
    loadedAddonIds.add(extractedAddon.metadata.id); // Add to set after successful load and enablement

    return true;
  } catch (error) {
    logger.error(`Failed to load addon ${addonFile.manifest.id}: ${String(error)}`);
    notifyAddonLoadError(addonFile, error);
    return false;
  }
}

/**
 * Load installed addons (production mode)
 */
export async function loadInstalledAddons(): Promise<void> {
  const addonFiles = await discoverAddons();

  // Reserve every installed add-on's route namespace up front (before any load)
  // so load order can't let one add-on squat a peer's namespace. Note: in dev
  // mode, dev-server add-ons load before this runs (see loadAllAddons), so the
  // reservation doesn't cover them — acceptable, as dev add-ons are trusted.
  setInstalledAddonIds(addonFiles.map((addonFile) => addonFile.manifest.id));

  if (addonFiles.length === 0) {
    clearAllContributions();
    resetActivations();
    publishActivationEpoch();
    logger.info("⚠️  No addons found to load - check AppData/addons directory");
    return;
  }

  // Filter only enabled addons
  const enabledAddonFiles = addonFiles.filter((addonFile) => addonFile.manifest.enabled !== false);

  // Rebuild the durable contribution layer from scratch on every (re)load so a
  // disabled/uninstalled addon (no longer in enabledAddonFiles) leaves no stale
  // nav. Ingest reads `contributes` (routes + links) from the manifest WITHOUT
  // executing addon code or booting an iframe — it only populates the durable
  // nav/route layer. A disabled addon shows no nav, so ingest only the enabled
  // ones.
  clearAllContributions();
  // Reset lazy-activation state so a (re)load re-registers every addon cleanly.
  resetActivations();

  // Register every enabled addon with the activation coordinator BEFORE
  // ingesting contributions: ingest fires navigation updates that re-render
  // mounted addon routes, and a route self-healing from a reload (its runtime
  // was stopped) immediately calls activateView — its bootFn must already be
  // registered or that activation would fail spuriously. Addons that contribute
  // routes boot lazily on first visit to a contributed route; addons WITHOUT
  // contributed routes must eager-boot ("pinned") so their runtime's
  // sidebar.addItem/router.add still registers navigation at startup. (Dev-mode
  // addons take the separate dev path and are always pinned there; this function
  // only sees installed addons.)
  for (const addonFile of enabledAddonFiles) {
    const pinned = !addonFile.manifest.contributes?.routes?.length;
    registerActivatable(addonFile.manifest.id, (epoch) => loadAddon(addonFile, epoch), { pinned });
  }
  for (const addonFile of enabledAddonFiles) {
    ingestAddonContributions(addonFile.manifest.id, addonFile.manifest);
  }
  // Wake mounted addon routes only after their new-generation boot functions
  // are registered; publishing earlier can make a route observe an empty gap.
  publishActivationEpoch();

  if (enabledAddonFiles.length === 0) {
    logger.info("📦 No enabled addons found to load");
    return;
  }

  // Eager-boot ONLY pinned addons at startup. Lazy addons boot later, on first
  // visit to a contributed route (see AddonIframeRoute).
  const pinnedAddonFiles = enabledAddonFiles.filter((addonFile) => isPinned(addonFile.manifest.id));
  const lazyCount = enabledAddonFiles.length - pinnedAddonFiles.length;

  let loadedCount = 0;
  const activationEpoch = getActivationEpoch();
  const loadPromises = pinnedAddonFiles.map(async (addonFile) => {
    // Each addon gets its own context, but loadAddon creates its own internally
    const success = await loadAddon(addonFile, activationEpoch);
    if (success) {
      loadedCount++;
    } else {
      void 0;
    }
  });

  // Boot all pinned addons concurrently
  await Promise.all(loadPromises);

  logger.info(
    `🎉 Eager-loaded ${loadedCount} out of ${pinnedAddonFiles.length} pinned addons ` +
      `(${lazyCount} lazy addon(s) will boot on first visit)`,
  );

  // Debug: Show current navigation state
}

/**
 * Unloads a specific addon by ID
 */
export function unloadAddon(addonId: string): void {
  const addon = loadedAddons.get(addonId);
  if (addon) {
    try {
      void addon.disable();
      loadedAddons.delete(addonId);
      loadedAddonIds.delete(addonId);
      logger.info(`🗑️ Unloaded addon: ${addonId}`);
    } catch (error) {
      logger.error(`Error unloading addon ${addonId}: ${String(error)}`);
    }
  }
}

/**
 * Unloads all addons and cleans up resources
 */
export function unloadAllAddons(): void {
  // Invalidate async loads before teardown. A load still awaiting backend I/O
  // cannot publish a runtime after this reload generation has ended.
  invalidateActivations();

  loadedAddons.forEach((addon, id) => {
    try {
      void addon.disable();
    } catch (error) {
      logger.error(`Error unloading addon ${id}: ${String(error)}`);
    }
  });

  loadedAddons.clear();
  loadedAddonIds.clear(); // Clear the set when unloading all
  // `loadedAddons` contains only fully booted handles. Also stop manager-owned
  // runtimes that are still in their loading phase and therefore have no handle.
  void addonIframeManager.stopAllAddons();
}

/**
 * Gets information about currently loaded addons
 */
export function getLoadedAddons(): string[] {
  return Array.from(loadedAddons.keys());
}

/**
 * Debug function to check current addon state
 */
export function debugAddonState(): void {
  logger.info("🐛 Addon Debug Info:");
  logger.info(`- Dynamic nav items: ${JSON.stringify(getDynamicNavItems())}`);
  logger.info(`- Dynamic routes: ${JSON.stringify(getDynamicRoutes())}`);
  logger.info(`- Loaded addons: ${JSON.stringify(getLoadedAddons())}`);
}

/**
 * Reloads all addons (useful for development and settings)
 * This function dynamically imports the full plugin loader to avoid circular dependencies
 */
export async function reloadAllAddons(): Promise<void> {
  unloadAllAddons();

  // Dynamically import the full plugin loader to avoid importing dev mode
  const { loadAllAddons } = await import("./addons-loader");
  await loadAllAddons();
}
