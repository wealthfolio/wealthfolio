import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./app-layout";

interface PlatformState {
  isTauri: boolean;
  info: { is_mobile: boolean; is_desktop: boolean } | null;
}
const state = vi.hoisted((): PlatformState => ({ isTauri: false, info: null }));

// Mirrors usePlatform's defaults: until the lookup resolves, it reports a desktop.
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: state.info,
    isTauri: state.isTauri,
    isMobile: state.info?.is_mobile ?? false,
    isDesktop: state.info?.is_desktop ?? true,
    isMacOS: false,
  }),
  useIsMobileViewport: () => state.info?.is_mobile ?? false,
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { onboardingCompleted: true } }),
}));
vi.mock("@/context/portfolio-sync-context", () => ({
  PortfolioSyncProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./navigation/navigation-mode-context", () => ({
  NavigationModeProvider: ({ children }: { children: ReactNode }) => children,
  useNavigationMode: () => ({ isLaunchBar: false, isFocusMode: false }),
}));
vi.mock("./navigation/app-navigation", () => ({ useNavigation: () => ({ primary: [] }) }));
vi.mock("@/app-screen-routes", () => ({ AppScreenRoutes: () => null }));
vi.mock("./navigation/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("./navigation/floating-navigation-bar", () => ({ FloatingNavigationBar: () => null }));
vi.mock("./navigation/mobile-navbar", () => ({ MobileNavBar: () => null }));
vi.mock("./mobile-navigation-container", () => ({ MobileNavigationContainer: () => null }));
vi.mock("@/components/app-launcher", () => ({ default: () => null }));
vi.mock("@/components/update-dialog", () => ({ UpdateDialog: () => null }));
vi.mock("@/components/mobile-loading-indicator", () => ({ MobileLoadingIndicator: () => null }));
vi.mock("@/use-global-event-listener", () => ({ default: () => true }));
vi.mock("@/features/devices-sync/hooks/use-active-app-sync-trigger", () => ({
  useActiveAppSyncTrigger: () => undefined,
}));
vi.mock("@/features/wealthfolio-connect/hooks", () => ({
  usePostLoginConnectSync: () => undefined,
}));

const dragStrip = () => {
  const { container } = render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<p>Dashboard</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return container.querySelector("main > [data-tauri-drag-region]");
};

const desktop = { is_mobile: false, is_desktop: true };
const phone = { is_mobile: true, is_desktop: false };

describe("AppLayout window drag strip", () => {
  beforeEach(() => Object.assign(state, { isTauri: false, info: desktop }));

  it("is not rendered in a browser, where it would cover the top of the page", () => {
    expect(dragStrip()).toBeNull();
  });

  it("is not rendered in the phone app, which has no window to drag", () => {
    Object.assign(state, { isTauri: true, info: phone });
    expect(dragStrip()).toBeNull();
  });

  it("is not rendered before the app knows it runs on a desktop", () => {
    Object.assign(state, { isTauri: true, info: null });
    expect(dragStrip()).toBeNull();
  });

  it("is rendered in the desktop app", () => {
    Object.assign(state, { isTauri: true, info: desktop });
    expect(dragStrip()).toBeInTheDocument();
  });
});
