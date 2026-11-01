import { cn } from "@/lib/utils";
import { GainAmount, GainPercent, useNumberFormatting } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Stable translation keys for metric explanations; resolve in the rendering locale.
export const TIME_WEIGHTED_RETURN_INFO_KEY = "performance:metric_info.time_weighted_return";
export const MONEY_WEIGHTED_RETURN_INFO_KEY = "performance:metric_info.money_weighted_return";
export const IRR_RETURN_INFO_KEY = "performance:metric_info.irr";
export const SIMPLE_RETURN_INFO_KEY = "performance:metric_info.simple_return";
export const VALUE_RETURN_INFO_KEY = "performance:metric_info.value_return";
export const PRICE_RETURN_INFO_KEY = "performance:metric_info.price_return";
export const VOLATILITY_INFO_KEY = "performance:metric_info.volatility";
export const MAX_DRAWDOWN_INFO_KEY = "performance:metric_info.max_drawdown";
export const ANNUALIZED_RETURN_INFO_KEY = "performance:metric_info.annualized_return";

// Holdings mode specific info texts.
export const HOLDINGS_MODE_VOLATILITY_INFO_KEY = "performance:metric_info.holdings_volatility";
export const HOLDINGS_MODE_MAX_DRAWDOWN_INFO_KEY = "performance:metric_info.holdings_max_drawdown";

export interface MetricDisplayProps {
  label: string;
  value?: number; // Made optional as performance-page might only need label and info
  infoText: string;
  annualizedValue?: number | null;
  secondaryValue?: number | null;
  secondaryValueLabel?: string;
  isPercentage?: boolean;
  currency?: string;
  className?: string;
  valueClassName?: string; // Added to allow custom styling for the value itself
  labelComponent?: React.ReactNode; // Allow passing a full component for label + info
  emptyReason?: string;
  tone?: "gain" | "neutral";
}

export const MetricDisplay: React.FC<MetricDisplayProps> = ({
  label,
  value,
  infoText,
  annualizedValue,
  secondaryValue,
  secondaryValueLabel,
  isPercentage = true,
  currency = "USD",
  className,
  valueClassName,
  labelComponent,
  emptyReason,
  tone = "gain",
}) => {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  const [mobilePopoverOpen, setMobilePopoverOpen] = useState(false);

  const displayValue =
    value === undefined ? (
      <span className={cn("text-muted-foreground text-base font-medium", valueClassName)}>
        {t("performance:not_available")}
      </span>
    ) : isPercentage && tone === "neutral" ? (
      <span className={cn("text-foreground text-base font-medium", valueClassName)}>
        {formatting.formatPercent(value)}
      </span>
    ) : isPercentage ? (
      <GainPercent
        value={value}
        animated={true}
        showSign={isPercentage}
        className={cn("text-base font-medium", !isPercentage && "text-foreground", valueClassName)}
      />
    ) : (
      <GainAmount
        value={value}
        currency={currency}
        displayCurrency={false}
        className={cn("text-base font-medium", valueClassName)}
      />
    );

  const labelContent = labelComponent ?? (
    <>
      <div className="text-muted-foreground flex w-full items-center justify-center text-xs">
        {/* A word wider than a narrow tile breaks rather than being cut off. */}
        <span className="min-w-0 text-center wrap-break-word">{label}</span>
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground absolute end-2 top-2 hidden h-4 w-4 rounded-full p-0 md:inline-flex"
            />
          }
        >
          <Icons.Info className="h-3 w-3" />
          <span className="sr-only">{t("common:component.more_info_about", { label })}</span>
        </PopoverTrigger>
        <PopoverContent className="w-60 text-xs" side="top" align="end">
          {infoText}
        </PopoverContent>
      </Popover>
    </>
  );

  const formatTooltipValue = (tooltipValue: number) =>
    isPercentage ? (
      <GainPercent value={tooltipValue} animated={false} />
    ) : (
      <GainAmount value={tooltipValue} currency={currency} displayCurrency={false} />
    );

  const valueTooltipRows =
    value === undefined
      ? []
      : [
          annualizedValue !== undefined && annualizedValue !== null
            ? { label: t("common:component.annualized"), value: annualizedValue }
            : null,
          secondaryValue !== undefined && secondaryValue !== null
            ? { label: secondaryValueLabel ?? t("common:component.related"), value: secondaryValue }
            : null,
        ].filter((row): row is { label: string; value: number } => row !== null);

  const content = (
    <>
      {labelContent}

      {valueTooltipRows.length > 0 ? (
        <TooltipProvider delay={100}>
          <Tooltip>
            <TooltipTrigger render={<div className="cursor-help" />}>{displayValue}</TooltipTrigger>
            <TooltipContent className="flex flex-col gap-1">
              {valueTooltipRows.map((row) => (
                <p key={row.label} className="text-xs">
                  {row.label}: {formatTooltipValue(row.value)}
                </p>
              ))}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div>{displayValue}</div>
      )}

      {value === undefined && emptyReason && (
        <Link
          to="/health"
          title={emptyReason}
          aria-label={t("common:component.open_health_center_for", { label })}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-2xs relative z-20 line-clamp-2 max-w-[11rem] rounded-sm text-center leading-tight underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {emptyReason}
        </Link>
      )}
    </>
  );

  // On mobile the whole tile opens the explanation. The trigger is a sibling
  // overlay rather than a wrapper, so the info button and Health link inside
  // the tile are not nested in another control. It sits above the animated
  // value, which isolates its own stacking context, and below the Health link.
  return (
    <div
      className={cn(
        "relative flex min-h-16 flex-col items-center justify-center space-y-1 p-4 md:p-4",
        className,
      )}
    >
      <Popover open={mobilePopoverOpen} onOpenChange={setMobilePopoverOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={t("common:component.more_info_about", { label })}
              className="focus-visible:outline-ring absolute inset-0 z-10 cursor-pointer rounded-[inherit] focus-visible:outline-2 md:hidden"
            />
          }
        />
        <PopoverContent className="w-60 text-xs md:hidden" side="top" align="center">
          {infoText}
        </PopoverContent>
      </Popover>
      {content}
    </div>
  );
};

