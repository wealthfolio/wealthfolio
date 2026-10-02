import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";

/**
 * Field help behind an (i). A popover rather than a tooltip so it opens on touch.
 * Render it beside the label, not inside it, so the input's name stays the label.
 */
export function LoanFieldInfo({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("common:more_info_about", { label })}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2"
        >
          <Icons.Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 text-sm">
        {children}
      </PopoverContent>
    </Popover>
  );
}
