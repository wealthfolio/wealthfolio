import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { useI18n } from "@/i18n/i18n-provider";

interface RefreshQuotesConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Optional asset name shown in the description */
  assetName?: string;
}

export function RefreshQuotesConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  assetName,
}: RefreshQuotesConfirmDialogProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isChinese ? "刷新历史数据" : "Refresh history"}</AlertDialogTitle>
          <AlertDialogDescription>
            {isChinese
              ? `这会删除并用最新数据替换${assetName ? ` ${assetName} 的` : "所有"}服务商报价。手动报价会保留。是否继续？`
              : `This will delete and replace all provider quotes with fresh data${
                  assetName ? ` for ${assetName}` : ""
                }. Manual quotes will be preserved. Continue?`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{isChinese ? "取消" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {isChinese ? "刷新" : "Refresh"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
