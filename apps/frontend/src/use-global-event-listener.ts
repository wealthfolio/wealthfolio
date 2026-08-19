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
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const TOAST_IDS = {
  marketSyncStart: "market-sync-start",
  marketSyncError: "market-sync-error",
  portfolioUpdateStart: "portfolio-update-start",
  portfolioUpdateError: "portfolio-update-error",
  portfolioInvalidSnapshotError: "portfolio-invalid-snapshot-error",

  brokerSyncStart: "broker-sync-start",
} as const;

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
  const { t } = useTranslation();
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
  const translationRef = useRef(t);

  // Keep refs up to date
  useEffect(() => {
    isMobileViewportRef.current = isMobileViewport;
    syncContextRef.current = syncContext;
    queryClientRef.current = queryClient;
    navigateRef.current = navigate;
    translationRef.current = t;
  });

  useEffect(() => {
    let isMounted = true;
    let cleanupFn: (() => void) | undefined;
    setAreListenersReady(false);

    const handleMarketSyncStart = () => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setMarketSyncing();
      } else {
        toast.loading(translationRef.current("common:globalEvents.syncingMarket"), {
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
        toast.error(translationRef.current("common:globalEvents.priceUpdateFailed", { count }), {
          id: TOAST_IDS.marketSyncError,
          duration: 10000,
          action: {
            label: translationRef.current("common:globalEvents.view"),
            onClick: () => navigateRef.current("/health"),
          },
        });
      }

      if (event.payload?.show_skipped_reasons && skipped_reasons.length > 0) {
        const count = skipped_reasons.length;
        const reasons = [...new Set(skipped_reasons.map(([, reason]) => reason))];
        toast.warning(translationRef.current("common:globalEvents.priceUpdateSkipped", { count }), {
          id: "market-sync-skipped",
          description: reasons.slice(0, 2).join("; "),
          duration: 10000,
          action: {
            label: translationRef.current("common:globalEvents.view"),
            onClick: () => navigateRef.current("/health"),
          },
        });
      }
    };

    const handleMarketSyncError = (event: { payload: string }) => {
      const errorMsg = event.payload || translationRef.current("common:globalEvents.unknownError");
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.marketSyncStart);
      }
      toast.error(translationRef.current("common:globalEvents.marketSyncFailed"), {
        id: TOAST_IDS.marketSyncError,
        description: translationRef.current("common:globalEvents.errorTryAgainLater", {
          error: errorMsg.replace(/[.\s]+$/u, ""),
        }),
        duration: 10000,
      });
      logger.error("Market sync error: " + errorMsg);
    };

    const handlePortfolioUpdateStart = () => {
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setPortfolioCalculating();
      } else {
        toast.loading(
          translationRef.current("common:globalEvents.calculatingPortfolioPerformance"),
          {
            id: TOAST_IDS.portfolioUpdateStart,
            duration: 2000,
          },
        );
      }
    };

    const handlePortfolioUpdateError = (error: unknown) => {
      const errorMessage =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? String(error.message)
            : translationRef.current("common:globalEvents.unknownPortfolioUpdateError");
      const errorCode =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      const invalidSnapshotDate =
        errorCode === "INVALID_SNAPSHOT_DATE" || errorMessage.includes("INVALID_SNAPSHOT_DATE");
      if (isMobileViewportRef.current && syncContextRef.current) {
        syncContextRef.current.setIdle();
      } else {
        toast.dismiss(TOAST_IDS.portfolioUpdateStart);
      }
      toast.error(
        invalidSnapshotDate
          ? translationRef.current("account:snapshot.invalid_date_update_failed")
          : translationRef.current("common:globalEvents.portfolioUpdateFailed"),
        {
          id: invalidSnapshotDate
            ? TOAST_IDS.portfolioInvalidSnapshotError
            : TOAST_IDS.portfolioUpdateError,
          description: invalidSnapshotDate
            ? translationRef.current("account:snapshot.invalid_date_update_desc")
            : translationRef.current("common:globalEvents.portfolioUpdateFailedDescription"),
          action: invalidSnapshotDate
            ? {
                label: translationRef.current("account:snapshot.review_health"),
                onClick: () => navigateRef.current("/health"),
              }
            : undefined,
          style: invalidSnapshotDate
            ? {
                display: "grid",
                gridTemplateColumns: "16px minmax(0, 1fr)",
                alignItems: "start",
                columnGap: "12px",
                rowGap: "12px",
              }
            : undefined,
          actionButtonStyle: invalidSnapshotDate
            ? {
                gridColumn: 2,
                gridRow: 2,
                margin: 0,
                marginLeft: "auto",
              }
            : undefined,
          duration: invalidSnapshotDate ? 10000 : 5000,
        },
      );
      logger.error("Portfolio Update Error: " + errorMessage);
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
      toast.success(translationRef.current("common:globalEvents.databaseRestored"), {
        description: translationRef.current("common:globalEvents.databaseRestoredDescription"),
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
          message: translationRef.current("common:globalEvents.unknownError"),
        };

      // Dismiss the loading toast
      toast.dismiss(TOAST_IDS.brokerSyncStart);

      // Invalidate queries that could be affected by sync
      queryClientRef.current.invalidateQueries();

      if (success) {
        // Check if there are new accounts that need configuration
        if (newAccounts && newAccounts.length > 0) {
          toast.info(translationRef.current("common:globalEvents.newAccountsFound"), {
            description: translationRef.current("common:globalEvents.newAccountsDescription", {
              count: newAccounts.length,
            }),
            action: {
              label: translationRef.current("common:globalEvents.review"),
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
            if (accountsCreated > 0) {
              parts.push(
                translationRef.current("common:globalEvents.newAccounts", {
                  count: accountsCreated,
                }),
              );
            }
            if (accountsUpdated > 0) {
              parts.push(
                translationRef.current("common:globalEvents.accountsUpdated", {
                  count: accountsUpdated,
                }),
              );
            }
            if (activities > 0) {
              parts.push(
                translationRef.current("common:globalEvents.activities", { count: activities }),
              );
            }
            if (positions > 0) {
              parts.push(
                translationRef.current("common:globalEvents.positions", {
                  count: positions,
                  accounts: holdingsAccounts,
                }),
              );
            }
            if (totalNewAssets > 0) {
              parts.push(
                translationRef.current("common:globalEvents.newAssets", { count: totalNewAssets }),
              );
            }
            description = parts.join(" · ");
          } else {
            description = translationRef.current("common:globalEvents.everythingUpToDate");
          }

          toast.success(translationRef.current("common:globalEvents.brokerSyncComplete"), {
            description,
            duration: 5000,
          });
        }
      } else {
        toast.error(translationRef.current("common:globalEvents.brokerSyncFailed"), {
          description: translationRef.current("common:globalEvents.brokerSyncFailedDescription"),
          duration: 10000,
        });
        logger.error("Broker sync failed: " + message);
      }
    };

    const handleBrokerSyncError = (event: { payload: { error: string } }) => {
      const { error } = event.payload || {
        error: translationRef.current("common:globalEvents.unknownError"),
      };
      // Dismiss the loading toast
      toast.dismiss(TOAST_IDS.brokerSyncStart);
      toast.error(translationRef.current("common:globalEvents.brokerSyncFailed"), {
        description: translationRef.current("common:globalEvents.brokerSyncFailedDescription"),
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
            handlePortfolioUpdateError(event.payload);
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
