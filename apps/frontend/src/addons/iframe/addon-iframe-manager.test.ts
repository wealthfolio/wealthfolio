import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters", () => ({
  loadAddonAsset: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/addons/addons-runtime-context", () => ({
  clearAddonRegistrations: vi.fn(),
  createAddonHostAPI: vi.fn(),
  registerAddonNavItem: vi.fn(),
  registerAddonRoute: vi.fn(),
  removeAddonNavItem: vi.fn(),
  removeAddonRoute: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { AddonIframeManager } from "./addon-iframe-manager";
import { resetAddonSandboxRuntimeAssetsForTest } from "./addon-sandbox-assets";
import { setAddonLocalizationSnapshot } from "./addon-sandbox-localization";
import { loadAddonAsset } from "@/adapters";

const input = {
  addonId: "test-addon",
  code: "export default () => undefined",
  manifest: { id: "test-addon", name: "Test Addon", version: "1.0.0" },
};

const CHANNEL = "wealthfolio:addon-sandbox:v1";

function getSandboxFrame(addonId = input.addonId) {
  const iframe = Array.from(document.querySelectorAll("iframe")).find(
    (candidate) => new URLSearchParams(candidate.name).get("addonId") === addonId,
  );
  if (!iframe?.contentWindow) {
    throw new Error(`Sandbox iframe for ${addonId} was not created`);
  }
  return iframe;
}

function getNonce(iframe: HTMLIFrameElement) {
  return new URLSearchParams(iframe.name).get("nonce") ?? "";
}

function dispatchFromSandbox(
  iframe: HTMLIFrameElement,
  type: string,
  payload: Record<string, unknown> = {},
  source: MessageEventSource | null = iframe.contentWindow,
) {
  const addonId = new URLSearchParams(iframe.name).get("addonId") ?? "";
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        addonId,
        channel: CHANNEL,
        nonce: getNonce(iframe),
        type,
        ...payload,
      },
      source,
    }),
  );
}

function successfulRuntimeFetch() {
  return vi.fn((request: RequestInfo | URL) => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    return Promise.resolve(
      new Response(url.endsWith(".js") ? "runtime" : "styles", { status: 200 }),
    );
  });
}

