import type { User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { hasVerifiedTotpFactor, isMfaCodeRejected, isMfaRequiredError } from "./mfa";

describe("two-factor helpers", () => {
  it.each([
    [new Error("Unexpected error: API error 403: MFA_REQUIRED: Enter a code (requestId=x)"), true],
    ["API error (403): MFA_REQUIRED: Enter a code", true],
    [new Error("API error 403: SUBSCRIPTION_CANCELED: Denied"), false],
    [new Error("API error 403: NOT_MFA_REQUIRED_X"), false],
    [null, false],
    [{ code: "MFA_REQUIRED" }, false],
  ])("detects the cloud API's MFA denial: %s", (error, expected) => {
    expect(isMfaRequiredError(error)).toBe(expected);
  });

  it.each([
    [{ code: "mfa_verification_failed" }, true],
    [{ code: "mfa_challenge_expired" }, true],
    [{ code: "over_request_rate_limit" }, false],
    [new Error("network"), false],
    [undefined, false],
  ])("tells a rejected code from other failures: %s", (error, expected) => {
    expect(isMfaCodeRejected(error)).toBe(expected);
  });

  it("counts only verified authenticator apps", () => {
    const user = (factors: User["factors"]) => ({ factors }) as User;
    const factor = (status: "verified" | "unverified", type: "totp" | "phone" = "totp") => ({
      id: `${type}-${status}`,
      factor_type: type,
      status,
      created_at: "",
      updated_at: "",
    });
    expect(hasVerifiedTotpFactor(user([factor("verified")]))).toBe(true);
    expect(hasVerifiedTotpFactor(user([factor("unverified")]))).toBe(false);
    expect(hasVerifiedTotpFactor(user([factor("verified", "phone")]))).toBe(false);
    expect(hasVerifiedTotpFactor(user(undefined))).toBe(false);
    expect(hasVerifiedTotpFactor(null)).toBe(false);
  });
});
