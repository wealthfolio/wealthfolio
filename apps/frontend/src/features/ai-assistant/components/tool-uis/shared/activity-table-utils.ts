import { calculateTradeFinalAmount } from "@/lib/activity-final-amount";
import { ActivityType } from "@/lib/constants";
import type { FormattingApi } from "@wealthfolio/ui";
import { parseISO } from "date-fns";

/**
 * Display estimate for an AI draft's total. A stated amount shows verbatim;
 * BUY/SELL totals are previewed with the shared trade-final mirror. Drafts
 * deliberately never synthesize a persisted amount (see record_activity.rs) -
 * the backend derives the real value at commit - so this is preview-only.
 */
export function estimateDraftAmount(
  draft: {
    activityType: string;
    quantity?: number;
    unitPrice?: number;
    fee?: number;
    tax?: number;
    amount?: number;
  },
  instrumentType?: string,
): number | undefined {
  if (draft.amount != null) return draft.amount;
  if (draft.activityType !== ActivityType.BUY && draft.activityType !== ActivityType.SELL) {
    return undefined;
  }
  return calculateTradeFinalAmount({
    activityType: draft.activityType as ActivityType,
    instrumentType: instrumentType ?? "",
    quantity: draft.quantity,
    unitPrice: draft.unitPrice,
    fee: draft.fee,
    tax: draft.tax,
  });
}

export function getActivityTypeBadge(activityType: string): {
  variant: "default" | "secondary" | "destructive" | "success";
  className: string;
} {
  const typeUpper = activityType.toUpperCase();
  switch (typeUpper) {
    case "DIVIDEND":
    case "INTEREST":
    case "BUY":
    case "DEPOSIT":
    case "TRANSFER_IN":
      return { variant: "success", className: "rounded-sm" };
    case "SELL":
    case "WITHDRAWAL":
    case "TRANSFER_OUT":
    case "FEE":
    case "TAX":
      return { variant: "destructive", className: "rounded-sm" };
    case "SPLIT":
    case "ADJUSTMENT":
      return { variant: "secondary", className: "rounded-sm" };
    default:
      return { variant: "default", className: "rounded-sm" };
  }
}

export function formatActivityType(activityType: string): string {
  return activityType.replace(/_/g, " ");
}

export function formatActivityDate(
  dateString: string,
  formatting: Pick<FormattingApi, "formatDate">,
): string {
  try {
    return formatting.formatDate(parseISO(dateString));
  } catch {
    return dateString;
  }
}

interface ValueFormatter {
  format(value: number): string;
}

interface AmountFormatter {
  format(value: number, currency: string): string;
}

export function createActivityAmountFormatter(
  formatting: Pick<FormattingApi, "currencyLocale">,
): AmountFormatter {
  // Each currency may have its own format, so keep one formatter per locale.
  const formatters = new Map<string, Intl.NumberFormat>();
  return {
    format: (value, currency) => {
      const locale = formatting.currencyLocale(currency);
      let formatter = formatters.get(locale);
      if (!formatter) {
        formatter = new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        formatters.set(locale, formatter);
      }
      return formatter.format(value);
    },
  };
}

export function createActivityQuantityFormatter(
  formatting: Pick<FormattingApi, "formatDecimal">,
): ValueFormatter {
  return {
    format: (value) =>
      formatting.formatDecimal(value, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      }),
  };
}

export function formatActivityAmount(
  value: number | null | undefined,
  formatter: AmountFormatter,
  isHidden: boolean,
  currency: string,
  { showCurrency = true }: { showCurrency?: boolean } = {},
): string {
  if (value == null) return "-";
  if (isHidden) return "******";
  const formatted = formatter.format(Math.abs(value), currency);
  return showCurrency && currency ? `${formatted} ${currency}` : formatted;
}

export function formatActivityQuantity(
  value: number | null | undefined,
  formatter: ValueFormatter,
  isHidden: boolean,
): string {
  if (value == null) return "-";
  if (isHidden) return "***";
  return formatter.format(value);
}
