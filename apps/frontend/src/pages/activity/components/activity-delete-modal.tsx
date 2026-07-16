import { Icons } from "@wealthfolio/ui/components/ui/icons";
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
import { useTranslation } from "react-i18next";

export interface ActivityDeleteModalProps {
  isOpen?: boolean;
  isDeleting?: boolean;
  linkedTransfer?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function ActivityDeleteModal({
  isOpen,
  isDeleting,
  linkedTransfer,
  onConfirm,
  onCancel,
}: ActivityDeleteModalProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={isOpen} onOpenChange={onCancel}>
      <AlertDialogContent className="max-sm:gap-5 max-sm:p-5">
        <AlertDialogHeader className="max-sm:items-center max-sm:space-y-3 max-sm:text-center">
          <div className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-full sm:hidden">
            <Icons.Trash className="size-5" />
          </div>
          <AlertDialogTitle className="leading-tight max-sm:text-xl">
            {t("activity:delete_modal.title")}
          </AlertDialogTitle>
          <AlertDialogDescription className="max-sm:text-[15px]">
            {linkedTransfer
              ? t("activity:delete_modal.linked_transfer_desc")
              : t("activity:delete_modal.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => onConfirm()}
            disabled={isDeleting}
            className="max-sm:h-12"
          >
            {isDeleting ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Trash className="mr-2 h-4 w-4" />
            )}
            <span>{t("common:delete")}</span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
