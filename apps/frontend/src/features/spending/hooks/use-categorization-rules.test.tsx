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

  it("explains an incompatible Savings rule without claiming its matches were categorized", async () => {
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(true));

    expect(mocks.rerunCategorizationRulesDetailed).toHaveBeenCalledWith(true);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "Categorized 0 activities.",
      expect.objectContaining({
        description: expect.stringContaining("Savings categories require a linked transfer"),
      }),
    );
    expect(mocks.invalidateSpendingCaches).toHaveBeenCalled();
  });

  it("reports changed rows rather than matches and explains protected assignments", async () => {
    mocks.rerunCategorizationRulesDetailed.mockResolvedValue({
      ...summary,
      changed: 1,
      incompatible: 0,
      protectedManual: 2,
      protectedSplits: 1,
      skippedExisting: 1,
    });
    const { result } = renderHook(() => useCategorizationRuleMutations(), { wrapper });
    await act(() => result.current.rerun.mutateAsync(false));

    expect(mocks.success).toHaveBeenCalledWith(
      "Re-categorized 1 activity.",
      expect.objectContaining({ description: expect.stringContaining("4") }),
    );
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
