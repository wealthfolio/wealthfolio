import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useTickerLogoSuffix, useTickerLogoSuffixes } from "./use-ticker-logo-suffix";
import * as adapters from "@/adapters";

vi.mock("@/adapters", () => ({
  getExchanges: vi.fn(),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return TestWrapper;
};

describe("useTickerLogoSuffix", () => {
  it("builds a mic to suffix map from exchange list", async () => {
    vi.mocked(adapters.getExchanges).mockResolvedValueOnce([
      {
        mic: "XPAR",
        name: "Euronext Paris",
        longName: "Euronext Paris",
        currency: "EUR",
        logoSuffix: ".PA",
      },
      { mic: "XNAS", name: "NASDAQ", longName: "NASDAQ", currency: "USD", logoSuffix: "" },
      {
        mic: "XTSE",
        name: "TSX",
        longName: "Toronto Stock Exchange",
        currency: "CAD",
        logoSuffix: "TO",
      },
    ]);

    const { result } = renderHook(() => useTickerLogoSuffixes(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        XPAR: "PA",
        XTSE: "TO",
      });
    });
  });

  it("returns the suffix for a specific exchangeMic", async () => {
    vi.mocked(adapters.getExchanges).mockResolvedValueOnce([
      {
        mic: "XPAR",
        name: "Euronext Paris",
        longName: "Euronext Paris",
        currency: "EUR",
        logoSuffix: ".PA",
      },
    ]);

    const { result } = renderHook(() => useTickerLogoSuffix("xpar"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toBe("PA");
    });
  });

  it("returns undefined for null, undefined, or unknown mic", async () => {
    vi.mocked(adapters.getExchanges).mockResolvedValueOnce([
      {
        mic: "XPAR",
        name: "Euronext Paris",
        longName: "Euronext Paris",
        currency: "EUR",
        logoSuffix: ".PA",
      },
    ]);

    const { result } = renderHook(() => useTickerLogoSuffix(undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current).toBeUndefined();
  });
});
