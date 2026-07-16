import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatPercent, GainAmount, GainPercent } from "@wealthfolio/ui";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Explanatory texts for info popovers
export const TIME_WEIGHTED_RETURN_INFO =
  "Time-weighted return (TWR) measures investment performance after removing the effect of deposits and withdrawals. Periods under one year are shown as selected-period returns; periods of one year or longer are shown annualized when available.";
export const MONEY_WEIGHTED_RETURN_INFO =
  "Money-weighted return (MWR) measures performance using the size and timing of external cash flows. It is calculated with IRR/XIRR; for periods of one year or longer, annualized XIRR is the standard display.";
export const IRR_RETURN_INFO =
  "Internal rate of return (IRR) measures money-weighted performance using the size and timing of external cash flows. For periods of one year or longer, annualized XIRR is the standard display.";
export const SIMPLE_RETURN_INFO =
  "Simple return compares total gain or loss with net contributions. It is cumulative and not time weighted.";
export const VALUE_RETURN_INFO =
  "Value return measures the change in account value over the selected period when transaction-level cash flows are not available.";
export const PRICE_RETURN_INFO =
  "Price return measures the selected symbol's price change over the selected period.";
export const VOLATILITY_INFO =
  "Volatility measures the dispersion of returns for a given investment. Higher volatility means the investment can change dramatically over a short period. It is annualized from calendar-daily returns.";
export const MAX_DRAWDOWN_INFO =
  "Maximum Drawdown represents the largest percentage decline from a peak to a subsequent trough in portfolio value during the specified period. It indicates downside risk.";
export const ANNUALIZED_RETURN_INFO =
  "Annualized return is the average yearly compounded rate for the selected period. It is not the cumulative total gain or loss.";

// Holdings mode specific info texts.
export const HOLDINGS_MODE_VOLATILITY_INFO =
  "Volatility of account value changes. Based on daily valuations without adjusting for deposits or withdrawals. Reflects how much the market value fluctuates.";
export const HOLDINGS_MODE_MAX_DRAWDOWN_INFO =
  "Largest peak-to-trough decline in account value. Based on daily valuations without adjusting for deposits or withdrawals.";

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
  const { t } = useTranslation();
  const [mobilePopoverOpen, setMobilePopoverOpen] = useState(false);

  const displayValue =
    value === undefined ? (
      <span className={cn("text-muted-foreground text-base font-medium", valueClassName)}>N/A</span>
    ) : isPercentage && tone === "neutral" ? (
      <span className={cn("text-foreground text-base font-medium", valueClassName)}>
        {formatPercent(value)}
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
        <span className="text-center">{label}</span>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground absolute right-2 top-2 hidden h-4 w-4 rounded-full p-0 md:inline-flex"
          >
            <Icons.Info className="h-3 w-3" />
            <span className="sr-only">{t("common:component.more_info_about", { label })}</span>
          </Button>
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
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-help">{displayValue}</div>
            </TooltipTrigger>
            <TooltipContent className="space-y-1">
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
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring line-clamp-2 max-w-[11rem] rounded-sm text-center text-[10px] leading-tight underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {emptyReason}
        </Link>
      )}
    </>
  );

  return (
    <Popover open={mobilePopoverOpen} onOpenChange={setMobilePopoverOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-h-16 flex-col items-center justify-center space-y-1 p-4 md:cursor-default md:p-4",
            "relative cursor-pointer md:cursor-auto",
            className,
          )}
        >
          {content}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-60 text-xs md:hidden" side="top" align="center">
        {infoText}
      </PopoverContent>
    </Popover>
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

export const MetricLabelWithInfo: React.FC<MetricLabelWithInfoProps> = ({
  label,
  infoText,
  warningText,
  boldTerms = [],
  className,
}) => {
  const { t } = useTranslation();
  const warningItems = Array.from(
    new Set(
      (Array.isArray(warningText) ? warningText : warningText ? [warningText] : [])
        .map((warning) => warning.trim())
        .filter(Boolean),
    ),
  );
  const hasWarnings = warningItems.length > 0;

  return (
    <div className={cn("text-muted-foreground flex items-center text-xs font-light", className)}>
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "ml-1 h-4 w-4 rounded-full p-0",
              hasWarnings && "text-warning hover:text-warning",
            )}
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
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[40rem] max-w-[calc(100vw-2rem)] p-0 text-sm"
          side="top"
          align="center"
        >
          <div className="space-y-3 p-5">
            <p className="text-muted-foreground leading-relaxed">{infoText}</p>
            {hasWarnings && (
              <div className="space-y-2 border-t pt-3">
                <div className="text-warning flex items-center gap-1.5 font-medium">
                  <Icons.AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    {warningItems.length === 1
                      ? t("common:component.calculation_note")
                      : t("common:component.calculation_notes", { count: warningItems.length })}
                  </span>
                </div>
                <ul className="text-muted-foreground max-h-[60vh] space-y-2 overflow-y-auto pr-1 leading-relaxed">
                  {warningItems.map((warning, index) => (
                    <li key={`${warning}-${index}`} className="flex gap-1.5">
                      <span className="bg-warning/70 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                      <span className="min-w-0 break-words">
                        {renderWarningText(warning, boldTerms)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
