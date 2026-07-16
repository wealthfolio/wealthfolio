import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddonIframeRoute } from "./addon-iframe-route";

// Stable identities, like the real react-router: useParams/useLocation return
// memoized objects between location changes (fresh objects per call would
// re-fire the location effect on every render — a loop the real app doesn't
// have). The location effect re-fires in tests via a routeId prop change.
const stableLocation = { hash: "", pathname: "/addons/test", search: "" };
const stableParams = {};

vi.mock("react-router-dom", () => ({
  useLocation: () => stableLocation,
  useParams: () => stableParams,
}));

const IDLE_STATUS = { status: "idle" as const };

const manager = vi.hoisted(() => ({
  hasRuntime: vi.fn<() => boolean>(() => true),
  attachRoute: vi.fn(),
  detachRoute: vi.fn(),
  updateRoute: vi.fn(),
  getRouteStatus: vi.fn(),
  subscribeRouteStatus: vi.fn(() => () => {}),
  retryRoute: vi.fn(),
}));

vi.mock("./addon-iframe-manager", () => ({
  addonIframeManager: manager,
}));

const activateView = vi.hoisted(() => vi.fn(async () => true));
const activationEpochStore = vi.hoisted(() => {
  let epoch = 0;
  const listeners = new Set<() => void>();
  return {
    advance: () => {
      epoch += 1;
      listeners.forEach((listener) => listener());
    },
    getSnapshot: () => epoch,
    reset: () => {
      epoch = 0;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/addons/activation-coordinator", () => ({
  activationCoordinator: {
    activateView,
    getPublishedActivationEpoch: activationEpochStore.getSnapshot,
    subscribeToActivationEpoch: activationEpochStore.subscribe,
  },
}));

describe("AddonIframeRoute self-healing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.hasRuntime.mockReturnValue(true);
    manager.getRouteStatus.mockReturnValue(IDLE_STATUS);
    activateView.mockResolvedValue(true);
    activationEpochStore.reset();
  });

  it("activates once and renders the route on mount", async () => {
    render(<AddonIframeRoute addonId="test-addon" routeId="test" />);

    await waitFor(() => expect(manager.updateRoute).toHaveBeenCalled());
    expect(activateView).toHaveBeenCalledTimes(1);
    expect(manager.attachRoute).toHaveBeenCalledTimes(1);
  });

  it("re-activates instead of crashing when the runtime is stopped underneath a mounted route", async () => {
    const { rerender } = render(<AddonIframeRoute addonId="test-addon" routeId="test" />);
    await waitFor(() => expect(manager.updateRoute).toHaveBeenCalled());
    const activationsAfterMount = activateView.mock.calls.length;
    const attachesAfterMount = manager.attachRoute.mock.calls.length;

    // Simulate a whole-world addon reload: the runtime is stopped while the
    // route stays mounted (settings save triggers reloadAllAddons and this
    // lazy addon is not re-booted). The next location-effect run must fall
    // back to activation instead of calling into the dead runtime.
    manager.hasRuntime.mockReturnValueOnce(false).mockReturnValue(true);

    // Re-fire the location effect (in the real app the router hands out a new
    // params identity after the durable registry re-ingests).
    await act(async () => {
      rerender(<AddonIframeRoute addonId="test-addon" routeId="test-2" />);
    });

    await waitFor(() =>
      expect(activateView.mock.calls.length).toBeGreaterThan(activationsAfterMount),
    );
    await waitFor(() =>
      expect(manager.attachRoute.mock.calls.length).toBeGreaterThan(attachesAfterMount),
    );
  });

  it("recovers via the same path when the manager throws in the stop race", async () => {
    const { rerender } = render(<AddonIframeRoute addonId="test-addon" routeId="test" />);
    await waitFor(() => expect(manager.updateRoute).toHaveBeenCalled());
    const activationsAfterMount = activateView.mock.calls.length;

    // hasRuntime still reports true (race), but the runtime dies between the
    // check and the call — the manager throws. Must not crash the tree.
    manager.updateRoute.mockImplementationOnce(() => {
      throw new Error("Addon 'test-addon' is not loaded");
    });
    await act(async () => {
      rerender(<AddonIframeRoute addonId="test-addon" routeId="test-2" />);
    });

    await waitFor(() =>
      expect(activateView.mock.calls.length).toBeGreaterThan(activationsAfterMount),
    );
  });

  it("re-activates when a reload publishes a new activation epoch", async () => {
    render(<AddonIframeRoute addonId="test-addon" routeId="test" />);
    await waitFor(() => expect(manager.updateRoute).toHaveBeenCalled());
    const activationsAfterMount = activateView.mock.calls.length;

    act(() => activationEpochStore.advance());

    await waitFor(() =>
      expect(activateView.mock.calls.length).toBeGreaterThan(activationsAfterMount),
    );
  });
});
