import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
  /** taxonomy_id:category_id → display metadata (joined client-side from taxonomies) */
  categoryMeta: Record<string, RuleCategoryMeta>;
  /** preset_id → display metadata. Missing entries fall back to the raw id. */
  presetMeta?: Record<string, RulePresetMeta>;
  onEdit: (rule: CategorizationRule) => void;
  onDelete: (rule: CategorizationRule) => void;
}

export function RuleItem({ rule, categoryMeta, presetMeta, onEdit, onDelete }: RuleItemProps) {
  const { t } = useTranslation();
  const MATCH_TYPE_LABELS = useMemo<Record<string, string>>(
    () => ({
      contains: t("spending:rules.matchContains"),
      starts_with: t("spending:rules.matchStartsWith"),
      exact: t("spending:rules.matchExact"),
      regex: t("spending:rules.matchRegex"),
    }),
    [t],
  );
  const ACTIVITY_TYPE_LABELS = useMemo<Record<string, string>>(
    () => ({
      DEPOSIT: t("spending:rules.activityDeposit"),
      WITHDRAWAL: t("spending:rules.activityWithdrawal"),
      CREDIT: t("spending:rules.activityCredit"),
      INTEREST: t("spending:rules.activityInterest"),
      DIVIDEND: t("spending:rules.activityDividend"),
      FEE: t("spending:rules.activityFee"),
      TAX: t("spending:rules.activityTax"),
      TRANSFER_IN: t("spending:rules.activityTransferIn"),
      TRANSFER_OUT: t("spending:rules.activityTransferOut"),
    }),
    [t],
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [patternExpanded, setPatternExpanded] = useState(false);

  const handleDelete = () => {
    onDelete(rule);
    setShowDeleteDialog(false);
  };

  const targetKey =
    rule.taxonomyId && rule.categoryId ? `${rule.taxonomyId}:${rule.categoryId}` : null;
  const target =
    targetKey && categoryMeta[targetKey]
      ? categoryMeta[targetKey]
      : rule.categoryId
        ? (categoryMeta[rule.categoryId] ?? null)
        : null;
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
      ? t("spending:rules.fromPresetEdited", { name: preset.name })
      : t("spending:rules.fromPreset", { name: preset.name })
    : rule.presetId
      ? t("spending:rules.fromPreset", { name: rule.presetId.toUpperCase() })
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
                    ·{t("spending:rules.edited")}
                  </span>
                )}
              </span>
            ) : null}
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {matchLabel}
              {rule.priority > 0 && (
                <> · {t("spending:rules.priority", { value: rule.priority })}</>
              )}
            </span>
          </div>

          {/* Line 2: pattern (truncated by default; click to expand) */}
          <button
            type="button"
            onClick={() => setPatternExpanded((v) => !v)}
            className="text-muted-foreground/80 hover:text-muted-foreground block w-full text-left transition-colors"
            aria-label={
              patternExpanded
                ? t("spending:rules.collapsePattern")
                : t("spending:rules.expandPattern")
            }
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
            <span className="text-muted-foreground/60 text-xs italic">
              {t("spending:rules.noTarget")}
            </span>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={t("spending:rules.ruleActions")}
              >
                <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(rule)}>
                <Icons.Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("common:edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Icons.Trash className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("common:delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("spending:rules.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("spending:rules.deleteConfirm", { name: rule.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
