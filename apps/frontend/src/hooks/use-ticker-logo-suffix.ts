import { useMemo } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import * as adapters from "@/adapters";

const fallbackQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
    },
  },
});

export function useTickerLogoSuffixes(): Record<string, string> {
  let queryClient: QueryClient | undefined;
  try {
    queryClient = useQueryClient();
  } catch {
    queryClient = fallbackQueryClient;
  }

  const { data: exchanges = [] } = useQuery(
    {
      queryKey: ["exchanges"],
      queryFn: () =>
        typeof adapters.getExchanges === "function" ? adapters.getExchanges() : Promise.resolve([]),
      staleTime: Infinity,
    },
    queryClient,
  );

  return useMemo(() => {
    const map: Record<string, string> = {};
    for (const exchange of exchanges) {
      if (exchange.logoSuffix && exchange.mic) {
        const cleanSuffix = exchange.logoSuffix.trim().replace(/^\./, "").toUpperCase();
        if (cleanSuffix) {
          map[exchange.mic.trim().toUpperCase()] = cleanSuffix;
        }
      }
    }
    return map;
  }, [exchanges]);
}

export function useTickerLogoSuffix(exchangeMic?: string | null): string | undefined {
  const suffixMap = useTickerLogoSuffixes();
  if (!exchangeMic) return undefined;
  return suffixMap[exchangeMic.trim().toUpperCase()];
}
