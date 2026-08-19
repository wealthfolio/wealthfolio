import { useTranslation } from "react-i18next";

import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import {} from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  useAmountFormatting,
} from "@wealthfolio/ui";

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
  const formatting = useAmountFormatting();
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const previewAmount = isBalanceHidden
    ? "••••"
    : formatting.formatAmount(parseFloat(preview?.amount ?? "0") || 0, preview?.currency ?? "USD");
  const message =
    count === 1 && preview
      ? t("spending:transactions.deleteConfirmSingle", {
          type: preview.activityType.toLowerCase(),
          amount: previewAmount,
        })
      : t("spending:transactions.deleteConfirmMany", { count });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("spending:transactions.deleteTitle", { count })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("spending:transactions.deleteMessageWithUndo", { message })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("common:delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
