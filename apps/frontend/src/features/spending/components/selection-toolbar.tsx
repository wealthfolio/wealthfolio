import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui";

import { SelectionCheckbox } from "./selection-checkbox";

interface SelectionToolbarProps {
  /** Rows currently loaded. The toolbar hides entirely when there are none. */
  rowCount: number;
  selectionMode: boolean;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onToggleSelectAllVisible: () => void;
}

/**
 * The mobile card list's selection control: a `Select` affordance at rest, and
 * a select-all plus `Cancel` once selection is on. The table reveals its
 * checkboxes on row hover or focus instead, so this has no desktop counterpart.
 */
export function SelectionToolbar({
  rowCount,
  selectionMode,
  onEnterSelectionMode,
  onExitSelectionMode,
  allVisibleSelected,
  someVisibleSelected,
  onToggleSelectAllVisible,
}: SelectionToolbarProps) {
  const { t } = useTranslation();

  // `> 0`, not `> 1`: this is the only way into selection mode, so requiring a
  // second row put bulk actions out of reach whenever a filter matched exactly
  // one transaction.
  if (rowCount === 0) return null;

  return (
    <div className="flex h-8 items-center gap-2 px-1">
      {selectionMode ? (
        <>
          <SelectionCheckbox
            checked={allVisibleSelected}
            indeterminate={!allVisibleSelected && someVisibleSelected}
            onCheckedChange={onToggleSelectAllVisible}
            aria-label={
              allVisibleSelected
                ? t("spending:txTab.deselectAllVisible")
                : t("spending:txTab.selectAllVisible")
            }
          />
          {/* Just the control here — the bulk bar above already reports how
              many rows are selected. */}
          <span className="text-muted-foreground text-xs">{t("common:select_all")}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={onExitSelectionMode}
          >
            {t("common:cancel")}
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          onClick={onEnterSelectionMode}
        >
          {t("common:select")}
        </Button>
      )}
    </div>
  );
}
