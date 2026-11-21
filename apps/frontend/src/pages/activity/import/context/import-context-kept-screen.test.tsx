import { Activity, StrictMode, useState } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActivityImport, ImportAssetCandidate, ImportAssetPreviewItem } from "@/lib/types";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), check: vi.fn() }));
vi.mock("@/adapters", () => ({
  previewImportAssets: mocks.preview,
  checkActivitiesImport: mocks.check,
  logger: { error: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function draft(index: number): DraftActivity {
  return {
    rowIndex: index,
    rawRow: [],
    activityDate: "2026-01-01",
    activityType: "BUY",
    symbol: `ASSET${index}`,
    currency: "USD",
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
    status: "EXISTING_ASSET",
    resolutionSource: "existing_asset",
    assetId: candidate.symbol,
    draft: {
      kind: "INVESTMENT",
      isActive: true,
      quoteMode: "MARKET",
      quoteCcy: "USD",
      instrumentType: "EQUITY",
      instrumentSymbol: candidate.symbol,
      instrumentExchangeMic: "XNAS",
    },
  }));
}

function setup(drafts: DraftActivity[]) {
  let latest!: ReturnType<typeof useImportContext>;
  let setHidden!: (hidden: boolean) => void;
  function Probe() {
    latest = useImportContext();
    return null;
  }
  function KeptScreen() {
    const [hidden, updateHidden] = useState(false);
    setHidden = updateHidden;
    return (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <ImportProvider>
          <Probe />
        </ImportProvider>
      </Activity>
    );
  }
  render(
    <StrictMode>
      <KeptScreen />
    </StrictMode>,
  );
  act(() => {
    latest.dispatch({ type: "SET_STEP", payload: drafts[0].symbol ? "assets" : "review" });
    latest.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: drafts });
  });
  return { context: () => latest, hide: (hidden: boolean) => act(() => setHidden(hidden)) };
}

beforeEach(() => vi.resetAllMocks());

it("settles a preview that finishes while its mobile screen is hidden", async () => {
  const pending = deferred<ImportAssetPreviewItem[]>();
  mocks.preview.mockReturnValue(pending.promise);
  const { context, hide } = setup([draft(0)]);
  let run!: Promise<void>;
  act(() => {
    run = context().previewAssets(context().state.draftActivities);
  });
  hide(true);
  await act(async () => {
    pending.resolve(previews(mocks.preview.mock.calls[0][0].candidates));
    await run;
  });
  hide(false);
  expect(context().state.isPreviewingAssets).toBe(false);
  expect(context().state.assetPreviewItems).toHaveLength(1);
  expect(context().state.draftActivities[0].assetId).toBe("ASSET0");
});

it("keeps the completed batch and pauses further requests until the user resumes", async () => {
  const pending = deferred<ImportAssetPreviewItem[]>();
  mocks.preview
    .mockReturnValueOnce(pending.promise)
    .mockImplementation(async ({ candidates }) => previews(candidates));
  const { context, hide } = setup(Array.from({ length: 6 }, (_, index) => draft(index)));
  let run!: Promise<void>;
  act(() => {
    run = context().previewAssets(context().state.draftActivities);
  });
  hide(true);
  await act(async () => {
    pending.resolve(previews(mocks.preview.mock.calls[0][0].candidates));
    await run;
  });
  expect(mocks.preview).toHaveBeenCalledTimes(1);
  hide(false);
  expect(context().state.isPreviewingAssets).toBe(false);
  expect(context().state.assetPreviewProgress).toMatchObject({ completed: 5, total: 6 });
  await act(async () => context().previewAssets(context().state.draftActivities, { retry: true }));
  expect(
    mocks.preview.mock.calls[1][0].candidates.map((c: ImportAssetCandidate) => c.symbol),
  ).toEqual(["ASSET5"]);
  expect(context().state.assetPreviewItems).toHaveLength(6);
});

it("continues the same preview if the screen returns before its request finishes", async () => {
  const pending = deferred<ImportAssetPreviewItem[]>();
  mocks.preview
    .mockReturnValueOnce(pending.promise)
    .mockImplementation(async ({ candidates }) => previews(candidates));
  const { context, hide } = setup(Array.from({ length: 6 }, (_, index) => draft(index)));
  let run!: Promise<void>;
  act(() => {
    run = context().previewAssets(context().state.draftActivities);
  });
  hide(true);
  hide(false);
  await act(async () => {
    pending.resolve(previews(mocks.preview.mock.calls[0][0].candidates));
    await run;
  });
  expect(context().state.isPreviewingAssets).toBe(false);
  expect(context().state.assetPreviewItems).toHaveLength(6);
});

it.each(["DEPOSIT", "WITHDRAWAL"])(
  "settles %s transaction review while its mobile screen is hidden",
  async (activityType) => {
    const pending = deferred<ActivityImport[]>();
    mocks.check.mockReturnValue(pending.promise);
    const { context, hide } = setup([
      { ...draft(0), symbol: undefined, activityType, amount: "10", currencySource: "csv" },
    ]);
    let run!: ReturnType<ReturnType<typeof useImportContext>["validateDrafts"]>;
    act(() => {
      run = context().validateDrafts(context().state.draftActivities);
    });
    hide(true);
    await act(async () => {
      pending.resolve(
        mocks.check.mock.calls[0][0].activities.map((a: ActivityImport) => ({
          ...a,
          isValid: true,
        })),
      );
      await run;
    });
    hide(false);
    expect(context().state.isValidating).toBe(false);
    expect(context().state.lastValidatedRevision).toBe(context().state.draftRevision);
    expect(context().state.draftActivities[0]).toMatchObject({
      activityType,
      amount: "10",
      currency: "USD",
      currencySource: "csv",
    });
    expect(mocks.preview).not.toHaveBeenCalled();
  },
);

it("shows a validation failure that arrives while the mobile screen is hidden", async () => {
  const pending = deferred<ActivityImport[]>();
  mocks.check.mockReturnValue(pending.promise);
  const { context, hide } = setup([
    { ...draft(0), symbol: undefined, activityType: "DEPOSIT", amount: "10" },
  ]);
  let run!: ReturnType<ReturnType<typeof useImportContext>["validateDrafts"]>;
  act(() => {
    run = context().validateDrafts(context().state.draftActivities);
  });
  hide(true);
  await act(async () => {
    pending.reject(new Error("test failure"));
    await run;
  });
  hide(false);
  expect(context().state.isValidating).toBe(false);
  expect(context().state.validationError).toEqual({ key: "activity:import.review.backend_failed" });
});
