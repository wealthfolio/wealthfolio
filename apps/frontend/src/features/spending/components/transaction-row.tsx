import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { memo, type Ref } from "react";
import { useTranslation } from "react-i18next";

import type { Account } from "@/lib/types";
import { AccountType } from "@/lib/constants";
import { TruncatedText } from "@/components/truncated-text";
import { HOVER_SLOT, SELECTION_SLOT } from "@/lib/hover-slot";
import { isRowBodyClick } from "@/lib/row-click";
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
import {
  NEEDS_REVIEW_ROW_CLASS,
  NeedsReviewIcon,
  NeedsReviewStripe,
} from "@/components/needs-review";

interface TransactionRowProps {
  row: TransactionRowVM;
  account: Account | undefined;
  event: { id: string; name: string; eventTypeId: string } | null;
  eventTypeColor: string | null;
  appTimezone?: string;
  /** True when the loaded result set spans more than one account. */
  showAccount: boolean;
  /** Adds the Balance cell: the list shows one account's running balance. */
  showBalance?: boolean;
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
  showBalance = false,
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
      className={cn("group/row cursor-pointer", row.needsReview && NEEDS_REVIEW_ROW_CLASS)}
      onClick={(e) => isRowBodyClick(e) && onEdit(row)}
    >
      <TableCell className="relative w-10 px-3 py-2" data-row-click-ignore>
        {row.needsReview && <NeedsReviewStripe />}
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(a.id)}
          aria-label={rowAriaLabel}
          className={SELECTION_SLOT}
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
          {row.needsReview && <NeedsReviewIcon label={t("spending:transactions.review")} />}
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
            className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-start transition-colors"
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
                    ? t("spending:transactions.changeCategory", {
                        name: getCategoryLabel(
                          t,
                          row.category.taxonomyId,
                          row.category.id,
                          row.category.name,
                        ),
                      })
                    : t("spending:transactions.assignCategory")
                }
                className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-start transition-colors"
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
                    <span className="truncate text-sm">
                      {getCategoryLabel(
                        t,
                        row.category.taxonomyId,
                        row.category.id,
                        row.category.name,
                      )}
                    </span>
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
          "w-28 whitespace-nowrap px-3 py-2 text-end text-sm font-medium tabular-nums",
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
      {showBalance && (
        <TableCell className="text-muted-foreground hidden w-28 whitespace-nowrap px-3 py-2 text-end text-sm tabular-nums sm:table-cell">
          {a.cashBalance != null && a.cashBalanceCurrency && (
            <PrivacyAmount value={Number(a.cashBalance)} currency={a.cashBalanceCurrency} />
          )}
        </TableCell>
      )}
      <TableCell className="w-10 px-3 py-2" data-row-click-ignore>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn("data-popup-open:opacity-100 h-7 w-7", HOVER_SLOT)}
                aria-label={t("spending:transactions.rowActions")}
              />
            }
          >
            <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(row)}>
              <Icons.Pencil className="me-2 h-4 w-4" aria-hidden="true" />
              {t("common:edit")}
            </DropdownMenuItem>
            {canMarkReimbursement && (
              <DropdownMenuItem onClick={() => onMarkReimbursement(row)}>
                <Icons.RefreshCw className="me-2 h-4 w-4" aria-hidden="true" />
                {t("spending:transactions.markReimbursement")}
              </DropdownMenuItem>
            )}
            {!isNeutral && (
              <DropdownMenuItem onClick={() => onEditSplits(row)}>
                <Icons.SplitHorizontal className="me-2 h-4 w-4" aria-hidden="true" />
                {t("spending:transactions.splitTransaction")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onDuplicate(row)}>
              <Icons.Copy className="me-2 h-4 w-4" aria-hidden="true" />
              {t("spending:transactions.duplicate")}
            </DropdownMenuItem>
            {isTransfer && (onLinkTransfer || onUnlinkTransfer) ? (
              transferLinkStatus === "linked" ? (
                onUnlinkTransfer ? (
                  <DropdownMenuItem onClick={() => onUnlinkTransfer(row)}>
                    <Icons.Unlink className="me-2 h-4 w-4" aria-hidden="true" />
                    {t("spending:transactions.unlinkTransfer")}
                  </DropdownMenuItem>
                ) : null
              ) : onLinkTransfer ? (
                <DropdownMenuItem onClick={() => onLinkTransfer(row)}>
                  <Icons.Link className="me-2 h-4 w-4" aria-hidden="true" />
                  {t("spending:transactions.linkTransfer")}
                </DropdownMenuItem>
              ) : null
            ) : null}
            {canPayLoan && (
              <DropdownMenuItem onClick={() => onLoanPayment(row)}>
                <Icons.Link className="me-2 h-4 w-4" aria-hidden="true" />
                {t("asset:loanPayments.menu")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-destructive" onClick={() => onDelete(row)}>
              <Icons.Trash className="me-2 h-4 w-4" aria-hidden="true" />
              {t("common:delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

export const TransactionRow = memo(TransactionRowImpl);
