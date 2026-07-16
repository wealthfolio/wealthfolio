import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { TickerAvatar } from "@/components/ticker-avatar";
import { cn, formatAmount } from "@/lib/utils";
import { useAccounts } from "@/hooks/use-accounts";
import type { DriftHoldingRow, DriftReport } from "@/lib/types";
import { formatPp } from "./drift-copy";

interface HoldingsTableProps {
  report: DriftReport;
}

const EMPTY_DRIFT_ROWS: DriftHoldingRow[] = [];

function driftColor(driftBps: number): string {
  if (driftBps > 0) return "text-destructive";
  if (driftBps < 0) return "text-blue-600 dark:text-blue-400";
  return "text-muted-foreground";
}

function cashSymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CAD") return "C$";
  if (currency === "BTC") return "₿";
  if (currency.length <= 2) return currency;
  return currency.slice(0, 2);
}

function HoldingAvatar({
  isCash,
  symbol,
  className = "size-6",
}: {
  isCash: boolean;
  symbol: string;
  className?: string;
}) {
  if (isCash) {
    return (
      <span
        className={cn(
          "bg-primary/80 dark:bg-primary/20 flex shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white",
          className,
        )}
      >
        {cashSymbol(symbol)}
      </span>
    );
  }

  return (
    <TickerAvatar
      symbol={symbol === "-" ? "?" : symbol}
      className={cn("shrink-0", className)}
      imageClassName="object-contain p-1"
    />
  );
}

function formatUpdatedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
    .format(date)
    .replace(/\bE[DS]T\b/, "ET");
}

function accountLabelForRow(
  row: DriftHoldingRow,
  accountMap: Map<string, string>,
  t: TFunction,
): string {
  if (row.sourceAccountIds && row.sourceAccountIds.length > 0) {
    const names = row.sourceAccountIds.map((id) => accountMap.get(id) ?? id).filter(Boolean);
    if (names.length === 1) return names[0];
    if (names.length > 1) return t("allocation:holdings.accountCount", { count: names.length });
  }
  return accountMap.get(row.accountId) ?? row.accountId;
}

function canNavigateToHolding(row: DriftHoldingRow): boolean {
  return !row.isCash && row.assetId.trim().length > 0;
}

