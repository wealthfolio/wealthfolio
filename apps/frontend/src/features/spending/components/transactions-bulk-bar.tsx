import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Icons, Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui";

import type { TaxonomyCategory } from "@/lib/types";

import { PayeeCommand } from "./payee-field";
import { QuickCategorizePopover, type QuickCategorizeScope } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";

interface TransactionsBulkBarProps {
  selectedCount: number;
  categoryScope: QuickCategorizeScope | null;
  onCategorize: (taxonomyId: string, categoryId: string) => void;
  onTagEvent: (eventId: string | null) => void;
  /** Existing payees, offered in the "Set payee" list. */
  payees: TaxonomyCategory[];
  /** Called with an existing payee's name, a new one to create, or "" to clear. */
  onSetPayee: (name: string) => void;
  onDelete: () => void;
  onClearSelection: () => void;
}

export function TransactionsBulkBar({
  selectedCount,
  categoryScope,
  onCategorize,
  onTagEvent,
  payees,
  onSetPayee,
  onDelete,
  onClearSelection,
}: TransactionsBulkBarProps) {
  const { t } = useTranslation();
  const [payeeOpen, setPayeeOpen] = useState(false);
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
      {/* Wraps: on a phone these four buttons do not fit beside the count, and
          without it the last one is cut off at the edge of the screen. */}
      <div className="flex flex-wrap items-center gap-2">
        {categoryScope ? (
          <QuickCategorizePopover
            align="end"
            scope={categoryScope}
            onSelect={onCategorize}
            trigger={
              <Button size="sm" variant="default">
                <Icons.Tag className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
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
            <Icons.Tag className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("spending:transactions.categorize")}
          </Button>
        )}
        <QuickEventPopover
          align="end"
          onSelect={(eventId) => onTagEvent(eventId)}
          onClear={() => onTagEvent(null)}
          trigger={
            <Button size="sm" variant="outline">
              <Icons.Calendar className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t("spending:transactions.tagEvent")}
            </Button>
          }
        />
        <Popover open={payeeOpen} onOpenChange={setPayeeOpen}>
          <PopoverTrigger render={<Button size="sm" variant="outline" />}>
            <Icons.Store className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("spending:cashForm.payeeBulkSet")}
          </PopoverTrigger>
          <PopoverContent className="w-70 p-0" align="end">
            <PayeeCommand
              value=""
              clearable
              payees={payees}
              onPick={(name) => {
                setPayeeOpen(false);
                onSetPayee(name);
              }}
            />
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive-subtle hover:text-destructive-subtle-foreground"
          onClick={onDelete}
        >
          <Icons.Trash className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("common:delete")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          {t("common:clear")}
        </Button>
      </div>
    </div>
  );
}
