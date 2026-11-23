import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetKind } from "@/lib/constants";
import type { Asset } from "@/lib/types";
import { getNoQuoteReasonText, isExpiredOptionAsset, toParsedAsset } from "./asset-utils";

const makeAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: "asset-1",
  kind: AssetKind.INVESTMENT,
  name: "Option",
  displayCode: "TSLA260426C00397500",
  quoteMode: "MARKET",
  quoteCcy: "USD",
  instrumentType: "OPTION",
  instrumentSymbol: "TSLA260426C00397500",
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isExpiredOptionAsset", () => {
  it("uses the configured timezone for the current date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T01:00:00Z"));

    const asset = makeAsset({
      metadata: {
        option: {
          expiration: "2026-04-26",
        },
      },
    });

    expect(isExpiredOptionAsset(asset, "America/Los_Angeles")).toBe(false);
    expect(isExpiredOptionAsset(asset, "UTC")).toBe(true);
  });

  it("falls back to the OCC symbol when metadata is missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));

    expect(isExpiredOptionAsset(makeAsset(), "UTC")).toBe(true);
  });

  it("ignores non-option assets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00Z"));

    expect(
      isExpiredOptionAsset(
        makeAsset({
          instrumentType: "EQUITY",
          metadata: {
            option: {
              expiration: "2026-04-26",
            },
          },
        }),
        "UTC",
      ),
    ).toBe(false);
  });
});

describe("getNoQuoteReasonText", () => {
  it.each(["LAST_ERROR", "FUTURE_REASON"])(
    "does not display saved diagnostic text for %s",
    (code) => {
      const text = getNoQuoteReasonText({
        quote: null,
        isStale: true,
        effectiveMarketDate: "2026-04-27",
        noQuoteReason: { code, message: "FAKE-KEY-2531 /private/portfolio.db" },
      });
      expect(text).not.toContain("FAKE-KEY");
      expect(text).not.toContain("/private");
    },
  );
  it("uses the backend reason when present", () => {
    expect(
      getNoQuoteReasonText({
        quote: null,
        isStale: true,
        effectiveMarketDate: "2026-04-27",
        quoteDate: null,
        noQuoteReason: {
          code: "TOO_MANY_ERRORS",
          message: "Sync paused after repeated errors",
        },
      }),
    ).toBe("Sync paused after repeated errors");
  });

  it("falls back to asset state when the snapshot has no reason", () => {
    expect(getNoQuoteReasonText(undefined, toParsedAsset(makeAsset({ quoteMode: "MANUAL" })))).toBe(
      "Quote mode is Manual",
    );
    expect(getNoQuoteReasonText(undefined, toParsedAsset(makeAsset({ isActive: false })))).toBe(
      "Asset is inactive",
    );
  });
});
