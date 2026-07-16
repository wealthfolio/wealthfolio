import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  PrivacyAmount,
} from "@wealthfolio/ui";
import type { Account } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";

import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import {
  getCashActivityLabel,
  getEffectiveCashActivityType,
  isCreditCardAccountType,
} from "../lib/constants";
import {
  getTransactionDisplay,
  getTransferLinkStatus,
  isTransferCashActivity,
  type TransactionRowVM,
} from "../lib/transactions-helpers";

interface TransactionCardProps {
  row: TransactionRowVM;
  account: Account | undefined;
  event: { id: string; name: string; eventTypeId: string } | null;
  eventTypeColor: string | null;
  appTimezone?: string;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onAssignCategory: (activityId: string, taxonomyId: string, categoryId: string) => void;
  onClearCategory: (activityId: string, taxonomyId: string) => void;
  onSetEvent: (activityId: string, eventId: string | null) => void;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
  onLinkTransfer?: (row: TransactionRowVM) => void;
  onUnlinkTransfer?: (row: TransactionRowVM) => void;
}

const CHIP =
  "border-border/60 bg-background/50 hover:bg-muted/60 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors";

function TransactionCardImpl({
  row,
  account,
  event,
  eventTypeColor,
  appTimezone,
  isSelected,
  onToggleSelect,
  onAssignCategory,
  onClearCategory,
  onSetEvent,
  onMarkReimbursement,
  onEditSplits,
  onEdit,
  onDuplicate,
  onDelete,
  onLinkTransfer,
  onUnlinkTransfer,
}: TransactionCardProps) {
  const { t } = useTranslation();
  const a = row.activity;
  const { isOutflow, isIncome, isSaving, isNeutral, sign, safeAmount } = getTransactionDisplay(
    a,
    account?.accountType,
  );
  const accountName = account?.name ?? a.accountId;
  const activityType = getEffectiveCashActivityType(a);
  const isTransfer = isTransferCashActivity(a);
  const transferLinkStatus = getTransferLinkStatus(a);
  const canMarkReimbursement =
    isIncome && !isCreditCardAccountType(account?.accountType) && activityType !== "CREDIT";
  const formattedDate = formatDateTime(a.activityDate, appTimezone);

  return (
    <div
      data-state={isSelected ? "selected" : undefined}
      className={cn(
        "border-border/40 bg-card/40 rounded-2xl border p-3",
        row.needsReview && "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(a.id)}
          aria-label={
            isSelected ? t("spending:transactions.deselect") : t("spending:transactions.select")
          }
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
              {a.notes ?? <span className="text-muted-foreground italic">—</span>}
            </span>
            {row.needsReview && (
              <Badge
                variant="outline"
                className="shrink-0 border-amber-500/50 text-[10px] text-amber-600"
              >
                {t("spending:transactions.review")}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
            {formattedDate.date} {formattedDate.time} · {accountName} ·{" "}
            {getCashActivityLabel(activityType, account?.accountType, a.subtype)}
          </div>
        </div>
        <div
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            isSaving
              ? "text-[#6B8E54]"
              : isOutflow
                ? "text-destructive"
                : isNeutral
                  ? "text-muted-foreground"
                  : "text-success",
          )}
        >
          {sign}
          <PrivacyAmount value={Math.abs(safeAmount)} currency={a.currency} />
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2 pl-7">
        {isNeutral ? (
          <span className="text-muted-foreground text-xs">
            {t("spending:transactions.neutral")}
          </span>
        ) : row.splitCount > 0 ? (
          <button type="button" className={cn(CHIP, "min-w-0")} onClick={() => onEditSplits(row)}>
            <Icons.SplitHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {t("spending:transactions.splitLines", { count: row.splitCount })}
            </span>
          </button>
        ) : (
          <QuickCategorizePopover
            scope={isIncome ? "income" : isSaving ? "saving" : "expense"}
            selectedCategoryId={row.category?.id ?? null}
            onSelect={(taxonomyId, categoryId) => onAssignCategory(a.id, taxonomyId, categoryId)}
            onClear={() => row.category && onClearCategory(a.id, row.category.taxonomyId)}
            trigger={
              <button
                type="button"
                aria-label={
                  row.category
                    ? t("spending:transactions.changeCategory", { name: row.category.name })
                    : t("spending:transactions.assignCategory")
                }
                className={cn(CHIP, "min-w-0")}
              >
                {row.category ? (
                  <>
                    {row.category.color && (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.category.color }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{row.category.name}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground inline-flex items-center gap-1 italic">
                    <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                    {t("spending:transactions.categorize")}
                  </span>
                )}
              </button>
            }
          />
        )}

        <QuickEventPopover
          selectedEventId={event?.id ?? null}
          onSelect={(eventId) => onSetEvent(a.id, eventId)}
          onClear={() => onSetEvent(a.id, null)}
          activityId={a.id}
          defaultDate={a.activityDate ? new Date(a.activityDate) : undefined}
          trigger={
            event ? (
              <button
                type="button"
                aria-label={t("spending:transactions.changeEvent", { name: event.name })}
                className={cn(CHIP, "min-w-0")}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: eventTypeColor ?? "var(--muted-foreground)" }}
                  aria-hidden="true"
                />
                <span className="truncate">{event.name}</span>
              </button>
            ) : (
              <button
                type="button"
                aria-label={t("spending:transactions.tagEvent")}
                className="border-border/60 bg-background/50 text-muted-foreground hover:bg-muted/60 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors"
              >
                <Icons.Tag className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )
          }
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-8 w-8 shrink-0"
              aria-label={t("spending:transactions.rowActions")}
            >
              <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(row)}>
              <Icons.Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("common:edit")}
            </DropdownMenuItem>
            {canMarkReimbursement && (
              <DropdownMenuItem onClick={() => onMarkReimbursement(row)}>
                <Icons.RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("spending:transactions.markReimbursement")}
              </DropdownMenuItem>
            )}
            {!isNeutral && (
              <DropdownMenuItem onClick={() => onEditSplits(row)}>
                <Icons.SplitHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("spending:transactions.splitTransaction")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onDuplicate(row)}>
              <Icons.Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("spending:transactions.duplicate")}
            </DropdownMenuItem>
            {isTransfer && (onLinkTransfer || onUnlinkTransfer) ? (
              transferLinkStatus === "linked" ? (
                onUnlinkTransfer ? (
                  <DropdownMenuItem onClick={() => onUnlinkTransfer(row)}>
                    <Icons.Unlink className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("spending:transactions.unlinkTransfer")}
                  </DropdownMenuItem>
                ) : null
              ) : onLinkTransfer ? (
                <DropdownMenuItem onClick={() => onLinkTransfer(row)}>
                  <Icons.Link className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t("spending:transactions.linkTransfer")}
                </DropdownMenuItem>
              ) : null
            ) : null}
            <DropdownMenuItem className="text-destructive" onClick={() => onDelete(row)}>
              <Icons.Trash className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("common:delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export const TransactionCard = memo(TransactionCardImpl);
