import type { AddonContext, SidebarItemHandle } from "@wealthfolio/addon-sdk";
import React from "react";
import { toast } from "sonner";
import { createSDKHostAPIBridge } from "./type-bridge";

// Import all command functions
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
  deleteSecret,
  getSecret,
  setSecret,
  backupDatabase,
  getSettings,
  updateSettings,
} from "@/adapters";

// Store for dynamically added navigation items
interface NavItem {
  icon: React.ReactNode | string;
  title: string;
  href: string;
  onClick?: () => void;
  order: number;
  id: string;
}
const dynamicNavItems = new Map<string, NavItem>();
const disableCallbacks = new Set<() => void>();

// Store for dynamically added routes
const dynamicRoutes = new Map<string, React.LazyExoticComponent<React.ComponentType<unknown>>>();

// Navigation update listeners
const navigationUpdateListeners = new Set<() => void>();

// Function to notify navigation update listeners
function notifyNavigationUpdate() {
  navigationUpdateListeners.forEach((listener) => listener());
}

// Public API for getting dynamic navigation items
export function getDynamicNavItems() {
  return Array.from(dynamicNavItems.values()).sort((a, b) => a.order - b.order);
}

// Public API for getting dynamic routes
export function getDynamicRoutes() {
  return Array.from(dynamicRoutes.entries()).map(([path, component]) => ({
    path,
    component,
  }));
}

// Public API for subscribing to navigation updates
export function subscribeToNavigationUpdates(callback: () => void) {
  navigationUpdateListeners.add(callback);
  return () => navigationUpdateListeners.delete(callback);
}

// Public API for triggering navigation updates
export function triggerNavigationUpdate() {
  notifyNavigationUpdate();
}

// Public API for triggering all disable callbacks
export function triggerAllDisableCallbacks() {
  disableCallbacks.forEach((cb) => {
    try {
      cb();
    } catch (error) {
      console.error("Error in addon disable callback:", error);
    }
  });
  disableCallbacks.clear();
  dynamicNavItems.clear();
  dynamicRoutes.clear();
  notifyNavigationUpdate();
}

// Create addon-scoped secret functions
function createAddonScopedSecrets(addonId: string) {
  const addonPrefix = `addon_${addonId}_`;

  return {
    set: async (key: string, value: string): Promise<void> => {
      const scopedKey = `${addonPrefix}${key}`;
      return setSecret(scopedKey, value);
    },
    get: async (key: string): Promise<string | null> => {
      const scopedKey = `${addonPrefix}${key}`;
      return getSecret(scopedKey);
    },
    delete: async (key: string): Promise<void> => {
      const scopedKey = `${addonPrefix}${key}`;
      return deleteSecret(scopedKey);
    },
  };
}

