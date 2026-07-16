import { describe, expect, it } from "vitest";

import type { Quote } from "@/lib/types";
import { toQuoteEntry } from "./quote-history-utils";

describe("quote history edit state", () => {
  it("preserves OHLC precision", () => {
    const quote: Quote = {
      id: "20260711_asset",
      createdAt: "2026-07-11T00:00:00.000Z",
      dataSource: "CUSTOM_SCRAPER",
      timestamp: "2026-07-11T00:00:00.000Z",
      assetId: "asset",
      open: 1.4018,
      high: 1.40267,
      low: 1.39995,
      close: 1.4026,
      adjclose: 1.4026,
      volume: 0,
      currency: "CNY",
    };

    expect(toQuoteEntry(quote)).toMatchObject({
      open: 1.4018,
      high: 1.40267,
      low: 1.39995,
      close: 1.4026,
    });
  });
});
