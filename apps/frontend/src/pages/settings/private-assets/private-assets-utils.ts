import type {
  PrivateAssetFreshnessState,
  PrivateAssetStatus,
  PrivateAssetStrategyType,
  PrivateAssetVehicleKind,
  PrivateSnapshotCashFlowType,
  PrivateSnapshotValueSourceType,
  PrivateSubAssetReportingBasis,
} from "@/lib/types";
import { formatAmount } from "@wealthfolio/ui";

export const privateAssetVehicleKindOptions = [
  { label: "Fund", value: "FUND" },
  { label: "Co-Investment", value: "CO_INVESTMENT" },
  { label: "Real Estate", value: "REAL_ESTATE" },
  { label: "Other", value: "OTHER" },
] as const;

export const privateAssetStrategyOptions = [
  { label: "Venture", value: "VENTURE" },
  { label: "Private Equity", value: "PRIVATE_EQUITY" },
  { label: "Hedge Fund", value: "HEDGE_FUND" },
  { label: "Private Credit", value: "PRIVATE_CREDIT" },
  { label: "Fund of Funds", value: "FUND_OF_FUNDS" },
  { label: "Energy", value: "ENERGY" },
  { label: "Real Estate", value: "REAL_ESTATE" },
  { label: "Other", value: "OTHER" },
] as const;

export const privateAssetStatusOptions = [
  { label: "Active", value: "ACTIVE" },
  { label: "Realized", value: "REALIZED" },
  { label: "Archived", value: "ARCHIVED" },
] as const;

export const privateSubAssetReportingBasisOptions = [
  { label: "Unknown", value: "UNKNOWN" },
  { label: "Gross", value: "GROSS" },
  { label: "Net", value: "NET" },
] as const;

export const privateSnapshotValueSourceOptions = [
  { label: "Manual", value: "MANUAL" },
  { label: "Statement", value: "STATEMENT" },
  { label: "Estimated", value: "ESTIMATED" },
] as const;

export const privateSnapshotCashFlowTypeOptions = [
  { label: "ITD / inception-to-date column", value: "TOTAL_TO_DATE" },
  { label: "Period activity only (MTD / QTD / YTD column)", value: "PERIOD_ONLY" },
] as const;

const vehicleKindLabels: Record<PrivateAssetVehicleKind, string> = {
  FUND: "Fund",
  CO_INVESTMENT: "Co-Investment",
  DIRECT: "Direct",
  REAL_ESTATE: "Real Estate",
  OTHER: "Other",
};

const strategyLabels: Record<PrivateAssetStrategyType, string> = {
  VENTURE: "Venture",
  PRIVATE_EQUITY: "Private Equity",
  HEDGE_FUND: "Hedge Fund",
  PRIVATE_CREDIT: "Private Credit",
  FUND_OF_FUNDS: "Fund of Funds",
  ENERGY: "Energy",
  REAL_ESTATE: "Real Estate",
  OTHER: "Other",
};

const statusLabels: Record<PrivateAssetStatus, string> = {
  ACTIVE: "Active",
  REALIZED: "Realized",
  ARCHIVED: "Archived",
};

const reportingBasisLabels: Record<PrivateSubAssetReportingBasis, string> = {
  UNKNOWN: "Unknown",
  GROSS: "Gross",
  NET: "Net",
};

const snapshotSourceLabels: Record<PrivateSnapshotValueSourceType, string> = {
  MANUAL: "Manual",
  STATEMENT: "Statement",
  ESTIMATED: "Estimated",
};

const snapshotCashFlowTypeLabels: Record<PrivateSnapshotCashFlowType, string> = {
  TOTAL_TO_DATE: "ITD / inception-to-date",
  PERIOD_ONLY: "Period activity only",
};

export function formatPrivateAssetVehicleKind(value: PrivateAssetVehicleKind) {
  return vehicleKindLabels[value];
}

export function formatPrivateAssetStrategy(value: PrivateAssetStrategyType) {
  return strategyLabels[value];
}

export function formatPrivateAssetStatus(value: PrivateAssetStatus) {
  return statusLabels[value];
}

export function formatPrivateSubAssetReportingBasis(value: PrivateSubAssetReportingBasis) {
  return reportingBasisLabels[value];
}

export function formatPrivateSnapshotValueSource(value: PrivateSnapshotValueSourceType) {
  return snapshotSourceLabels[value];
}

export function formatPrivateSnapshotCashFlowType(value: PrivateSnapshotCashFlowType) {
  return snapshotCashFlowTypeLabels[value];
}

export function getPrivateStatementAmountLabel(
  value: PrivateSnapshotCashFlowType,
  direction: "contributed" | "distributed",
) {
  const baseLabel = direction === "contributed" ? "Contributed" : "Distributed";
  return value === "PERIOD_ONLY" ? `${baseLabel} (Period)` : `${baseLabel} (Since Inception)`;
}

export function getFreshnessBadgeClass(state: PrivateAssetFreshnessState) {
  switch (state) {
    case "CURRENT":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "STALE":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "ESTIMATED":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "MISSING":
      return "border-muted bg-muted text-muted-foreground";
  }
}

export function getStatusBadgeClass(status: PrivateAssetStatus) {
  switch (status) {
    case "ACTIVE":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "REALIZED":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "ARCHIVED":
      return "border-muted bg-muted text-muted-foreground";
  }
}

export function formatPrivateAmount(
  value: number | null | undefined,
  currency: string,
  isHidden = false,
) {
  if (isHidden) {
    return "••••";
  }

  if (value === null || value === undefined) {
    return "—";
  }

  return formatAmount(value, currency, false);
}
