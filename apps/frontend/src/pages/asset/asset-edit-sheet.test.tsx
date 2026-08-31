import { fireEvent, render, screen, waitFor } from "@/test/render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset } from "@/lib/types";
import { AssetEditSheet } from "./asset-edit-sheet";

const mutateAsync = vi.fn();

function setInputValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

// The Sheet renders through a portal; swap it for plain markup so queries work.
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/adapters", () => ({
  getExchanges: vi.fn().mockResolvedValue([]),
  resolveSymbolQuote: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({ useCustomProviders: () => ({ data: [] }) }));
vi.mock("@/hooks/use-market-data-providers", () => ({
  useMarketDataProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomies: () => ({ data: [], isLoading: false }),
}));
vi.mock("./hooks/use-asset-profile-mutations", () => ({
  useAssetProfileMutations: () => ({
    updateAssetProfileMutation: { mutateAsync, isPending: false },
  }),
}));

const completeOption = {
  underlyingAssetId: "AAPL",
  expiration: "2026-12-18",
  right: "CALL",
  strike: 200,
  multiplier: 100,
};

function buildAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    kind: "INVESTMENT",
    name: "Test Asset",
    displayCode: "TEST",
    notes: "",
    isActive: true,
    quoteMode: "MARKET",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
    metadata: {},
    ...overrides,
  } as Asset;
}

function renderSheet(asset: Asset) {
  return render(<AssetEditSheet asset={asset} open onOpenChange={vi.fn()} />);
}

async function saveAndGetMetadata(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  return mutateAsync.mock.calls.at(-1)![0].metadata as Record<string, unknown>;
}

describe("AssetEditSheet contract multiplier", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
  });

  it("shows the field for an EQUITY asset, covering futures and CFDs", () => {
    renderSheet(buildAsset());
    expect(screen.getByTestId("asset-contract-multiplier")).toBeInTheDocument();
  });

  it("shows the default as a placeholder, not a value, when nothing is stored", () => {
    // Holding only an explicit override means an untouched field cannot pin a
    // stale value across an instrument-type change, and the placeholder always
    // matches the current type's default rather than contradicting the hint.
    renderSheet(buildAsset({ instrumentType: "OPTION" }));

    const input = screen.getByTestId("asset-contract-multiplier");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "100");
  });

  it("seeds an explicitly stored override", () => {
    renderSheet(buildAsset({ metadata: { contractMultiplier: 50 } }));
    expect(screen.getByTestId("asset-contract-multiplier")).toHaveValue("50");
  });

  it("writes a CFD multiplier to the top-level key", async () => {
    renderSheet(buildAsset());
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "50");

    expect(await saveAndGetMetadata()).toMatchObject({ contractMultiplier: 50 });
  });

  it("removes the top-level key when reset to the non-option default", async () => {
    renderSheet(buildAsset({ metadata: { contractMultiplier: 50 } }));
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "1");

    expect(await saveAndGetMetadata()).not.toHaveProperty("contractMultiplier");
  });

  it("keeps a complete OptionSpec deserializable when reset to 100", async () => {
    renderSheet(
      buildAsset({
        instrumentType: "OPTION",
        metadata: { option: { ...completeOption, multiplier: 10 } },
      }),
    );
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "100");

    // Dropping `multiplier` would make the whole spec fail to parse in Rust,
    // breaking resolution, option display and expiry handling.
    expect((await saveAndGetMetadata()).option).toMatchObject({
      ...completeOption,
      multiplier: 100,
    });
  });

  it("writes top-level when the option spec is partial", async () => {
    renderSheet(
      buildAsset({ instrumentType: "OPTION", metadata: { option: { multiplier: 100 } } }),
    );
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "10");

    expect(await saveAndGetMetadata()).toMatchObject({ contractMultiplier: 10 });
  });

  it("preserves sibling metadata namespaces", async () => {
    renderSheet(
      buildAsset({
        metadata: {
          identifiers: { isin: "US0378331005" },
          bond: { couponRate: 0.04375 },
          profile: { marketCap: 1 },
        },
      }),
    );
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "5");

    const metadata = await saveAndGetMetadata();
    expect(metadata.bond).toEqual({ couponRate: 0.04375 });
    expect(metadata.profile).toEqual({ marketCap: 1 });
    expect(metadata.identifiers).toMatchObject({ isin: "US0378331005" });
  });

  it("leaves metadata alone when the multiplier is never touched", async () => {
    // The field is seeded from the asset's original instrument type. Writing an
    // untouched value would pin an override the user never chose — retyping an
    // equity to an option would persist 1 instead of the option default of 100.
    renderSheet(buildAsset({ metadata: { identifiers: { isin: "US0378331005" } } }));

    const metadata = await saveAndGetMetadata();
    expect(metadata).not.toHaveProperty("contractMultiplier");
    expect(metadata.identifiers).toMatchObject({ isin: "US0378331005" });
  });

  it("preserves a stored multiplier across an unrelated save", async () => {
    renderSheet(buildAsset({ metadata: { contractMultiplier: 50 } }));
    expect(await saveAndGetMetadata()).toMatchObject({ contractMultiplier: 50 });
  });

  it("saves with the multiplier left empty", async () => {
    renderSheet(buildAsset());
    setInputValue(screen.getByTestId("asset-contract-multiplier"), "");

    // A blocking validation error here would also break the Market Data tab,
    // which submits this same form with no visible FormMessage.
    expect(await saveAndGetMetadata()).not.toHaveProperty("contractMultiplier");
  });
});

describe("AssetEditSheet bond spec", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
  });

  it("shows bond fields only for bonds", () => {
    renderSheet(buildAsset({ instrumentType: "EQUITY" }));
    expect(screen.queryByTestId("asset-coupon-rate")).not.toBeInTheDocument();
  });

  it("seeds the coupon rate as a percent", () => {
    renderSheet(
      buildAsset({ instrumentType: "BOND", metadata: { bond: { couponRate: 0.04375 } } }),
    );
    expect(screen.getByTestId("asset-coupon-rate")).toHaveValue("4.375");
  });

  it("stores the coupon rate back as a fraction", async () => {
    renderSheet(buildAsset({ instrumentType: "BOND" }));
    setInputValue(screen.getByTestId("asset-coupon-rate"), "2.5");

    const bond = (await saveAndGetMetadata()).bond as Record<string, unknown>;
    expect(bond.couponRate).toBeCloseTo(0.025, 10);
  });

  it("saves a zero-coupon bond", async () => {
    renderSheet(buildAsset({ instrumentType: "BOND" }));
    setInputValue(screen.getByTestId("asset-coupon-rate"), "0");

    // `.positive()` here would reject T-bills and, because the Market Data tab
    // shares this form, break that save with no visible error.
    const bond = (await saveAndGetMetadata()).bond as Record<string, unknown>;
    expect(bond.couponRate).toBe(0);
  });

  it("preserves faceValue, which the UI does not manage", async () => {
    renderSheet(buildAsset({ instrumentType: "BOND", metadata: { bond: { faceValue: 100 } } }));
    setInputValue(screen.getByTestId("asset-coupon-rate"), "1");

    expect((await saveAndGetMetadata()).bond).toMatchObject({ faceValue: 100 });
  });
});
