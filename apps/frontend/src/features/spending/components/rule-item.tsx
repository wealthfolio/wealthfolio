import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
} from "@wealthfolio/ui";

import type { CategorizationRule } from "../types/rule";

export interface RuleCategoryMeta {
  name: string;
  color: string | null;
  parentName: string | null;
}

export interface RulePresetMeta {
  name: string;
  flag: string;
}

interface RuleItemProps {
  rule: CategorizationRule;
  /** category_id → display metadata (joined client-side from taxonomies) */
  categoryMeta: Record<string, RuleCategoryMeta>;
  /** preset_id → display metadata. Missing entries fall back to the raw id. */
  presetMeta?: Record<string, RulePresetMeta>;
  onEdit: (rule: CategorizationRule) => void;
  onDelete: (rule: CategorizationRule) => void;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  contains: "contains",
  starts_with: "starts with",
  exact: "exact",
  regex: "regex",
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  CREDIT: "Credit / Refund",
  INTEREST: "Interest",
  DIVIDEND: "Dividend",
  FEE: "Fee",
  TAX: "Tax",
  TRANSFER_IN: "Transfer In",
  TRANSFER_OUT: "Transfer Out",
};

export function RuleItem({ rule, categoryMeta, presetMeta, onEdit, onDelete }: RuleItemProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [patternExpanded, setPatternExpanded] = useState(false);

  const handleDelete = () => {
    onDelete(rule);
    setShowDeleteDialog(false);
  };

  const target = rule.categoryId ? categoryMeta[rule.categoryId] : null;
  const targetLabel = target
    ? target.parentName
      ? `${target.parentName} / ${target.name}`
      : target.name
    : null;
  const activityTypeLabel = rule.activityType
    ? (ACTIVITY_TYPE_LABELS[rule.activityType] ?? rule.activityType)
    : null;
  const matchLabel = MATCH_TYPE_LABELS[rule.matchType] ?? rule.matchType;
  const preset = rule.presetId ? (presetMeta?.[rule.presetId] ?? null) : null;
  const presetBadgeTitle = preset
    ? rule.presetModified
      ? `From ${preset.name} preset (edited)`
      : `From ${preset.name} preset`
    : rule.presetId
      ? `From ${rule.presetId.toUpperCase()} preset`
      : null;

  return (
    <>
      <div className="hover:bg-muted/30 group flex items-start gap-3 px-4 py-3 transition-colors">
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Line 1: name + meta */}
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">{rule.name}</span>
            {rule.presetId && presetBadgeTitle ? (
              <span
                className="border-muted-foreground/20 text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none"
                title={presetBadgeTitle}
                aria-label={presetBadgeTitle}
              >
                {preset?.flag && (
                  <span className="text-[11px] leading-none" aria-hidden="true">
                    {preset.flag}
                  </span>
                )}
                <span className="font-medium uppercase tracking-wide">
                  {preset?.name ?? rule.presetId}
                </span>
                {rule.presetModified && (
                  <span className="text-muted-foreground/60" aria-hidden="true">
                    ·edited
                  </span>
                )}
              </span>
            ) : null}
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {matchLabel}
              {rule.priority > 0 && <> · priority {rule.priority}</>}
            </span>
          </div>

          {/* Line 2: pattern (truncated by default; click to expand) */}
          <button
            type="button"
            onClick={() => setPatternExpanded((v) => !v)}
            className="text-muted-foreground/80 hover:text-muted-foreground block w-full text-left transition-colors"
            aria-label={patternExpanded ? "Collapse pattern" : "Expand pattern"}
            title={rule.pattern}
          >
            <code
              className={
                patternExpanded
                  ? "block whitespace-pre-wrap break-all font-mono text-[11px]"
                  : "block truncate font-mono text-[11px]"
              }
            >
              {rule.pattern}
            </code>
          </button>
        </div>

        {/* Right: target chip + actions */}
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {target && targetLabel ? (
            <span
              className="bg-muted/60 inline-flex max-w-[200px] items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
              title={targetLabel}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: target.color ?? "var(--muted-foreground)" }}
                aria-hidden="true"
              />
              <span className="truncate">{target.name}</span>
            </span>
          ) : activityTypeLabel ? (
            <span className="bg-muted/60 text-muted-foreground inline-flex items-center rounded-full px-2 py-0.5 text-xs">
              {activityTypeLabel}
            </span>
          ) : (
            <span className="text-muted-foreground/60 text-xs italic">no target</span>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label="Rule actions"
              >
                <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(rule)}>
                <Icons.Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Icons.Trash className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the rule &quot;{rule.name}&quot;? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
