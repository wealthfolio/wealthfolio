import { getGoalFunding } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { AccountPurpose } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, GoalFundingRule, GoalFundingRuleInput } from "@/lib/types";
import { Button } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useQueries } from "@tanstack/react-query";
import { useGoalPlanMutations } from "../hooks/use-goal-detail";
import { useGoalDetail } from "../hooks/use-goal-detail";
import { useGoals } from "../hooks/use-goals";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const TAX_BUCKET_COLORS: Record<string, string> = {
  taxable: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  tax_deferred: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  tax_free: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
};

const INDICATOR_COLORS = [
  "var(--color-blue-400)",
  "var(--color-orange-400)",
  "var(--color-green-400)",
  "var(--color-purple-400)",
  "var(--color-cyan-400)",
  "var(--color-red-400)",
  "var(--color-magenta-400)",
  "var(--color-yellow-400)",
  "var(--color-blue-600)",
  "var(--color-orange-600)",
  "var(--color-green-600)",
  "var(--color-purple-600)",
  "var(--color-cyan-600)",
  "var(--color-red-600)",
  "var(--color-magenta-600)",
  "var(--color-yellow-600)",
];

const SHARE_EPSILON = 0.01;

interface OtherGoalFundingRule extends GoalFundingRule {
  goalTitle: string;
}

interface AccountAllocationRow {
  account: Account;
  thisShare: number;
  otherAllocations: OtherGoalFundingRule[];
  otherTotal: number;
  total: number;
  maxForThisGoal: number;
  left: number;
  overBy: number;
}

interface Props {
  goalId: string;
  goalType: string;
  dcLinkedAccountIds?: string[];
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

function SharePercentInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(formatShare(value));
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    if (!inputFocused) {
      setDraftValue(formatShare(value));
    }
  }, [inputFocused, value]);

  const commitDraftValue = () => {
    const raw = draftValue.trim();
    if (!raw) {
      setDraftValue(formatShare(value));
      return;
    }

    const parsed = parseFloat(raw.replace(/,/g, ""));
    if (Number.isNaN(parsed)) {
      setDraftValue(formatShare(value));
      return;
    }

    onChange(parsed);
    setDraftValue(formatShare(parsed));
  };

  return (
    <div className="bg-muted/70 flex h-8 w-20 shrink-0 items-center gap-1 rounded-md border px-2">
      <input
        type="text"
        inputMode="decimal"
        value={draftValue}
        onFocus={() => {
          setInputFocused(true);
          setDraftValue(formatShare(value));
        }}
        onChange={(e) => {
          const next = e.target.value;
          if (/^-?\d*([.,]\d*)?$/.test(next)) {
            setDraftValue(next);
          }
        }}
        onBlur={() => {
          setInputFocused(false);
          commitDraftValue();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraftValue(formatShare(value));
            e.currentTarget.blur();
          }
        }}
        className="text-foreground min-w-0 flex-1 bg-transparent text-right text-sm tabular-nums outline-none"
      />
      <span className="text-muted-foreground text-xs tabular-nums">%</span>
    </div>
  );
}

function formatShare(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.abs(value) < SHARE_EPSILON ? 0 : value;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
}

function sumShares(rules: { sharePercent: number }[]): number {
  return rules.reduce((sum, rule) => sum + rule.sharePercent, 0);
}

function allocationLabel(row: AccountAllocationRow, t: TFunction): string {
  if (row.overBy > SHARE_EPSILON)
    return t("goals:funding.over", { percent: formatShare(row.overBy) });
  return t("goals:funding.left", { percent: formatShare(row.left) });
}

function allocationLabelClass(row: AccountAllocationRow): string {
  if (row.overBy > SHARE_EPSILON) return "text-destructive";
  if (row.left <= SHARE_EPSILON) return "text-muted-foreground";
  return "text-muted-foreground";
}

