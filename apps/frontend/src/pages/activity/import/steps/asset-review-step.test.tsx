import type { ImportAssetPreviewItem, NewAsset } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import type { DraftActivity } from "../context";
import { buildImportAssetCandidateFromDraft } from "../utils/asset-review-utils";
import { AssetReviewStep } from "./asset-review-step";

const { createAsset, useImportContext } = vi.hoisted(() => ({
  createAsset: vi.fn(),
  useImportContext: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  createAsset,
  getExchanges: vi.fn().mockResolvedValue([{ mic: "XBOM", longName: "BSE" }]),
}));
vi.mock("../context", () => ({ useImportContext }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "INR" } }),
}));
vi.mock("@/components/ticker-search", () => ({ default: () => null }));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));

describe.each(["ltr", "rtl"] as const)("AssetReviewStep (%s)", (direction) => {
  it.each(["AUTO_RESOLVED_NEW_ASSET", "NEEDS_FIXING"] as const)(
    "keeps an automatically found fund's label in Manual mode (%s)",
    async (status) => {
      const dispatch = vi.fn();
      const row: DraftActivity = {
        rowIndex: 0,
        isEdited: false,
        rawRow: [],
        activityDate: "2026-01-01",
        activityType: "BUY",
        symbol: "122639",
        currency: "INR",
        accountId: "account-1",
        status: "valid",
        errors: {},
        warnings: {},
      };
      const candidate = buildImportAssetCandidateFromDraft(row)!;
      const fund: NewAsset = {
        kind: "INVESTMENT",
        name: "Example Corporate Bond Fund",
        displayCode: "122639",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "INR",
        instrumentType: "EQUITY",
        instrumentTypeLabel: "MUTUALFUND",
        instrumentSymbol: "122639",
        instrumentExchangeMic: status === "NEEDS_FIXING" ? undefined : "XBOM",
      };
      const preview: ImportAssetPreviewItem = {
        key: candidate.key,
        status,
        resolutionSource: status === "NEEDS_FIXING" ? "missing_exchange" : "provider_resolution",
        draft: fund,
      };
      useImportContext.mockReturnValue({
        dispatch,
        previewAssets: vi.fn(),
        state: {
          draftActivities: [row],
          assetPreviewItems: [preview],
          isPreviewingAssets: false,
          parseConfig: { defaultCurrency: "INR" },
        },
      });
      createAsset.mockReset().mockResolvedValue({ ...fund, id: "fund-1", quoteMode: "MANUAL" });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <DirectionProvider direction={direction}>
          <QueryClientProvider client={client}>
            <AssetReviewStep />
          </QueryClientProvider>
        </DirectionProvider>,
      );

      const needsFixing = status === "NEEDS_FIXING";
      fireEvent.click(
        screen.getByRole("button", { name: needsFixing ? "Create manually" : "Edit" }),
      );
      fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "122639" } });
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: fund.name } });
      if (!needsFixing) {
        const user = userEvent.setup();
        await user.click(screen.getByRole("combobox", { name: "Quote mode" }));
        await user.click(await screen.findByRole("option", { name: "Manual" }));
      }
      fireEvent.click(
        screen.getByRole("button", { name: needsFixing ? "Create Asset" : "Use Edited Asset" }),
      );

      const manualFund = {
        instrumentSymbol: "122639",
        instrumentType: "EQUITY",
        instrumentTypeLabel: "MUTUALFUND",
        quoteMode: "MANUAL",
      };
      if (needsFixing) {
        await waitFor(() =>
          expect(createAsset).toHaveBeenCalledWith(expect.objectContaining(manualFund)),
        );
      } else {
        await waitFor(() =>
          expect(dispatch).toHaveBeenCalledWith({
            type: "SET_PENDING_IMPORT_ASSET",
            payload: {
              key: candidate.key,
              source: "manual",
              draft: expect.objectContaining(manualFund),
            },
          }),
        );
      }
    },
  );
});
