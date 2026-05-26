import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  PrivacyAmount,
  useIsMobile,
} from "@wealthfolio/ui";
import { Switch } from "@wealthfolio/ui/components/ui/switch";

import { cn } from "@/lib/utils";

import { useBudget, useBudgetMutations } from "../hooks/use-budget";
import { FOREST_THEME } from "../lib/theme";
import type {
  BudgetCategoryRow,
  BudgetGroup,
  BudgetGroupRow,
  BudgetRolloverSetting,
  BudgetSnapshot,
  BudgetTarget,
} from "../types/budget";

import { AmountInput } from "./amount-input";
import { CategoryIcon } from "./category-chips";
import { EXTENDED_PALETTE } from "./color-picker";
import { IconPicker } from "./icon-picker";

const SPENDING_TAXONOMY = "spending_categories";
const CARD_CLASS = "border-border/60 bg-card/40 shadow-xs rounded-xl border backdrop-blur-xl";

export type BudgetEditorMode = "setup" | "monthly";

interface BudgetEditorProps {
  mode: BudgetEditorMode;
  periodKey: string;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function BudgetEditor({ mode, periodKey }: BudgetEditorProps) {
  const { data: budget, isLoading: budgetLoading, error, refetch } = useBudget(periodKey);
  const mutations = useBudgetMutations(periodKey);

  const periodForWrite = periodKey || "default";
  const monthMode = mode === "monthly";
  const currency = budget?.computed.currency ?? "USD";
  const targets = budget?.state.targets ?? [];
  const rolloverSettings = budget?.state.rolloverSettings ?? [];
  const groups = budget?.state.groups ?? [];

  const saveGroupBuffer = (row: BudgetGroupRow, amount: string) => {
    mutations.upsertTarget.mutate({
      periodKey: periodForWrite,
      targetType: "group_buffer",
      groupId: row.group.id,
      amount: amount || "0",
    });
  };

  const saveCategoryTarget = (row: BudgetCategoryRow, amount: string) => {
    mutations.upsertTarget.mutate({
      periodKey: periodForWrite,
      targetType: "category",
      taxonomyId: row.taxonomyId,
      categoryId: row.categoryId,
      amount: amount || "0",
    });
  };

  const deleteMonthOverride = (target: BudgetTarget | undefined) => {
    if (target) mutations.removeTarget.mutate(target.id);
  };

  if (budgetLoading) return <BudgetSkeleton />;
  if (error) return <BudgetErrorState error={error} onRetry={() => refetch()} />;
  if (!budget) return null;

  // Pool of categories the user can pull *into* a given group. Other groups'
  // top-level categories + any top-level ungrouped strays. Subcategories are
  // excluded because they inherit a group through their parent and aren't
  // valid direct targets for `budget_group_assignments`.
  const allCategoryPool: CategoryPoolEntry[] = [
    ...budget.computed.groupRows.flatMap((g) =>
      g.categories
        .filter((c) => !c.parentId)
        .map((c) => ({
          category: c,
          fromGroupId: g.group.id,
          fromGroupName: g.group.name,
        })),
    ),
    ...budget.computed.ungroupedRows
      .filter((c) => !c.parentId)
      .map((c) => ({
        category: c,
        fromGroupId: null,
        fromGroupName: null,
      })),
  ];

  const groupSection = (
    <div className="space-y-2">
      {budget.computed.groupRows.map((row) => (
        <GroupBudgetSection
          key={row.group.id}
          row={row}
          groups={groups}
          targets={targets}
          rolloverSettings={rolloverSettings}
          currency={currency}
          periodKey={periodForWrite}
          monthMode={monthMode}
          mode={mode}
          categoryPool={allCategoryPool}
          onSaveGroupBuffer={saveGroupBuffer}
          onSaveCategoryTarget={saveCategoryTarget}
          onDeleteOverride={deleteMonthOverride}
          onMoveCategory={(categoryId, groupId) =>
            mutations.assignCategory.mutate({ categoryId, groupId })
          }
          onUpdateGroup={(patch) => mutations.updateGroup.mutate({ id: row.group.id, patch })}
          onDeleteGroup={() => {
            const target =
              groups.find((g) => g.key === "other" && g.id !== row.group.id) ??
              groups.find((g) => g.id !== row.group.id);
            if (target) {
              mutations.removeGroup.mutate({
                id: row.group.id,
                reassignToGroupId: target.id,
              });
            }
          }}
          canDelete={!row.group.isSystem && groups.some((g) => g.id !== row.group.id)}
          deletePending={mutations.removeGroup.isPending}
          onSaveGroupRollover={(enabled, startingBalance) =>
            mutations.upsertRollover.mutate({
              targetType: "group",
              groupId: row.group.id,
              enabled,
              startMonth: monthMode ? periodForWrite : currentMonthKey(),
              startingBalance:
                startingBalance ??
                findGroupRollover(rolloverSettings, row.group.id)?.startingBalance ??
                "0",
            })
          }
          onToggleCategoryRollover={(category, enabled) =>
            mutations.upsertRollover.mutate({
              targetType: "category",
              taxonomyId: SPENDING_TAXONOMY,
              categoryId: category.categoryId,
              enabled,
              startMonth: monthMode ? periodForWrite : currentMonthKey(),
              startingBalance:
                findCategoryRollover(rolloverSettings, category.categoryId)?.startingBalance ?? "0",
            })
          }
        />
      ))}

      {mode === "setup" && (
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              mutations.createGroup.mutate({
                name: "New group",
                color: FOREST_THEME.deep,
                icon: "Folder",
              })
            }
            className="text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2 text-xs"
          >
            <Icons.Plus className="h-3.5 w-3.5" />
            Add group
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => mutations.resetGroups.mutate()}
            className="text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2 text-xs"
          >
            <Icons.Refresh className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  );

  const incomePanel = (
    <IncomeSourcesPanel
      rows={budget.computed.incomeRows}
      targets={targets}
      currency={currency}
      periodKey={periodForWrite}
      monthMode={monthMode}
      mode={mode}
      onSaveTarget={saveCategoryTarget}
      onDeleteOverride={deleteMonthOverride}
    />
  );

  if (mode === "monthly") {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <BudgetSummary budget={budget} currency={currency} mode={mode} />
          <BudgetFxNote budget={budget} currency={currency} />
          {groupSection}
        </div>
        <div className="space-y-4">
          {incomePanel}
          <CopyFromMonthRow
            currentPeriodKey={periodForWrite}
            onCopy={(sourcePeriodKey, overwrite) =>
              mutations.copyFromMonth.mutate({ sourcePeriodKey, overwrite })
            }
            pending={mutations.copyFromMonth.isPending}
          />
          <OverridesSummary
            budget={budget}
            periodKey={periodForWrite}
            currency={currency}
            onRevert={(target) => mutations.removeTarget.mutate(target.id)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <BudgetSummary budget={budget} currency={currency} mode={mode} />
      {groupSection}
      {incomePanel}
      <BudgetTotalsPanel totals={budget.computed.totals} currency={currency} />
    </div>
  );
}

function BudgetSummary({
  budget,
  currency,
  mode,
}: {
  budget: BudgetSnapshot;
  currency: string;
  mode: BudgetEditorMode;
}) {
  const totals = budget.computed.totals;
  const groupRows = budget.computed.groupRows;
  const planned = totals.spendingPlanned;
  const income = totals.incomePlanned;
  const denominator = income > 0 ? income : planned;
  const allocatedPct = denominator > 0 ? planned / denominator : 0;
  const fullyAllocated = income > 0 && Math.abs(income - planned) < 0.01;
  const overAllocated = income > 0 && planned > income;
  const hasPlan = planned > 0;
  const headingLabel = mode === "setup" ? "Default monthly plan" : "Monthly plan";

  return (
    <section className={cn(CARD_CLASS, "overflow-hidden p-3 sm:p-4")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.08em]">
            {headingLabel}
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-foreground truncate text-lg font-semibold tabular-nums tracking-tight sm:text-xl">
              <PrivacyAmount value={planned} currency={currency} />
            </span>
            {income > 0 && (
              <span className="text-muted-foreground truncate text-[11px]">
                / <PrivacyAmount value={income} currency={currency} />
              </span>
            )}
          </div>
        </div>
        <div
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            fullyAllocated
              ? "bg-success/10 text-success"
              : overAllocated
                ? "bg-destructive/10 text-destructive"
                : "bg-muted/60 text-muted-foreground",
          )}
        >
          {fullyAllocated ? (
            <Icons.Check className="h-3 w-3" />
          ) : overAllocated ? (
            <Icons.AlertCircle className="h-3 w-3" />
          ) : null}
          <span className="tabular-nums">{formatPercent(allocatedPct)}</span>
        </div>
      </div>

      <SegmentedGroupBar groupRows={groupRows} total={planned} hasPlan={hasPlan} />

      <div className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
        {groupRows.map((row) => (
          <GroupSummaryCell
            key={row.group.id}
            row={row}
            currency={currency}
            denominator={denominator}
          />
        ))}
      </div>
    </section>
  );
}