// Create context factory function for addon-specific contexts
export function createAddonContext(addonId: string): AddonContext {
  return {
    sidebar: {
      addItem: (cfg: {
        id: string;
        label: string;
        icon?: React.ReactNode;
        route?: string;
        order?: number;
        onClick?: () => void;
      }): SidebarItemHandle => {
        // Create navigation item
        const navItem = {
          icon: cfg.icon ?? '<Icons.Circle className="h-5 w-5" />',
          title: cfg.label,
          href: cfg.route ?? "#",
          onClick: cfg.onClick,
          order: cfg.order ?? 999,
          id: cfg.id,
        };

        // Store the navigation item
        dynamicNavItems.set(cfg.id, navItem);

        // Notify listeners that navigation has changed
        notifyNavigationUpdate();

        return {
          remove: () => {
            dynamicNavItems.delete(cfg.id);
            notifyNavigationUpdate();
          },
        };
      },
    },
    router: {
      add: (r: {
        path: string;
        component: React.LazyExoticComponent<React.ComponentType<unknown>>;
      }): void => {
        // Store the route component
        dynamicRoutes.set(r.path, r.component);

        // Notify listeners that routes have changed
        notifyNavigationUpdate();
      },
    },
    onDisable: (cb: () => void): void => {
      disableCallbacks.add(cb);
    },
    api: (() => {
      const baseAPI = createSDKHostAPIBridge(
        {
          // Core data access
          getHoldings: (accountId: string) => getHoldings({ type: "account", accountId }),
          getActivities: getActivities,
          getAccounts: getAccounts,

          // Exchange rates
          getExchangeRates,
          updateExchangeRate,
          addExchangeRate,

          // Contribution limits
          getContributionLimit,
          createContributionLimit,
          updateContributionLimit,
          calculateDepositsForLimit,

          // Goals
          getGoals,
          createGoal,
          updateGoal,
          getGoalFunding,
          saveGoalFunding,

          // Market data
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

          // Portfolio
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

          // Settings
          getSettings,
          updateSettings,
          backupDatabase,

          // Account management
          createAccount,
          updateAccount,

          // Activity management
          searchActivities,
          createActivity,
          updateActivity,
          saveActivities,

          // File operations
          openCsvFileDialog,
          openFileSaveDialog,

          // Event listeners - Import
          listenImportFileDropHover,
          listenImportFileDrop,
          listenImportFileDropCancelled,

          // Event listeners - Portfolio
          listenPortfolioUpdateStart,
          listenPortfolioUpdateComplete,
          listenPortfolioUpdateError,
          listenMarketSyncStart,
          listenMarketSyncComplete,

          // Activity import
          importActivities,
          checkActivitiesImport,
          getAccountImportMapping,
          saveAccountImportMapping,

          // Snapshots
          getSnapshots,
          getSnapshotByDate,
          saveManualHoldings,
          checkHoldingsImport,
          importHoldingsCsv,
          deleteSnapshot,

          // Logger functions
          logError: logger.error,
          logInfo: logger.info,
          logWarn: logger.warn,
          logTrace: logger.trace,
          logDebug: logger.debug,

          // Navigation functions
          navigateToRoute: async (route: string) => {
            // Use the browser's navigation API through React Router
            const navigate = (
              window as unknown as { __wealthfolio_navigate__?: (r: string) => void }
            ).__wealthfolio_navigate__;
            if (navigate) {
              navigate(route);
            } else {
              // Fallback: change the URL directly
              window.location.hash = route;
            }
          },

          // Query functions
          getQueryClient: () => {
            interface QueryClientLike {
              invalidateQueries: (opts: { queryKey: string[] }) => unknown;
              refetchQueries: (opts: { queryKey: string[] }) => unknown;
            }
            return (window as unknown as { __wealthfolio_query_client__?: QueryClientLike })
              .__wealthfolio_query_client__;
          },
          invalidateQueries: (queryKey: string | string[]) => {
            interface QueryClientLike {
              invalidateQueries: (opts: { queryKey: string[]; exact?: boolean }) => unknown;
            }
            const queryClient = (
              window as unknown as { __wealthfolio_query_client__?: QueryClientLike }
            ).__wealthfolio_query_client__;
            if (queryClient) {
              queryClient.invalidateQueries({
                queryKey: Array.isArray(queryKey) ? queryKey : [queryKey],
                exact: false,
              });
            }
          },
          refetchQueries: (queryKey: string | string[]) => {
            interface QueryClientLike {
              refetchQueries: (opts: { queryKey: string[]; exact?: boolean }) => unknown;
            }
            const queryClient = (
              window as unknown as { __wealthfolio_query_client__?: QueryClientLike }
            ).__wealthfolio_query_client__;
            if (queryClient) {
              queryClient.refetchQueries({
                queryKey: Array.isArray(queryKey) ? queryKey : [queryKey],
                exact: false,
              });
            }
          },

          // Toast functions (backed by host's sonner instance)
          toastSuccess: (message: string) => toast.success(message),
          toastError: (message: string) => toast.error(message),
          toastWarning: (message: string) => toast.warning(message),
          toastInfo: (message: string) => toast.info(message),
        },
        addonId,
      );

      // Add the secrets API manually (without `any`)
      const apiWithSecrets = {
        ...baseAPI,
        secrets: createAddonScopedSecrets(addonId),
      };

      return apiWithSecrets;
    })(),
  };
}

// Note: We intentionally do not set a global context to ensure proper secret isolation.
// Each addon receives its own scoped context via the enable(ctx: AddonContext) function parameter.
