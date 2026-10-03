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
