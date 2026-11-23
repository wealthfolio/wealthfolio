import type { FxConversionIssue } from "@/lib/types";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { cn } from "@wealthfolio/ui/lib/utils";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

interface IncompleteValuationNoteProps {
  /** The N/A as the page shows it. */
  children: ReactNode;
  /** Conversions the valuation lacked, when it reports them. */
  missingFx?: FxConversionIssue[];
  /**
   * The currency of the missing value. A valuation reports conversions into
   * other currencies too, which do not explain this N/A.
   */
  currency: string;
  className?: string;
}

/**
 * An N/A shown because a valuation is incomplete, with the reason and a way to
 * the Health Center. A popover rather than a tooltip: it opens on hover, but
 * also on tap and with the keyboard, and its link can be reached.
 */
export function IncompleteValuationNote({
  children,
  missingFx,
  currency,
  className,
}: IncompleteValuationNoteProps) {
  const { t } = useTranslation();
  const pairs = [
    ...new Set(
      (missingFx ?? [])
        .filter((issue) => issue.toCurrency.toUpperCase() === currency.toUpperCase())
        .map((issue) => `${issue.fromCurrency} → ${issue.toCurrency}`),
    ),
  ];

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        // Inside a card that is itself a link or toggle, opening the note
        // neither follows nor toggles it.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        render={
          <button
            type="button"
            className={cn(
              "focus-visible:ring-ring cursor-help rounded-sm underline decoration-dotted underline-offset-4 focus-visible:ring-2 focus-visible:outline-none",
              className,
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-64 space-y-2 p-3 text-xs"
        // React events cross the portal: keep clicks here from the card's handlers.
        onClick={(e) => e.stopPropagation()}
      >
        {pairs.length > 0 ? (
          <p>
            {t("common:valuation_incomplete_fx", { count: pairs.length })}{" "}
            {pairs.map((pair, index) => (
              <span key={pair}>
                {index > 0 && ", "}
                <bdi>{pair}</bdi>
              </span>
            ))}
          </p>
        ) : (
          <p>{t("common:valuation_incomplete")}</p>
        )}
        <Link
          to="/health"
          className="text-primary inline-flex items-center gap-1 font-medium underline underline-offset-2"
        >
          {t("common:view_in_health_center")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
