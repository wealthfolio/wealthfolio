import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { QueryKeys } from "./query-keys";
import {
  shouldInvalidateAfterPortfolioUpdate,
  invalidateAfterGoalSummariesUpdated,
} from "./query-invalidation";

it("refreshes plans and funding only when inputs changed, not on portfolio-only updates", () => {
  const client = new QueryClient();
  const keys = [QueryKeys.goalPlan("goal"), QueryKeys.goalFunding("goal")];
  for (const key of keys) client.setQueryData(key, {});
  invalidateAfterGoalSummariesUpdated(client, { goalIds: ["goal"], inputsChanged: false });
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  invalidateAfterGoalSummariesUpdated(client, { goalIds: ["goal"], inputsChanged: true });
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.clear();
});

it("refreshes the retirement goal when a savings goal's summary changes", () => {
  const client = new QueryClient();
  const keys = [QueryKeys.goal("fire"), QueryKeys.retirementOverview("fire")];
  for (const key of keys) client.setQueryData(key, {});
  invalidateAfterGoalSummariesUpdated(client, { goalIds: ["house"], inputsChanged: true });
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.clear();
});

describe("device sync settings refresh", () => {
  it("refetches settings after the portfolio update triggered by a device sync pull", () => {
    expect(shouldInvalidateAfterPortfolioUpdate([QueryKeys.SETTINGS])).toBe(true);
    expect(shouldInvalidateAfterPortfolioUpdate([QueryKeys.BROKER_CONNECTIONS])).toBe(false);
    expect(shouldInvalidateAfterPortfolioUpdate(["sync", "status"])).toBe(false);
  });
});
