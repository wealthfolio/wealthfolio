import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryKeys } from "@/lib/query-keys";

import { applySpendingRuleSuggestion, getSpendingRuleSuggestions } from "../adapters/suggestions";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type { ApplySuggestionRequest, SuggestedRule } from "../types/suggestion";

const DISMISSED_STORAGE_KEY = "wf.spending.dismissedRuleSuggestions";

function readDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // A full or unavailable localStorage just means dismissals don't persist —
    // not worth surfacing to the user.
  }
}

export function useSpendingRuleSuggestions() {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);

  const query = useQuery<SuggestedRule[], Error>({
    queryKey: [QueryKeys.SPENDING_RULES, "suggestions"],
    queryFn: getSpendingRuleSuggestions,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissed(next);
      return next;
    });
  }, []);

  const applyMutation = useMutation({
    mutationFn: ({
      suggestion,
      categoryName,
      useCaseInsensitive,
    }: {
      suggestion: SuggestedRule;
      categoryName?: string;
      useCaseInsensitive?: boolean;
    }) => {
      const pattern =
        useCaseInsensitive && suggestion.caseInsensitivePattern
          ? suggestion.caseInsensitivePattern
          : suggestion.pattern;
      const request: ApplySuggestionRequest = {
        pattern,
        taxonomyId: suggestion.taxonomyId,
        categoryId: suggestion.categoryId,
        categoryName: categoryName ?? null,
        action: suggestion.action,
      };
      return applySpendingRuleSuggestion(request);
    },
    onSuccess: (_rule, { suggestion }) => {
      // The new/extended/combined rule and the re-categorization it triggers
      // touch rules, suggestions, and every downstream spending view.
      qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_RULES] });
      invalidateSpendingCaches(qc);
      const verb =
        suggestion.action.type === "extendRule"
          ? "Extended"
          : suggestion.action.type === "combineRules"
            ? "Combined"
            : "Added";
      toast.success(`${verb} rule for ${suggestion.merchants.join(", ")}.`);
    },
    onError: () => toast.error("Failed to apply suggestion."),
  });

  const suggestions = useMemo(
    () => (query.data ?? []).filter((s) => !dismissed.has(s.id)),
    [query.data, dismissed],
  );

  return {
    suggestions,
    isLoading: query.isLoading,
    isError: query.isError,
    dismiss,
    apply: (suggestion: SuggestedRule, categoryName?: string, useCaseInsensitive?: boolean) =>
      applyMutation.mutate({ suggestion, categoryName, useCaseInsensitive }),
    applyingId:
      applyMutation.isPending && applyMutation.variables
        ? applyMutation.variables.suggestion.id
        : null,
  };
}
