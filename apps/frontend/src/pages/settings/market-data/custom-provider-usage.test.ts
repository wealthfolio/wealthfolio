import { describe, expect, it } from "vitest";

import type { Asset } from "@/lib/types";
import type { CustomProviderWithSources } from "@/lib/types/custom-provider";

import {
  assetUsageLabel,
  getCustomProviderUsage,
  hasIdentityPlaceholder,
  servesAsFallback,
} from "./custom-provider-usage";

function asset(overrides: Partial<Asset>): Asset {
  return {
    id: "asset",
    kind: "INVESTMENT",
    quoteMode: "MARKET",
    quoteCcy: "USD",
    ...overrides,
  } as Asset;
}

function provider(useAsFallback: boolean, url: string): CustomProviderWithSources {
  return {
    id: "fund",
    name: "Fund",
    description: "",
    enabled: true,
    priority: 50,
    useAsFallback,
    sources: [
      { id: "fund:latest", providerId: "fund", kind: "latest", format: "json", url, pricePath: "" },
    ],
  };
}

describe("hasIdentityPlaceholder", () => {
  it("matches the backend's identity placeholder rule", () => {
    expect(hasIdentityPlaceholder({ url: "https://x.test/{SYMBOL}" })).toBe(true);
    expect(hasIdentityPlaceholder({ url: "https://x.test/{ISIN}" })).toBe(true);
    expect(hasIdentityPlaceholder({ url: "https://x.test/nav?fund=abc" })).toBe(false);
    expect(
      hasIdentityPlaceholder({ url: "https://x.test", method: "POST", body: '{"isin":"{ISIN}"}' }),
    ).toBe(true);
    // A GET request never sends its body template.
    expect(
      hasIdentityPlaceholder({ url: "https://x.test", method: "GET", body: '{"isin":"{ISIN}"}' }),
    ).toBe(false);
  });
});

describe("servesAsFallback", () => {
  it("needs both the setting and an identity placeholder", () => {
    expect(servesAsFallback(provider(true, "https://x.test/{SYMBOL}"))).toBe(true);
    expect(servesAsFallback(provider(false, "https://x.test/{SYMBOL}"))).toBe(false);
    expect(servesAsFallback(provider(true, "https://x.test/nav?fund=abc"))).toBe(false);
  });
});

describe("getCustomProviderUsage", () => {
  it("splits assigned securities from mapping-only ones, as the delete check counts them", () => {
    const assets = [
      asset({
        id: "b",
        displayCode: "FUNDB",
        providerConfig: { preferred_provider: "CUSTOM_SCRAPER", custom_provider_code: "fund" },
      }),
      asset({
        id: "a",
        displayCode: "FUNDA",
        providerConfig: { preferred_provider: "CUSTOM_SCRAPER", custom_provider_code: "fund" },
      }),
      asset({
        id: "mapped",
        displayCode: "AAPL",
        providerConfig: {
          preferred_provider: "YAHOO",
          overrides: { "CUSTOM:fund": { type: "equity_symbol", symbol: "apple" } },
        },
      }),
      asset({
        id: "other",
        providerConfig: { preferred_provider: "CUSTOM_SCRAPER", custom_provider_code: "other" },
      }),
      asset({ id: "plain", providerConfig: null }),
    ];

    const usage = getCustomProviderUsage(assets, "fund");

    expect(usage.assigned.map((a) => a.id)).toEqual(["a", "b"]);
    expect(usage.mappedOnly.map((a) => a.id)).toEqual(["mapped"]);
  });

  it("labels exchange rates as currency pairs", () => {
    expect(assetUsageLabel(asset({ kind: "FX", instrumentSymbol: "EUR", quoteCcy: "USD" }))).toBe(
      "EUR/USD",
    );
    expect(assetUsageLabel(asset({ id: "x", displayCode: "VWRL" }))).toBe("VWRL");
  });
});
