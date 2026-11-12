import i18n from "i18next";
import { describe, expect, it } from "vitest";
import { BackendError } from "@/lib/backend-error";
import { cloudSubscriptionErrorMessage } from "./error-messages";

describe("cloud subscription messages", () => {
  it.each([
    ["SUBSCRIPTION_REQUIRED", "connect:subscription.syncPausedDescription"],
    ["PLAN_UPGRADE_REQUIRED", "connect:upgrade.title"],
  ])("reads the code both runtimes now send (%s)", (code, key) => {
    expect(cloudSubscriptionErrorMessage(new BackendError(code))).toBe(i18n.t(key));
  });

  it("keeps reading the code inside event text", () => {
    expect(cloudSubscriptionErrorMessage("API error 403: SUBSCRIPTION_CANCELED: required")).toBe(
      i18n.t("connect:subscription.syncPausedDescription"),
    );
    expect(cloudSubscriptionErrorMessage(new BackendError("internal_error"))).toBeNull();
  });
});