function BudgetFxNote({ budget, currency }: { budget: BudgetSnapshot; currency: string }) {
  if (!budget.computed.fxAsOf) return null;

  return (
    <div className="border-border/60 bg-muted/30 text-muted-foreground rounded-lg border px-3 py-2 text-xs">
      Targets are entered in {currency}; actuals use FX rates around {budget.computed.fxAsOf}.
    </div>
  );
}

function SegmentedGroupBar({
  groupRows,
  total,
  hasPlan,
}: {
  groupRows: BudgetGroupRow[];
  total: number;
  hasPlan: boolean;
}) {
  if (!hasPlan) {
    return (
      <div className="bg-muted/40 mt-3 h-1.5 rounded-full">
        <div className="sr-only">No budget allocated yet</div>
      </div>
    );
  }

  const visibleRows = groupRows.filter((row) => row.plannedTotal > 0);

  return (
    <div className="bg-muted/40 mt-3 flex h-1.5 overflow-hidden rounded-full">
      {visibleRows.map((row) => (
        <div
          key={row.group.id}
          className="min-w-[3px] transition-all"
          style={{
            width: `${Math.max(1, safePercent(row.plannedTotal, total) * 100)}%`,
            backgroundColor: row.group.color ?? FOREST_THEME.deep,
          }}
        />
      ))}
    </div>
  );
}

function GroupSummaryCell({
  row,
  currency,
  denominator,
}: {
  row: BudgetGroupRow;
  currency: string;
  denominator: number;
}) {
  const accent = row.group.color ?? FOREST_THEME.deep;
  const pct = safePercent(row.plannedTotal, denominator);
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: accent }}
        aria-hidden
      />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">{row.group.name}</span>
      <span className="text-muted-foreground w-8 shrink-0 text-right text-[10px] tabular-nums">
        {formatPercent(pct)}
      </span>
      <span className="text-foreground shrink-0 text-xs font-medium tabular-nums">
        <PrivacyAmount value={row.plannedTotal} currency={currency} />
      </span>
    </div>
  );
}

interface CategoryPoolEntry {
  category: BudgetCategoryRow;
  fromGroupId: string | null;
  fromGroupName: string | null;
}

