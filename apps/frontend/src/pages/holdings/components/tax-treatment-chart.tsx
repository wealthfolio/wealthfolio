import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Account, Holding } from "@/lib/types";
import {
  AmountDisplay,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DonutChart,
  formatPercent,
  Skeleton,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";

interface TaxTreatmentDonutChartProps {
  holdings: Holding[];
  accounts: Account[];
  baseCurrency: string;
  isLoading?: boolean;
}

interface TaxTreatmentDataPoint {
  key: string;
  name: string;
  value: number;
  percent: number;
  currency: string;
}

const TREATMENT_ORDER = ["TAXABLE", "TAX_DEFERRED", "TAX_FREE", "UNCATEGORIZED"];

const TREATMENT_LABELS: Record<string, string> = {
  TAXABLE: "Taxable",
  TAX_DEFERRED: "Tax Deferred",
  TAX_FREE: "Tax Free",
  UNCATEGORIZED: "Uncategorized",
};

function normalizeTaxTreatment(taxTreatment?: string): string {
  const normalized = taxTreatment?.trim().toUpperCase();
  if (normalized === "TAXABLE" || normalized === "TAX_DEFERRED" || normalized === "TAX_FREE") {
    return normalized;
  }
  return "UNCATEGORIZED";
}

function buildTaxTreatmentData(
  holdings: Holding[] = [],
  accounts: Account[] = [],
  baseCurrency: string,
): TaxTreatmentDataPoint[] {
  if (!holdings.length) {
    return [];
  }

  const accountTaxMap = new Map<string, string>();
  for (const account of accounts) {
    accountTaxMap.set(account.id, normalizeTaxTreatment(account.taxTreatment));
  }

  const totalsByTreatment = new Map<string, number>();
  for (const holding of holdings) {
    const baseValue = Number(holding.marketValue?.base) || 0;
    if (!Number.isFinite(baseValue) || baseValue === 0) {
      continue;
    }

    const treatment = accountTaxMap.get(holding.accountId) ?? "UNCATEGORIZED";
    totalsByTreatment.set(treatment, (totalsByTreatment.get(treatment) ?? 0) + baseValue);
  }

  const total = Array.from(totalsByTreatment.values()).reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return [];
  }

  return TREATMENT_ORDER.map((treatment) => {
    const value = totalsByTreatment.get(treatment) ?? 0;
    if (value <= 0) {
      return null;
    }

    return {
      key: treatment,
      name: TREATMENT_LABELS[treatment] ?? treatment,
      value,
      percent: value / total,
      currency: baseCurrency,
    };
  }).filter((item): item is TaxTreatmentDataPoint => item !== null);
}

export function TaxTreatmentDonutChart({
  holdings,
  accounts,
  baseCurrency,
  isLoading = false,
}: TaxTreatmentDonutChartProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const { isBalanceHidden } = useBalancePrivacy();

  const data = useMemo(
    () => buildTaxTreatmentData(holdings, accounts, baseCurrency),
    [holdings, accounts, baseCurrency],
  );

  if (isLoading) {
    return (
      <Card className="overflow-hidden backdrop-blur-sm">
        <CardHeader>
          <Skeleton className="h-5 w-[140px]" />
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-0">
          <div className="flex h-[160px] items-center justify-center">
            <Skeleton className="h-[120px] w-[120px] rounded-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
          Tax Treatment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {data.length > 0 ? (
          <>
            <DonutChart
              data={data.map((entry) => ({
                name: entry.name,
                value: entry.value,
                currency: entry.currency,
              }))}
              activeIndex={activeIndex}
              onSectionClick={(_, index) => setActiveIndex(index)}
              startAngle={180}
              endAngle={0}
            />

            <div className="space-y-1">
              {data.map((entry, index) => (
                <button
                  key={entry.key}
                  type="button"
                  className="hover:bg-muted/50 flex w-full items-center justify-between rounded-md px-1 py-1 text-left transition-colors"
                  onClick={() => setActiveIndex(index)}
                >
                  <span className="text-sm font-medium">{entry.name}</span>
                  <div className="flex items-center gap-2 text-sm">
                    <AmountDisplay
                      value={entry.value}
                      currency={baseCurrency}
                      isHidden={isBalanceHidden}
                      displayCurrency={false}
                    />
                    <span className="text-muted-foreground text-xs">|</span>
                    <span className="text-muted-foreground">{formatPercent(entry.percent)}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="bg-muted/20 text-muted-foreground rounded-md py-6 text-center text-sm">
            No tax treatment data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
