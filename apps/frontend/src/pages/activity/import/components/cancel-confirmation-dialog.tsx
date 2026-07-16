import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CancelConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function CancelConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
}: CancelConfirmationDialogProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("activity:import.dialog.cancelTitle");
  const resolvedDescription = description ?? t("activity:import.dialog.cancelDescription");

  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Icons.AlertTriangle className="h-5 w-5 text-amber-500" />
            {resolvedTitle}
          </AlertDialogTitle>
          <AlertDialogDescription>{resolvedDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("activity:import.dialog.continueImporting")}</AlertDialogCancel>
          <Button variant="destructive" onClick={handleConfirm}>
            <Icons.X className="mr-2 h-4 w-4" />
            {t("activity:import.dialog.cancelImport")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default CancelConfirmationDialog;
