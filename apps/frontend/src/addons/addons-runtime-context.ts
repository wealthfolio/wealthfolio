import type { AddonContext, Permission, SidebarItemConfig } from "@wealthfolio/addon-sdk";
import { toast } from "sonner";
import { createPermissionGuard, createSDKHostAPIBridge, type PermissionGuard } from "./type-bridge";
import { getDurableNavItems, getDurableRoutes } from "./contribution-registry";

import {
  logger,
  checkActivitiesImport,
  getAccountImportMapping,
  importActivities,
  saveAccountImportMapping,
  createActivity,
  getActivities,
  saveActivities,
  searchActivities,
  updateActivity,
  createAccount,
  getAccounts,
  updateAccount,
  addonNetworkRequest,
} from "@/adapters";
import {
  addExchangeRate,
  getExchangeRates,
  updateExchangeRate,
  calculateDepositsForLimit,
  createContributionLimit,
  getContributionLimit,
  updateContributionLimit,
} from "@/adapters";
import { openCsvFileDialog, openFileSaveDialog } from "@/adapters";
import { createGoal, getGoals, getGoalFunding, saveGoalFunding, updateGoal } from "@/adapters";
import {
  listenFileDrop as listenImportFileDrop,
  listenFileDropCancelled as listenImportFileDropCancelled,
  listenFileDropHover as listenImportFileDropHover,
} from "@/adapters";
import {
  fetchDividends,
  getAssetProfile,
  getMarketDataProviders,
  getQuoteHistory,
  searchTicker,
  syncHistoryQuotes,
  syncMarketData,
  updateQuoteMode,
  updateAssetProfile,
  updateQuote,
} from "@/adapters";
import {
  calculateAccountsSimplePerformance,
  calculatePerformanceHistory,
  calculatePerformanceSummary,
  getHistoricalValuations,
  getHolding,
  getHoldings,
  getIncomeSummary,
  getLatestValuations,
  recalculatePortfolio,
  updatePortfolio,
  getSnapshots,
  getSnapshotByDate,
  saveManualHoldings,
  checkHoldingsImport,
  importHoldingsCsv,
  deleteSnapshot,
} from "@/adapters";
import {
  listenMarketSyncComplete,
  listenMarketSyncStart,
  listenPortfolioUpdateComplete,
  listenPortfolioUpdateError,
  listenPortfolioUpdateStart,
} from "@/adapters";
import {
  deleteAddonSecret,
  getAddonSecret,
  setAddonSecret,
  deleteAddonStorageItem,
  getAddonStorageItem,
  setAddonStorageItem,
  backupDatabase,
  getSettings,
  updateSettings,
} from "@/adapters";

export interface DynamicNavItem {
  icon?: string;
  title: string;
  href: string;
  order: number;
  id: string;
  addonId: string;
}

export interface DynamicRouteEntry {
  path: string;
  href: string;
  addonId: string;
  routeId: string;
  title?: string;
}

interface QueryClientLike {
  invalidateQueries: (opts: { queryKey: string[]; exact?: boolean }) => unknown;
  refetchQueries: (opts: { queryKey: string[]; exact?: boolean }) => unknown;
}

const dynamicNavItems = new Map<string, DynamicNavItem>();
const dynamicRoutes = new Map<string, DynamicRouteEntry>();
const claimedRouteNamespaces = new Map<string, string>();
// Maps each installed add-on's owned namespaces (id + slug) to the single
// add-on id that owns it. Populated from the installed-addon registry before
// any add-on loads, so a namespace that is a peer's identity stays reserved for
// that peer even if it hasn't loaded yet — a malicious add-on that loads first
// cannot squat it. Exact-id ownership wins over slug ownership, so a bare-id
// add-on ("foo") and a suffixed peer ("foo-addon") can't co-own the "foo" slug.
const installedNamespaceOwners = new Map<string, string>();
const disableCallbacks = new Map<string, Set<() => void>>();
const navigationUpdateListeners = new Set<() => void>();
const ADDON_ID_SUFFIX = "-addon";

