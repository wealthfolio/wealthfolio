import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAggregatedSyncStatus } from "./use-aggregated-sync-status";

const context = vi.hoisted(() => ({
  isConnected: true,
  isEnabled: true,
  userInfo: null as unknown,
}));
vi.mock("../providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => context,
}));
vi.mock("./use-sync-states", () => ({
  useSyncStates: () => ({ data: [], isLoading: false }),
}));
afterEach(() => {
  cleanup();
  context.isConnected = true;
  context.isEnabled = true;
  context.userInfo = null;
});

describe("subscription navigation status", () => {
  it.each([null, "canceled", "unpaid", "paused", "unknown"])(
    "distinguishes signed-in status %s from signed out",
    (status) => {
      context.userInfo = { team: { subscription_status: status } };
      const { result } = renderHook(useAggregatedSyncStatus);
      expect(result.current.status).toBe("subscription_required");
    },
  );

  it("shows subscription required when the account has no team", () => {
    context.userInfo = { team: null };
    const { result } = renderHook(useAggregatedSyncStatus);
    expect(result.current.status).toBe("subscription_required");
  });

  it.each(["active", "trialing", "past_due"])("preserves active status %s", (status) => {
    context.userInfo = { team: { subscription_status: status, plan: "basic" } };
    const { result } = renderHook(useAggregatedSyncStatus);
    expect(result.current.status).toBe("idle");
  });

  it("does not infer an inactive subscription before user info is available", () => {
    const { result } = renderHook(useAggregatedSyncStatus);
    expect(result.current.status).toBe("not_connected");
  });

  it.each(["isConnected", "isEnabled"] as const)(
    "keeps disconnected status when %s is false",
    (key) => {
      context[key] = false;
      context.userInfo = { team: { subscription_status: null } };
      const { result } = renderHook(useAggregatedSyncStatus);
      expect(result.current.status).toBe("not_connected");
    },
  );
});
