import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCategorizationRuleMutations } from "./use-categorization-rules";

const mocks = vi.hoisted(() => ({
  rerunCategorizationRules: vi.fn(),
  rerunCategorizationRulesDetailed: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  invalidateSpendingCaches: vi.fn(),
}));

vi.mock("../adapters/rules", () => ({
  rerunCategorizationRules: mocks.rerunCategorizationRules,
  rerunCategorizationRulesDetailed: mocks.rerunCategorizationRulesDetailed,
}));
vi.mock("../lib/invalidation", () => ({
  invalidateSpendingCaches: mocks.invalidateSpendingCaches,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, warning: mocks.warning, error: mocks.error },
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

const summary = {
  matched: 5,
  eligible: 0,
  changed: 0,
  protectedSplits: 0,
  protectedManual: 0,
  skippedExisting: 0,
  unchanged: 0,
  incompatible: 5,
  withoutTarget: 0,
};

describe("categorization rule feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rerunCategorizationRules.mockResolvedValue(5);
    mocks.rerunCategorizationRulesDetailed.mockResolvedValue(summary);
  });

  it("explains incompatible matches without claiming they were categorized", async () => {
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(true));

    expect(mocks.rerunCategorizationRulesDetailed).toHaveBeenCalledWith(true);
    expect(mocks.success).not.toHaveBeenCalled();
    // Any taxonomy can mismatch (e.g. a spending rule on a refund deposit), so the
    // explanation states the general rule before the Savings-specific one.
    expect(mocks.warning).toHaveBeenCalledWith("Categorized 0 activities.", {
      description:
        "Incompatible categories: 5. Categories follow the transaction's cash flow. Savings categories apply only to linked transfers leaving your tracked spending accounts.",
    });
    expect(mocks.invalidateSpendingCaches).toHaveBeenCalled();
  });

  it("reports changed rows rather than matches and explains protected assignments", async () => {
    mocks.rerunCategorizationRulesDetailed.mockResolvedValue({
      ...summary,
      changed: 1,
      incompatible: 0,
      protectedManual: 2,
      protectedSplits: 1,
    });
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(false));

    expect(mocks.success).toHaveBeenCalledWith("Re-categorized 1 activity.", {
      description: "Existing categories or splits kept: 3.",
    });
  });

  it("does not report categorized rows an uncategorized-only run skips by request", async () => {
    mocks.rerunCategorizationRulesDetailed.mockResolvedValue({
      ...summary,
      matched: 6,
      eligible: 1,
      changed: 1,
      incompatible: 0,
      protectedManual: 1,
      protectedSplits: 1,
      skippedExisting: 3,
    });
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(true));

    expect(mocks.success).toHaveBeenCalledWith("Categorized 1 activity.", {
      description: undefined,
    });
  });

  it("reports an ordinary successful run without skip explanations", async () => {
    mocks.rerunCategorizationRulesDetailed.mockResolvedValue({
      ...summary,
      matched: 1,
      eligible: 1,
      changed: 1,
      incompatible: 0,
    });
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(true));

    expect(mocks.success).toHaveBeenCalledWith("Categorized 1 activity.", {
      description: undefined,
    });
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