let hostNavigate: ((route: string) => void) | undefined;
let hostQueryClient: QueryClientLike | undefined;

function navigateWithoutReload(route: string) {
  const targetUrl = new URL(route, window.location.href);
  if (targetUrl.origin !== window.location.origin) {
    console.warn(`Blocked addon navigation to external URL: ${route}`);
    return;
  }

  const normalizedRoute = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  window.history.pushState(null, "", normalizedRoute);
  const popStateEvent =
    typeof PopStateEvent === "function" ? new PopStateEvent("popstate") : new Event("popstate");
  window.dispatchEvent(popStateEvent);
}

export function setAddonNavigationHandler(navigate: (route: string) => void) {
  hostNavigate = navigate;
}

export function clearAddonNavigationHandler(navigate: (route: string) => void) {
  if (hostNavigate === navigate) {
    hostNavigate = undefined;
  }
}

export function setAddonQueryClient(queryClient: QueryClientLike) {
  hostQueryClient = queryClient;
}

/**
 * Registers the identities of all installed add-ons so their route namespaces
 * are reserved regardless of load order. Call before loading add-ons (and on
 * reload) with every installed add-on id.
 */
export function setInstalledAddonIds(addonIds: string[]) {
  installedNamespaceOwners.clear();
  // Pass 1: exact-id namespaces take precedence.
  for (const addonId of addonIds) {
    const idNamespace = cleanRouteNamespace(addonId);
    if (idNamespace && !installedNamespaceOwners.has(idNamespace)) {
      installedNamespaceOwners.set(idNamespace, addonId);
    }
  }
  // Pass 2: slug namespaces, only where no exact id already claimed them.
  for (const addonId of addonIds) {
    for (const namespace of getOwnedAddonRouteNamespaces(addonId)) {
      if (!installedNamespaceOwners.has(namespace)) {
        installedNamespaceOwners.set(namespace, addonId);
      }
    }
  }
}

function notifyNavigationUpdate() {
  navigationUpdateListeners.forEach((listener) => listener());
}

export function scopedKey(addonId: string, id: string) {
  return `${addonId}:${id}`;
}

