import { memo, type Ref } from "react";
import { useTranslation } from "react-i18next";

import type { Account } from "@/lib/types";
import { AccountType } from "@/lib/constants";
import { TruncatedText } from "@/components/truncated-text";
import { HOVER_SLOT } from "@/lib/hover-slot";
import { cn } from "@/lib/utils";
import {
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
  useDateFormatting,
} from "@wealthfolio/ui";

import { getEffectiveCashActivityType, isCreditCardAccountType } from "../lib/constants";
import {
  getTransactionDisplay,
  getTransferLinkStatus,
  isTransferCashActivity,
  type TransactionRowVM,
} from "../lib/transactions-helpers";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";

interface TransactionRowProps {
  row: TransactionRowVM;
  account: Account | undefined;
  event: { id: string; name: string; eventTypeId: string } | null;
  eventTypeColor: string | null;
  appTimezone?: string;
  /** True when the loaded result set spans more than one account. */
  showAccount: boolean;
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
  /** Count a withdrawal as a loan payment, or stop counting it. */
  onLoanPayment?: (row: TransactionRowVM) => void;
  /**
   * Virtualizer wiring: it measures the rendered row through the ref and
   * identifies it by `data-index`. Both are unset when the list renders
   * unvirtualized.
   */
  ref?: Ref<HTMLTableRowElement>;
  "data-index"?: number;
}

/** Shown only on row hover/focus, so an unset slot costs nothing at rest. */
function TransactionRowImpl({
  ref,
  "data-index": dataIndex,
  row,
  account,
  event,
  eventTypeColor,
  appTimezone,
  showAccount,
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
  onLoanPayment,
}: TransactionRowProps) {
  const { formatTime } = useDateFormatting();

  const { t } = useTranslation();
  const a = row.activity;
  const { isOutflow, isIncome, isSaving, isNeutral, sign, safeAmount } = getTransactionDisplay(
    a,
    account?.accountType,
  );
  const accountName = account?.name ?? a.accountId;
  const rowAriaLabel = isSelected
    ? t("spending:transactions.deselect")
    : t("spending:transactions.select");
  const activityType = getEffectiveCashActivityType(a);
  const isTransfer = isTransferCashActivity(a);
  const transferLinkStatus = getTransferLinkStatus(a);
  const canMarkReimbursement =
    isIncome && !isCreditCardAccountType(account?.accountType) && activityType !== "CREDIT";
  // Loans take payments only as withdrawals from a cash account.
  const canPayLoan =
    !!onLoanPayment && activityType === "WITHDRAWAL" && account?.accountType === AccountType.CASH;
  const time = formatTime(a.activityDate, {
    hour: "numeric",
    minute: "numeric",
    ...(appTimezone ? { timeZone: appTimezone } : {}),
  });

  return (
    <TableRow
      ref={ref}
      data-index={dataIndex}
      data-state={isSelected ? "selected" : undefined}
      className={cn("group/row", row.needsReview && "bg-amber-500/5")}
    >
      <TableCell className="relative w-10 px-3 py-2">
        {row.needsReview && (
          <span className="absolute inset-y-0 left-0 w-[3px] bg-amber-500" aria-hidden="true" />
        )}
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(a.id)}
          aria-label={rowAriaLabel}
        />
      </TableCell>
      <TableCell className="text-muted-foreground hidden w-20 whitespace-nowrap px-3 py-2 text-xs tabular-nums md:table-cell">
        {time}
      </TableCell>
      {/* `max-w-0` hands this column whatever width the fixed-width columns
          leave over, instead of letting a long note stretch the table. It has
          to be `!important`: globals.css sets `max-width: 100vw` on every
          element at or below 1024px from outside any layer, which beats a
          plain utility and would let the note run to the viewport edge. */}
      <TableCell className="max-w-0! px-3 py-2">
        <div className="flex items-center gap-2">
          {/* The stripe beside the checkbox carries this too, but colour alone
              cannot be the only signal — it says nothing to a screen reader and
              nothing to a reader who cannot separate amber from the row behind
              it. An icon costs a line of width and says it in both registers. */}
          {row.needsReview && (
            <span className="shrink-0 text-amber-600 dark:text-amber-500">
              <Icons.AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">{t("spending:transactions.review")}</span>
            </span>
          )}
          {a.notes != null ? (
            <TruncatedText text={a.notes} className="text-sm" />
          ) : (
            <span className="text-muted-foreground text-sm italic">—</span>
          )}
          {showAccount && (
            <span className="text-muted-foreground max-w-[8rem] shrink-0 truncate text-xs">
              {accountName}
            </span>
          )}
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
                className={cn(
                  "hover:bg-muted/60 inline-flex shrink-0 items-center gap-1.5 rounded-full transition-colors",
                  event ? "bg-muted/60 max-w-[10rem] px-2 py-0.5" : cn("px-1", HOVER_SLOT),
                )}
              >
                {event ? (
                  <>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: eventTypeColor ?? "var(--muted-foreground)" }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs">{event.name}</span>
                  </>
                ) : (
                  <Icons.Tag className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            }
          />
        </div>
      </TableCell>
      <TableCell className="hidden w-44 px-3 py-2 sm:table-cell">
        {isNeutral ? (
          <span className="text-muted-foreground text-xs">
            {t("spending:transactions.neutral")}
          </span>
        ) : row.splitCount > 0 ? (
          <button
            type="button"
            className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
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
                className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
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
      <TableCell
        className={cn(
          "w-28 whitespace-nowrap px-3 py-2 text-right text-sm font-medium tabular-nums",
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
      <TableCell className="w-10 px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7 data-[state=open]:opacity-100", HOVER_SLOT)}
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
            {canPayLoan && (
              <DropdownMenuItem onClick={() => onLoanPayment(row)}>
                <Icons.Link className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("asset:loanPayments.menu")}
              </DropdownMenuItem>
            )}
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
