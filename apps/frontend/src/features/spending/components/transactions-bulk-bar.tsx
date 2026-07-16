import { useTranslation } from "react-i18next";

import { Button, Icons } from "@wealthfolio/ui";

import { QuickCategorizePopover, type QuickCategorizeScope } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";

interface TransactionsBulkBarProps {
  selectedCount: number;
  categoryScope: QuickCategorizeScope | null;
  onCategorize: (taxonomyId: string, categoryId: string) => void;
  onTagEvent: (eventId: string | null) => void;
  onDelete: () => void;
  onClearSelection: () => void;
}

export function TransactionsBulkBar({
  selectedCount,
  categoryScope,
  onCategorize,
  onTagEvent,
  onDelete,
  onClearSelection,
}: TransactionsBulkBarProps) {
  const { t } = useTranslation();
  return (
    <div
      role="region"
      aria-label={t("spending:transactions.bulkActions")}
      className="bg-muted/40 ring-border flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 ring-1"
    >
      <div className="text-foreground flex items-center gap-2 text-sm">
        <Icons.Check className="h-4 w-4" aria-hidden="true" />
        <span className="font-medium">
          {t("spending:transactions.selectedCount", { count: selectedCount })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {categoryScope ? (
          <QuickCategorizePopover
            align="end"
            scope={categoryScope}
            onSelect={onCategorize}
            trigger={
              <Button size="sm" variant="default">
                <Icons.Tag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t("spending:transactions.categorize")}
              </Button>
            }
          />
        ) : (
          <Button
            size="sm"
            variant="default"
            disabled
            title={t("spending:transactions.categorizeHint")}
          >
            <Icons.Tag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("spending:transactions.categorize")}
          </Button>
        )}
        <QuickEventPopover
          align="end"
          onSelect={(eventId) => onTagEvent(eventId)}
          onClear={() => onTagEvent(null)}
          trigger={
            <Button size="sm" variant="outline">
              <Icons.Calendar className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t("spending:transactions.tagEvent")}
            </Button>
          }
        />
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Icons.Trash className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("common:delete")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          {t("common:clear")}
        </Button>
      </div>
    </div>
  );
}
