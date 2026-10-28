import { expect, it, vi } from "vitest";

vi.mock("./core", () => ({ logger: { warn: vi.fn() }, EVENTS_ENDPOINT: "/api/v1/events/stream" }));
vi.mock("@/features/profiles/session", () => ({
  profileScope: () => "scope",
  matchesProfileScope: () => true,
}));

it("announces recovery after an interrupted event stream, without announcing the initial connection", async () => {
  const sources: FakeEventSource[] = [];
  class FakeEventSource {
    onerror?: (event: Event) => void;
    onopen?: () => void;
    constructor() {
      sources.push(this);
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  const reconnected = vi.fn();
  window.addEventListener("wealthfolio:event-stream-reconnected", reconnected);
  vi.stubGlobal("EventSource", FakeEventSource);
  try {
    const { listenPortfolioUpdateStart } = await import("./events");
    const unlisten = await listenPortfolioUpdateStart(() => {});
    const source = sources[0];
    source.onopen?.();
    expect(reconnected).not.toHaveBeenCalled();
    source.onerror?.(new Event("error"));
    source.onopen?.();
    expect(reconnected).toHaveBeenCalledOnce();
    source.onopen?.();
    expect(reconnected).toHaveBeenCalledOnce();
    await unlisten();
  } finally {
    window.removeEventListener("wealthfolio:event-stream-reconnected", reconnected);
    vi.unstubAllGlobals();
  }
});

it("forwards goal summary IDs through the existing SSE bridge", async () => {
  const listeners = new Map<string, EventListener>();
  class FakeEventSource {
    addEventListener(name: string, handler: EventListener) {
      listeners.set(name, handler);
    }
    removeEventListener(name: string) {
      listeners.delete(name);
    }
    close() {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  try {
    const { listenGoalSummariesUpdated } = await import("./events");
    const handler = vi.fn();
    const unlisten = await listenGoalSummariesUpdated(handler);
    listeners.get("goal:summaries-updated")!(
      new MessageEvent("goal:summaries-updated", { data: '["goal-1"]' }),
    );
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: ["goal-1"] }));
    await unlisten();
  } finally {
    vi.unstubAllGlobals();
  }
});