describe("AddonIframeManager", () => {
  beforeEach(() => {
    resetAddonSandboxRuntimeAssetsForTest();
  });

  afterEach(() => {
    setAddonLocalizationSnapshot({
      locale: navigator.language || "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    vi.useRealTimers();
    document.getElementById("addon-sandbox-parking")?.remove();
    vi.unstubAllGlobals();
  });

  it("rejects a stale boot before it can touch the current runtime", async () => {
    const manager = new AddonIframeManager();
    const isCurrent = vi.fn(() => false);

    await expect(manager.startAddon({ ...input, isCurrent })).rejects.toMatchObject({
      name: "AddonLoadCancelled",
    });
    expect(isCurrent).toHaveBeenCalledTimes(1);
  });

  it("passes host localization into the sandbox and broadcasts updates", async () => {
    setAddonLocalizationSnapshot({ locale: "ja-JP", uiLocale: "en", timezone: "Asia/Tokyo" });
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    const cancelled = expect(starting).rejects.toMatchObject({ name: "AddonLoadCancelled" });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    const iframe = getSandboxFrame();
    const bootstrap = new URLSearchParams(iframe.name);
    expect(bootstrap.get("locale")).toBe("ja-JP");
    expect(bootstrap.get("uiLocale")).toBe("en");
    expect(bootstrap.get("timezone")).toBe("Asia/Tokyo");

    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    setAddonLocalizationSnapshot({ locale: "ko-KR", uiLocale: "fr", timezone: "Asia/Seoul" });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        localization: { locale: "ko-KR", uiLocale: "fr", timezone: "Asia/Seoul" },
        type: "localizationUpdate",
      }),
      "*",
    );

    await manager.stopAllAddons();
    await cancelled;
  });

  it("allows a longer bootstrap window before applying the execution timeout", async () => {
    vi.useFakeTimers();
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    const rejection = expect(starting).rejects.toThrow(
      "Timed out loading addon 'test-addon' during loading sandbox document",
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(getSandboxFrame()).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(getSandboxFrame()).toBeDefined();

    await vi.advanceTimersByTimeAsync(19_999);
    await rejection;
  });

  it("starts the shorter execution timeout after the sandbox runtime is ready", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", successfulRuntimeFetch());
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    const rejection = expect(starting).rejects.toThrow(
      "Timed out loading addon 'test-addon' during host sent addon code",
    );
    await vi.advanceTimersByTimeAsync(0);
    const iframe = getSandboxFrame();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "bootstrapReady");
    await vi.advanceTimersByTimeAsync(0);
    dispatchFromSandbox(iframe, "ready", { runtimeProtocolVersion: 1 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("checks the generation again after awaiting runtime teardown", async () => {
    const manager = new AddonIframeManager();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    await expect(manager.startAddon({ ...input, isCurrent })).rejects.toMatchObject({
      name: "AddonLoadCancelled",
    });
    expect(isCurrent).toHaveBeenCalledTimes(2);
  });

  it("tracks visual viewport changes while iframe layout updates are active", () => {
    const visualViewport = new EventTarget();
    const addEventListener = vi.spyOn(visualViewport, "addEventListener");
    const removeEventListener = vi.spyOn(visualViewport, "removeEventListener");
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.stubGlobal("visualViewport", visualViewport);

    const manager = new AddonIframeManager();
    const internals = manager as unknown as {
      ensureLayoutListener: () => void;
      stopLayoutListenerIfIdle: () => void;
    };
    internals.ensureLayoutListener();

    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    visualViewport.dispatchEvent(new Event("resize"));
    expect(requestFrame).toHaveBeenCalledTimes(1);

    internals.stopLayoutListenerIfIdle();
    expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("hides stale warm content when the next route render fails", () => {
    const manager = new AddonIframeManager();
    const routeStatusListener = vi.fn();
    const iframeStyle = {
      height: "600px",
      pointerEvents: "auto",
      visibility: "visible",
      width: "800px",
    };
    const runtime = {
      activeRoute: {
        location: { hash: "", params: {}, pathname: "/addons/test-addon/next", search: "" },
        routeId: "next",
      },
      activeRouteRequestId: "request-1",
      addonId: "test-addon",
      iframe: { style: iframeStyle },
      lastRenderedRouteKey: "previous-route",
      routeStatusListeners: new Set([routeStatusListener]),
    };

    const internals = manager as unknown as {
      handleRouteRenderError: (runtime: unknown, message: unknown) => void;
    };
    internals.handleRouteRenderError(runtime, {
      error: "Route component failed",
      requestId: "request-1",
    });

    expect(runtime.lastRenderedRouteKey).toBeUndefined();
    expect(iframeStyle).toMatchObject({
      height: "0",
      pointerEvents: "none",
      visibility: "hidden",
      width: "0",
    });
    expect(routeStatusListener).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Route component failed", status: "error" }),
    );
  });

  it("loads runtime Blobs before sending addon code and requires protocol version 1", async () => {
    const fetchMock = successfulRuntimeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
    expect(iframe.getAttribute("src")).toBeNull();
    expect(iframe.srcdoc).toContain('id="addon-root"');
    expect(new URLSearchParams(iframe.name).get("hostBaseUrl")).toBeTruthy();

    dispatchFromSandbox(iframe, "bootstrapReady");
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          protocolVersion: 1,
          script: expect.any(Blob),
          stylesheet: expect.any(Blob),
          type: "loadRuntime",
        }),
        "*",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    dispatchFromSandbox(iframe, "ready", { runtimeProtocolVersion: 1 });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ code: input.code, type: "loadAddon" }),
        "*",
      ),
    );
    dispatchFromSandbox(iframe, "loaded");
    await expect(starting).resolves.toBeDefined();
    await manager.stopAllAddons();

    const postedTypes = postMessage.mock.calls.map(([message]) => message.type);
    expect(postedTypes.indexOf("loadRuntime")).toBeLessThan(postedTypes.indexOf("loadAddon"));
  });

  it("loads and disables a legacy 3.6 addon without packaged assets", async () => {
    vi.stubGlobal("fetch", successfulRuntimeFetch());
    const manager = new AddonIframeManager();
    const legacyInput = {
      ...input,
      manifest: {
        ...input.manifest,
        minWealthfolioVersion: "3.6.2",
        sdkVersion: "3.6.2",
      },
    };
    const starting = manager.startAddon(legacyInput);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "bootstrapReady");
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "loadRuntime" }),
        "*",
      ),
    );
    dispatchFromSandbox(iframe, "ready", { runtimeProtocolVersion: 1 });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ assets: [], code: input.code, type: "loadAddon" }),
        "*",
      ),
    );
    dispatchFromSandbox(iframe, "loaded");
    const handle = await starting;

    const disabling = handle.disable();
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "disable" }), "*"),
    );
    dispatchFromSandbox(iframe, "disabled");
    await disabling;
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("loads only registered packaged assets by opaque id", async () => {
    vi.stubGlobal("fetch", successfulRuntimeFetch());
    vi.mocked(loadAddonAsset).mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    const manager = new AddonIframeManager();
    const starting = manager.startAddon({
      ...input,
      assets: [
        {
          id: "opaque-asset-id",
          mimeType: "image/png",
          path: "assets/logo.png",
          size: 3,
        },
      ],
    });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "bootstrapReady");
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "loadRuntime" }),
        "*",
      ),
    );
    dispatchFromSandbox(iframe, "ready", { runtimeProtocolVersion: 1 });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: "opaque-asset-id" })],
          type: "loadAddon",
        }),
        "*",
      ),
    );
    dispatchFromSandbox(iframe, "loaded");
    await starting;

    dispatchFromSandbox(iframe, "addonAssetRequest", {
      assetId: "opaque-asset-id",
      requestId: "asset-request",
    });
    dispatchFromSandbox(iframe, "addonAssetRequest", {
      assetId: "opaque-asset-id",
      requestId: "second-asset-request",
    });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          requestId: "asset-request",
          result: expect.any(Blob),
          type: "rpcResponse",
        }),
        "*",
      ),
    );
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          requestId: "second-asset-request",
          result: expect.any(Blob),
          type: "rpcResponse",
        }),
        "*",
      ),
    );
    expect(loadAddonAsset).toHaveBeenCalledWith("test-addon", "opaque-asset-id", "image/png");

    dispatchFromSandbox(iframe, "addonAssetRequest", {
      assetId: "unregistered-id",
      requestId: "invalid-asset-request",
    });
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          requestId: "invalid-asset-request",
          type: "rpcResponse",
        }),
        "*",
      ),
    );
    expect(loadAddonAsset).toHaveBeenCalledTimes(1);
  });

  it("posts the same cached Blob instances to simultaneous addon frames", async () => {
    const fetchMock = successfulRuntimeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AddonIframeManager();
    const firstStart = manager.startAddon(input);
    const secondInput = {
      ...input,
      addonId: "second-addon",
      manifest: { ...input.manifest, id: "second-addon", name: "Second Addon" },
    };
    const secondStart = manager.startAddon(secondInput);
    await vi.waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(2));
    const firstFrame = getSandboxFrame();
    const secondFrame = getSandboxFrame(secondInput.addonId);
    const firstPost = vi
      .spyOn(firstFrame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const secondPost = vi
      .spyOn(secondFrame.contentWindow!, "postMessage")
      .mockImplementation(() => {});

    dispatchFromSandbox(firstFrame, "bootstrapReady");
    dispatchFromSandbox(secondFrame, "bootstrapReady");
    await vi.waitFor(() => {
      expect(firstPost).toHaveBeenCalledWith(expect.objectContaining({ type: "loadRuntime" }), "*");
      expect(secondPost).toHaveBeenCalledWith(
        expect.objectContaining({ type: "loadRuntime" }),
        "*",
      );
    });

    const firstPayload = firstPost.mock.calls.find(
      ([message]) => message.type === "loadRuntime",
    )?.[0];
    const secondPayload = secondPost.mock.calls.find(
      ([message]) => message.type === "loadRuntime",
    )?.[0];
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstPayload?.script).toBe(secondPayload?.script);
    expect(firstPayload?.stylesheet).toBe(secondPayload?.stylesheet);

    await manager.stopAllAddons();
    await expect(firstStart).rejects.toMatchObject({ name: "AddonLoadCancelled" });
    await expect(secondStart).rejects.toMatchObject({ name: "AddonLoadCancelled" });
  });

  it("rejects an incompatible runtime protocol and tears down the iframe", async () => {
    vi.stubGlobal("fetch", successfulRuntimeFetch());
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "bootstrapReady");
    await Promise.resolve();
    dispatchFromSandbox(iframe, "ready", { runtimeProtocolVersion: 2 });

    await expect(starting).rejects.toThrow("expected 1, received 2");
    await vi.waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  });

  it("ignores bootstrap messages with a wrong nonce or source", async () => {
    const fetchMock = successfulRuntimeFetch();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { addonId: input.addonId, channel: CHANNEL, nonce: "wrong", type: "bootstrapReady" },
        source: iframe.contentWindow,
      }),
    );
    dispatchFromSandbox(iframe, "bootstrapReady", {}, window);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    await manager.stopAllAddons();
    await expect(starting).rejects.toMatchObject({ name: "AddonLoadCancelled" });
  });

  it("fails immediately when the shared runtime is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "bootstrapReady");

    await expect(starting).rejects.toThrow("Sandbox runtime unavailable");
    await vi.waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  });

  it("surfaces phase-specific bootstrap errors and removes the runtime", async () => {
    const manager = new AddonIframeManager();
    const starting = manager.startAddon(input);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = getSandboxFrame();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

    dispatchFromSandbox(iframe, "loadError", {
      error: "Sandbox runtime stylesheet failed to load",
      phase: "loading runtime stylesheet",
    });

    await expect(starting).rejects.toThrow(
      "Sandbox failed during loading runtime stylesheet: Sandbox runtime stylesheet failed to load",
    );
    await vi.waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  });
});
