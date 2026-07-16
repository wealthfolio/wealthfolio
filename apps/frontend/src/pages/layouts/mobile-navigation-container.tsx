import { syncTriggerCycle, updatePortfolio } from "@/adapters";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useQueryClient } from "@tanstack/react-query";
import { Icons, PageScrollContainer } from "@wealthfolio/ui";
import { AnimatePresence } from "motion/react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

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
      <PageScrollContainer
        withMobileNavOffset
        className="lg:px-6 lg:py-0"
        {...pullToRefreshHandlers}
      >
        <AnimatePresence mode="wait" initial={false}>
          <Outlet />
        </AnimatePresence>
      </PageScrollContainer>

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
            <Icons.Loader className="size-4 animate-spin" />

            <span>{t("common:layout.refreshing")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
