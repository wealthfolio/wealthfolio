import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters", () => ({
  getWebPushPublicKey: vi.fn(() => Promise.resolve("BP")),
  subscribeWebPush: vi.fn(() => Promise.resolve()),
  unsubscribeWebPush: vi.fn(() => Promise.resolve()),
}));

import {
  base64UrlToBytes,
  getWebPushStatus,
  isWebPushSupported,
  toSubscriptionInput,
} from "./web-push";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64UrlToBytes", () => {
  it("decodes unpadded base64url, including the url-safe characters", () => {
    // 0xfb 0xff 0xbf encodes to "-_-_" in base64url and "+/+/" in base64.
    expect(Array.from(base64UrlToBytes("-_-_"))).toEqual([0xfb, 0xff, 0xbf]);
    expect(Array.from(base64UrlToBytes("AQ"))).toEqual([1]);
  });
});

describe("toSubscriptionInput", () => {
  it("keeps only the endpoint and the two keys the server needs", () => {
    const subscription = {
      toJSON: () => ({
        endpoint: "https://push.example.com/abc",
        expirationTime: null,
        keys: { p256dh: "P", auth: "A" },
      }),
    } as unknown as PushSubscription;
    expect(toSubscriptionInput(subscription)).toEqual({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "P", auth: "A" },
    });
  });

  it("refuses an incomplete subscription instead of registering a dead one", () => {
    const subscription = {
      toJSON: () => ({ endpoint: "https://push.example.com/abc", keys: {} }),
    } as unknown as PushSubscription;
    expect(() => toSubscriptionInput(subscription)).toThrow();
  });
});

describe("support detection", () => {
  it("reports unsupported outside a secure context, where push cannot work", async () => {
    vi.stubGlobal("isSecureContext", false);
    expect(isWebPushSupported()).toBe(false);
    await expect(getWebPushStatus()).resolves.toBe("unsupported");
  });
});
