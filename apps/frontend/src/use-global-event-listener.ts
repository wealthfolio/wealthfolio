// useGlobalEventListener.ts
import {
  isDesktop,
  listenAssetClassificationsChanged,
  listenBrokerSyncComplete,
  listenBrokerSyncError,
  listenDatabaseRestored,
  listenMarketSyncComplete,
  listenMarketSyncError,
  listenMarketSyncStart,
  listenPortfolioUpdateComplete,
  listenPortfolioUpdateError,
  listenPortfolioUpdateStart,
  logger,
  updatePortfolio,
} from "@/adapters";
import { usePortfolioSyncOptional } from "@/context/portfolio-sync-context";
import { useIsMobileViewport } from "@/hooks/use-platform";
import {
  invalidateAfterAssetClassificationsChanged,
  shouldInvalidateAfterPortfolioUpdate,
  type AssetClassificationsChangedPayload,
} from "@/lib/query-invalidation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const TOAST_IDS = {
  marketSyncStart: "market-sync-start",
  marketSyncError: "market-sync-error",
  portfolioUpdateStart: "portfolio-update-start",
  portfolioUpdateError: "portfolio-update-error",

  brokerSyncStart: "broker-sync-start",
} as const;

const BROKER_SYNC_FAILURE_DESCRIPTION =
  "We couldn't sync your broker data. Please try again later.";

const POST_LOGIN_REQUIRED_LISTENERS = new Set(["broker-sync-complete", "broker-sync-error"]);

interface MarketSyncCompletePayload {
  failed_syncs?: [string, string][];
  skipped_reasons?: [string, string][];
  show_skipped_reasons?: boolean;
}

function getSyncFailures(payload?: MarketSyncCompletePayload | null): [string, string][] {
  return Array.isArray(payload?.failed_syncs) ? payload.failed_syncs : [];
}

function getSyncSkips(payload?: MarketSyncCompletePayload | null): [string, string][] {
  return Array.isArray(payload?.skipped_reasons) ? payload.skipped_reasons : [];
}

