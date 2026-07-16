export interface PerformanceToolResult {
  id: string;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
  currency: string;
  mode?: string;
  twr?: number | null;
  annualizedTwr?: number | null;
  irr?: number | null;
  annualizedIrr?: number | null;
  valueReturn?: number | null;
  annualizedValueReturn?: number | null;
  attribution?: PerformanceToolAttribution | null;
  volatility?: number | null;
  maxDrawdown?: number | null;
  isMixedTrackingMode?: boolean;
  summaryAmount?: number | null;
  summaryPercent?: number | null;
  summaryAmountStatus?: string;
  summaryPercentStatus?: string;
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
  const legacyPercentStatus =
    typeof legacyComponentCoverage?.percentComplete === "boolean"
      ? legacyComponentCoverage.percentComplete
        ? "complete"
        : "unavailable"
      : typeof legacyComponentCoverage?.percent_complete === "boolean"
        ? legacyComponentCoverage.percent_complete
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
    mode: (candidate.mode as string | undefined) ?? (candidate.Mode as string | undefined),
    twr: returns?.twr != null || returns?.Twr != null ? Number(returns.twr ?? returns.Twr) : null,
    annualizedTwr:
      returns?.annualizedTwr != null || returns?.annualized_twr != null
        ? Number(returns.annualizedTwr ?? returns.annualized_twr)
        : null,
    irr: returns?.irr != null || returns?.Irr != null ? Number(returns.irr ?? returns.Irr) : null,
    annualizedIrr:
      returns?.annualizedIrr != null || returns?.annualized_irr != null
        ? Number(returns.annualizedIrr ?? returns.annualized_irr)
        : null,
    valueReturn:
      returns?.valueReturn != null || returns?.value_return != null
        ? Number(returns.valueReturn ?? returns.value_return)
        : null,
    annualizedValueReturn:
      returns?.annualizedValueReturn != null || returns?.annualized_value_return != null
        ? Number(returns.annualizedValueReturn ?? returns.annualized_value_return)
        : null,
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
    summaryPercent: numberOrNull(summary?.percent ?? summary?.Percent),
    summaryAmountStatus:
      (summary?.amountStatus as string | undefined) ??
      (summary?.amount_status as string | undefined) ??
      legacyAmountStatus,
    summaryPercentStatus:
      (summary?.percentStatus as string | undefined) ??
      (summary?.percent_status as string | undefined) ??
      legacyPercentStatus,
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
