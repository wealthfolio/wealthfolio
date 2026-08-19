import { fireEvent, render, screen, waitFor } from "@/test/render";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateToolResultRequest } from "@/adapters/types";
import type { PrepareAssetClassificationOutput } from "../../types";
import { AssetClassificationToolUIContentImpl } from "./asset-classification-tool-ui";

const adapterMocks = vi.hoisted(() => ({
  updateToolResult: vi.fn<(request: UpdateToolResultRequest) => Promise<void>>(),
}));

const taxonomyHookMocks = vi.hoisted(() => ({
  replaceMutateAsync: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("@/hooks/use-taxonomies", () => ({
  useReplaceAssetTaxonomyAssignments: () => ({
    isPending: false,
    mutateAsync: taxonomyHookMocks.replaceMutateAsync,
  }),
}));
vi.mock("../../hooks/use-runtime-context", () => ({
  useRuntimeContext: () => ({
    currentThreadId: "thread-1",
  }),
}));

type AssetClassificationToolUIProps = ComponentProps<typeof AssetClassificationToolUIContentImpl>;

function result(overrides: Partial<PrepareAssetClassificationOutput> = {}) {
  return {
    assetQuery: "AAPL",
    resolvedAsset: {
      assetId: "asset-aapl",
      label: "AAPL - Apple Inc.",
      displayCode: "AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchangeMic: "XNAS",
      currency: "USD",
      matchedBy: "symbol",
    },
    taxonomy: {
      taxonomyId: "asset-class",
      name: "Asset Class",
      isSingleSelect: false,
    },
    currentAssignments: [
      {
        assignmentId: "assignment-stale",
        categoryId: "old",
        categoryName: "Old",
        categoryKey: "old",
        weightBasisPoints: 10000,
        source: "manual",
      },
    ],
    proposedAssignments: [
      {
        assignmentId: null,
        categoryId: "equity",
        categoryName: "Equity",
        categoryKey: "equity",
        weightBasisPoints: 10000,
        source: "ai",
      },
    ],
    changes: {
      addCount: 1,
      updateCount: 0,
      removeCount: 1,
      unchangedCount: 0,
    },
    unallocatedBasisPoints: 0,
    draftStatus: "draft" as const,
    ...overrides,
  };
}

const vtCandidates = [
  {
    assetId: "asset-vt-xnas",
    label: "VT - Vanguard Total World Stock Index Fund ETF Shares",
    displayCode: "VT",
    symbol: "VT",
    name: "Vanguard Total World Stock Index Fund ETF Shares",
    exchangeMic: "XNAS",
    currency: "USD",
    matchedBy: "candidate",
  },
  {
    assetId: "asset-vt-arcx",
    label: "VT - Vanguard Total World Stock Index Fund ETF Shares",
    displayCode: "VT",
    symbol: "VT",
    name: "Vanguard Total World Stock Index Fund ETF Shares",
    exchangeMic: "ARCX",
    currency: "USD",
    matchedBy: "candidate",
  },
];

function ambiguousResult(overrides: Partial<PrepareAssetClassificationOutput> = {}) {
  return result({
    assetQuery: "VT",
    resolvedAsset: null,
    draftStatus: "needsAssetSelection",
    assetCandidates: vtCandidates,
    candidateCurrentAssignments: [
      {
        assetId: "asset-vt-xnas",
        currentAssignments: [
          {
            assignmentId: "assignment-xnas-old",
            categoryId: "old",
            categoryName: "Old",
            categoryKey: "old",
            weightBasisPoints: 10000,
            source: "manual",
          },
        ],
        changes: {
          addCount: 1,
          updateCount: 0,
          removeCount: 1,
          unchangedCount: 0,
        },
      },
      {
        assetId: "asset-vt-arcx",
        currentAssignments: [],
        changes: {
          addCount: 1,
          updateCount: 0,
          removeCount: 0,
          unchangedCount: 0,
        },
      },
    ],
    ...overrides,
  });
}

function renderWidget(output: unknown) {
  return render(
    <AssetClassificationToolUIContentImpl
      args={{ assetQuery: "AAPL", taxonomyId: "asset-class", assignments: [] }}
      argsText=""
      result={output as PrepareAssetClassificationOutput}
      status={{ type: "complete" } as AssetClassificationToolUIProps["status"]}
      toolName="prepare_asset_classification"
      toolCallId="tool-call-1"
      type="tool-call"
      addResult={vi.fn()}
      resume={vi.fn()}
    />,
  );
}

function assetOption(exchangeMic: string) {
  const button = screen.getByText(new RegExp(`\\b${exchangeMic}\\b`)).closest("button");
  if (!button) throw new Error(`Asset option ${exchangeMic} was not rendered`);
  return button;
}

describe("AssetClassificationToolUIContentImpl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.updateToolResult.mockResolvedValue(undefined);
    taxonomyHookMocks.replaceMutateAsync.mockResolvedValue([
      { id: "assignment-equity", categoryId: "equity", weight: 10000 },
    ]);
  });

  it("disables confirm for applied drafts", () => {
    renderWidget(result({ draftStatus: "applied", appliedAt: "2026-06-03T10:00:00.000Z" }));

    expect(screen.getByRole("button", { name: /applied/i })).toBeDisabled();
  });

  it("writes assignments and patches the tool result after confirm", async () => {
    renderWidget(result());

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(taxonomyHookMocks.replaceMutateAsync).toHaveBeenCalledWith({
        assetId: "asset-aapl",
        taxonomyId: "asset-class",
        assignments: [
          {
            assetId: "asset-aapl",
            taxonomyId: "asset-class",
            categoryId: "equity",
            weight: 10000,
            source: "ai",
          },
        ],
      });
      const request = adapterMocks.updateToolResult.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      expect(request?.threadId).toBe("thread-1");
      expect(request?.toolCallId).toBe("tool-call-1");
      expect(request?.resultPatch.draftStatus).toBe("applied");
      expect(typeof request?.resultPatch.appliedAt).toBe("string");
      expect(request?.resultPatch.appliedChanges).toEqual({
        addCount: 1,
        updateCount: 0,
        removeCount: 1,
        unchangedCount: 0,
      });
    });
  });

  it("uses edited new weights when confirming", async () => {
    renderWidget(result());

    expect(screen.getByLabelText("Current Old percent").tagName).toBe("SPAN");
    const newEquityInput = screen.getByLabelText("New Equity percent");
    expect(newEquityInput.tagName).toBe("INPUT");
    expect(newEquityInput).toHaveAttribute("type", "text");
    expect(newEquityInput).toHaveAttribute("inputmode", "decimal");

    fireEvent.change(newEquityInput, {
      target: { value: "75.25" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(taxonomyHookMocks.replaceMutateAsync).toHaveBeenCalledWith({
        assetId: "asset-aapl",
        taxonomyId: "asset-class",
        assignments: [
          {
            assetId: "asset-aapl",
            taxonomyId: "asset-class",
            categoryId: "equity",
            weight: 7525,
            source: "ai",
          },
        ],
      });

      const request = adapterMocks.updateToolResult.mock.calls[0]?.[0];
      expect(request?.resultPatch.proposedAssignments).toEqual([
        expect.objectContaining({
          categoryId: "equity",
          weightBasisPoints: 7525,
        }),
      ]);
      expect(request?.resultPatch.unallocatedBasisPoints).toBe(2475);
      expect(request?.resultPatch.changes).toEqual({
        addCount: 1,
        updateCount: 0,
        removeCount: 1,
        unchangedCount: 0,
      });
    });
  });

  it("selects an ambiguous asset inside the draft", async () => {
    renderWidget(ambiguousResult());

    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
    expect(screen.getByText(/existing: 1 allocation/i)).toBeInTheDocument();
    expect(screen.getByText(/no existing allocation/i)).toBeInTheDocument();

    fireEvent.click(assetOption("ARCX"));

    await waitFor(() => {
      const request = adapterMocks.updateToolResult.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      expect(request?.threadId).toBe("thread-1");
      expect(request?.toolCallId).toBe("tool-call-1");
      expect(request?.resultPatch.draftStatus).toBe("assetSelected");
      expect(request?.resultPatch.selectedAssetId).toBe("asset-vt-arcx");
      expect(request?.resultPatch.selectedAsset).toMatchObject({
        assetId: "asset-vt-arcx",
        exchangeMic: "ARCX",
      });
      expect(typeof request?.resultPatch.selectedAt).toBe("string");
    });

    expect(screen.getByRole("button", { name: /confirm/i })).toBeEnabled();
  });

  it("allows changing asset selection before confirming", async () => {
    renderWidget(ambiguousResult());

    fireEvent.click(assetOption("ARCX"));

    await waitFor(() => {
      expect(adapterMocks.updateToolResult).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(assetOption("XNAS"));

    await waitFor(() => {
      expect(adapterMocks.updateToolResult).toHaveBeenCalledTimes(2);
      expect(adapterMocks.updateToolResult.mock.calls[1]?.[0].resultPatch.selectedAssetId).toBe(
        "asset-vt-xnas",
      );
    });
  });

  it("uses selected candidate assignments when applying ambiguous drafts", async () => {
    renderWidget(ambiguousResult());

    fireEvent.click(assetOption("XNAS"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm/i })).toBeEnabled();
    });

    expect(screen.getByText("Old")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(taxonomyHookMocks.replaceMutateAsync).toHaveBeenCalledWith({
        assetId: "asset-vt-xnas",
        taxonomyId: "asset-class",
        assignments: [
          {
            assetId: "asset-vt-xnas",
            taxonomyId: "asset-class",
            categoryId: "equity",
            weight: 10000,
            source: "ai",
          },
        ],
      });
      const appliedRequest = adapterMocks.updateToolResult.mock.calls[1]?.[0];
      expect(appliedRequest?.resultPatch).toMatchObject({
        draftStatus: "applied",
        selectedAssetId: "asset-vt-xnas",
        appliedChanges: {
          addCount: 1,
          updateCount: 0,
          removeCount: 1,
          unchangedCount: 0,
        },
      });
    });
  });

  it("applies to the newly selected candidate when changing a persisted selection", async () => {
    renderWidget(
      ambiguousResult({
        draftStatus: "assetSelected",
        selectedAssetId: "asset-vt-xnas",
        selectedAsset: vtCandidates[0],
      }),
    );

    fireEvent.click(assetOption("ARCX"));

    await waitFor(() => {
      expect(adapterMocks.updateToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          resultPatch: expect.objectContaining({
            selectedAssetId: "asset-vt-arcx",
          }),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(taxonomyHookMocks.replaceMutateAsync).toHaveBeenCalledWith({
        assetId: "asset-vt-arcx",
        taxonomyId: "asset-class",
        assignments: [
          {
            assetId: "asset-vt-arcx",
            taxonomyId: "asset-class",
            categoryId: "equity",
            weight: 10000,
            source: "ai",
          },
        ],
      });

      const appliedRequest = adapterMocks.updateToolResult.mock.calls[1]?.[0];
      expect(appliedRequest?.resultPatch).toMatchObject({
        draftStatus: "applied",
        selectedAssetId: "asset-vt-arcx",
        selectedAsset: expect.objectContaining({
          assetId: "asset-vt-arcx",
          exchangeMic: "ARCX",
        }),
      });
    });
  });

  it("renders ambiguous final draft selector from a wrapped tool result", () => {
    renderWidget({ data: ambiguousResult() });

    expect(screen.getByText(/needs asset/i)).toBeInTheDocument();
    expect(screen.getByText(/XNAS · USD/i)).toBeInTheDocument();
    expect(screen.getByText(/ARCX · USD/i)).toBeInTheDocument();
    expect(screen.queryByText(/no resolved asset was returned/i)).not.toBeInTheDocument();
  });

  it("renders tool errors as inline status text", () => {
    const { container } = renderWidget({
      error: "Toolset error: ToolCallError: Duplicate category ID 'north_america'",
    });

    expect(screen.getByRole("status")).toHaveTextContent(/some rows map to the same category/i);
    expect(container.querySelector('[class*="bg-destructive"]')).not.toBeInTheDocument();
  });

  it("retries asset selection persistence when the tool result is not saved yet", async () => {
    adapterMocks.updateToolResult
      .mockRejectedValueOnce(new Error("Tool result not found"))
      .mockResolvedValueOnce(undefined);

    renderWidget(ambiguousResult());

    fireEvent.click(assetOption("ARCX"));

    await waitFor(() => {
      expect(adapterMocks.updateToolResult).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/could not be updated/i)).not.toBeInTheDocument();
    });
  });
});
