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
  const previewAmount = isBalanceHidden
    ? "••••"
    : formatAmount(parseFloat(preview?.amount ?? "0") || 0, preview?.currency ?? "USD");
  const message =
    count === 1 && preview
      ? `Are you sure you want to delete this ${preview.activityType.toLowerCase()} of ${previewAmount}?`
      : `Are you sure you want to delete ${count} transactions?`;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pluralizeTransaction(count)}</AlertDialogTitle>
          <AlertDialogDescription>{message} This action cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
