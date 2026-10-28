import { beforeEach, expect, it, vi } from "vitest";
const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    listeners.set(name, callback);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  listeners.clear();
});
it("drops queued data from an older scope, including after a local lock", async () => {
  const session = await import("@/features/profiles/session");
  session.installProfileSession({ profileId: "B", scopeId: "scope-b" });
  const { listenPortfolioUpdateError } = await import("./events");
  const handler = vi.fn();
  await listenPortfolioUpdateError(handler);
  const deliver = (scopeId: string) =>
    listeners.get("portfolio:update-error")!({
      event: "portfolio:update-error",
      payload: { scopeId, data: "private" },
      id: 1,
    });
  deliver("scope-a");
  expect(handler).not.toHaveBeenCalled();
  deliver("scope-b");
  expect(handler).toHaveBeenCalledWith({
    event: "portfolio:update-error",
    payload: "private",
    id: 1,
  });
  session.revokeProfileSession();
  deliver("scope-b");
  expect(handler).toHaveBeenCalledTimes(1);
});

it("delivers goal summary events only for the current profile scope", async () => {
  const session = await import("@/features/profiles/session");
  session.installProfileSession({ profileId: "B", scopeId: "scope-b" });
  const { listenGoalSummariesUpdated } = await import("./events");
  const handler = vi.fn();
  await listenGoalSummariesUpdated(handler);
  const deliver = (scopeId: string) =>
    listeners.get("goal:summaries-updated")!({
      event: "goal:summaries-updated",
      payload: { scopeId, data: ["goal-1"] },
      id: 1,
    });
  deliver("scope-a");
  expect(handler).not.toHaveBeenCalled();
  deliver("scope-b");
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: ["goal-1"] }));
  session.revokeProfileSession();
  deliver("scope-b");
  expect(handler).toHaveBeenCalledTimes(1);
});
