import type { NewAsset, SymbolSearchResult } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirectionProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import { CreateSecurityDialog } from "./create-security-dialog";

const results = vi.hoisted(() => {
  const common = {
    quoteType: "MUTUALFUND",
    quoteMode: "MARKET" as const,
    currency: "INR",
    index: "",
    score: 0,
    typeDisplay: "",
  };
  return {
    yahoo: {
      ...common,
      symbol: "0P0000YWL1.BO",
      canonicalSymbol: "0P0000YWL1",
      exchange: "BSE",
      exchangeMic: "XBOM",
      canonicalExchangeMic: "XBOM",
      shortName: "Parag Parikh Flexi Cap Dir Gr",
      longName: "Parag Parikh Flexi Cap Dir Gr",
      providerId: "YAHOO",
      providerSymbol: "0P0000YWL1.BO",
    },
    amfi: {
      ...common,
      symbol: "122639",
      canonicalSymbol: "122639",
      exchange: "AMFI",
      shortName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
      longName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
      providerId: "AMFI",
      providerSymbol: "122639",
    },
  } satisfies Record<string, SymbolSearchResult>;
});

vi.mock("@/adapters", () => ({
  getExchanges: vi.fn().mockResolvedValue([{ mic: "XBOM", longName: "BSE" }]),
  resolveSymbolQuote: vi.fn().mockResolvedValue({ currency: "INR" }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "INR" } }),
}));
vi.mock("@/components/ticker-search", () => ({
  default: ({
    onSelectResult,
  }: {
    onSelectResult: (symbol: string, result: SymbolSearchResult) => void;
  }) => (
    <>
      <button type="button" onClick={() => onSelectResult(results.yahoo.symbol, results.yahoo)}>
        Select Yahoo
      </button>
      <button type="button" onClick={() => onSelectResult(results.amfi.symbol, results.amfi)}>
        Select AMFI
      </button>
    </>
  ),
}));

describe.each(["ltr", "rtl"] as const)("CreateSecurityDialog (%s)", (direction) => {
  it.each([false, true])(
    "preserves the AMFI provider without an exchange (previous Yahoo selection: %s)",
    async (selectYahooFirst) => {
      const submit = vi.fn<(payload: NewAsset) => void>();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <DirectionProvider direction={direction}>
          <QueryClientProvider client={client}>
            <CreateSecurityDialog open onOpenChange={vi.fn()} onSubmit={submit} />
          </QueryClientProvider>
        </DirectionProvider>,
      );

      if (selectYahooFirst) {
        fireEvent.click(screen.getByRole("button", { name: "Select Yahoo" }));
        await waitFor(() => expect(screen.getByLabelText("Symbol")).toHaveValue("0P0000YWL1"));
      }
      fireEvent.click(screen.getByRole("button", { name: "Select AMFI" }));
      await waitFor(() => expect(screen.getByLabelText("Symbol")).toHaveValue("122639"));
      fireEvent.click(screen.getByRole("button", { name: "Create security" }));

      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(submit.mock.calls[0][0]).toMatchObject({
        instrumentSymbol: "122639",
        instrumentExchangeMic: undefined,
        providerId: "AMFI",
        providerSymbol: "122639",
        quoteCcy: "INR",
        quoteMode: "MARKET",
        name: results.amfi.longName,
      });
    },
  );
});