export function HoldingsTable({ report }: HoldingsTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { accounts } = useAccounts();

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const updatedAt = useMemo(() => formatUpdatedAt(new Date()), []);

  const showAccountCol = report.scopeType !== "account";
  const holdingsReport = report.holdings ?? null;
  const isLoading = !holdingsReport;
  const rows = holdingsReport?.rows ?? EMPTY_DRIFT_ROWS;
  const baseCurrency = holdingsReport?.baseCurrency ?? report.baseCurrency;
  const holdingCount = useMemo(() => new Set(rows.map((row) => row.holdingId)).size, [rows]);

  function navigateToHolding(row: DriftHoldingRow) {
    if (!canNavigateToHolding(row)) return;
    navigate(`/holdings/${encodeURIComponent(row.assetId)}`);
  }

  return (
    <Card>
      <CardHeader className="px-4 pb-2 pt-4 md:px-6 md:pb-3 md:pt-6">
        <CardTitle className="text-base">{t("allocation:holdings.title")}</CardTitle>
        <CardDescription>
          {isLoading ? (
            t("allocation:holdings.loading")
          ) : (
            <>
              <span className="md:hidden">
                {t("allocation:holdings.summary", { count: holdingCount, currency: baseCurrency })}
              </span>
              <span className="hidden md:inline">
                {t("allocation:holdings.summaryUpdated", {
                  count: holdingCount,
                  currency: baseCurrency,
                  updatedAt,
                })}
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {rows.map((row) => {
            const canNavigate = canNavigateToHolding(row);
            return (
              <button
                key={row.id}
                type="button"
                disabled={!canNavigate}
                className={cn(
                  "focus-visible:ring-ring block w-full px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  canNavigate ? "hover:bg-muted/30" : "cursor-default",
                )}
                onClick={() => navigateToHolding(row)}
              >
                <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                  <div className="row-span-2 flex items-center">
                    <HoldingAvatar isCash={row.isCash} symbol={row.symbol} className="size-7" />
                  </div>

                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="text-foreground shrink-0 text-[12px] font-semibold">
                      {row.symbol}
                    </span>
                    <span className="text-muted-foreground truncate text-[12px]">{row.name}</span>
                  </div>
                  <span className="text-foreground text-right text-[12px] font-medium tabular-nums">
                    {formatAmount(row.value, baseCurrency)}
                  </span>

                  <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11.5px]">
                    {row.categoryColor && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: row.categoryColor }}
                      />
                    )}
                    <span className="truncate">{row.categoryName}</span>
                  </div>
                  <span
                    className={cn(
                      "text-right text-[11.5px] font-medium tabular-nums",
                      row.driftBps != null ? driftColor(row.driftBps) : "text-muted-foreground",
                    )}
                  >
                    {row.driftBps != null ? formatPp(row.driftBps) : "—"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-muted-foreground border-b text-[10px] uppercase tracking-wider">
                <th className="py-2.5 pl-6 pr-3 text-left font-medium">
                  {t("allocation:holdings.colHolding")}
                </th>
                <th className="py-2.5 pr-3 text-left font-medium">
                  {t("allocation:holdings.colCategory")}
                </th>
                <th className="py-2.5 pr-3 text-right font-medium">
                  {t("allocation:holdings.colValue")}
                </th>
                <th className="py-2.5 pr-3 text-right font-medium">
                  {t("allocation:holdings.colCurrent")}
                </th>
                <th className="py-2.5 pr-3 text-right font-medium">
                  {t("allocation:holdings.colTarget")}
                </th>
                <th className="py-2.5 pr-3 text-right font-medium">
                  {t("allocation:holdings.colDrift")}
                </th>
                {showAccountCol && (
                  <th className="py-2.5 pl-2 pr-6 text-right font-medium">
                    {t("allocation:holdings.colAccount")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const canNavigate = canNavigateToHolding(row);
                return (
                  <tr
                    key={row.id}
                    tabIndex={canNavigate ? 0 : -1}
                    className={cn(
                      "h-11 border-b outline-none last:border-b-0",
                      canNavigate
                        ? "hover:bg-muted/30 focus-visible:bg-muted/30 cursor-pointer"
                        : "cursor-default",
                    )}
                    onClick={() => navigateToHolding(row)}
                    onKeyDown={(event) => {
                      if (!canNavigate) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigateToHolding(row);
                      }
                    }}
                  >
                    <td className="pl-6 pr-3">
                      <div className="flex min-w-[280px] items-center gap-2">
                        <HoldingAvatar isCash={row.isCash} symbol={row.symbol} />
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="text-foreground shrink-0 text-[12px] font-semibold">
                            {row.symbol}
                          </span>
                          <span className="text-muted-foreground max-w-[330px] truncate text-[12px]">
                            {row.name}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="pr-3">
                      <div className="flex items-center gap-1.5">
                        {row.categoryColor && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: row.categoryColor }}
                          />
                        )}
                        <span className="min-w-0">
                          <span className="text-muted-foreground block truncate text-[12px]">
                            {row.categoryName}
                          </span>
                          {row.isUnknownCategory && (
                            <span className="text-muted-foreground/80 block max-w-[220px] truncate text-[10.5px]">
                              {t("allocation:holdings.notMapped")}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="text-foreground pr-3 text-right tabular-nums">
                      {formatAmount(row.value, baseCurrency)}
                    </td>
                    <td className="text-foreground pr-3 text-right font-medium tabular-nums">
                      {row.currentPct.toFixed(2)}%
                    </td>
                    <td className="text-muted-foreground pr-3 text-right tabular-nums">
                      {row.targetPct != null ? `${row.targetPct.toFixed(2)}%` : "—"}
                    </td>
                    <td
                      className={cn(
                        "pr-3 text-right font-medium tabular-nums",
                        row.driftBps != null ? driftColor(row.driftBps) : "text-muted-foreground",
                      )}
                    >
                      {row.driftBps != null ? formatPp(row.driftBps) : "—"}
                    </td>
                    {showAccountCol && (
                      <td className="text-muted-foreground pl-2 pr-6 text-right">
                        {accountLabelForRow(row, accountMap, t)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