// Simple component for displaying only the label with info popover
// This can be used by performance-page.tsx
export interface MetricLabelWithInfoProps {
  label: string;
  infoText: string;
  warningText?: string | string[];
  /** Substrings (e.g. account names) to render in bold within each warning. */
  boldTerms?: string[];
  className?: string;
}

/** Render a warning string, bolding any occurrences of the provided terms. */
function renderWarningText(text: string, boldTerms: string[]): React.ReactNode {
  const terms = boldTerms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "g"));
  return parts.map((part, index) =>
    terms.includes(part) ? (
      <strong key={index} className="text-foreground font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/** Normalize the `string | string[] | undefined` warning prop into a deduped, trimmed list. */
export function metricWarningItems(warningText?: string | string[]): string[] {
  return Array.from(
    new Set(
      (Array.isArray(warningText) ? warningText : warningText ? [warningText] : [])
        .map((warning) => warning.trim())
        .filter(Boolean),
    ),
  );
}

/** Shared body of a metric's info popover: explanatory text plus any calculation notes. */
export const MetricInfoPopoverBody: React.FC<{
  infoText: string;
  warningItems: string[];
  boldTerms?: string[];
}> = ({ infoText, warningItems, boldTerms = [] }) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-3 p-5">
      <p className="text-muted-foreground leading-relaxed">{infoText}</p>
      {warningItems.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-warning flex items-center gap-1.5 font-medium">
            <Icons.AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {warningItems.length === 1
                ? t("common:component.calculation_note")
                : t("common:component.calculation_notes", { count: warningItems.length })}
            </span>
          </div>
          <ul className="text-muted-foreground max-h-[60vh] space-y-2 overflow-y-auto pe-1 leading-relaxed">
            {warningItems.map((warning, index) => (
              <li key={`${warning}-${index}`} className="flex gap-1.5">
                <span className="bg-warning/70 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                <span className="min-w-0 break-words">{renderWarningText(warning, boldTerms)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export const MetricLabelWithInfo: React.FC<MetricLabelWithInfoProps> = ({
  label,
  infoText,
  warningText,
  boldTerms = [],
  className,
}) => {
  const { t } = useTranslation();
  const warningItems = metricWarningItems(warningText);
  const hasWarnings = warningItems.length > 0;

  return (
    <div className={cn("text-muted-foreground flex items-center text-xs font-light", className)}>
      <span>{label}</span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "ms-1 h-4 w-4 rounded-full p-0",
                hasWarnings && "text-warning hover:text-warning",
              )}
            />
          }
        >
          {hasWarnings ? (
            <Icons.AlertTriangle className="h-3 w-3" />
          ) : (
            <Icons.Info className="h-3 w-3" />
          )}
          <span className="sr-only">
            {hasWarnings
              ? t("common:component.calculation_note_for", { label })
              : t("common:component.more_info_about", { label })}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="w-[40rem] max-w-[calc(100vw-2rem)] p-0 text-sm"
          side="top"
          align="center"
        >
          <MetricInfoPopoverBody
            infoText={infoText}
            warningItems={warningItems}
            boldTerms={boldTerms}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};
