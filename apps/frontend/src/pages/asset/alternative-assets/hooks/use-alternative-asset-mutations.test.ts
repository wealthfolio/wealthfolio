import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { invalidateAlternativeAssetQueries } from "./use-alternative-asset-mutations";

describe("alternative asset query invalidation", () => {
  it("waits for holdings and metadata queries to finish refreshing", async () => {
    let resolveAlternativeHoldings: (() => void) | undefined;
    const alternativeHoldingsRefresh = new Promise<void>((resolve) => {
      resolveAlternativeHoldings = resolve;
    });
    const invalidateQueries = vi.fn(({ queryKey }: { queryKey: string[] }) =>
      queryKey[0] === QueryKeys.ALTERNATIVE_HOLDINGS
        ? alternativeHoldingsRefresh
        : Promise.resolve(),
    );
    const queryClient = { invalidateQueries } as unknown as QueryClient;

    let completed = false;
    const invalidation = invalidateAlternativeAssetQueries(queryClient).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    resolveAlternativeHoldings?.();
    await invalidation;
    expect(completed).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.ASSET_DATA],
    });
  });
});
