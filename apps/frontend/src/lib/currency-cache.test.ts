import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { QueryKeys } from "./query-keys";
import {
  fetchWebCurrencySettings,
  isWebCurrencyCompletion,
  resetWebCurrencyQueries,
} from "./currency-cache";
import type { Settings } from "./types";

describe("web currency cache transition", () => {
  it("clears old amounts before a tab accepts changed settings after missing SSE", async () => {
    const client = new QueryClient();
    client.setQueryData([QueryKeys.SETTINGS], { baseCurrency: "CAD" });
    client.setQueryData([QueryKeys.PERFORMANCE_HISTORY, "portfolio:all"], { amount: 100 });
    const next = await fetchWebCurrencySettings(
      client,
      async () => ({ baseCurrency: "USD" }) as Settings,
    );
    expect(next.baseCurrency).toBe("USD");
    expect(client.getQueryData([QueryKeys.PERFORMANCE_HISTORY, "portfolio:all"])).toBeUndefined();
    client.clear();
  });

  it("recognizes only an explicit currency completion event", () => {
    expect(isWebCurrencyCompletion({ baseCurrencyChanged: true })).toBe(true);
    for (const payload of [
      null,
      {},
      { baseCurrencyChanged: false },
      { baseCurrencyChanged: "true" },
      { currencyChanged: true },
    ]) {
      expect(isWebCurrencyCompletion(payload)).toBe(false);
    }
  });

  it("installs the new currency before an active financial query refetches", async () => {
    const client = new QueryClient();
    const key = [QueryKeys.CURRENT_VALUATION, "portfolio:all"];
    client.setQueryData([QueryKeys.SETTINGS], { baseCurrency: "CAD" });
    client.setQueryData(key, { amount: 100 });
    const currenciesSeen: unknown[] = [];
    const observer = new QueryObserver(client, {
      queryKey: key,
      staleTime: Infinity,
      queryFn: async () => {
        currenciesSeen.push(client.getQueryData<Settings>([QueryKeys.SETTINGS])?.baseCurrency);
        return { amount: 500 };
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await resetWebCurrencyQueries(client, { baseCurrency: "CNY" } as Settings);
    expect(currenciesSeen).toEqual(["CNY"]);
    expect(client.getQueryData(key)).toEqual({ amount: 500 });
    unsubscribe();
    client.clear();
  });

  it("a cancelled old-currency request cannot replace the rebuilt result", async () => {
    const client = new QueryClient();
    const key = [QueryKeys.HOLDINGS, "portfolio:all"];
    client.setQueryData([QueryKeys.SETTINGS], { baseCurrency: "CAD" });
    let finishOld!: (value: { amount: number }) => void;
    const oldRequest = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<{ amount: number }>((resolve) => {
            finishOld = resolve;
          }),
      })
      .catch(() => undefined);
    await resetWebCurrencyQueries(client, { baseCurrency: "CNY" } as Settings);
    client.setQueryData(key, { amount: 500 });
    finishOld({ amount: 100 });
    await oldRequest;
    await Promise.resolve();
    expect(client.getQueryData(key)).toEqual({ amount: 500 });
    client.clear();
  });

  it("cancels and resets every financial cache family", async () => {
    const client = new QueryClient();
    const keys = [
      [QueryKeys.HOLDINGS, "portfolio:all"],
      [QueryKeys.NET_WORTH_HISTORY, "2025-01-01", "2025-01-02"],
      [QueryKeys.SPENDING_TRANSACTIONS],
      [QueryKeys.SNAPSHOT_HOLDINGS, "account:one", "2025-01-06"],
    ];
    keys.forEach((key) => client.setQueryData(key, { amount: 100, currency: "CAD" }));
    client.setQueryData([QueryKeys.SETTINGS], { baseCurrency: "CAD" });
    await resetWebCurrencyQueries(client);
    keys.forEach((key) => expect(client.getQueryData(key)).toBeUndefined());
    client.clear();
  });
});
