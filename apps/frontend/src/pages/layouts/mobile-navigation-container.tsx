import { syncTriggerCycle, updatePortfolio } from "@/adapters";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useQueryClient } from "@tanstack/react-query";
import { Icons, Spinner } from "@wealthfolio/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MobileStackOutlet } from "./mobile-stack/mobile-stack-outlet";

export function MobileNavigationContainer() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const onRefresh = useCallback(async () => {
    await updatePortfolio();
    await queryClient.invalidateQueries();
    await syncTriggerCycle().catch(() => undefined);
  }, [queryClient]);
  const [isRefreshing, pullToRefreshHandlers, ptr] = usePullToRefresh({ onRefresh });

  return (
    <div className="relative flex min-h-0 w-full flex-1">
      <MobileStackOutlet scrollProps={pullToRefreshHandlers} />

      {/* Pull progress indicator: shows during pull before activation */}
      {!isRefreshing && ptr.isPulling && !ptr.isActivated && (
        <div className="pointer-events-none absolute left-1/2 top-[calc(env(safe-area-inset-top,0px)+0.25rem)] z-50 -translate-x-1/2">
          <div
            className="border-border/60 bg-background/70 text-muted-foreground backdrop-saturate-125 flex items-center justify-center rounded-full border px-2 py-2 shadow-sm backdrop-blur-sm transition-transform duration-75 ease-linear"
            style={{
              transform: `translateY(${Math.min(ptr.pullDistance * 0.5, 28)}px)`,
              opacity: 0.5 + Math.min(ptr.progress, 1) * 0.5,
            }}
          >
            <Icons.ArrowDown className="text-muted-foreground size-5" />
          </div>
        </div>
      )}

      {(isRefreshing || ptr.isActivated) && (
        <div className="pointer-events-none absolute left-1/2 top-[calc(env(safe-area-inset-top,0px)+2rem)] z-50 -translate-x-1/2">
          <div className="bg-background/80 text-muted-foreground flex items-center gap-2 rounded-full px-3 py-1 text-xs backdrop-blur-sm">
            <Spinner className="size-4" />

            <span>{t("common:layout.refreshing")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
