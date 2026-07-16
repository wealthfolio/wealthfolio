import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

import type { ContributionLimit } from "@/lib/types";

export interface ContributionLimitOperationsProps {
  limit: ContributionLimit;
  onEdit: (limit: ContributionLimit) => void;
  onDelete: (limit: ContributionLimit) => void;
}

export function ContributionLimitOperations({
  limit,
  onEdit,
  onDelete,
}: ContributionLimitOperationsProps) {
  const { t } = useTranslation();
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const isDeleting = false; // You can implement loading state if needed

  const handleDelete = () => {
    onDelete(limit);
    setShowDeleteAlert(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md border transition-colors">
          <Icons.MoreVertical className="h-4 w-4" />
          <span className="sr-only">{t("settings:limits_operations_open")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEdit(limit)}>
            {t("settings:limits_operations_edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive flex cursor-pointer items-center"
            onSelect={() => setShowDeleteAlert(true)}
          >
            {t("settings:limits_operations_delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={showDeleteAlert} onOpenChange={setShowDeleteAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:limits_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:limits_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>

            <Button
              disabled={isDeleting}
              onClick={() => handleDelete()}
              className="bg-red-600 focus:ring-red-600"
            >
              {isDeleting ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Trash className="mr-2 h-4 w-4" />
              )}
              <span>{t("settings:limits_operations_delete")}</span>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
