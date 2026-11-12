import type { NewAsset, SymbolSearchResult } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
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
  // The longest scheme name in AMFI's NAVAll.txt of 31 October 2026 (166 characters).
  const longAmfiName =
    "Sundaram Dynamic Asset Allocation Fund (Formerly Known as Sundaram Balanced Advantage Fund) - Regular Plan - Monthly IDCW (Income Distribution CUM Capital Withdrawal)";
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
    amfiLongName: {
      ...common,
      symbol: "149716",
      canonicalSymbol: "149716",
      exchange: "AMFI",
      shortName: longAmfiName,
      longName: longAmfiName,
      providerId: "AMFI",
      providerSymbol: "149716",
    },
    future: {
      ...common,
      symbol: "GC=F",
      exchange: "CMX",
      shortName: "Gold Future",
      longName: "Gold Future",
      quoteType: "FUTURE",
      providerId: "YAHOO",
      providerSymbol: "GC=F",
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
      <button type="button" onClick={() => onSelectResult(results.future.symbol, results.future)}>
        Select future
      </button>
      <button
        type="button"
        onClick={() => onSelectResult(results.amfiLongName.symbol, results.amfiLongName)}
      >
        Select long AMFI name
      </button>
    </>
  ),
}));

describe.each(["ltr", "rtl"] as const)("CreateSecurityDialog (%s)", (direction) => {
  const renderDialog = (initialAsset?: Partial<NewAsset>) => {
    const submit = vi.fn<(payload: NewAsset) => void>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <DirectionProvider direction={direction}>
        <QueryClientProvider client={client}>
          <CreateSecurityDialog
            open
            onOpenChange={vi.fn()}
            onSubmit={submit}
            initialAsset={initialAsset}
          />
        </QueryClientProvider>
      </DirectionProvider>,
    );
    return submit;
  };

  it.each([false, true])(
    "preserves the AMFI provider without an exchange (previous Yahoo selection: %s)",
    async (selectYahooFirst) => {
      const submit = renderDialog();

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
        instrumentTypeLabel: "MUTUALFUND",
      });
    },
  );

  const pendingFund: Partial<NewAsset> = {
    kind: "INVESTMENT",
    name: "Example Corporate Bond Fund",
    displayCode: "INFZ00000003",
    quoteMode: "MANUAL",
    quoteCcy: "INR",
    instrumentType: "EQUITY",
    instrumentTypeLabel: "MUTUALFUND",
    instrumentSymbol: "INFZ00000003",
  };

  it("keeps an edited fund's quote type while its identity is unchanged", async () => {
    const submit = renderDialog(pendingFund);

    fireEvent.click(screen.getByRole("button", { name: "Create security" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      quoteMode: "MANUAL",
      instrumentType: "EQUITY",
      instrumentTypeLabel: "MUTUALFUND",
    });
  });

  it("drops an edited fund's quote type once its symbol changes", async () => {
    const submit = renderDialog(pendingFund);

    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "OTHER" } });
    fireEvent.click(screen.getByRole("button", { name: "Create security" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({ instrumentSymbol: "OTHER" });
    expect(submit.mock.calls[0][0].instrumentTypeLabel).toBeUndefined();
  });

  it("drops an unmapped search quote type when the user chooses the instrument type", async () => {
    const user = userEvent.setup();
    const submit = renderDialog();

    await user.click(screen.getByRole("button", { name: "Select future" }));
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Bond" }));
    await user.click(screen.getByRole("button", { name: "Create security" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      instrumentType: "BOND",
      quoteMode: "MANUAL",
    });
    expect(submit.mock.calls[0][0].instrumentTypeLabel).toBeUndefined();
  });

  it("creates an AMFI fund with a 166-character name", async () => {
    const submit = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Select long AMFI name" }));
    await waitFor(() => expect(screen.getByLabelText("Symbol")).toHaveValue("149716"));
    fireEvent.click(screen.getByRole("button", { name: "Create security" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      instrumentSymbol: "149716",
      providerId: "AMFI",
      providerSymbol: "149716",
      name: results.amfiLongName.longName,
    });
  });

  it("rejects a name longer than 200 characters", async () => {
    const submit = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Select long AMFI name" }));
    await waitFor(() => expect(screen.getByLabelText("Symbol")).toHaveValue("149716"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x".repeat(201) } });
    fireEvent.click(screen.getByRole("button", { name: "Create security" }));

    expect(await screen.findByText("Name must be 200 characters or less")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
});
