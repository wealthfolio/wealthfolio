import { render, screen } from "@testing-library/react";
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

vi.mock("@/features/profiles/profile-menu", () => ({
  ProfileMenu: () => null,
}));

import { ConnectNavItem } from "./connect-nav-item";
import { FloatingNavigationBar } from "./floating-navigation-bar";

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
});