function GroupBudgetSection({
  row,
  groups,
  targets,
  rolloverSettings,
  currency,
  periodKey,
  monthMode,
  mode,
  categoryPool,
  canDelete,
  deletePending,
  onSaveGroupBuffer,
  onSaveCategoryTarget,
  onDeleteOverride,
  onMoveCategory,
  onUpdateGroup,
  onDeleteGroup,
  onSaveGroupRollover,
  onToggleCategoryRollover,
}: {
  row: BudgetGroupRow;
  groups: BudgetGroup[];
  targets: BudgetTarget[];
  rolloverSettings: BudgetRolloverSetting[];
  currency: string;
  periodKey: string;
  monthMode: boolean;
  mode: BudgetEditorMode;
  categoryPool: CategoryPoolEntry[];
  canDelete: boolean;
  deletePending: boolean;
  onSaveGroupBuffer: (row: BudgetGroupRow, amount: string) => void;
  onSaveCategoryTarget: (row: BudgetCategoryRow, amount: string) => void;
  onDeleteOverride: (target: BudgetTarget | undefined) => void;
  onMoveCategory: (categoryId: string, groupId: string) => void;
  onUpdateGroup: (patch: { name?: string; color?: string | null; icon?: string | null }) => void;
  onDeleteGroup: () => void;
  onSaveGroupRollover: (enabled: boolean, startingBalance?: string) => void;
  onToggleCategoryRollover: (row: BudgetCategoryRow, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const groupOverride = findGroupBufferTarget(targets, periodKey, row.group.id);
  const groupRollover = findGroupRollover(rolloverSettings, row.group.id);
  const accent = row.group.color ?? FOREST_THEME.deep;
  const spentPct = safePercent(Math.max(0, row.actual), row.plannedTotal);
  const totalSuffix = mode === "setup" ? "/ default month" : "/ month";

  return (
    <section className={cn(CARD_CLASS, "overflow-hidden")}>
      <div className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground -ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors"
          aria-label={open ? "Collapse group" : "Expand group"}
          aria-expanded={open}
        >
          <Icons.ChevronRight
            className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
          />
        </button>

        <button
          type="button"
          onClick={() => mode === "setup" && setEditOpen(true)}
          disabled={mode !== "setup"}
          className="ring-offset-background focus-visible:ring-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 enabled:hover:scale-105 disabled:cursor-default disabled:hover:scale-100"
          style={{ backgroundColor: `${accent}1f`, color: accent }}
          aria-label={mode === "setup" ? `Edit ${row.group.name}` : row.group.name}
        >
          <CategoryIcon icon={row.group.icon ?? null} className="h-3.5 w-3.5" />
        </button>

        {mode === "setup" && (
          <GroupEditDialog
            group={row.group}
            color={accent}
            open={editOpen}
            onOpenChange={setEditOpen}
            onUpdate={onUpdateGroup}
            rolloverEnabled={groupRollover?.enabled ?? false}
            rolloverStartingBalance={groupRollover?.startingBalance ?? "0"}
            onSaveRollover={onSaveGroupRollover}
          />
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="text-foreground truncate text-sm font-semibold">{row.group.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <div className="bg-muted/40 h-1 w-16 shrink-0 overflow-hidden rounded-full sm:w-20">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, spentPct * 100)}%`,
                  backgroundColor: accent,
                }}
              />
            </div>
            <span className="text-muted-foreground truncate text-[10px] tabular-nums">
              <PrivacyAmount value={row.actual} currency={currency} /> /{" "}
              <PrivacyAmount value={row.plannedTotal} currency={currency} />
            </span>
          </div>
        </button>

        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            <PrivacyAmount value={row.plannedTotal} currency={currency} />
          </div>
          <div className="text-muted-foreground text-[9px] uppercase tracking-wide">
            {totalSuffix}
          </div>
        </div>

        {mode === "setup" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-7 w-7 shrink-0 p-0"
                aria-label="Group actions"
              >
                <Icons.MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-muted-foreground/70 text-[10px] font-normal uppercase tracking-wide">
                {row.categories.length} {row.categories.length === 1 ? "category" : "categories"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setEditOpen(true);
                }}
                className="text-xs"
              >
                <Icons.Pencil className="mr-2 h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  onSaveGroupRollover(!groupRollover?.enabled);
                }}
                className="text-xs"
              >
                <Icons.Refresh className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">Group rollover</span>
                <span className="text-muted-foreground text-[10px]">
                  {groupRollover?.enabled ? "On" : "Off"}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canDelete}
                onSelect={(event) => {
                  event.preventDefault();
                  if (canDelete) setConfirmDeleteOpen(true);
                }}
                className="text-destructive focus:text-destructive text-xs"
              >
                <Icons.Trash className="mr-2 h-3.5 w-3.5" />
                Delete group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {mode === "setup" && (
        <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {row.group.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {row.categories.length > 0
                  ? `Its ${row.categories.length} ${
                      row.categories.length === 1 ? "category" : "categories"
                    } will be moved to another group. This can't be undone.`
                  : "This can't be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  onDeleteGroup();
                  setConfirmDeleteOpen(false);
                }}
                disabled={deletePending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deletePending ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {open && (
        <div className="border-border/30 border-t">
          <GroupBufferLine
            row={row}
            target={groupOverride}
            monthMode={monthMode}
            mode={mode}
            onSaveGroupBuffer={onSaveGroupBuffer}
            onDeleteOverride={onDeleteOverride}
          />
          {row.categories.map((category) => (
            <BudgetCategoryLine
              key={category.categoryId}
              row={category}
              groups={groups}
              target={findCategoryTarget(
                targets,
                periodKey,
                category.taxonomyId,
                category.categoryId,
              )}
              currency={currency}
              groupTotal={row.plannedTotal}
              monthMode={monthMode}
              mode={mode}
              groupRolloverEnabled={row.rolloverEnabled}
              onSaveTarget={onSaveCategoryTarget}
              onDeleteOverride={onDeleteOverride}
              onMoveCategory={onMoveCategory}
              onToggleRollover={onToggleCategoryRollover}
            />
          ))}
          {mode === "setup" && (
            <AddCategoryRow
              groupId={row.group.id}
              groupName={row.group.name}
              pool={categoryPool.filter((entry) => entry.fromGroupId !== row.group.id)}
              onMoveCategory={onMoveCategory}
            />
          )}
        </div>
      )}
    </section>
  );
}

function AddCategoryRow({
  groupId,
  groupName,
  pool,
  onMoveCategory,
}: {
  groupId: string;
  groupName: string;
  pool: CategoryPoolEntry[];
  onMoveCategory: (categoryId: string, groupId: string) => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{
    categoryId: string;
    categoryName: string;
    fromGroupName: string;
  } | null>(null);

  const handlePick = (entry: CategoryPoolEntry) => {
    if (entry.fromGroupName) {
      // Always confirm when moving from another group — the source group
      // loses the category, which can shift its allocation surface area.
      setPendingMove({
        categoryId: entry.category.categoryId,
        categoryName: entry.category.name,
        fromGroupName: entry.fromGroupName,
      });
      setOpen(false);
    } else {
      onMoveCategory(entry.category.categoryId, groupId);
      setOpen(false);
    }
  };

  const trigger = (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground hover:bg-muted/40 border-border/40 group flex w-full items-center gap-2 border-t border-dashed px-3 py-2 text-left transition-colors sm:px-4"
    >
      <span className="border-border/50 group-hover:border-foreground/30 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-dashed">
        <Icons.Plus className="h-3 w-3" />
      </span>
      <span className="text-xs">Add category</span>
    </button>
  );

  const emptyState = (
    <div className="text-muted-foreground p-4 text-xs">
      No other categories available. Create one in{" "}
      <Link
        to="/settings/spending/categories?tab=expense"
        className="text-foreground underline-offset-2 hover:underline"
      >
        Manage categories
      </Link>
      .
    </div>
  );

  const list = (
    <div className={cn("overflow-y-auto", isMobile ? "max-h-[55vh]" : "max-h-72")}>
      {pool.map((entry, idx) => {
        const accent = entry.category.color ?? FOREST_THEME.deep;
        return (
          <button
            key={entry.category.categoryId}
            type="button"
            onClick={() => handlePick(entry)}
            className={cn(
              "active:bg-muted/80 hover:bg-muted/50 flex w-full items-center gap-3 text-left transition-colors",
              isMobile ? "px-4 py-3" : "px-3 py-2",
              idx > 0 && "border-border/40 border-t",
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md",
                isMobile ? "h-8 w-8" : "h-6 w-6",
              )}
              style={{ backgroundColor: `${accent}1f`, color: accent }}
              aria-hidden
            >
              <CategoryIcon
                icon={entry.category.icon ?? null}
                className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-foreground truncate", isMobile ? "text-base" : "text-sm")}>
                {entry.category.name}
              </div>
              {entry.fromGroupName && (
                <div className="text-muted-foreground truncate text-xs">
                  from {entry.fromGroupName}
                </div>
              )}
            </div>
            <Icons.ChevronRight className="text-muted-foreground/60 h-4 w-4 shrink-0" />
          </button>
        );
      })}
    </div>
  );

  const footer = (
    <Link
      to="/settings/spending/categories?tab=expense"
      className={cn(
        "text-foreground hover:bg-muted/40 active:bg-muted/60 border-border/60 flex w-full items-center gap-3 border-t transition-colors",
        isMobile ? "px-4 py-4" : "px-3 py-2.5 text-sm",
      )}
    >
      <span
        className={cn(
          "border-border bg-muted/40 flex shrink-0 items-center justify-center rounded-md border border-dashed",
          isMobile ? "h-8 w-8" : "h-6 w-6",
        )}
        aria-hidden
      >
        <Icons.Plus className={isMobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </span>
      <span className={cn("font-medium", isMobile ? "text-base" : "text-sm")}>
        Create new category
      </span>
    </Link>
  );

  return (
    <>
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent side="bottom" showCloseButton={false} className="pb-safe rounded-t-2xl p-0">
            {/* iOS-style drag indicator — backdrop tap and swipe-down dismiss the sheet */}
            <div className="flex justify-center pb-1 pt-2">
              <div className="bg-muted-foreground/30 h-1 w-10 rounded-full" />
            </div>
            <SheetHeader className="px-4 pb-3 pt-1 text-left">
              <SheetTitle className="text-base">Add category to {groupName}</SheetTitle>
            </SheetHeader>
            {pool.length === 0 ? (
              emptyState
            ) : (
              <div className="border-border/60 border-t">{list}</div>
            )}
            {pool.length > 0 && footer}
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            {pool.length === 0 ? (
              emptyState
            ) : (
              <>
                <div className="text-muted-foreground border-border/60 border-b px-3 py-2 text-[10px] font-medium uppercase tracking-widest">
                  Move existing category
                </div>
                {list}
                {footer}
              </>
            )}
          </PopoverContent>
        </Popover>
      )}

      <AlertDialog
        open={pendingMove !== null}
        onOpenChange={(o) => {
          if (!o) setPendingMove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move {pendingMove?.categoryName} to {groupName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMove?.categoryName} is currently in {pendingMove?.fromGroupName}. Moving it
              re-groups its budget total under {groupName}. The category's target amount and history
              are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingMove) {
                  onMoveCategory(pendingMove.categoryId, groupId);
                  setPendingMove(null);
                }
              }}
            >
              Move category
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface GroupEditDialogProps {
  group: BudgetGroup;
  color: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (patch: { name?: string; color?: string | null; icon?: string | null }) => void;
  rolloverEnabled: boolean;
  rolloverStartingBalance: string;
  onSaveRollover: (enabled: boolean, startingBalance?: string) => void;
}

function GroupEditDialog(props: GroupEditDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mount the body only when open so its useState initializes from the
            current props each time — kills the prop-to-state mirror effect. */}
        {props.open && <GroupEditDialogBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function GroupEditDialogBody({
  group,
  color,
  onOpenChange,
  onUpdate,
  rolloverEnabled,
  rolloverStartingBalance,
  onSaveRollover,
}: GroupEditDialogProps) {
  const [draftName, setDraftName] = useState(group.name);
  const [draftColor, setDraftColor] = useState(color);
  const [draftIcon, setDraftIcon] = useState<string | null>(group.icon ?? null);
  const [draftRollover, setDraftRollover] = useState(rolloverEnabled);
  const [draftStartingBalance, setDraftStartingBalance] = useState(rolloverStartingBalance);

  const handleSave = () => {
    const patch: { name?: string; color?: string | null; icon?: string | null } = {};
    const trimmedName = draftName.trim();
    if (trimmedName && trimmedName !== group.name) patch.name = trimmedName;
    if (draftColor !== color) patch.color = draftColor;
    if ((draftIcon ?? null) !== (group.icon ?? null)) patch.icon = draftIcon;
    if (Object.keys(patch).length > 0) onUpdate(patch);

    const balanceChanged =
      draftRollover && normalizeBalance(draftStartingBalance) !== rolloverStartingBalance;
    if (draftRollover !== rolloverEnabled || balanceChanged) {
      onSaveRollover(
        draftRollover,
        draftRollover ? normalizeBalance(draftStartingBalance) : undefined,
      );
    }
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md"
            style={{ backgroundColor: `${draftColor}1f`, color: draftColor }}
          >
            <CategoryIcon icon={draftIcon} className="h-4 w-4" />
          </span>
          Edit group
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
            Name
          </label>
          <div className="bg-muted/60 border-border/60 focus-within:ring-ring/50 flex h-9 items-center rounded-md border px-3 transition-shadow focus-within:ring-2">
            <input
              type="text"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSave();
              }}
              className="text-foreground placeholder:text-muted-foreground/50 w-full bg-transparent text-sm outline-none"
              autoFocus
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
            Color
          </label>
          <GroupColorSwatchGrid value={draftColor} onChange={setDraftColor} />
        </div>

        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
            Icon
          </label>
          <IconPicker value={draftIcon} accent={draftColor} onChange={setDraftIcon} />
        </div>

        <div className="border-border/40 space-y-2 border-t pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="text-foreground text-sm font-medium">Monthly rollover</div>
              <p className="text-muted-foreground text-[11px] leading-snug">
                Carry unspent budget into next month for this group.
              </p>
            </div>
            <Switch
              checked={draftRollover}
              onCheckedChange={setDraftRollover}
              aria-label="Enable monthly rollover"
            />
          </div>
          {draftRollover && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <label
                htmlFor="rollover-starting-balance"
                className="text-muted-foreground text-[11px]"
              >
                Starting balance
              </label>
              <div className="w-[120px]">
                <input
                  id="rollover-starting-balance"
                  type="text"
                  inputMode="decimal"
                  value={draftStartingBalance}
                  onChange={(event) => setDraftStartingBalance(event.target.value)}
                  placeholder="0"
                  className="bg-background border-input focus-visible:ring-ring/40 text-foreground placeholder:text-muted-foreground/70 h-8 w-full rounded-md border px-2 text-right text-xs tabular-nums outline-none focus-visible:ring-2"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!draftName.trim()}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

function BudgetCategoryLine({
  row,
  groups,
  target,
  currency,
  groupTotal,
  monthMode,
  mode,
  groupRolloverEnabled,
  onSaveTarget,
  onDeleteOverride,
  onMoveCategory,
  onToggleRollover,
}: {
  row: BudgetCategoryRow;
  groups: BudgetGroup[];
  target: BudgetTarget | undefined;
  currency: string;
  groupTotal: number;
  monthMode: boolean;
  mode: BudgetEditorMode;
  groupRolloverEnabled: boolean;
  onSaveTarget: (row: BudgetCategoryRow, amount: string) => void;
  onDeleteOverride: (target: BudgetTarget | undefined) => void;
  onMoveCategory: (categoryId: string, groupId: string) => void;
  onToggleRollover: (row: BudgetCategoryRow, enabled: boolean) => void;
}) {
  const accent = row.color ?? FOREST_THEME.deep;
  const hasOverride = monthMode && !!target;
  const overBudget = row.target > 0 && row.actual > row.target;
  const sharePct = safePercent(row.target, groupTotal);
  const usagePct = Math.min(1, safePercent(row.actual, row.target));

  return (
    <div className="group/row hover:bg-muted/15 flex items-center gap-2 px-3 py-1.5 text-xs transition-colors sm:gap-3 sm:px-4">
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `${accent}1f`, color: accent }}
        aria-hidden
      >
        <CategoryIcon icon={row.icon ?? null} className="h-3 w-3" />
      </span>
      <span className="text-foreground min-w-0 flex-1 truncate">{row.name}</span>

      <div className="relative w-[80px] shrink-0">
        <AmountInput value={row.target} onCommit={(value) => onSaveTarget(row, value)} />
        {hasOverride && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onDeleteOverride(target)}
                className="bg-warning/15 text-warning hover:bg-warning/25 border-background absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors"
                aria-label="Revert override"
              >
                <Icons.X className="h-2 w-2" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="text-xs">
              Month override · click to revert
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <span className="text-muted-foreground hidden w-8 shrink-0 text-right text-[10px] tabular-nums sm:inline">
        {formatPercent(sharePct)}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="bg-muted/50 hidden h-1 w-14 shrink-0 overflow-hidden rounded-full sm:block">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${usagePct * 100}%`,
                backgroundColor: overBudget ? "var(--destructive)" : accent,
              }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="text-xs">
          <PrivacyAmount value={row.actual} currency={currency} /> spent of{" "}
          <PrivacyAmount value={row.target} currency={currency} /> ({formatPercent(sharePct)} of
          group)
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0 p-0"
            aria-label="Row options"
          >
            <Icons.MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {mode === "setup" && (
            <>
              <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide">
                Move to group
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={row.groupId ?? ""}
                onValueChange={(value) => onMoveCategory(row.categoryId, value)}
              >
                {groups.map((group) => (
                  <DropdownMenuRadioItem key={group.id} value={group.id} className="text-xs">
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: group.color ?? FOREST_THEME.deep }}
                      />
                      {group.name}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={groupRolloverEnabled}
                onSelect={(event) => {
                  event.preventDefault();
                  onToggleRollover(row, !row.rolloverEnabled);
                }}
                className="text-xs"
              >
                <Icons.Refresh className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">Rollover</span>
                <span className="text-muted-foreground text-[10px]">
                  {groupRolloverEnabled ? "Group-wide" : row.rolloverEnabled ? "On" : "Off"}
                </span>
              </DropdownMenuItem>
            </>
          )}
          {hasOverride && (
            <>
              {mode === "setup" && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => onDeleteOverride(target)}
                className="text-warning text-xs"
              >
                <Icons.X className="mr-2 h-3.5 w-3.5" />
                Revert month override
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function GroupBufferLine({
  row,
  target,
  monthMode,
  mode,
  onSaveGroupBuffer,
  onDeleteOverride,
}: {
  row: BudgetGroupRow;
  target: BudgetTarget | undefined;
  monthMode: boolean;
  mode: BudgetEditorMode;
  onSaveGroupBuffer: (row: BudgetGroupRow, amount: string) => void;
  onDeleteOverride: (target: BudgetTarget | undefined) => void;
}) {
  const hasOverride = monthMode && !!target;
  const sharePct = safePercent(row.buffer, row.plannedTotal);
  const label = mode === "setup" ? "Group buffer default" : "Group buffer";
  return (
    <div className="hover:bg-muted/15 flex items-center gap-2 px-3 py-1.5 text-xs sm:gap-3 sm:px-4">
      <span
        className="border-muted-foreground/40 h-4 w-0.5 shrink-0 border-l border-dashed"
        aria-hidden
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground min-w-0 flex-1 truncate">{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-[220px] text-xs">
          Extra headroom for this group that isn't assigned to a category.
        </TooltipContent>
      </Tooltip>

      <div className="relative w-[80px] shrink-0">
        <AmountInput
          value={row.buffer}
          variant="dashed"
          onCommit={(value) => onSaveGroupBuffer(row, value)}
        />
        {hasOverride && (
          <button
            type="button"
            onClick={() => onDeleteOverride(target)}
            className="bg-warning/15 text-warning hover:bg-warning/25 border-background absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border transition-colors"
            aria-label="Revert override"
          >
            <Icons.X className="h-2 w-2" />
          </button>
        )}
      </div>

      <span className="text-muted-foreground hidden w-8 shrink-0 text-right text-[10px] tabular-nums sm:inline">
        {formatPercent(sharePct)}
      </span>
      <span className="hidden w-14 shrink-0 sm:block" aria-hidden />
      <span className="w-6 shrink-0" aria-hidden />
    </div>
  );
}

function IncomeSourcesPanel({
  rows,
  targets,
  currency,
  periodKey,
  monthMode,
  mode,
  onSaveTarget,
  onDeleteOverride,
}: {
  rows: BudgetCategoryRow[];
  targets: BudgetTarget[];
  currency: string;
  periodKey: string;
  monthMode: boolean;
  mode: BudgetEditorMode;
  onSaveTarget: (row: BudgetCategoryRow, amount: string) => void;
  onDeleteOverride: (target: BudgetTarget | undefined) => void;
}) {
  const title = mode === "setup" ? "Income defaults" : "Income";
  const isMonthly = mode === "monthly";
  const [showAll, setShowAll] = useState(false);

  const { total, nonZeroRows, hiddenCount } = useMemo(() => {
    let sum = 0;
    const nonZero: BudgetCategoryRow[] = [];
    for (const row of rows) {
      sum += row.target;
      if (row.target > 0) nonZero.push(row);
    }
    return { total: sum, nonZeroRows: nonZero, hiddenCount: rows.length - nonZero.length };
  }, [rows]);
  const visibleRows = isMonthly && !showAll ? nonZeroRows : rows;

  return (
    <section className={cn(CARD_CLASS, "p-3 sm:p-4")}>
      <div className="flex items-center justify-between">
        <PanelHeader title={title} icon={<Icons.Wallet className="h-3.5 w-3.5" />} />
        {isMonthly && (
          <span className="text-foreground text-xs font-semibold tabular-nums">
            <PrivacyAmount value={total} currency={currency} />
          </span>
        )}
      </div>
      <div className="mt-2 space-y-0.5">
        {rows.length === 0 ? (
          <EmptyPanelLine>No income categories yet.</EmptyPanelLine>
        ) : visibleRows.length === 0 ? (
          <EmptyPanelLine>No income set for this month.</EmptyPanelLine>
        ) : (
          visibleRows.map((row) => {
            const target = findCategoryTarget(targets, periodKey, row.taxonomyId, row.categoryId);
            const hasOverride = monthMode && !!target;
            return (
              <div key={row.categoryId} className="flex items-center gap-3 py-0.5">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-xs">{row.name}</div>
                  {hasOverride && (
                    <button
                      type="button"
                      onClick={() => onDeleteOverride(target)}
                      className="text-warning hover:text-warning/80 text-[10px] underline-offset-4 hover:underline"
                    >
                      Revert override
                    </button>
                  )}
                </div>
                <div className="w-[80px] shrink-0">
                  <AmountInput value={row.target} onCommit={(value) => onSaveTarget(row, value)} />
                </div>
              </div>
            );
          })
        )}
      </div>
      {isMonthly && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-[11px] underline-offset-4 hover:underline"
        >
          <Icons.Plus className="h-3 w-3" />
          {showAll ? "Hide empty sources" : `Add source (${hiddenCount} available)`}
        </button>
      )}
      {!isMonthly && (
        <div className="border-border/40 mt-2.5 flex items-center justify-between border-t pt-2.5">
          <span className="text-muted-foreground text-xs">Total default</span>
          <span className="text-sm font-semibold tabular-nums">
            <PrivacyAmount value={total} currency={currency} />
          </span>
        </div>
      )}
    </section>
  );
}

function GroupColorSwatchGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {EXTENDED_PALETTE.map((color) => {
        const isActive = value.toLowerCase() === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={cn(
              "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
              isActive ? "border-foreground" : "border-transparent",
            )}
            style={{ backgroundColor: color }}
            aria-label={`Use color ${color}`}
          />
        );
      })}
    </div>
  );
}

function OverridesSummary({
  budget,
  periodKey,
  currency,
  onRevert,
}: {
  budget: BudgetSnapshot;
  periodKey: string;
  currency: string;
  onRevert: (target: BudgetTarget) => void;
}) {
  // Memoize the two-map build + flatMap so we don't redo the O(n*m) walks on
  // every parent re-render of the budget editor.
  const overrides = useMemo(() => {
    const targets = budget.state.targets;
    const monthTargets = targets.filter((t) => t.periodKey === periodKey);
    if (monthTargets.length === 0) return [];

    const categoryRowByKey = new Map<string, BudgetCategoryRow>();
    for (const row of budget.computed.groupRows) {
      for (const cat of row.categories) {
        categoryRowByKey.set(`${cat.taxonomyId}:${cat.categoryId}`, cat);
      }
    }
    for (const row of budget.computed.incomeRows) {
      categoryRowByKey.set(`${row.taxonomyId}:${row.categoryId}`, row);
    }
    const groupById = new Map(budget.state.groups.map((g) => [g.id, g] as const));

    return monthTargets.flatMap((target) => {
      if (target.targetType === "category" && target.taxonomyId && target.categoryId) {
        const row = categoryRowByKey.get(`${target.taxonomyId}:${target.categoryId}`);
        if (!row) return [];
        const defaultTarget = targets.find(
          (t) =>
            t.periodKey === "default" &&
            t.targetType === "category" &&
            t.taxonomyId === target.taxonomyId &&
            t.categoryId === target.categoryId,
        );
        const defaultAmount = defaultTarget ? Number.parseFloat(defaultTarget.amount) : 0;
        const monthAmount = Number.parseFloat(target.amount) || 0;
        return [
          {
            target,
            name: row.name,
            color: row.color,
            monthAmount,
            defaultAmount,
          },
        ];
      }
      if (target.targetType === "group_buffer" && target.groupId) {
        const group = groupById.get(target.groupId);
        if (!group) return [];
        const defaultTarget = targets.find(
          (t) =>
            t.periodKey === "default" &&
            t.targetType === "group_buffer" &&
            t.groupId === target.groupId,
        );
        const defaultAmount = defaultTarget ? Number.parseFloat(defaultTarget.amount) : 0;
        const monthAmount = Number.parseFloat(target.amount) || 0;
        return [
          {
            target,
            name: `${group.name} · group buffer`,
            color: group.color,
            monthAmount,
            defaultAmount,
          },
        ];
      }
      return [];
    });
  }, [budget, periodKey]);

  if (overrides.length === 0) return null;

  return (
    <section className={cn(CARD_CLASS, "p-3 sm:p-4")}>
      <div className="flex items-center justify-between gap-2">
        <PanelHeader
          title={`Overrides · ${overrides.length}`}
          icon={<Icons.Pencil className="h-3.5 w-3.5" />}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => overrides.forEach((o) => onRevert(o.target))}
          className="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5 text-[10px]"
        >
          <Icons.X className="h-3 w-3" />
          Revert all
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        {overrides.map((o) => {
          const delta = o.monthAmount - o.defaultAmount;
          const positive = delta > 0;
          return (
            <div key={o.target.id} className="group/override min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: o.color ?? "var(--muted-foreground)" }}
                  aria-hidden
                />
                <span className="text-foreground min-w-0 flex-1 truncate text-xs">{o.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground h-5 w-5 shrink-0 p-0 opacity-0 transition-opacity group-hover/override:opacity-100"
                  aria-label="Revert this override"
                  onClick={() => onRevert(o.target)}
                >
                  <Icons.X className="h-3 w-3" />
                </Button>
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5 pl-3 text-[11px] tabular-nums">
                <span className="text-foreground font-medium">
                  <PrivacyAmount value={o.monthAmount} currency={currency} />
                </span>
                <span className="text-muted-foreground/70">
                  vs <PrivacyAmount value={o.defaultAmount} currency={currency} />
                </span>
                <span
                  className={cn(
                    "ml-auto font-medium",
                    delta === 0
                      ? "text-muted-foreground"
                      : positive
                        ? "text-destructive"
                        : "text-success",
                  )}
                >
                  {delta === 0 ? (
                    "—"
                  ) : (
                    <>
                      {positive ? "+" : ""}
                      <PrivacyAmount value={delta} currency={currency} />
                    </>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CopyFromMonthRow({
  currentPeriodKey,
  onCopy,
  pending,
}: {
  currentPeriodKey: string;
  onCopy: (sourcePeriodKey: string, overwrite: boolean) => void;
  pending: boolean;
}) {
  const previousMonth = useMemo(() => {
    const [year, month] = currentPeriodKey.split("-").map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return currentPeriodKey;
    const date = new Date(year, (month ?? 1) - 2, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }, [currentPeriodKey]);
  const [sourceMonth, setSourceMonth] = useState(previousMonth);
  const [overwrite, setOverwrite] = useState(false);

  return (
    <section className={cn(CARD_CLASS, "p-3 sm:p-4")}>
      <PanelHeader
        title="Copy plan from another month"
        icon={<Icons.Copy className="h-3.5 w-3.5" />}
      />
      <p className="text-muted-foreground mt-1 text-[11px]">
        Copies all overrides from the source month into this one.{" "}
        {overwrite
          ? "Existing overrides this month will be replaced."
          : "Existing overrides are preserved."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="bg-background border-input flex items-center rounded-md border px-2">
          <Icons.Calendar className="text-muted-foreground h-3.5 w-3.5" />
          <input
            type="month"
            value={sourceMonth}
            max={currentPeriodKey}
            onChange={(event) => setSourceMonth(event.target.value || previousMonth)}
            className="text-foreground h-7 w-[120px] bg-transparent px-2 text-xs outline-none"
          />
        </div>
        <label className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
            className="accent-foreground h-3 w-3"
          />
          Replace existing overrides
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!sourceMonth || sourceMonth === currentPeriodKey || pending}
          onClick={() => onCopy(sourceMonth, overwrite)}
          className="ml-auto h-7 px-3 text-xs"
        >
          {pending ? "Copying…" : "Copy plan"}
        </Button>
      </div>
    </section>
  );
}

function BudgetTotalsPanel({
  totals,
  currency,
}: {
  totals: BudgetSnapshot["computed"]["totals"];
  currency: string;
}) {
  return (
    <section className={cn(CARD_CLASS, "p-3 sm:p-4")}>
      <PanelHeader title="Totals" icon={<Icons.PieChart className="h-3.5 w-3.5" />} />
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        <TotalLine label="Planned" value={totals.spendingPlanned} currency={currency} />
        <TotalLine label="Actual" value={totals.spendingActual} currency={currency} />
        <TotalLine
          label="Remaining"
          value={totals.spendingRemaining}
          currency={currency}
          destructive={totals.spendingRemaining < 0}
        />
        <TotalLine label="Income" value={totals.incomePlanned} currency={currency} />
        <TotalLine label="Unassigned" value={totals.groupBuffer} currency={currency} />
        <TotalLine label="Rollover in" value={totals.rolloverIn} currency={currency} />
      </div>
    </section>
  );
}

function TotalLine({
  label,
  value,
  currency,
  destructive = false,
}: {
  label: string;
  value: number;
  currency: string;
  destructive?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</span>
      <span
        className={cn(
          "truncate text-sm font-semibold tabular-nums",
          destructive ? "text-destructive" : "text-foreground",
        )}
      >
        <PrivacyAmount value={value} currency={currency} />
      </span>
    </div>
  );
}

function PanelHeader({ title, icon }: { title: string; icon: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <h2 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.08em]">
        {title}
      </h2>
    </div>
  );
}

function BudgetErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const missingTables = message.includes("no such table: budget_groups");

  return (
    <section className={cn(CARD_CLASS, "p-5")}>
      <div className="flex gap-3">
        <Icons.AlertCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 space-y-3">
          <div>
            <h2 className="font-semibold">Budget data is not available</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {missingTables
                ? "The current local database was created before the updated spending migration."
                : message}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <Icons.Refresh className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    </section>
  );
}

function BudgetSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 rounded-xl" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

function EmptyPanelLine({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground border-border/40 rounded-lg border border-dashed p-3 text-xs">
      {children}
    </div>
  );
}

function findCategoryTarget(
  targets: BudgetTarget[],
  periodKey: string,
  taxonomyId: string,
  categoryId: string,
) {
  return targets.find(
    (target) =>
      target.targetType === "category" &&
      target.periodKey === periodKey &&
      target.taxonomyId === taxonomyId &&
      target.categoryId === categoryId,
  );
}

function findGroupBufferTarget(targets: BudgetTarget[], periodKey: string, groupId: string) {
  return targets.find(
    (target) =>
      target.targetType === "group_buffer" &&
      target.periodKey === periodKey &&
      target.groupId === groupId,
  );
}

function findGroupRollover(settings: BudgetRolloverSetting[], groupId: string) {
  return settings.find((setting) => setting.targetType === "group" && setting.groupId === groupId);
}

function findCategoryRollover(settings: BudgetRolloverSetting[], categoryId: string) {
  return settings.find(
    (setting) =>
      setting.targetType === "category" &&
      setting.taxonomyId === SPENDING_TAXONOMY &&
      setting.categoryId === categoryId,
  );
}

function normalizeBalance(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "0";
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return "0";
  return String(parsed);
}

function safePercent(value: number, total: number) {
  if (total <= 0) return 0;
  return value / total;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}
