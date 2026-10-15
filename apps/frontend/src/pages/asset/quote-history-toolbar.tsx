import { cn } from "@/lib/utils";
import { useRef, useState } from "react";
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
  buttonVariants,
} from "@wealthfolio/ui";

interface QuoteHistoryToolbarProps {
  selectedRowCount: number;
  hasUnsavedChanges: boolean;
  dirtyCount: number;
  deletedCount: number;
  isManualDataSource: boolean;
  /** Disables Add, e.g. while a mobile quote is open */
  isAddDisabled?: boolean;
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
  isAddDisabled = false,
  onAddRow,
  onDeleteSelected,
  onSave,
  onCancel,
  onChangeDataSource,
}: QuoteHistoryToolbarProps) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const trackingRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex items-center justify-between gap-2">
      {/* Left: action buttons */}
      <div className="flex items-center gap-2">
        {isManualDataSource && (
          <>
            <Button variant="default" size="sm" onClick={onAddRow} disabled={isAddDisabled}>
              <Icons.Plus className="mr-1.5 h-4 w-4" />
              {t("asset:quoteToolbar.add")}
            </Button>

            <Link
              to="/settings/market-data/import"
              aria-label={t("asset:quoteToolbar.import")}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "flex items-center gap-1.5",
              )}
            >
              <Icons.Import className="h-4 w-4" />
              <span className="hidden sm:inline">{t("asset:quoteToolbar.import")}</span>
            </Link>
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
        <div ref={trackingRef} className="flex shrink-0 items-center space-x-2">
          {/* The switch shows the mode and opens the confirmation; it never
              toggles itself, so it is read-only. The trigger would make it a
              button, so it keeps its switch role. */}
          <PopoverTrigger
            nativeButton={false}
            render={
              <Switch id="manual-tracking" role="switch" checked={isManualDataSource} readOnly />
            }
          />
          <Label
            htmlFor="manual-tracking"
            className="cursor-pointer text-xs sm:text-sm"
            onClick={() => setPopoverOpen(true)}
          >
            {t("asset:quoteToolbar.manual")}
          </Label>
        </div>
        <PopoverContent className="w-[320px] p-4 sm:w-[360px]" align="end" anchor={trackingRef}>
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
