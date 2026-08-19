import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Icons,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";

import { useSpendingRuleSuggestions } from "../hooks/use-spending-rule-suggestions";
import type { RuleCategoryMeta } from "./rule-item";
import type { SuggestedRule } from "../types/suggestion";

interface RuleSuggestionsPanelProps {
  /** taxonomyId:categoryId and bare categoryId → display metadata. */
  categoryMeta: Record<string, RuleCategoryMeta>;
}

/**
 * Rules the engine infers from how the user has categorized transactions by
 * hand, shown above the rule list. Renders nothing while loading finds no
 * suggestions, on error, or once every suggestion is applied or dismissed.
 */
export function RuleSuggestionsPanel({ categoryMeta }: RuleSuggestionsPanelProps) {
  const { t } = useTranslation();
  const { suggestions, isLoading, isError, dismiss, apply, applyingId } =
    useSpendingRuleSuggestions();
  const [open, setOpen] = useState(true);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  // Errors are non-blocking here — the rule list still works without suggestions.
  if (isError || suggestions.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-dashed p-3">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icons.Sparkles className="h-4 w-4 text-amber-500" aria-hidden="true" />
          <span className="text-foreground text-sm font-medium">
            {t("settings:spending.rules.suggestions.title", "Suggested rules")}
          </span>
          <Badge variant="secondary" className="tabular-nums">
            {suggestions.length}
          </Badge>
        </div>
        <Icons.ChevronDown
          className={cn("text-muted-foreground h-4 w-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-3">
        {suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            categoryName={categoryMeta[s.categoryId]?.name ?? null}
            applying={applyingId === s.id}
            onApply={(useCaseInsensitive) =>
              apply(s, categoryMeta[s.categoryId]?.name, useCaseInsensitive)
            }
            onDismiss={() => dismiss(s.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SuggestionCard({
  suggestion,
  categoryName,
  applying,
  onApply,
  onDismiss,
}: {
  suggestion: SuggestedRule;
  categoryName: string | null;
  applying: boolean;
  onApply: (useCaseInsensitive: boolean) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [showExamples, setShowExamples] = useState(false);
  const [useCaseInsensitive, setUseCaseInsensitive] = useState(false);
  const isExtend = suggestion.action.type === "extendRule";
  const isCombine = suggestion.action.type === "combineRules";
  const confidencePct = Math.round(suggestion.confidence * 100);
  const merchantLabel = suggestion.merchants.join(", ");

  return (
    <div className="bg-card animate-in fade-in slide-in-from-top-1 rounded-md border p-3 duration-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-foreground text-sm font-medium">{merchantLabel}</span>
            <Icons.ArrowRight className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            <span className="text-foreground text-sm">{categoryName ?? suggestion.categoryId}</span>
            {isExtend && suggestion.action.type === "extendRule" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="cursor-help text-[10px]">
                      {t("settings:spending.rules.suggestions.extends", "Extends existing rule")}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <code className="text-xs">{suggestion.action.proposedPattern}</code>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {isCombine && suggestion.action.type === "combineRules" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="cursor-help text-[10px]">
                      {t("settings:spending.rules.suggestions.combines", {
                        count: suggestion.action.ruleIds.length,
                        defaultValue: "Combines {{count}} existing rules",
                      })}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{suggestion.action.ruleNames.join(", ")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {suggestion.uncategorizedMatchCount > 0 && (
              <span>
                {t("settings:spending.rules.suggestions.wouldCatch", {
                  count: suggestion.uncategorizedMatchCount,
                  defaultValue: "Catches {{count}} uncategorized",
                })}
              </span>
            )}
            <span className={confidenceClass(suggestion.confidence)}>
              {t("settings:spending.rules.suggestions.confidence", {
                pct: confidencePct,
                defaultValue: "{{pct}}% confidence",
              })}
            </span>
            {suggestion.examples.length > 0 && (
              <button
                type="button"
                onClick={() => setShowExamples((v) => !v)}
                className="hover:text-foreground underline-offset-2 hover:underline"
              >
                {showExamples
                  ? t("settings:spending.rules.suggestions.hideExamples", "Hide examples")
                  : t("settings:spending.rules.suggestions.showExamples", "Examples")}
              </button>
            )}
          </div>
          {showExamples && (
            <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
              {suggestion.examples.map((ex) => (
                <li key={ex} className="truncate font-mono">
                  {ex}
                </li>
              ))}
            </ul>
          )}
          {suggestion.caseSensitive && suggestion.caseInsensitivePattern && (
            <label className="text-muted-foreground mt-1.5 flex items-start gap-1.5 text-xs">
              <Checkbox
                checked={useCaseInsensitive}
                onCheckedChange={(checked) => setUseCaseInsensitive(checked === true)}
                className="mt-0.5"
              />
              <span>
                {t(
                  "settings:spending.rules.suggestions.switchCaseInsensitive",
                  "This keeps your rule's case-sensitive matching. Also match regardless of case?",
                )}
              </span>
            </label>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={() => onApply(useCaseInsensitive)} disabled={applying}>
            {applying ? (
              <Icons.Spinner className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Icons.Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {isExtend
              ? t("settings:spending.rules.suggestions.extend", "Extend")
              : isCombine
                ? t("settings:spending.rules.suggestions.combine", "Combine")
                : t("settings:spending.rules.suggestions.add", "Add rule")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDismiss}
            disabled={applying}
            aria-label={t("settings:spending.rules.suggestions.dismiss", "Dismiss suggestion")}
            className="h-8 w-8"
          >
            <Icons.X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.8) return "text-success";
  if (confidence >= 0.6) return "text-amber-600 dark:text-amber-500";
  return "text-muted-foreground";
}
