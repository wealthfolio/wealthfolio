import AppLauncher from "@/components/app-launcher";
import { MobileLoadingIndicator } from "@/components/mobile-loading-indicator";
import { UpdateDialog } from "@/components/update-dialog";
import { PortfolioSyncProvider } from "@/context/portfolio-sync-context";
import { useActiveAppSyncTrigger } from "@/features/devices-sync/hooks/use-active-app-sync-trigger";
import { usePostLoginConnectSync } from "@/features/wealthfolio-connect/hooks";
import { useIsMobileViewport, usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import { MobileNavigationContainer } from "@/pages/layouts/mobile-navigation-container";
import useGlobalEventListener from "@/use-global-event-listener";
import { ApplicationShell, ErrorBoundary, PageScrollContainer } from "@wealthfolio/ui";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useNavigation } from "./navigation/app-navigation";
import { AppSidebar } from "./navigation/app-sidebar";
import { FloatingNavigationBar } from "./navigation/floating-navigation-bar";
import { MobileNavBar } from "./navigation/mobile-navbar";
import { NavigationModeProvider, useNavigationMode } from "./navigation/navigation-mode-context";

const AppLayoutContent = () => {
  const { settings } = useSettingsContext();
  const location = useLocation();
  const navigation = useNavigation();
  const { isMobile, isMacOS, isTauri } = usePlatform();
  const isMobileViewport = useIsMobileViewport();
  const isIPad =
    typeof window !== "undefined" &&
    (/ipad/i.test(window.navigator.userAgent) ||
      (/macintosh/i.test(window.navigator.userAgent) && window.navigator.maxTouchPoints > 1));
  const { isLaunchBar, isFocusMode } = useNavigationMode();
  const shouldUseMobileNavigation = isIPad ? false : isMobile || isMobileViewport;
  const shouldUseBottomNavigation = shouldUseMobileNavigation || (isLaunchBar && !isFocusMode);
  const isDesktopFocusMode = !shouldUseMobileNavigation && isFocusMode;
  const hasSidebar = !shouldUseBottomNavigation && !isDesktopFocusMode;
  // macOS only: `titleBarStyle: "Overlay"` floats the traffic lights over the
  // WebView, and without the sidebar nothing covers the top-left corner they
  // occupy. Observed at y 8-20 against pills starting at y 16, so 8px clears
  // them with a small margin. Consumed by .titlebar-nudge.
  const titleBarNudge =
    isTauri && isMacOS && !shouldUseMobileNavigation && !hasSidebar
      ? "translateY(0.5rem)"
      : undefined;
  const launchBarHeight =
    !shouldUseMobileNavigation && isLaunchBar && !isFocusMode ? "56px" : undefined;
  const isAppShellReady = !!settings?.onboardingCompleted;
  const pageScrollKey =
    location.pathname.startsWith("/addon/") || location.pathname.startsWith("/addons/")
      ? "/addons"
      : location.pathname;

  const areGlobalEventsReady = useGlobalEventListener();
  useActiveAppSyncTrigger({ enabled: isTauri, requireWindowFocusForInterval: !isMobile });
  usePostLoginConnectSync({ enabled: areGlobalEventsReady && isAppShellReady });

  if (!settings?.onboardingCompleted && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" />;
  }

  return (
    <ErrorBoundary>
      <ApplicationShell
        className="app-shell h-screen overflow-x-hidden"
        data-mobile-navigation={shouldUseMobileNavigation ? "true" : undefined}
        style={{
          ...(launchBarHeight ? { ["--mobile-nav-ui-height" as string]: launchBarHeight } : {}),
          ...(titleBarNudge ? { ["--titlebar-nudge" as string]: titleBarNudge } : {}),
        }}
      >
        {/* Mobile sync loading indicator */}
        {shouldUseMobileNavigation && <MobileLoadingIndicator />}

        <div className="scan-hide-target">
          {hasSidebar && <AppSidebar navigation={navigation} />}
        </div>

        <div
          className={cn(
            "relative flex min-h-0 w-full max-w-full flex-1 overflow-x-hidden",
            shouldUseMobileNavigation ? "overscroll-contain" : undefined,
          )}
        >
          <main className="relative flex min-h-0 w-full max-w-full flex-1 flex-col overflow-x-hidden">
            <div
              data-tauri-drag-region="true"
              className="draggable pointer-events-auto absolute inset-x-0 top-0 z-50 h-6 cursor-grab opacity-0"
            ></div>
            {shouldUseMobileNavigation ? (
              <MobileNavigationContainer key={pageScrollKey} />
            ) : (
              <PageScrollContainer
                key={pageScrollKey}
                withMobileNavOffset={shouldUseBottomNavigation}
              >
                <Outlet />
              </PageScrollContainer>
            )}
          </main>
        </div>

        {shouldUseMobileNavigation && <MobileNavBar navigation={navigation} />}
        {!shouldUseMobileNavigation && isLaunchBar && !isDesktopFocusMode && (
          <FloatingNavigationBar navigation={navigation} />
        )}

        <AppLauncher />
        <UpdateDialog />
      </ApplicationShell>
    </ErrorBoundary>
  );
};

const AppLayout = () => {
  return (
    <PortfolioSyncProvider>
      <NavigationModeProvider>
        <AppLayoutContent />
      </NavigationModeProvider>
    </PortfolioSyncProvider>
  );
};

export { AppLayout };
