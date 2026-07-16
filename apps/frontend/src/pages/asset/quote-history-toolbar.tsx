import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Button,
  Icons,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from "@wealthfolio/ui";

interface QuoteHistoryToolbarProps {
  selectedRowCount: number;
  hasUnsavedChanges: boolean;
  dirtyCount: number;
  deletedCount: number;
  isManualDataSource: boolean;
  onAddRow: () => void;
  onDeleteSelected: () => void;
  onSave: () => void;
  onCancel: () => void;
  onChangeDataSource?: (isManual: boolean) => void;
}

export function QuoteHistoryToolbar({
  selectedRowCount,
  hasUnsavedChanges,
  dirtyCount,
  deletedCount,
  isManualDataSource,
  onAddRow,
  onDeleteSelected,
  onSave,
  onCancel,
  onChangeDataSource,
}: QuoteHistoryToolbarProps) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);

  return (
    <div className="flex items-center justify-between gap-2">
      {/* Left: action buttons */}
      <div className="flex items-center gap-2">
        {isManualDataSource && (
          <>
            <Button variant="default" size="sm" onClick={onAddRow}>
              <Icons.Plus className="mr-1.5 h-4 w-4" />
              {t("asset:quoteToolbar.add")}
            </Button>

            <Button asChild variant="outline" size="sm">
              <Link to="/settings/market-data/import" className="flex items-center gap-1.5">
                <Icons.Import className="h-4 w-4" />
                <span className="hidden sm:inline">{t("asset:quoteToolbar.import")}</span>
              </Link>
            </Button>
          </>
        )}

        {selectedRowCount > 0 && isManualDataSource && (
          <Button variant="outline" size="sm" onClick={onDeleteSelected}>
            <Icons.Trash className="mr-1.5 h-4 w-4" />
            {t("asset:quoteToolbar.delete_count", { count: selectedRowCount })}
          </Button>
        )}

        {/* Save/Cancel when there are changes */}
        {hasUnsavedChanges && (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("common:cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={onSave}>
              <Icons.Save className="mr-1.5 h-4 w-4" />
              {t("asset:quoteToolbar.save")}
              <span className="text-primary-foreground/70 ml-1 text-xs">
                ({dirtyCount + deletedCount})
              </span>
            </Button>
          </>
        )}
      </div>

      {/* Right: manual tracking toggle */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <div className="flex shrink-0 cursor-pointer items-center space-x-2">
            <Switch id="manual-tracking" checked={isManualDataSource} />
            <Label htmlFor="manual-tracking" className="cursor-pointer text-xs sm:text-sm">
              {t("asset:quoteToolbar.manual")}
            </Label>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-4 sm:w-[360px]" align="end">
          <div className="space-y-4">
            <h4 className="font-medium">{t("asset:quoteToolbar.change_tracking_mode")}</h4>
            {isManualDataSource ? (
              <>
                <p className="text-muted-foreground text-sm">
                  {t("asset:quoteToolbar.to_auto_description")}
                </p>
                <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                  {t("asset:quoteToolbar.to_auto_warning")}
                </p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground text-sm">
                  {t("asset:quoteToolbar.to_manual_description")}
                </p>
                <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                  {t("asset:quoteToolbar.to_manual_warning")}
                </p>
              </>
            )}
            <div className="flex justify-end space-x-2">
              <Button variant="ghost" size="sm" onClick={() => setPopoverOpen(false)}>
                {t("common:cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  onChangeDataSource?.(!isManualDataSource);
                  setPopoverOpen(false);
                }}
              >
                {t("asset:quoteToolbar.confirm_change")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