const useGlobalEventListener = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [areListenersReady, setAreListenersReady] = useState(false);
  const hasTriggeredInitialUpdate = useRef(false);
  const isDesktopEnv = isDesktop;
  const isMobileViewport = useIsMobileViewport();
  const syncContext = usePortfolioSyncOptional();

  // Use refs to avoid stale closures in event handlers
  const isMobileViewportRef = useRef(isMobileViewport);
  const syncContextRef = useRef(syncContext);
  const queryClientRef = useRef(queryClient);
  const navigateRef = useRef(navigate);

  // Keep refs up to date
  useEffect(() => {
    isMobileViewportRef.current = isMobileViewport;
    syncContextRef.current = syncContext;
    queryClientRef.current = queryClient;
    navigateRef.current = navigate;
  });

  useEffect(() => {
    let isMounted = true;
    let cleanupFn: (() => void) | undefined;
    setAreListenersReady(false);

    const handleMarketSyncStart = () => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setMarketSyncing();
      } else {
        toast.loading("Syncing market data...", {
          id: TOAST_IDS.marketSyncStart,
          duration: 3000,
        });
      }
    };

    const handleMarketSyncComplete = (event: { payload: MarketSyncCompletePayload | null }) => {
      const failed_syncs = getSyncFailures(event.payload);
      const skipped_reasons = getSyncSkips(event.payload);

      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.marketSyncStart);
      }

      // Show error toast on both mobile and desktop for failed syncs
      if (failed_syncs && failed_syncs.length > 0) {
        const count = failed_syncs.length;
        toast.error(`Price update failed for ${count} asset${count === 1 ? "" : "s"}`, {
          id: TOAST_IDS.marketSyncError,
          duration: 10000,
          action: {
            label: "View",
            onClick: () => navigateRef.current("/health"),
          },
        });
      }

      if (event.payload?.show_skipped_reasons && skipped_reasons.length > 0) {
        const count = skipped_reasons.length;
        const reasons = [...new Set(skipped_reasons.map(([, reason]) => reason))];
        toast.warning(`Price update skipped for ${count} asset${count === 1 ? "" : "s"}`, {
          id: "market-sync-skipped",
          description: reasons.slice(0, 2).join("; "),
          duration: 10000,
          action: {
            label: "View",
            onClick: () => navigateRef.current("/health"),
          },
        });
      }
    };

    const handleMarketSyncError = (event: { payload: string }) => {
      const errorMsg = event.payload || "Unknown error";
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.marketSyncStart);
      }
      toast.error("Market Data Sync Failed", {
        id: TOAST_IDS.marketSyncError,
        description: `${errorMsg}. Please try again later.`,
        duration: 10000,
      });
      logger.error("Market sync error: " + errorMsg);
    };

    const handlePortfolioUpdateStart = () => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setPortfolioCalculating();
      } else {
        toast.loading("Calculating portfolio performance...", {
          id: TOAST_IDS.portfolioUpdateStart,
          duration: 2000,
        });
      }
    };

    const handlePortfolioUpdateError = (error: string) => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.portfolioUpdateStart);
      }
      toast.error("Portfolio Update Failed", {
        id: TOAST_IDS.portfolioUpdateError,
        description:
          "There was an error updating your portfolio. Please try again or contact support if the issue persists.",
        duration: 5000,
      });
      logger.error("Portfolio Update Error: " + error);
    };

    const handlePortfolioUpdateComplete = () => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.portfolioUpdateStart);
      }
      queryClientRef.current.invalidateQueries({
        predicate: (query) => shouldInvalidateAfterPortfolioUpdate(query.queryKey),
      });
    };

    const handleDatabaseRestored = () => {
      queryClientRef.current.invalidateQueries();
      toast.success("Database restored successfully", {
        description: "Please restart the application to ensure all data is properly refreshed.",
      });
    };

    const handleAssetClassificationsChanged = (event: {
      payload: AssetClassificationsChangedPayload | null;
    }) => {
      invalidateAfterAssetClassificationsChanged(queryClientRef.current, event.payload);
    };

    const handleBrokerSyncComplete = (event: {
      payload: {
        success: boolean;
        message: string;
        accountsSynced?: { created: number; updated: number; skipped: number };
        activitiesSynced?: { activitiesUpserted: number; assetsInserted: number };
        holdingsSynced?: {
          accountsSynced: number;
          snapshotsUpserted: number;
          positionsUpserted: number;
          assetsInserted: number;
          newAssetIds: string[];
        };
        newAccounts?: {
          localAccountId: string;
          providerAccountId: string;
          defaultName: string;
          currency: string;
          institutionName?: string;
        }[];
      };
    }) => {
      const { success, message, accountsSynced, activitiesSynced, holdingsSynced, newAccounts } =
        event.payload || {
          success: false,
          message: "Unknown error",
        };

      // Dismiss the loading toast
      toast.dismiss(TOAST_IDS.brokerSyncStart);

      // Invalidate queries that could be affected by sync
      queryClientRef.current.invalidateQueries();

      if (success) {
        // Check if there are new accounts that need configuration
        if (newAccounts && newAccounts.length > 0) {
          toast.info("New accounts found", {
            description: `${newAccounts.length} new account(s) need to be configured`,
            action: {
              label: "Review",
              onClick: () => {
                navigateRef.current("/settings/accounts");
              },
            },
            duration: Infinity, // Don't auto-dismiss - user must act or dismiss manually
          });
        } else {
          // Build description with key numbers
          const accountsCreated = accountsSynced?.created ?? 0;
          const accountsUpdated = accountsSynced?.updated ?? 0;
          const activities = activitiesSynced?.activitiesUpserted ?? 0;
          const activityAssets = activitiesSynced?.assetsInserted ?? 0;
          const positions = holdingsSynced?.positionsUpserted ?? 0;
          const holdingsAccounts = holdingsSynced?.accountsSynced ?? 0;
          const holdingsAssets = holdingsSynced?.assetsInserted ?? 0;
          const totalNewAssets = activityAssets + holdingsAssets;

          const hasChanges =
            accountsCreated > 0 ||
            accountsUpdated > 0 ||
            activities > 0 ||
            totalNewAssets > 0 ||
            positions > 0;

          let description: string;
          if (hasChanges) {
            const parts: string[] = [];
            if (accountsCreated > 0) parts.push(`${accountsCreated} new accounts`);
            if (accountsUpdated > 0) parts.push(`${accountsUpdated} accounts updated`);
            if (activities > 0) parts.push(`${activities} activities`);
            if (positions > 0) parts.push(`${positions} positions (${holdingsAccounts} accounts)`);
            if (totalNewAssets > 0) parts.push(`${totalNewAssets} new assets`);
            description = parts.join(" · ");
          } else {
            description = "Everything is up to date";
          }

          toast.success("Broker Sync Complete", {
            description,
            duration: 5000,
          });
        }
      } else {
        toast.error("Broker Sync Failed", {
          description: BROKER_SYNC_FAILURE_DESCRIPTION,
          duration: 10000,
        });
        logger.error("Broker sync failed: " + message);
      }
    };

    const handleBrokerSyncError = (event: { payload: { error: string } }) => {
      const { error } = event.payload || { error: "Unknown error" };
      // Dismiss the loading toast
      toast.dismiss(TOAST_IDS.brokerSyncStart);
      toast.error("Broker Sync Failed", {
        description: BROKER_SYNC_FAILURE_DESCRIPTION,
        duration: 10000,
      });
      logger.error("Broker sync error: " + error);
    };

    const setupListeners = async () => {
      const listenerSetups: [name: string, setup: Promise<() => void>][] = [
        ["portfolio-update-start", listenPortfolioUpdateStart(handlePortfolioUpdateStart)],
        ["portfolio-update-complete", listenPortfolioUpdateComplete(handlePortfolioUpdateComplete)],
        [
          "portfolio-update-error",
          listenPortfolioUpdateError((event) => {
            handlePortfolioUpdateError(event.payload as string);
          }),
        ],
        ["market-sync-start", listenMarketSyncStart(handleMarketSyncStart)],
        ["market-sync-complete", listenMarketSyncComplete(handleMarketSyncComplete)],
        ["market-sync-error", listenMarketSyncError(handleMarketSyncError)],
        [
          "asset-classifications-changed",
          listenAssetClassificationsChanged(handleAssetClassificationsChanged),
        ],
        ["database-restored", listenDatabaseRestored(handleDatabaseRestored)],
        ["broker-sync-complete", listenBrokerSyncComplete(handleBrokerSyncComplete)],
        ["broker-sync-error", listenBrokerSyncError(handleBrokerSyncError)],
      ];

      const results = await Promise.allSettled(listenerSetups.map(([, setup]) => setup));
      const cleanupFns: (() => void)[] = [];
      const readyListeners = new Set<string>();

      results.forEach((result, index) => {
        const name = listenerSetups[index]?.[0] ?? "unknown";
        if (result.status === "fulfilled") {
          cleanupFns.push(result.value);
          readyListeners.add(name);
        } else {
          logger.error(`Failed to setup ${name} listener: ${String(result.reason)}`);
        }
      });

      const cleanup = () => {
        for (const unlisten of cleanupFns) {
          unlisten();
        }
      };

      // If unmounted while setting up, clean up immediately
      if (!isMounted) {
        cleanup();
        return;
      }

      cleanupFn = cleanup;
      setAreListenersReady(
        Array.from(POST_LOGIN_REQUIRED_LISTENERS).every((name) => readyListeners.has(name)),
      );

      // Trigger initial portfolio update after listeners are set up
      if (!hasTriggeredInitialUpdate.current) {
        hasTriggeredInitialUpdate.current = true;
        logger.debug("Triggering initial portfolio update from frontend");

        // Trigger portfolio update
        updatePortfolio().catch((error) => {
          logger.error("Failed to trigger initial portfolio update: " + String(error));
        });
        // Note: Update check is now handled by useCheckUpdateOnStartup query in UpdateDialog
      }
    };

    setupListeners().catch((error) => {
      logger.error("Failed to setup global event listeners: " + String(error));
    });

    return () => {
      isMounted = false;
      setAreListenersReady(false);
      cleanupFn?.();
    };
  }, [isDesktopEnv]); // Only re-run if isDesktopEnv changes (which it won't)

  return areListenersReady;
};

export default useGlobalEventListener;
