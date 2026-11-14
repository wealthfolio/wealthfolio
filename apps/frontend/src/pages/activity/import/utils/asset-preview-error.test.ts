import { describe, expect, it } from "vitest";
import { BackendError } from "@/lib/backend-error";
import { InvokeTimeoutError } from "../../../../adapters/invoke-timeout";
import { assetPreviewError } from "./asset-preview-error";

describe("asset preview error feedback", () => {
  it.each([
    [new InvokeTimeoutError("preview_import_assets"), "timeout"],
    [new DOMException("Private URL", "TimeoutError"), "timeout"],
    [new DOMException("Private URL", "NetworkError"), "network"],
    [new BackendError("provider_unavailable"), "provider"],
    [new Error("secret=FAKE-KEY /private/portfolio.db"), "failed"],
    [new TypeError("A programming error is not proof of a network failure"), "failed"],
    ["private backend error", "failed"],
  ])("classifies safe categories without retaining messages (%s)", (error, kind) => {
    expect(assetPreviewError(error)).toEqual({ kind });
  });

  it.each([
    [408, "timeout"],
    [504, "timeout"],
    [413, "too_large"],
    [500, "failed"],
  ])("preserves HTTP %s as safe diagnostic metadata", (httpStatus, kind) => {
    expect(
      assetPreviewError(Object.assign(new BackendError("internal_error"), { httpStatus })),
    ).toEqual({ kind, httpStatus });
  });
});
