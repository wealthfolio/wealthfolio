import { describe, expect, it } from "vitest";

import { getAssetIdFromSearchResult } from "./asset-utils";

describe("getAssetIdFromSearchResult", () => {
  it("uses canonical symbol and MIC for search-result identity", () => {
    expect(
      getAssetIdFromSearchResult(
        {
          symbol: "SHOP.TO",
          canonicalSymbol: "SHOP",
          canonicalExchangeMic: "XTSE",
          exchange: "TOR",
          exchangeMic: "XTSE",
          currency: "CAD",
          shortName: "Shopify",
          longName: "Shopify Inc.",
          quoteType: "EQUITY",
          index: "quotes",
          score: 100,
          typeDisplay: "Equity",
        },
        "USD",
      ),
    ).toBe("SEC:SHOP:XTSE");
  });

  it("strips crypto quote suffix only for crypto identities", () => {
    expect(
      getAssetIdFromSearchResult(
        {
          symbol: "BTC-USD",
          exchange: "",
          currency: "USD",
          shortName: "Bitcoin USD",
          longName: "Bitcoin USD",
          quoteType: "CRYPTOCURRENCY",
          index: "quotes",
          score: 100,
          typeDisplay: "Crypto",
        },
        "USD",
      ),
    ).toBe("CRYPTO:BTC:USD");
  });
});
