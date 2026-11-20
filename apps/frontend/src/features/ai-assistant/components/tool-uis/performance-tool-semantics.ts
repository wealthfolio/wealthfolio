import type { PerformanceReturnViewKey } from "@/lib/types";

/** One return view from the tool output; `period` is missing when the scope cannot support it. */
export interface PerformanceToolReturn {
  period: number | null;
  annualized: number | null;
  unavailableReason: string | null;
}

export interface PerformanceToolResult {
  id: string;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
  currency: string;
  returns: Record<PerformanceReturnViewKey, PerformanceToolReturn>;
  attribution?: PerformanceToolAttribution | null;
  volatility?: number | null;
  maxDrawdown?: number | null;
  isMixedTrackingMode?: boolean;
  summaryAmount?: number | null;
  summaryAmountStatus?: string;
  summaryBasisStatus?: string;
  basisStatus?: string;
  warnings?: string[];
  notApplicableReasons?: string[];
  dataQualityStatus?: string;
}

interface PerformanceToolAttribution {
  income: number;
  realizedPnl: number;
  unrealizedPnlChange: number;
  fxEffect: number;
  fees: number;
  taxes: number;
  residual: number;
}

function safeString(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolReturn(view: Record<string, unknown> | undefined): PerformanceToolReturn {
  return {
    period: numberOrNull(view?.period),
    annualized: numberOrNull(view?.annualized),
    unavailableReason:
      (view?.unavailableReason as string | undefined) ??
      (view?.unavailable_reason as string | undefined) ??
      null,
  };
}

/**
 * The tool's return views. Chats saved before the views existed hold flat
 * fields (`twr`, `annualizedIrr`, `valueReturn`, `mode`); those map onto the
 * closest view so old messages still render.
 */
function toolReturns(
  returns: Record<string, unknown> | undefined,
  legacyMode: string | undefined,
  legacyMixed: boolean,
): Record<PerformanceReturnViewKey, PerformanceToolReturn> {
  const twr = asRecord(returns?.twr);
  const moneyWeighted = asRecord(returns?.moneyWeighted ?? returns?.money_weighted);
  if (twr || moneyWeighted) {
    return {
      twr: toolReturn(twr),
      moneyWeighted: toolReturn(moneyWeighted),
      returnOnCost: toolReturn(asRecord(returns?.returnOnCost ?? returns?.return_on_cost)),
    };
  }
  const legacy = (camel: string, snake: string) =>
    numberOrNull(returns?.[camel] ?? returns?.[snake]);
  // A mixed scope's legacy value return was money-weighted; a holdings one
  // was gain on cost.
  const legacyValueReturn = legacyMode === "valueReturn" && !legacyMixed;
  return {
    twr: {
      period: numberOrNull(returns?.twr),
      annualized: legacy("annualizedTwr", "annualized_twr"),
      unavailableReason: null,
    },
    moneyWeighted: {
      period: legacyMixed ? legacy("valueReturn", "value_return") : numberOrNull(returns?.irr),
      annualized: legacy("annualizedIrr", "annualized_irr"),
      unavailableReason: null,
    },
    returnOnCost: {
      period: legacyValueReturn ? legacy("valueReturn", "value_return") : null,
      annualized: legacyValueReturn
        ? legacy("annualizedValueReturn", "annualized_value_return")
        : null,
      unavailableReason: null,
    },
  };
}

export function normalizePerformanceToolResult(
  result: unknown,
  fallbackCurrency: string,
): PerformanceToolResult | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    try {
      return normalizePerformanceToolResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizePerformanceToolResult(candidate.data, fallbackCurrency);
  }

  const scope = (candidate.scope ?? candidate.Scope) as Record<string, unknown> | undefined;
  const period = (candidate.period ?? candidate.Period) as Record<string, unknown> | undefined;
  const returns = (candidate.returns ?? candidate.Returns) as Record<string, unknown> | undefined;
  const attribution = (candidate.attribution ?? candidate.Attribution) as
    | Record<string, unknown>
    | undefined;
  const risk = (candidate.risk ?? candidate.Risk) as Record<string, unknown> | undefined;
  const dataQuality = (candidate.dataQuality ?? candidate.data_quality ?? candidate.DataQuality) as
    | Record<string, unknown>
    | undefined;
  const legacyHeadline = (candidate.headline ?? candidate.Headline) as
    | Record<string, unknown>
    | undefined;
  const summary = (candidate.summary ?? candidate.Summary ?? legacyHeadline) as
    | Record<string, unknown>
    | undefined;
  const legacyComponentCoverage = (legacyHeadline?.componentCoverage ??
    legacyHeadline?.component_coverage) as Record<string, unknown> | undefined;
  const legacyAmountStatus =
    typeof legacyComponentCoverage?.amountComplete === "boolean"
      ? legacyComponentCoverage.amountComplete
        ? "complete"
        : "unavailable"
      : typeof legacyComponentCoverage?.amount_complete === "boolean"
        ? legacyComponentCoverage.amount_complete
          ? "complete"
          : "unavailable"
        : undefined;
  const warnings = Array.isArray(dataQuality?.warnings)
    ? (dataQuality.warnings as string[])
    : Array.isArray(candidate.warnings)
      ? (candidate.warnings as string[])
      : [];
  const notApplicableReasons = Array.isArray(dataQuality?.notApplicableReasons)
    ? (dataQuality.notApplicableReasons as string[])
    : Array.isArray(dataQuality?.not_applicable_reasons)
      ? (dataQuality.not_applicable_reasons as string[])
      : [];

  return {
    id: safeString(candidate.id ?? candidate.Id ?? scope?.id, ""),
    periodStartDate:
      (candidate.periodStartDate as string | undefined) ??
      (candidate.period_start_date as string | undefined) ??
      (period?.startDate as string | undefined) ??
      (period?.start_date as string | undefined) ??
      null,
    periodEndDate:
      (candidate.periodEndDate as string | undefined) ??
      (candidate.period_end_date as string | undefined) ??
      (period?.endDate as string | undefined) ??
      (period?.end_date as string | undefined) ??
      null,
    currency:
      (candidate.currency as string | undefined) ??
      (candidate.Currency as string | undefined) ??
      (scope?.currency as string | undefined) ??
      fallbackCurrency,
    returns: toolReturns(
      returns,
      (candidate.mode as string | undefined) ?? (candidate.Mode as string | undefined),
      Boolean(candidate.isMixedTrackingMode ?? candidate.is_mixed_tracking_mode ?? false),
    ),
    attribution: attribution
      ? {
          income: Number(attribution.income ?? attribution.Income ?? 0),
          realizedPnl: Number(attribution.realizedPnl ?? attribution.realized_pnl ?? 0),
          unrealizedPnlChange: Number(
            attribution.unrealizedPnlChange ?? attribution.unrealized_pnl_change ?? 0,
          ),
          fxEffect: Number(attribution.fxEffect ?? attribution.fx_effect ?? 0),
          fees: Number(attribution.fees ?? attribution.Fees ?? 0),
          taxes: Number(attribution.taxes ?? attribution.Taxes ?? 0),
          residual: Number(attribution.residual ?? attribution.Residual ?? 0),
        }
      : null,
    volatility:
      risk?.volatility != null || risk?.Volatility != null
        ? Number(risk.volatility ?? risk.Volatility)
        : null,
    maxDrawdown:
      risk?.maxDrawdown != null || risk?.max_drawdown != null
        ? Number(risk.maxDrawdown ?? risk.max_drawdown)
        : null,
    isMixedTrackingMode: Boolean(
      candidate.isMixedTrackingMode ?? candidate.is_mixed_tracking_mode ?? false,
    ),
    summaryAmount: numberOrNull(summary?.amount ?? summary?.Amount),
    summaryAmountStatus:
      (summary?.amountStatus as string | undefined) ??
      (summary?.amount_status as string | undefined) ??
      legacyAmountStatus,
    summaryBasisStatus:
      (summary?.basisStatus as string | undefined) ?? (summary?.basis_status as string | undefined),
    basisStatus:
      (candidate.basisStatus as string | undefined) ??
      (candidate.basis_status as string | undefined) ??
      (summary?.basisStatus as string | undefined) ??
      (summary?.basis_status as string | undefined),
    warnings,
    notApplicableReasons,
    dataQualityStatus:
      (dataQuality?.status as string | undefined) ??
      (dataQuality?.Status as string | undefined) ??
      undefined,
  };
}

export function performanceToolPeriodPnl(result: PerformanceToolResult): number | null {
  if (result.summaryAmountStatus !== "complete") return null;
  return result.summaryAmount ?? null;
}
