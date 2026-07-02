import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useI18n } from "@/i18n/i18n-provider";
import { formatAmount } from "@/lib/utils";

import { pluralizeTransaction } from "../lib/transactions-helpers";

export interface DeletePreview {
  activityType: string;
  amount: string | null;
  currency: string;
}

interface DeleteTransactionsDialogProps {
  open: boolean;
  count: number;
  preview?: DeletePreview;
  onConfirm: () => void;
  onCancel: () => void;
  isPending?: boolean;
}

export function DeleteTransactionsDialog({
  open,
  count,
  preview,
  onConfirm,
  onCancel,
  isPending,
}: DeleteTransactionsDialogProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const previewAmount = isBalanceHidden
    ? "••••"
    : formatAmount(parseFloat(preview?.amount ?? "0") || 0, preview?.currency ?? "USD");
  const message =
    count === 1 && preview
      ? isChinese
        ? `确定要删除这笔 ${preview.activityType.toLowerCase()}（${previewAmount}）吗？`
        : `Are you sure you want to delete this ${preview.activityType.toLowerCase()} of ${previewAmount}?`
      : isChinese
        ? `确定要删除 ${count} 笔交易吗？`
        : `Are you sure you want to delete ${count} transactions?`;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isChinese ? `删除${count === 1 ? "交易" : "交易"}` : `Delete ${pluralizeTransaction(count)}`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isChinese ? `${message} 此操作无法撤销。` : `${message} This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{isChinese ? "取消" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isChinese ? "删除" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
