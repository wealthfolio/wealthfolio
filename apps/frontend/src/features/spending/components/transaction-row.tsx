import { memo } from "react";

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
import { cn, formatDate } from "@/lib/utils";

import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import {
  getActivitySpendingAmount,
  getCashActivityLabel,
  isCashActivityIncome,
} from "../lib/constants";
import type { TransactionRowVM } from "../lib/transactions-helpers";

interface TransactionRowProps {
  row: TransactionRowVM;
  account: Account | undefined;
  event: { id: string; name: string; eventTypeId: string } | null;
  eventTypeColor: string | null;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onAssignCategory: (activityId: string, taxonomyId: string, categoryId: string) => void;
  onClearCategory: (activityId: string, taxonomyId: string) => void;
  onSetEvent: (activityId: string, eventId: string | null) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
}

function TransactionRowImpl({
  row,
  account,
  event,
  eventTypeColor,
  isSelected,
  onToggleSelect,
  onAssignCategory,
  onClearCategory,
  onSetEvent,
  onEdit,
  onDuplicate,
  onDelete,
}: TransactionRowProps) {
  const a = row.activity;
  const spendingAmount = getActivitySpendingAmount(a, account?.accountType);
  const isOutflow = spendingAmount > 0;
  const isInternalTransfer =
    !!a.sourceGroupId && (a.activityType === "TRANSFER_IN" || a.activityType === "TRANSFER_OUT");
  const isIncome =
    !isInternalTransfer && isCashActivityIncome(a.activityType, account?.accountType, a.subtype);
  const isRefund = spendingAmount < 0;
  const isNeutral = !isOutflow && !isIncome && !isRefund;
  const sign = isOutflow ? "-" : isIncome || isRefund ? "+" : "";
  const amount = parseFloat(a.amount ?? "0");
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const accountName = account?.name ?? a.accountId;
  const rowAriaLabel = isSelected ? "Deselect transaction" : "Select transaction";

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
        {formatDate(a.activityDate)}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Badge variant="outline" className="text-xs">
          {getCashActivityLabel(a.activityType, account?.accountType)}
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
              Review
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 truncate text-[11px] sm:hidden">
          {formatDate(a.activityDate)} · {accountName}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {isNeutral ? (
          <span className="text-muted-foreground text-xs">Neutral</span>
        ) : (
          <QuickCategorizePopover
            scope={isIncome ? "income" : "expense"}
            selectedCategoryId={row.category?.id ?? null}
            onSelect={(taxonomyId, categoryId) => onAssignCategory(a.id, taxonomyId, categoryId)}
            onClear={() => row.category && onClearCategory(a.id, row.category.taxonomyId)}
            trigger={
              <button
                type="button"
                aria-label={
                  row.category ? `Change category (${row.category.name})` : "Assign category"
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
                    Categorize
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
              aria-label={event ? `Change event (${event.name})` : "Tag event"}
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
                  Tag event
                </span>
              )}
            </button>
          }
        />
      </TableCell>
      <TableCell
        className={cn(
          "text-right text-sm font-medium tabular-nums",
          isOutflow ? "text-destructive" : isNeutral ? "text-muted-foreground" : "text-success",
        )}
      >
        {sign}
        <PrivacyAmount value={Math.abs(safeAmount)} currency={a.currency} />
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Row actions">
              <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(row)}>
              <Icons.Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDuplicate(row)}>
              <Icons.Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={() => onDelete(row)}>
              <Icons.Trash className="mr-2 h-4 w-4" aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

export const TransactionRow = memo(TransactionRowImpl);