export function cleanRoutePath(path: string) {
  const routeOnly = path.trim().split(/[?#]/, 1)[0] ?? "";
  const withSlash = routeOnly.startsWith("/") ? routeOnly : `/${routeOnly}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

export function toRouterPath(href: string) {
  return href.replace(/^\/+/, "");
}

function cleanRouteNamespace(namespace: string) {
  // Lowercased so ownership/reservation checks match the router's
  // case-insensitive path matching (blocks "/addon/MyAddon" vs "/addon/myaddon"
  // squatting). Only used for namespace identity, never for the stored href.
  return namespace
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function getOwnedAddonRouteNamespaces(addonId: string) {
  const cleanAddonId = cleanRouteNamespace(addonId);
  const addonSlug = cleanAddonId.endsWith(ADDON_ID_SUFFIX)
    ? cleanAddonId.slice(0, -ADDON_ID_SUFFIX.length)
    : cleanAddonId;
  return Array.from(new Set([cleanAddonId, addonSlug].filter(Boolean)));
}

function isPathWithinRoutePrefix(path: string, prefix: string) {
  const href = cleanRoutePath(path);
  const cleanPrefix = cleanRoutePath(prefix);
  return href === cleanPrefix || href.startsWith(`${cleanPrefix}/`);
}

function getRequestedRouteNamespace(path: string) {
  const match = /^\/addons?\/([^/]+)(?:\/|$)/.exec(cleanRoutePath(path));
  return match ? cleanRouteNamespace(match[1]) : undefined;
}

function isAddonRouteNamespaceAllowed(addonId: string, path: string) {
  const namespace = getRequestedRouteNamespace(path);
  if (!namespace) {
    return false;
  }
  // A namespace that is a known installed add-on's identity (id or slug) is
  // reserved for its single owner, resolved regardless of load order — this is
  // what blocks route squatting between installed peers.
  const reservedOwner = installedNamespaceOwners.get(namespace);
  if (reservedOwner !== undefined) {
    return reservedOwner === addonId;
  }
  // Fallback when the installed registry hasn't been populated (dev servers,
  // tests): an add-on may always register under its own id/slug.
  if (getOwnedAddonRouteNamespaces(addonId).includes(namespace)) {
    return true;
  }
  // Id-shaped namespaces stay reserved for the add-on with that id. Anything
  // else is first-come-first-served: published add-ons register custom route
  // namespaces (e.g. goal-progress-tracker-addon uses
  // /addon/investment-target-tracker), so requiring an id match breaks them.
  if (namespace.endsWith(ADDON_ID_SUFFIX)) {
    return false;
  }
  const claimedBy = claimedRouteNamespaces.get(namespace);
  return claimedBy === undefined || claimedBy === addonId;
}

function claimRouteNamespace(addonId: string, path: string) {
  const namespace = getRequestedRouteNamespace(path);
  if (namespace && !claimedRouteNamespaces.has(namespace)) {
    claimedRouteNamespaces.set(namespace, addonId);
  }
}

function hasRegisteredAddonNavPrefix(addonId: string, path: string) {
  return Array.from(dynamicNavItems.values()).some(
    (item) => item.addonId === addonId && isPathWithinRoutePrefix(path, item.href),
  );
}

export function isAddonRoutePathAllowed(addonId: string, path: string) {
  return isAddonRouteNamespaceAllowed(addonId, path);
}

export function registerAddonNavItem(addonId: string, cfg: SidebarItemConfig) {
  const itemId = String(cfg.id || "").trim();
  const label = String(cfg.label || "").trim();
  if (!itemId || !label) {
    throw new Error("Addon sidebar items require a non-empty id and label");
  }

  const href = cleanRoutePath(cfg.route || `/addon/${addonId}`);
  if (!isAddonRoutePathAllowed(addonId, href)) {
    throw new Error(`Addon '${addonId}' cannot register sidebar route '${href}'`);
  }

  claimRouteNamespace(addonId, href);
  dynamicNavItems.set(scopedKey(addonId, itemId), {
    addonId,
    href,
    icon: typeof cfg.icon === "string" ? cfg.icon : undefined,
    id: scopedKey(addonId, itemId),
    order: typeof cfg.order === "number" ? cfg.order : 999,
    title: label,
  });
  notifyNavigationUpdate();
}

export function removeAddonNavItem(addonId: string, itemId: string) {
  dynamicNavItems.delete(scopedKey(addonId, itemId));
  notifyNavigationUpdate();
}

export function registerAddonRoute(
  addonId: string,
  route: { path: string; routeId: string; title?: string },
) {
  const routeId = String(route.routeId || "").trim();
  if (!routeId) {
    throw new Error("Addon routes require a non-empty routeId");
  }

  const href = cleanRoutePath(route.path);
  if (!isAddonRoutePathAllowed(addonId, href) && !hasRegisteredAddonNavPrefix(addonId, href)) {
    throw new Error(`Addon '${addonId}' cannot register route '${href}'`);
  }

  claimRouteNamespace(addonId, href);
  dynamicRoutes.set(scopedKey(addonId, routeId), {
    addonId,
    href,
    path: toRouterPath(href),
    routeId,
    title: route.title,
  });
  notifyNavigationUpdate();
}

export function removeAddonRoute(addonId: string, routeId: string) {
  dynamicRoutes.delete(scopedKey(addonId, routeId));
  notifyNavigationUpdate();
}

export function clearAddonRegistrations(addonId: string) {
  let changed = false;

  for (const [namespace, owner] of claimedRouteNamespaces) {
    if (owner === addonId) {
      claimedRouteNamespaces.delete(namespace);
    }
  }

  for (const [key, item] of dynamicNavItems) {
    if (item.addonId === addonId) {
      dynamicNavItems.delete(key);
      changed = true;
    }
  }

  for (const [key, route] of dynamicRoutes) {
    if (route.addonId === addonId) {
      dynamicRoutes.delete(key);
      changed = true;
    }
  }

  const callbacks = disableCallbacks.get(addonId);
  if (callbacks) {
    callbacks.forEach((cb) => {
      try {
        cb();
      } catch (error) {
        console.error("Error in addon disable callback:", error);
      }
    });
    disableCallbacks.delete(addonId);
  }

  if (changed) {
    notifyNavigationUpdate();
  }
}

export function getDynamicNavItems() {
  // Merge durable (manifest-contributed) items with transient runtime
  // registrations. Both are keyed by the scoped id (`addonId:linkId`, where a
  // link id defaults to its route id); per RFC A2 a runtime registration whose
  // id duplicates a durable contribution is ignored (durable wins), so we seed
  // transient first and let durable override.
  const merged = new Map<string, DynamicNavItem>();
  for (const item of dynamicNavItems.values()) {
    merged.set(item.id, item);
  }
  for (const item of getDurableNavItems()) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values()).sort((a, b) => a.order - b.order);
}

export function getDynamicRoutes() {
  // Same durable-wins merge as nav items, keyed by `addonId:routeId` (== the
  // contributed route id per RFC A2).
  const merged = new Map<string, DynamicRouteEntry>();
  for (const route of dynamicRoutes.values()) {
    merged.set(scopedKey(route.addonId, route.routeId), route);
  }
  for (const route of getDurableRoutes()) {
    merged.set(scopedKey(route.addonId, route.routeId), route);
  }
  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function subscribeToNavigationUpdates(callback: () => void) {
  navigationUpdateListeners.add(callback);
  return () => navigationUpdateListeners.delete(callback);
}

export function triggerNavigationUpdate() {
  notifyNavigationUpdate();
}

export function triggerAllDisableCallbacks() {
  Array.from(disableCallbacks.keys()).forEach(clearAddonRegistrations);
  dynamicNavItems.clear();
  dynamicRoutes.clear();
  notifyNavigationUpdate();
}

function createAddonScopedSecrets(addonId: string, guard: PermissionGuard) {
  return {
    set: async (key: string, value: string): Promise<void> => {
      guard.assertCanUse("secrets", "set");
      return setAddonSecret(addonId, key, value);
    },
    get: async (key: string): Promise<string | null> => {
      guard.assertCanUse("secrets", "get");
      return getAddonSecret(addonId, key);
    },
    delete: async (key: string): Promise<void> => {
      guard.assertCanUse("secrets", "delete");
      return deleteAddonSecret(addonId, key);
    },
  };
}

// Storage is a baseline (implicit) capability — no permission guard, mirroring
// the way secrets is scoped per addon but without a consent category.
function createAddonScopedStorage(addonId: string) {
  return {
    get: async (key: string): Promise<string | null> => getAddonStorageItem(addonId, key),
    set: async (key: string, value: string): Promise<void> =>
      setAddonStorageItem(addonId, key, value),
    delete: async (key: string): Promise<void> => deleteAddonStorageItem(addonId, key),
  };
}

export function createAddonHostAPI(
  addonId: string,
  permissions?: Permission[],
): AddonContext["api"] {
  const permissionGuard = createPermissionGuard(addonId, permissions);
  const baseAPI = createSDKHostAPIBridge(
    {
      getHoldings: (accountId: string) => getHoldings({ type: "account", accountId }),
      getActivities,
      getAccounts,

      getExchangeRates,
      updateExchangeRate,
      addExchangeRate,

      getContributionLimit,
      createContributionLimit,
      updateContributionLimit,
      calculateDepositsForLimit,

      getGoals,
      createGoal,
      updateGoal,
      getGoalFunding,
      saveGoalFunding,

      searchTicker,
      fetchDividends,
      syncHistoryQuotes,
      getAssetProfile,
      updateAssetProfile,
      updateQuoteMode,
      updateQuote,
      syncMarketData,
      getQuoteHistory,
      getMarketDataProviders,

      updatePortfolio,
      recalculatePortfolio,
      getIncomeSummary: () => getIncomeSummary(undefined),
      getHistoricalValuations: (accountId?: string, startDate?: string, endDate?: string) =>
        getHistoricalValuations(
          accountId ? { type: "account", accountId } : { type: "all" },
          startDate,
          endDate,
        ),
      getLatestValuations,
      calculatePerformanceHistory,
      calculatePerformanceSummary,
      calculateAccountsSimplePerformance,
      getHolding,

      getSettings,
      updateSettings,
      backupDatabase,

      createAccount,
      updateAccount,

      searchActivities,
      createActivity,
      updateActivity,
      saveActivities,

      openCsvFileDialog,
      openFileSaveDialog,

      listenImportFileDropHover,
      listenImportFileDrop,
      listenImportFileDropCancelled,

      listenPortfolioUpdateStart,
      listenPortfolioUpdateComplete,
      listenPortfolioUpdateError,
      listenMarketSyncStart,
      listenMarketSyncComplete,

      importActivities,
      checkActivitiesImport,
      getAccountImportMapping,
      saveAccountImportMapping,

      getSnapshots,
      getSnapshotByDate,
      saveManualHoldings,
      checkHoldingsImport,
      importHoldingsCsv,
      deleteSnapshot,

      logError: logger.error,
      logInfo: logger.info,
      logWarn: logger.warn,
      logTrace: logger.trace,
      logDebug: logger.debug,

      navigateToRoute: async (route: string) => {
        if (hostNavigate) {
          hostNavigate(route);
        } else {
          navigateWithoutReload(route);
        }
      },

      getQueryClient: () => undefined,
      invalidateQueries: (queryKey: string | string[]) => {
        hostQueryClient?.invalidateQueries({
          queryKey: Array.isArray(queryKey) ? queryKey : [queryKey],
          exact: false,
        });
      },
      refetchQueries: (queryKey: string | string[]) => {
        hostQueryClient?.refetchQueries({
          queryKey: Array.isArray(queryKey) ? queryKey : [queryKey],
          exact: false,
        });
      },

      addonNetworkRequest: (request) => addonNetworkRequest(addonId, request),

      toastSuccess: (message: string) => toast.success(message),
      toastError: (message: string) => toast.error(message),
      toastWarning: (message: string) => toast.warning(message),
      toastInfo: (message: string) => toast.info(message),
    },
    addonId,
    permissionGuard,
  );

  return {
    ...baseAPI,
    secrets: createAddonScopedSecrets(addonId, permissionGuard),
    storage: createAddonScopedStorage(addonId),
  };
}

export function createAddonContext(addonId: string, permissions?: Permission[]): AddonContext {
  return {
    ui: {
      root: document.createElement("div"),
    },
    sidebar: {
      addItem: (cfg) => {
        registerAddonNavItem(addonId, cfg);

        return {
          remove: () => removeAddonNavItem(addonId, cfg.id),
        };
      },
    },
    router: {
      add: (route) => {
        registerAddonRoute(addonId, {
          path: route.path,
          routeId: route.id ?? route.path,
          title: route.title,
        });
      },
    },
    onDisable: (cb) => {
      const callbacks = disableCallbacks.get(addonId) ?? new Set<() => void>();
      callbacks.add(cb);
      disableCallbacks.set(addonId, callbacks);
    },
    api: createAddonHostAPI(addonId, permissions),
  };
}
