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
import { useI18n } from "@/i18n/i18n-provider";

interface UnsavedTargetChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}

export function UnsavedTargetChangesDialog({
  open,
  onOpenChange,
  onDiscard,
}: UnsavedTargetChangesDialogProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isChinese ? "要放弃目标更改吗？" : "Discard target changes?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isChinese
              ? "你有未保存的目标更改。要放弃这些更改并离开编辑器吗？"
              : "You have unsaved target changes. Discard them and leave the editor?"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{isChinese ? "取消" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onDiscard}
          >
            {isChinese ? "放弃" : "Discard"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
