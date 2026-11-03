import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({ connectEnabled: false }));

vi.mock("@/lib/connect-config", () => ({
  get CONNECT_ENABLED() {
    return configState.connectEnabled;
  },
}));

vi.mock("@/features/wealthfolio-connect/hooks", () => ({
  useAggregatedSyncStatus: () => ({ status: "idle", lastSyncTime: null }),
}));

vi.mock("@/features/wealthfolio-connect/components/sync-status-icon", () => ({
  SyncStatusIcon: () => <span data-testid="sync-status-icon" />,
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: { is_mobile: true, is_desktop: false },
    isTauri: false,
    isMobile: true,
    isDesktop: false,
    isMacOS: false,
    isAndroid: false,
  }),
  useIsMobileViewport: () => true,
  getPlatform: () => ({ is_mobile: true, is_desktop: false }),
}));

vi.mock("@/features/profiles/profile-menu", () => ({
  ProfileMenu: () => null,
}));

vi.mock("@/features/profiles/profile-context", () => ({
  useProfile: () => null,
}));

vi.mock("@/hooks/use-haptic-feedback", () => ({
  useHapticFeedback: () => ({ triggerHaptic: vi.fn() }),
}));

vi.mock("../mobile-stack/use-mobile-stack", () => ({
  useMobileStack: () => null,
}));

import { ConnectNavItem } from "./connect-nav-item";
import { FloatingNavigationBar } from "./floating-navigation-bar";
import { MobileNavBar } from "./mobile-navbar";

describe("Connect navigation visibility", () => {
  beforeEach(() => {
    configState.connectEnabled = false;
  });

  it("omits ConnectNavItem when CONNECT_ENABLED is false", () => {
    const { container } = render(
      <MemoryRouter>
        <ConnectNavItem collapsed={false} />
      </MemoryRouter>,
    );

    expect(container.querySelector('a[href="/connect"]')).toBeNull();
  });

  it("renders ConnectNavItem when CONNECT_ENABLED is true", () => {
    configState.connectEnabled = true;

    const { container } = render(
      <MemoryRouter>
        <ConnectNavItem collapsed={false} />
      </MemoryRouter>,
    );

    expect(container.querySelector('a[href="/connect"]')).not.toBeNull();
  });

  it("omits the Connect link in FloatingNavigationBar when CONNECT_ENABLED is false", () => {
    const { container } = render(
      <MemoryRouter>
        <FloatingNavigationBar navigation={{ primary: [] }} />
      </MemoryRouter>,
    );

    expect(container.querySelector('a[href="/connect"]')).toBeNull();
  });

  it("renders the Connect link in FloatingNavigationBar when CONNECT_ENABLED is true", () => {
    configState.connectEnabled = true;

    render(
      <MemoryRouter>
        <FloatingNavigationBar navigation={{ primary: [] }} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("sync-status-icon")).toBeInTheDocument();
  });

  it("omits the Connect item in MobileNavBar when CONNECT_ENABLED is false", () => {
    render(
      <MemoryRouter>
        <MobileNavBar navigation={{ primary: [] }} />
      </MemoryRouter>,
    );

    const moreButton = screen.queryByRole("button", { name: /more options/i });
    if (moreButton) {
      fireEvent.click(moreButton);
    }

    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
  });

  it("renders the Connect item in MobileNavBar when CONNECT_ENABLED is true", () => {
    configState.connectEnabled = true;

    render(
      <MemoryRouter>
        <MobileNavBar navigation={{ primary: [] }} />
      </MemoryRouter>,
    );

    const moreButton = screen.getByRole("button", { name: /more options/i });
    fireEvent.click(moreButton);

    expect(screen.getByRole("link", { name: /connect/i })).toBeInTheDocument();
  });
});
