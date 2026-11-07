import { useTranslation } from "react-i18next";

import type { Account } from "@/lib/types";
import { AccountType } from "@/lib/constants";
import { HOVER_SLOT } from "@/lib/hover-slot";
import { cn } from "@/lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
} from "@wealthfolio/ui";

import { getEffectiveCashActivityType, isCreditCardAccountType } from "../lib/constants";
import {
  getTransactionDisplay,
  getTransferLinkStatus,
  isTransferCashActivity,
  type TransactionRowVM,
} from "../lib/transactions-helpers";
import { canConvertToTransfer } from "@/pages/activity/components/transfer-link-utils";

export interface TransactionRowActionsProps {
  row: TransactionRowVM;
  account: Account | undefined;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
  onLinkTransfer?: (row: TransactionRowVM) => void;
  onUnlinkTransfer?: (row: TransactionRowVM) => void;
  /** Count a withdrawal as a loan payment, or stop counting it. */
  onLoanPayment?: (row: TransactionRowVM) => void;
  /** Classes for the menu button; the list shows it on row hover. */
  triggerClassName?: string;
}

/** A Spending transaction's row menu, shared by the list and the grid. */
export function TransactionRowActions({
  row,
  account,
  onMarkReimbursement,
  onEditSplits,
  onEdit,
  onDuplicate,
  onDelete,
  onLinkTransfer,
  onUnlinkTransfer,
  onLoanPayment,
  triggerClassName = cn("data-popup-open:opacity-100 h-7 w-7", HOVER_SLOT),
}: TransactionRowActionsProps) {
  const { t } = useTranslation();
  const a = row.activity;
  const { isIncome, isNeutral } = getTransactionDisplay(a, account?.accountType);
  const activityType = getEffectiveCashActivityType(a);
  const isTransfer = isTransferCashActivity(a);
  const transferLinkStatus = getTransferLinkStatus(a);
  const canMarkReimbursement =
    isIncome && !isCreditCardAccountType(account?.accountType) && activityType !== "CREDIT";
  // Loans take payments only as withdrawals from a cash account.
  const canPayLoan =
    !!onLoanPayment && activityType === "WITHDRAWAL" && account?.accountType === AccountType.CASH;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={triggerClassName}
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
        {onLinkTransfer && canConvertToTransfer(a) ? (
          <DropdownMenuItem onClick={() => onLinkTransfer(row)}>
            <Icons.ArrowLeftRight className="me-2 h-4 w-4" aria-hidden="true" />
            {t("spending:transactions.convertToTransfer")}
          </DropdownMenuItem>
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
  );
}
