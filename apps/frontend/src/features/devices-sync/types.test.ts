import { describe, expect, it } from "vitest";
import { SyncError, SyncErrorCodes } from "./types";

describe("cloud domain denials", () => {
  it.each([
    ["API error (403): SUBSCRIPTION_REQUIRED: Subscription required", "SUBSCRIPTION_REQUIRED"],
    ["API error (403): PLAN_UPGRADE_REQUIRED: Upgrade", "PLAN_UPGRADE_REQUIRED"],
  ])("preserves %s ahead of generic status handling", (message, code) => {
    const error = SyncError.from(new Error(message));
    expect(error.code).toBe(code);
    expect(error.recoverable).toBe(false);
    expect(error.code).not.toBe(SyncErrorCodes.KEYS_ALREADY_INITIALIZED);
    expect(SyncError.isNoAccessToken(error)).toBe(false);
  });
});
