import { Button, Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface ValueHistoryToolbarProps {
  selectedRowCount: number;
  hasUnsavedChanges: boolean;
  dirtyCount: number;
  deletedCount: number;
  onAddRow: () => void;
  onDeleteSelected: () => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving?: boolean;
  isLiability?: boolean;
  onEarlyRepayment?: () => void;
  onCloseLoan?: () => void;
  onRecalculateSchedule?: () => void;
}

export function ValueHistoryToolbar({
  selectedRowCount,
  hasUnsavedChanges,
  dirtyCount,
  deletedCount,
  onAddRow,
  onDeleteSelected,
  onSave,
  onCancel,
  isSaving = false,
  isLiability = false,
  onEarlyRepayment,
  onCloseLoan,
  onRecalculateSchedule,
}: ValueHistoryToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={onAddRow} disabled={isSaving}>
          <Icons.Plus className="mr-2 h-4 w-4" />
          {isLiability ? t("asset:valueToolbar.add_balance") : t("asset:valueToolbar.add_value")}
        </Button>

        {isLiability && onEarlyRepayment && (
          <Button variant="outline" size="sm" onClick={onEarlyRepayment} disabled={isSaving}>
            <Icons.HandCoins className="mr-2 h-4 w-4" />
            {t("asset:loanActions.early_repayment")}
          </Button>
        )}

        {isLiability && onCloseLoan && (
          <Button variant="outline" size="sm" onClick={onCloseLoan} disabled={isSaving}>
            <Icons.Lock className="mr-2 h-4 w-4" />
            {t("asset:loanActions.close_loan")}
          </Button>
        )}

        {isLiability && onRecalculateSchedule && (
          <Button variant="outline" size="sm" onClick={onRecalculateSchedule} disabled={isSaving}>
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
            {t("asset:loanActions.recalculate_schedule")}
          </Button>
        )}

        {selectedRowCount > 0 && (
          <Button variant="outline" size="sm" onClick={onDeleteSelected} disabled={isSaving}>
            <Icons.Trash className="mr-2 h-4 w-4" />
            {t("asset:valueToolbar.delete_count", { count: selectedRowCount })}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasUnsavedChanges && (
          <>
            <span className="text-muted-foreground text-sm">
              {dirtyCount > 0 && t("asset:valueToolbar.modified", { count: dirtyCount })}
              {dirtyCount > 0 && deletedCount > 0 && ", "}
              {deletedCount > 0 && t("asset:valueToolbar.to_delete", { count: deletedCount })}
            </span>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
              {t("common:cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={onSave} disabled={isSaving}>
              <Icons.Save className="mr-2 h-4 w-4" />
              {t("asset:valueToolbar.save_changes")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
