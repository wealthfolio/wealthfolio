import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuoteImport } from "@/lib/types/quote-import";

import { useQuoteImport } from "./use-quote-import";

const adapterMocks = vi.hoisted(() => ({
  checkQuotesImport: vi.fn(),
  importManualQuotes: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);

const quote: QuoteImport = {
  symbol: "AAPL",
  date: "2026-01-02",
  close: 100,
  currency: "USD",
  validationStatus: "valid",
};

const renderQuoteImport = () => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useQuoteImport(), { wrapper });
  act(() => hook.result.current.setFile(new File(["month,quote\n"], "quotes.csv")));
  return hook;
};

describe("useQuoteImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      "Failed to check quotes import: Invalid input: Missing required columns: symbol, date, close",
      "Failed to check quotes import: Invalid input: Missing required columns: symbol, date, close",
    ],
    [new Error("Invalid date"), "Invalid date"],
    [{ message: "Permission denied" }, "Permission denied"],
    [{ code: 1 }, "Failed to validate CSV"],
    ["", "Failed to validate CSV"],
    ["   ", "Failed to validate CSV"],
    [new Error(""), "Failed to validate CSV"],
  ])("shows the backend validation error: %s", async (rejection, message) => {
    adapterMocks.checkQuotesImport.mockRejectedValue(rejection);
    const { result } = renderQuoteImport();

    await act(async () => {
      expect(await result.current.validateFile()).toBe(false);
    });

    expect(result.current.error).toBe(message);
  });

  it("shows the backend import error", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    adapterMocks.checkQuotesImport.mockResolvedValue([quote]);
    adapterMocks.importManualQuotes.mockRejectedValue(
      "Failed to import CSV quotes: Database error",
    );
    const { result } = renderQuoteImport();

    await act(async () => {
      await result.current.validateFile();
    });
    await act(async () => {
      expect(await result.current.importQuotes()).toBe(false);
    });

    expect(result.current.error).toBe("Failed to import CSV quotes: Database error");
    vi.clearAllTimers();
  });
});
