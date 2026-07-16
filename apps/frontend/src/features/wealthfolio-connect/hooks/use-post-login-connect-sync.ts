import { logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useEffect, useRef } from "react";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { postLoginBootstrap } from "../services/auth-service";

const BROKER_SYNC_START_TOAST_ID = "broker-sync-start";
const MAX_ATTEMPTED_REQUEST_IDS = 20;

interface UsePostLoginConnectSyncOptions {
  enabled: boolean;
}

export function usePostLoginConnectSync({ enabled }: UsePostLoginConnectSyncOptions) {
  const {
    isConnected,
    isInitializing,
    postLoginSyncRequest,
    session,
    user,
    consumePostLoginSyncRequest,
  } = useWealthfolioConnect();
  const attemptedRequestIdsRef = useRef<Set<string>>(new Set());

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

    if (attemptedRequestIdsRef.current.has(request.id)) {
      consumePostLoginSyncRequest(request.id);
      return;
    }

    attemptedRequestIdsRef.current.add(request.id);
    while (attemptedRequestIdsRef.current.size > MAX_ATTEMPTED_REQUEST_IDS) {
      const oldestRequestId = attemptedRequestIdsRef.current.keys().next().value;
      if (!oldestRequestId) break;
      attemptedRequestIdsRef.current.delete(oldestRequestId);
    }

    consumePostLoginSyncRequest(request.id);

    void postLoginBootstrap()
      .then((result) => {
        if (result.brokerSync.status === "started") {
          toast.loading("Syncing broker data...", { id: BROKER_SYNC_START_TOAST_ID });
          logger.info(`Post-login broker sync started after ${request.source}`);
        }

        if (result.brokerSync.status === "skipped" && result.brokerSync.reason === "error") {
          logger.warn("Post-login broker sync bootstrap skipped due to an unexpected error");
        }

        if (result.deviceSync.status === "skipped" && result.deviceSync.reason === "error") {
          logger.warn("Post-login device sync bootstrap skipped due to an unexpected error");
        }

        if (result.deviceSync.status === "started") {
          logger.info(`Post-login device sync started after ${request.source}`);
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Post-login sync bootstrap failed: ${message}`);
      });
  }, [
    enabled,
    isConnected,
    isInitializing,
    postLoginSyncRequest,
    session?.user.id,
    user?.id,
    consumePostLoginSyncRequest,
  ]);
}