export function GoalFundingEditor({
  goalId,
  goalType,
  dcLinkedAccountIds = [],
  editing,
  onEditingChange,
}: Props) {
  const { t } = useTranslation();
  const { accounts } = useAccounts({ accountPurpose: AccountPurpose.GOAL_FUNDING });
  const { goals } = useGoals();
  const { fundingRules } = useGoalDetail(goalId);
  const { saveFundingMutation } = useGoalPlanMutations(goalId);
  const isRetirement = goalType === "retirement";

  const activeAccounts = useMemo(() => accounts ?? [], [accounts]);

  const [sharePercents, setSharePercents] = useState<Map<string, number>>(new Map());
  const [taxBuckets, setTaxBuckets] = useState<Map<string, string>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [internalEditing, setInternalEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isEditing = editing ?? internalEditing;
  const setEditing = useCallback(
    (next: boolean) => {
      if (onEditingChange) {
        onEditingChange(next);
      } else {
        setInternalEditing(next);
      }
    },
    [onEditingChange],
  );

  const resetDraft = useCallback(() => {
    const spMap = new Map<string, number>();
    const tbMap = new Map<string, string>();
    for (const rule of fundingRules) {
      spMap.set(rule.accountId, rule.sharePercent);
      if (rule.taxBucket) tbMap.set(rule.accountId, rule.taxBucket);
    }
    setSharePercents(spMap);
    setTaxBuckets(tbMap);
    setDirty(false);
  }, [fundingRules]);

  useEffect(() => {
    if (!isEditing) resetDraft();
  }, [isEditing, resetDraft]);

  const participatingGoals = useMemo(
    () => goals.filter((goal) => goal.statusLifecycle === "active"),
    [goals],
  );
  const currentGoal = useMemo(() => goals.find((goal) => goal.id === goalId), [goalId, goals]);
  const otherGoals = useMemo(
    () => participatingGoals.filter((goal) => goal.id !== goalId),
    [goalId, participatingGoals],
  );

  const otherFundingQueries = useQueries({
    queries: otherGoals.map((goal) => ({
      queryKey: QueryKeys.goalFunding(goal.id),
      queryFn: () => getGoalFunding(goal.id),
      staleTime: 30_000,
    })),
  });

  const otherFundingRules: OtherGoalFundingRule[] = otherFundingQueries.flatMap((query, index) => {
    const goal = otherGoals[index];
    return (query.data ?? []).map((rule) => ({
      ...rule,
      goalTitle: goal?.title ?? t("goals:detail.goal_fallback"),
    }));
  });

  const otherShareByAccount = new Map<string, number>();
  for (const rule of otherFundingRules) {
    otherShareByAccount.set(
      rule.accountId,
      (otherShareByAccount.get(rule.accountId) ?? 0) + rule.sharePercent,
    );
  }

  const allocationRows = useMemo<AccountAllocationRow[]>(() => {
    return activeAccounts
      .map((account) => {
        const otherAllocations = otherFundingRules.filter((rule) => rule.accountId === account.id);
        const otherTotal = sumShares(otherAllocations);
        const thisShare = sharePercents.get(account.id) ?? 0;
        const total = otherTotal + thisShare;
        const maxForThisGoal = Math.max(0, 100 - otherTotal);
        const left = Math.max(0, 100 - total);
        const overBy = Math.max(0, total - 100);
        return {
          account,
          thisShare,
          otherAllocations,
          otherTotal,
          total,
          maxForThisGoal,
          left,
          overBy,
        };
      })
      .filter((row) => sharePercents.has(row.account.id) || row.total > SHARE_EPSILON);
  }, [activeAccounts, otherFundingRules, sharePercents]);

  const allocationByAccountId = useMemo(
    () => new Map(allocationRows.map((row) => [row.account.id, row])),
    [allocationRows],
  );

  const invalidAllocationRows = useMemo(
    () =>
      allocationRows.filter(
        (row) => sharePercents.has(row.account.id) && row.overBy > SHARE_EPSILON,
      ),
    [allocationRows, sharePercents],
  );
  const hasInvalidAllocations = invalidAllocationRows.length > 0;

  const addAccount = (accountId: string) => {
    const maxForThisGoal = Math.max(0, 100 - (otherShareByAccount.get(accountId) ?? 0));
    setSharePercents((prev) => new Map(prev).set(accountId, Math.min(100, maxForThisGoal)));
    setDirty(true);
  };

  const removeAccount = useCallback((accountId: string) => {
    setSharePercents((prev) => {
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
    setTaxBuckets((prev) => {
      const next = new Map(prev);
      next.delete(accountId);
      return next;
    });
    setDirty(true);
  }, []);

  const updateSharePercent = useCallback((accountId: string, value: number) => {
    setSharePercents((prev) => new Map(prev).set(accountId, Math.max(0, Math.min(100, value))));
    setDirty(true);
  }, []);

  const cycleTaxBucket = useCallback((accountId: string) => {
    const order = ["taxable", "tax_deferred", "tax_free"];
    setTaxBuckets((prev) => {
      const next = new Map(prev);
      const current = prev.get(accountId);
      const idx = current ? order.indexOf(current) : -1;
      next.set(accountId, order[(idx + 1) % order.length]);
      return next;
    });
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    if (hasInvalidAllocations) return;
    const rules: GoalFundingRuleInput[] = [];
    for (const [accountId, percent] of sharePercents) {
      rules.push({
        accountId,
        sharePercent: percent,
        taxBucket: isRetirement ? taxBuckets.get(accountId) : undefined,
      });
    }
    saveFundingMutation.mutate(rules);
    setDirty(false);
    setEditing(false);
  }, [
    hasInvalidAllocations,
    sharePercents,
    taxBuckets,
    isRetirement,
    saveFundingMutation,
    setEditing,
  ]);

  const handleCancel = useCallback(() => {
    resetDraft();
    setEditing(false);
  }, [resetDraft, setEditing]);

  const dcLinkedSet = useMemo(() => new Set(dcLinkedAccountIds), [dcLinkedAccountIds]);

  const includedAccounts = useMemo(
    () => activeAccounts.filter((a) => sharePercents.has(a.id)),
    [activeAccounts, sharePercents],
  );

  const availableAccounts = activeAccounts.filter(
    (a) =>
      !sharePercents.has(a.id) &&
      !dcLinkedSet.has(a.id) &&
      (otherShareByAccount.get(a.id) ?? 0) < 100 - SHARE_EPSILON,
  );

  const allocationGoalColumns = useMemo(() => {
    const idsWithAllocation = new Set<string>();
    if (sharePercents.size > 0) idsWithAllocation.add(goalId);
    for (const rule of otherFundingRules) idsWithAllocation.add(rule.goalId);

    const columns = participatingGoals
      .filter((goal) => idsWithAllocation.has(goal.id))
      .map((goal) => ({ id: goal.id, title: goal.title }));

    if (sharePercents.size > 0 && !columns.some((goal) => goal.id === goalId)) {
      columns.unshift({ id: goalId, title: currentGoal?.title ?? t("goals:funding.this_goal") });
    }

    return columns;
  }, [currentGoal?.title, goalId, otherFundingRules, participatingGoals, sharePercents.size, t]);

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between pb-4">
          <CardTitle className="text-md leading-none tracking-tight">
            {t("goals:funding.account_shares")}
          </CardTitle>
          {isEditing ? (
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setDetailsOpen(true)}
              >
                {t("common:details")}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleCancel}>
                {t("common:cancel")}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSave}
                disabled={saveFundingMutation.isPending || !dirty || hasInvalidAllocations}
              >
                {saveFundingMutation.isPending ? t("goals:funding.saving") : t("common:save")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4 transition-colors"
              >
                {t("common:details")}
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={t("goals:funding.edit_account_shares")}
                className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1.5 text-sm transition-colors"
              >
                <Icons.Pencil className="h-3.5 w-3.5" />
                {t("common:edit")}
              </button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isEditing ? (
            /* ── Edit mode ── */
            <div className="space-y-3">
              {!isRetirement && (
                <p className="text-muted-foreground text-[10px]">
                  {t("goals:funding.reserved_share_note")}
                </p>
              )}

              {includedAccounts.length > 0 && (
                <div className="space-y-1">
                  {includedAccounts.map((a) => {
                    const isDcLinked = dcLinkedSet.has(a.id);
                    const tb = taxBuckets.get(a.id);
                    const percent = sharePercents.get(a.id) ?? 100;
                    const allocation = allocationByAccountId.get(a.id);
                    const overBy = allocation?.overBy ?? 0;
                    const maxForThisGoal = allocation?.maxForThisGoal ?? 100;
                    const otherTotal = allocation?.otherTotal ?? 0;
                    const hasOverage = overBy > SHARE_EPSILON;

                    return (
                      <div
                        key={a.id}
                        className={`rounded-lg px-3 py-2.5 ${
                          hasOverage ? "bg-destructive/5 ring-destructive/30 ring-1" : "bg-muted/30"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                            {a.name}
                          </span>

                          {/* Tax bucket pill (retirement only) */}
                          {isRetirement && !isDcLinked && (
                            <button
                              onClick={() => cycleTaxBucket(a.id)}
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                tb
                                  ? (TAX_BUCKET_COLORS[tb] ?? "")
                                  : "bg-muted text-muted-foreground"
                              }`}
                              title={t("goals:funding.change_tax_bucket")}
                            >
                              {tb
                                ? t(`goals:funding.tax_bucket.${tb}`)
                                : t("goals:funding.set_type")}
                            </button>
                          )}

                          {!isDcLinked && allocation && (
                            <span
                              className={`w-16 shrink-0 text-right text-[11px] font-medium tabular-nums ${allocationLabelClass(allocation)}`}
                            >
                              {allocationLabel(allocation, t)}
                            </span>
                          )}

                          {/* Share % input */}
                          {!isDcLinked && (
                            <SharePercentInput
                              value={percent}
                              onChange={(value) => updateSharePercent(a.id, value)}
                            />
                          )}

                          {/* DC linked badge */}
                          {isDcLinked && (
                            <Tooltip>
                              <TooltipTrigger>
                                <span className="text-muted-foreground flex items-center gap-0.5 text-[10px]">
                                  <Icons.ShieldCheck className="h-3 w-3" />{" "}
                                  {t("goals:funding.pension")}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                {t("goals:funding.pension_tooltip")}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {/* Remove button */}
                          {!isDcLinked && (
                            <button
                              onClick={() => removeAccount(a.id)}
                              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors"
                              aria-label={t("goals:funding.remove_account", { name: a.name })}
                            >
                              <Icons.X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        {allocation && !isDcLinked && (
                          <div className="mt-2">
                            {(otherTotal > SHARE_EPSILON || hasOverage) && (
                              <div className="text-muted-foreground flex items-center justify-between gap-3 text-[10px]">
                                <span className="truncate">
                                  {otherTotal > SHARE_EPSILON
                                    ? t("goals:funding.used_by_other_goals", {
                                        percent: formatShare(otherTotal),
                                      })
                                    : t("goals:funding.still_unassigned", {
                                        percent: formatShare(allocation.left),
                                      })}
                                </span>
                                {hasOverage && (
                                  <button
                                    type="button"
                                    className="text-destructive shrink-0 font-medium underline underline-offset-2"
                                    onClick={() => updateSharePercent(a.id, maxForThisGoal)}
                                  >
                                    {t("goals:funding.use_max", {
                                      percent: formatShare(maxForThisGoal),
                                    })}
                                  </button>
                                )}
                              </div>
                            )}
                            {hasOverage && (
                              <p className="text-destructive mt-1 text-[10px]">
                                {t("goals:funding.overallocated", {
                                  percent: formatShare(overBy),
                                })}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Available accounts to add */}
              {availableAccounts.length > 0 && (
                <div className="space-y-1">
                  <p className="text-muted-foreground px-1 text-[10px] uppercase tracking-wider">
                    {t("goals:funding.add_accounts")}
                  </p>
                  {availableAccounts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => addAccount(a.id)}
                      className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
                    >
                      <Icons.Plus className="text-muted-foreground h-3 w-3 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-xs">{a.name}</span>
                      <span className="text-muted-foreground text-[10px]">{a.accountType}</span>
                    </button>
                  ))}
                </div>
              )}

              {activeAccounts.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  {t("goals:funding.no_active_accounts")}
                </p>
              )}

              {hasInvalidAllocations && (
                <div className="text-destructive bg-destructive/5 rounded-lg px-3 py-2 text-[11px]">
                  {t("goals:funding.accounts_exceed_share", {
                    count: invalidAllocationRows.length,
                  })}
                </div>
              )}
            </div>
          ) : (
            /* ── Read mode ── */
            <div>
              {includedAccounts.length === 0 ? (
                <p className="text-muted-foreground py-2 text-xs">
                  {t("goals:funding.no_accounts_assigned")}{" "}
                  <button
                    className="text-foreground underline underline-offset-2"
                    onClick={() => setEditing(true)}
                  >
                    {t("goals:funding.add_accounts_action")}
                  </button>
                </p>
              ) : (
                <div className="divide-border divide-y">
                  {includedAccounts.map((a, i) => {
                    const percent = sharePercents.get(a.id) ?? 0;
                    const tb = taxBuckets.get(a.id);
                    const tbLabel = tb ? t(`goals:funding.tax_bucket.${tb}`) : null;
                    return (
                      <div
                        key={a.id}
                        className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded"
                          style={{ backgroundColor: INDICATOR_COLORS[i % INDICATOR_COLORS.length] }}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {a.name}
                        </span>
                        {isRetirement && tbLabel && (
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tb ? (TAX_BUCKET_COLORS[tb] ?? "") : ""}`}
                          >
                            {tbLabel}
                          </span>
                        )}
                        <span className="text-sm font-semibold tabular-nums">{percent}%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <AllocationDetailsSheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        rows={allocationRows}
        goalColumns={allocationGoalColumns}
        currentGoalId={goalId}
      />
    </>
  );
}

function AllocationDetailsSheet({
  open,
  onOpenChange,
  rows,
  goalColumns,
  currentGoalId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: AccountAllocationRow[];
  goalColumns: { id: string; title: string }[];
  currentGoalId: string;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-3xl">
        <SheetHeader className="border-border border-b px-6 py-5">
          <SheetTitle>{t("goals:funding.allocation_details")}</SheetTitle>
          <SheetDescription>{t("goals:funding.allocation_details_description")}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("goals:funding.no_active_shares")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-[10px] uppercase tracking-[0.18em]">
                    <th className="border-border border-b py-2 pr-4 font-medium">
                      {t("common:account")}
                    </th>
                    {goalColumns.map((goal) => (
                      <th
                        key={goal.id}
                        className="border-border border-b px-3 py-2 text-right font-medium"
                      >
                        {goal.id === currentGoalId ? t("goals:funding.this_goal") : goal.title}
                      </th>
                    ))}
                    <th className="border-border border-b px-3 py-2 text-right font-medium">
                      {t("goals:funding.free")}
                    </th>
                    <th className="border-border border-b py-2 pl-3 text-right font-medium">
                      {t("common:total")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isOver = row.overBy > SHARE_EPSILON;
                    return (
                      <tr key={row.account.id}>
                        <td className="border-border border-b py-3 pr-4">
                          <div className="font-medium">{row.account.name}</div>
                          <div className="text-muted-foreground text-xs">
                            {row.account.accountType}
                          </div>
                        </td>
                        {goalColumns.map((goal) => (
                          <td
                            key={goal.id}
                            className="border-border border-b px-3 py-3 text-right tabular-nums"
                          >
                            {formatShare(shareForGoal(row, goal.id, currentGoalId))}%
                          </td>
                        ))}
                        <td className="border-border border-b px-3 py-3 text-right tabular-nums">
                          {formatShare(row.left)}%
                        </td>
                        <td
                          className={`border-border border-b py-3 pl-3 text-right font-semibold tabular-nums ${
                            isOver ? "text-destructive" : ""
                          }`}
                        >
                          {formatShare(row.total)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function shareForGoal(row: AccountAllocationRow, goalId: string, currentGoalId: string): number {
  if (goalId === currentGoalId) return row.thisShare;
  return row.otherAllocations
    .filter((allocation) => allocation.goalId === goalId)
    .reduce((sum, allocation) => sum + allocation.sharePercent, 0);
}
