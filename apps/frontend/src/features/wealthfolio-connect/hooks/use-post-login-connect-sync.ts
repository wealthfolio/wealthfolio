import { useTranslation } from "react-i18next";
import { logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useEffect, useRef } from "react";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { isSubscriptionStatusActive } from "../lib/plan-capabilities";
import { postLoginBootstrap } from "../services/auth-service";

const BROKER_SYNC_START_TOAST_ID = "broker-sync-start";
const MAX_COMPLETED_REQUEST_IDS = 20;

interface UsePostLoginConnectSyncOptions {
  enabled: boolean;
}

export function usePostLoginConnectSync({ enabled }: UsePostLoginConnectSyncOptions) {
  const { t } = useTranslation();
  const {
    isConnected,
    isInitializing,
    postLoginSyncRequest,
    session,
    user,
    userInfo,
    consumePostLoginSyncRequest,
  } = useWealthfolioConnect();
  const completedRequestIdsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<{
    id: string;
    promise: ReturnType<typeof postLoginBootstrap>;
  } | null>(null);
  const subscriptionInactive =
    !!userInfo && !isSubscriptionStatusActive(userInfo.team?.subscription_status);

  useEffect(() => {
    if (!enabled || isInitializing || !isConnected || !postLoginSyncRequest) {
      return;
    }

    const request = postLoginSyncRequest;
    const currentUserId = user?.id ?? session?.user.id ?? null;

    if (currentUserId !== request.userId) {
      consumePostLoginSyncRequest(request.id);
      logger.debug("Discarded stale post-login sync request");
      return;
    }

    if (completedRequestIdsRef.current.has(request.id)) {
      consumePostLoginSyncRequest(request.id);
      return;
    }

    if (subscriptionInactive) {
      consumePostLoginSyncRequest(request.id);
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attemptBootstrap = async () => {
      // Reuse an in-flight attempt when React re-runs the effect.
      let attempt = inFlightRef.current;
      if (attempt?.id !== request.id) {
        attempt = { id: request.id, promise: postLoginBootstrap() };
        inFlightRef.current = attempt;
      }
      let shouldRetry = false;
      try {
        const result = await attempt.promise;
        if (cancelled) return;

        if (result.brokerSync.status === "started") {
          toast.loading(t("connect:sync.syncingBrokerData"), { id: BROKER_SYNC_START_TOAST_ID });
          logger.info(`Post-login broker sync started after ${request.source}`);
        }

        if (result.brokerSync.status === "skipped" && result.brokerSync.reason === "error") {
          logger.warn("Post-login broker sync bootstrap skipped due to an unexpected error");
          shouldRetry = true;
        }

        if (result.deviceSync.status === "skipped" && result.deviceSync.reason === "error") {
          logger.warn("Post-login device sync bootstrap skipped due to an unexpected error");
          shouldRetry = true;
        }

        if (result.deviceSync.status === "started") {
          logger.info(`Post-login device sync started after ${request.source}`);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Post-login sync bootstrap failed: ${message}`);
        shouldRetry = true;
      } finally {
        if (inFlightRef.current === attempt) inFlightRef.current = null;
      }
      if (cancelled) return;

      if (shouldRetry) {
        retryTimer = setTimeout(() => void attemptBootstrap(), 60_000);
        return;
      }
      completedRequestIdsRef.current.add(request.id);
      while (completedRequestIdsRef.current.size > MAX_COMPLETED_REQUEST_IDS) {
        const oldestRequestId = completedRequestIdsRef.current.keys().next().value;
        if (!oldestRequestId) break;
        completedRequestIdsRef.current.delete(oldestRequestId);
      }
      consumePostLoginSyncRequest(request.id);
    };

    void attemptBootstrap();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [
    t,
    enabled,
    isConnected,
    isInitializing,
    subscriptionInactive,
    postLoginSyncRequest,
    session?.user.id,
    user?.id,
    consumePostLoginSyncRequest,
  ]);
}
