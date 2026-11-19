import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportAssetCandidate, ImportAssetPreviewItem } from "@/lib/types";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";
import {
  applyAssetResolution,
  canProceedFromAssetReviewStep,
  getImportAssetCandidates,
} from "../utils/asset-review-utils";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), check: vi.fn() }));
vi.mock("@/adapters", () => ({
  previewImportAssets: mocks.preview,
  checkActivitiesImport: mocks.check,
  logger: { error: vi.fn() },
}));

function draft(index: number): DraftActivity {
  return {
    rowIndex: index,
    rawRow: [],
    activityDate: "2026-01-01",
    activityType: "BUY",
    symbol: `ASSET${index}`,
    currency: "USD",
    currencySource: "csv",
    accountId: "account-1",
    quantity: "1",
    unitPrice: "10",
    status: "valid",
    isEdited: false,
    errors: {},
    warnings: {},
  };
}

function previews(candidates: ImportAssetCandidate[]): ImportAssetPreviewItem[] {
  return candidates.map((candidate) => ({
    key: candidate.key,
    status: "AUTO_RESOLVED_NEW_ASSET",
    resolutionSource: "provider_resolution",
    draft: {
      kind: "INVESTMENT",
      name: candidate.symbol,
      displayCode: candidate.symbol,
      instrumentSymbol: candidate.symbol,
      instrumentType: candidate.instrumentType?.trim().toUpperCase() || "EQUITY",
      instrumentExchangeMic: "XNAS",
      quoteCcy: "USD",
      quoteMode: "MARKET",
      isActive: true,
    },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(drafts = Array.from({ length: 12 }, (_, index) => draft(index))) {
  let value!: ReturnType<typeof useImportContext>;
  function Probe() {
    value = useImportContext();
    return null;
  }
  const rendered = render(
    <ImportProvider>
      <Probe />
    </ImportProvider>,
  );
  act(() => {
    value.dispatch({ type: "SET_STEP", payload: "assets" });
    value.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: drafts });
  });
  return { context: () => value, ...rendered };
}

beforeEach(() => vi.resetAllMocks());

describe("bond identity context", () => {
  const ca = "CA135087D275";
  const us = "US135087D279";
  // Both valid ISINs have CUSIP 135087D27. The Rust alias resolver must see
  // both claims together to refuse linking them to the same legacy CUSIP asset.
  function bondDrafts() {
    const drafts = Array.from({ length: 6 }, (_, index) => draft(index));
    drafts[0] = { ...drafts[0], symbol: ca, instrumentType: "BOND" };
    drafts[5] = { ...drafts[5], symbol: us, instrumentType: "BOND" };
    return drafts;
  }

  it("keeps bond claims across the five-item boundary in one request", async () => {
    mocks.preview.mockImplementation(async ({ candidates }) => previews(candidates));
    const { context } = setup(bondDrafts());
    await act(async () => context().previewAssets(context().state.draftActivities));
    const bondBatches = mocks.preview.mock.calls
      .map(([args]) => args.candidates as ImportAssetCandidate[])
      .filter((batch) => batch.some((c) => c.instrumentType === "BOND"));
    expect(bondBatches.map((batch) => batch.map((c) => c.symbol))).toEqual([[ca, us]]);
    expect(context().state.assetPreviewProgress).toMatchObject({ completed: 6, total: 6 });
  });

  it("keeps more than five bonds together instead of splitting their identity context", async () => {
    const drafts = Array.from({ length: 7 }, (_, index) => ({
      ...draft(index),
      instrumentType: "BOND",
    }));
    mocks.preview.mockImplementation(async ({ candidates }) => previews(candidates));
    const { context } = setup(drafts);
    await act(async () => context().previewAssets(context().state.draftActivities));
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview.mock.calls[0][0].candidates).toHaveLength(7);
  });

  it("includes reviewed bonds as retry context without replacing a manual match", async () => {
    const { context } = setup(bondDrafts());
    const [candidate] = getImportAssetCandidates(context().state.draftActivities);
    const [retained] = previews([candidate]);
    const manual = { ...retained.draft!, name: "Reviewed bond", quoteMode: "MANUAL" };
    act(() => {
      context().dispatch({
        type: "SET_DRAFT_ACTIVITIES",
        payload: applyAssetResolution(context().state.draftActivities, retained.key, manual, {
          importAssetKey: retained.key,
        }),
      });
      context().dispatch({
        type: "SET_ASSET_PREVIEW_ITEMS",
        payload: [{ ...retained, draft: manual, resolutionSource: "manual_edit" }],
      });
      context().dispatch({
        type: "SET_PENDING_IMPORT_ASSET",
        payload: { key: retained.key, draft: manual, source: "manual" },
      });
    });
    mocks.preview.mockImplementation(async ({ candidates }) => previews(candidates));
    await act(async () =>
      context().previewAssets(context().state.draftActivities, { retry: true }),
    );
    const bondBatches = mocks.preview.mock.calls
      .map(([args]) => args.candidates as ImportAssetCandidate[])
      .filter((batch) => batch.some((c) => c.instrumentType === "BOND"));
    expect(bondBatches.map((batch) => batch.map((c) => c.symbol))).toEqual([[ca, us]]);
    expect(context().state.pendingImportAssets[retained.key]).toEqual({
      key: retained.key,
      draft: manual,
      source: "manual",
    });
    expect(context().state.draftActivities[0]).toMatchObject({
      symbolName: "Reviewed bond",
      quoteMode: "MANUAL",
    });
    expect(context().state.assetPreviewProgress).toMatchObject({ completed: 6, total: 6 });
  });
});

describe("batched asset preview", () => {
  it("publishes real progress sequentially, preserves edits on retry, then validates the same drafts", async () => {
    const first = deferred<ImportAssetPreviewItem[]>();
    const second = deferred<ImportAssetPreviewItem[]>();
    mocks.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { context } = setup();
    const initialRevision = context().state.draftRevision;
    let run!: Promise<void>;
    act(() => {
      run = context().previewAssets(context().state.draftActivities);
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview.mock.calls[0][0].candidates).toHaveLength(5);
    await act(async () => first.resolve(previews(mocks.preview.mock.calls[0][0].candidates)));
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(context().state.assetPreviewProgress).toMatchObject({ completed: 5, total: 12 });
    expect(context().state.draftRevision).toBe(initialRevision);
    expect(context().state.isPreviewingAssets).toBe(true);
    expect(
      canProceedFromAssetReviewStep({
        ...context().state,
        isHoldingsMode: false,
        parsedRowCount: 12,
      }),
    ).toBe(false);

    await act(async () => {
      second.reject(new DOMException("Private diagnostic", "TimeoutError"));
      await run;
    });
    expect(context().state.assetPreviewError).toEqual({ kind: "timeout" });
    expect(context().state.isPreviewingAssets).toBe(false);
    expect(Object.keys(context().state.pendingImportAssets)).toHaveLength(5);

    const item = context().state.assetPreviewItems[0];
    const editedAsset = { ...item.draft!, name: "My reviewed name", quoteMode: "MANUAL" };
    act(() => {
      context().dispatch({
        type: "SET_PENDING_IMPORT_ASSET",
        payload: { key: item.key, draft: editedAsset, source: "manual" },
      });
      context().dispatch({
        type: "SET_ASSET_PREVIEW_ITEMS",
        payload: context().state.assetPreviewItems.map((p) =>
          p.key === item.key ? { ...p, draft: editedAsset } : p,
        ),
      });
      context().dispatch({
        type: "SET_DRAFT_ACTIVITIES",
        payload: context().state.draftActivities.map((d, i) =>
          i === 0 ? { ...d, symbolName: editedAsset.name, quoteMode: "MANUAL" } : d,
        ),
      });
    });
    mocks.preview.mockImplementation(async ({ candidates }) => previews(candidates));
    await act(async () =>
      context().previewAssets(context().state.draftActivities, { retry: true }),
    );
    expect(mocks.preview.mock.calls.slice(2).map(([args]) => args.candidates.length)).toEqual([
      5, 2,
    ]);
    expect(
      mocks.preview.mock.calls
        .slice(2)
        .flatMap(([args]) => args.candidates.map((c: ImportAssetCandidate) => c.symbol)),
    ).toEqual(Array.from({ length: 7 }, (_, i) => `ASSET${i + 5}`));
    expect(context().state.assetPreviewProgress).toMatchObject({ completed: 12, total: 12 });
    expect(context().state.pendingImportAssets[item.key]).toEqual({
      key: item.key,
      draft: editedAsset,
      source: "manual",
    });
    expect(context().state.draftActivities[0]).toMatchObject({
      symbolName: "My reviewed name",
      quoteMode: "MANUAL",
    });
    expect(
      canProceedFromAssetReviewStep({
        ...context().state,
        isHoldingsMode: false,
        parsedRowCount: 12,
      }),
    ).toBe(true);

    mocks.check.mockImplementation(async ({ activities }) =>
      activities.map((activity: object) => ({ ...activity, isValid: true })),
    );
    await act(async () => context().validateDrafts(context().state.draftActivities));
    expect(mocks.check.mock.calls[0][0].activities).toHaveLength(12);
    expect(mocks.check.mock.calls[0][0].activities[0]).toMatchObject({
      symbolName: "My reviewed name",
      quoteMode: "MANUAL",
    });
    expect(mocks.preview).toHaveBeenCalledTimes(4);
  });

  it.each(["back", "reset", "edit", "unmount"])(
    "discards late results and stops sending batches after %s",
    async (action) => {
      const pending = deferred<ImportAssetPreviewItem[]>();
      mocks.preview.mockReturnValue(pending.promise);
      const { context, unmount } = setup();
      let run!: Promise<void>;
      act(() => {
        run = context().previewAssets(context().state.draftActivities);
      });
      act(() => {
        if (action === "back") context().dispatch({ type: "PREV_STEP" });
        else if (action === "reset") context().dispatch({ type: "RESET" });
        else if (action === "edit")
          context().dispatch({
            type: "UPDATE_DRAFT",
            payload: { rowIndex: 0, updates: { quantity: "99" } },
          });
        else unmount();
      });
      await act(async () => {
        pending.resolve(previews(mocks.preview.mock.calls[0][0].candidates));
        await run;
      });
      expect(mocks.preview).toHaveBeenCalledTimes(1);
      expect(context().state.assetPreviewItems).toEqual([]);
      if (action === "edit") expect(context().state.draftActivities[0].quantity).toBe("99");
      if (action === "back") expect(context().state.draftActivities).toEqual([]);
    },
  );

  it("does not allow an older preview to replace a newer run", async () => {
    const old = deferred<ImportAssetPreviewItem[]>();
    mocks.preview
      .mockReturnValueOnce(old.promise)
      .mockImplementation(async ({ candidates }) => previews(candidates));
    const { context } = setup([draft(0)]);
    let run!: Promise<void>;
    act(() => {
      run = context().previewAssets(context().state.draftActivities);
    });
    act(() => context().dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: [draft(1)] }));
    await act(async () => context().previewAssets(context().state.draftActivities));
    await act(async () => {
      old.resolve(previews(mocks.preview.mock.calls[0][0].candidates));
      await run;
    });
    expect(context().state.assetPreviewItems).toHaveLength(1);
    expect(context().state.draftActivities[0].symbol).toBe("ASSET1");
  });

  it.each(["missing", "duplicate", "wrong-key", "unknown-status", "missing-draft", "missing-id"])(
    "does not count a %s response as a completed batch",
    async (problem) => {
      mocks.preview.mockImplementation(async ({ candidates }) => {
        const items = previews(candidates);
        if (problem === "missing") return items.slice(1);
        if (problem === "duplicate") return [items[0], items[0]];
        if (problem === "unknown-status")
          return items.map((item) => ({ ...item, status: "UNKNOWN" }));
        if (problem === "missing-draft")
          return items.map((item) => ({ ...item, draft: undefined }));
        if (problem === "missing-id")
          return items.map((item) => ({ ...item, status: "EXISTING_ASSET", assetId: undefined }));
        return items.map((item) => ({ ...item, key: "unknown" }));
      });
      const { context } = setup([draft(0), draft(1)]);
      await act(async () => context().previewAssets(context().state.draftActivities));
      expect(context().state.assetPreviewItems).toEqual([]);
      expect(context().state.assetPreviewProgress?.completed).toBe(0);
      expect(context().state.assetPreviewError).toEqual({ kind: "failed" });
    },
  );

  it("deduplicates repeated rows and needs no request for cash-only drafts", async () => {
    mocks.preview.mockImplementation(async ({ candidates }) => previews(candidates));
    const { context } = setup([draft(0), { ...draft(0), rowIndex: 1 }]);
    await act(async () => context().previewAssets(context().state.draftActivities));
    expect(mocks.preview.mock.calls[0][0].candidates).toHaveLength(1);
    expect(context().state.draftActivities.every((d) => d.importAssetKey)).toBe(true);
    act(() =>
      context().dispatch({
        type: "SET_DRAFT_ACTIVITIES",
        payload: [{ ...draft(0), symbol: undefined, activityType: "DEPOSIT" }],
      }),
    );
    await act(async () => context().previewAssets(context().state.draftActivities));
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(context().state.isPreviewingAssets).toBe(false);
  });
});
