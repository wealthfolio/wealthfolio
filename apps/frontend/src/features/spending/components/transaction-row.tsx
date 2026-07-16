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
  TableCell,
  TableRow,
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

interface TransactionRowProps {
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

function TransactionRowImpl({
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
}: TransactionRowProps) {
  const { t } = useTranslation();
  const a = row.activity;
  const { isOutflow, isIncome, isSaving, isRefund, isNeutral, sign, safeAmount } =
    getTransactionDisplay(a, account?.accountType);
  const accountName = account?.name ?? a.accountId;
  const rowAriaLabel = isSelected
    ? t("spending:transactions.deselect")
    : t("spending:transactions.select");
  const activityType = getEffectiveCashActivityType(a);
  const isTransfer = isTransferCashActivity(a);
  const transferLinkStatus = getTransferLinkStatus(a);
  const canMarkReimbursement =
    isIncome && !isCreditCardAccountType(account?.accountType) && activityType !== "CREDIT";
  const formattedDate = formatDateTime(a.activityDate, appTimezone);
  const typeBadgeVariant =
    isIncome || isSaving || isRefund ? "success" : isOutflow ? "destructive" : "secondary";

  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      className={cn(row.needsReview && "bg-amber-500/5")}
    >
      <TableCell>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(a.id)}
          aria-label={rowAriaLabel}
        />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-sm sm:table-cell">
        <div className="ml-2 flex flex-col">
          <span>{formattedDate.date}</span>
          <span className="text-muted-foreground text-xs font-light">{formattedDate.time}</span>
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Badge variant={typeBadgeVariant} className="rounded-sm text-xs font-normal">
          {getCashActivityLabel(activityType, account?.accountType, a.subtype)}
        </Badge>
      </TableCell>
      <TableCell className="hidden text-sm lg:table-cell">
        <div className="truncate">{accountName}</div>
        <div className="text-muted-foreground text-[10px]">{a.currency}</div>
      </TableCell>
      <TableCell className="text-foreground max-w-[260px] text-sm">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate">
            {a.notes ?? <span className="text-muted-foreground italic">—</span>}
          </span>
          {row.needsReview && (
            <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-600">
              {t("spending:transactions.review")}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 truncate text-[11px] sm:hidden">
          {formattedDate.date} {formattedDate.time} · {accountName}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {isNeutral ? (
          <span className="text-muted-foreground text-xs">
            {t("spending:transactions.neutral")}
          </span>
        ) : row.splitCount > 0 ? (
          <button
            type="button"
            className="hover:bg-muted/60 -mx-1 inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
            onClick={() => onEditSplits(row)}
          >
            <Icons.SplitHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate text-sm">
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
                className="hover:bg-muted/60 -mx-1 inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
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
                    <span className="truncate text-sm">{row.category.name}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs italic">
                    <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                    {t("spending:transactions.categorize")}
                  </span>
                )}
              </button>
            }
          />
        )}
      </TableCell>
      <TableCell className="hidden text-sm lg:table-cell">
        <QuickEventPopover
          selectedEventId={event?.id ?? null}
          onSelect={(eventId) => onSetEvent(a.id, eventId)}
          onClear={() => onSetEvent(a.id, null)}
          activityId={a.id}
          defaultDate={a.activityDate ? new Date(a.activityDate) : undefined}
          trigger={
            <button
              type="button"
              aria-label={
                event
                  ? t("spending:transactions.changeEvent", { name: event.name })
                  : t("spending:transactions.tagEvent")
              }
              className="hover:bg-muted/60 -mx-1 inline-flex max-w-[180px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
            >
              {event ? (
                <span className="bg-muted/60 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: eventTypeColor ?? "var(--muted-foreground)" }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{event.name}</span>
                </span>
              ) : (
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs italic">
                  <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                  {t("spending:transactions.tagEvent")}
                </span>
              )}
            </button>
          }
        />
      </TableCell>
      <TableCell
        className={cn(
          "text-right text-sm font-medium tabular-nums",
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
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
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
      </TableCell>
    </TableRow>
  );
}

export const TransactionRow = memo(TransactionRowImpl);
