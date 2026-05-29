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
} from "@wealthfolio/ui";
import type { Account } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import { getCashActivityLabel } from "../lib/constants";
import { getTransactionDisplay, type TransactionRowVM } from "../lib/transactions-helpers";

interface TransactionCardProps {
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

const CHIP =
  "border-border/60 bg-background/50 hover:bg-muted/60 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors";

function TransactionCardImpl({
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
}: TransactionCardProps) {
  const a = row.activity;
  const { isOutflow, isIncome, isNeutral, sign, safeAmount } = getTransactionDisplay(
    a,
    account?.accountType,
  );
  const accountName = account?.name ?? a.accountId;

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
          aria-label={isSelected ? "Deselect transaction" : "Select transaction"}
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
                Review
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
            {formatDate(a.activityDate)} · {accountName} ·{" "}
            {getCashActivityLabel(a.activityType, account?.accountType)}
          </div>
        </div>
        <div
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            isOutflow ? "text-destructive" : isNeutral ? "text-muted-foreground" : "text-success",
          )}
        >
          {sign}
          <PrivacyAmount value={Math.abs(safeAmount)} currency={a.currency} />
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2 pl-7">
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
                    Categorize
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
                aria-label={`Change event (${event.name})`}
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
                aria-label="Tag event"
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
              aria-label="Row actions"
            >
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
      </div>
    </div>
  );
}

export const TransactionCard = memo(TransactionCardImpl);
