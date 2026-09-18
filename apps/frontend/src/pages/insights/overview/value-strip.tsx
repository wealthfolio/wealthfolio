import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";
import { AmountDisplay, Card, Skeleton, useNumberFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { paletteColor, type ValueStripData } from "./allocation-derivations";

interface ValueWidgetProps {
  metric: "value" | "cash" | "invested" | "bookCost" | "pnl";
  data: ValueStripData;
  currency: string;
  isLoading?: boolean;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
      {children}
    </div>
  );
}

function CurrencyExposurePill({
  currency,
  percentage,
  color,
}: {
  currency: string;
  percentage: number;
  color: string;
}) {
  const formatting = useNumberFormatting();
  return (
    <span className="bg-muted/45 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5">
      <span className="h-2 w-1 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{currency}</span>
      <span className="text-foreground font-semibold tabular-nums">
        {formatting.formatPercent(percentage / 100)}
      </span>
    </span>
  );
}

function CurrencyValuePill({
  currency,
  value,
  color,
  isHidden,
}: {
  currency: string;
  value: number;
  color: string;
  isHidden: boolean;
}) {
  return (
    <span className="bg-muted/45 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5">
      <span className="h-2 w-1 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{currency}</span>
      <AmountDisplay
        value={value}
        currency={currency}
        displayCurrency={false}
        isHidden={isHidden}
        className="text-foreground font-semibold tabular-nums"
      />
    </span>
  );
}

export function ValueWidget({ metric, data, currency, isLoading }: ValueWidgetProps) {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const holdingsAccountsLabel = `${t("insights:insights.value_strip.holdings_count", {
    count: data.holdingsCount,
  })} · ${t("insights:insights.value_strip.accounts_count", { count: data.accountsCount })}`;

  const gain = data.unrealizedPnl;
  const bookCostRatio = data.total > 0 ? data.bookCost / data.total : 0;
  const pad = "px-3.5 py-2.5";
  const gap = "space-y-0.5";
  const totalSize = "whitespace-nowrap text-[clamp(0.875rem,10cqi,1.375rem)] leading-7";
  const secSize = "whitespace-nowrap text-[clamp(0.75rem,9cqi,1.125rem)] leading-6 sm:text-[18px]";
  const subSize = "text-[11px] leading-4";

  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <div data-value-content className={cn(gap, pad)}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-32 max-w-full" />
          <Skeleton className="h-3 w-40 max-w-full" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {metric === "value" && (
        <div
          data-value-content
          className={cn(gap, pad, "from-muted/60 bg-gradient-to-b to-transparent to-[60%]")}
        >
          <Eyebrow>{t("insights:insights.value_strip.portfolio_value")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", totalSize)}>
            <AmountDisplay value={data.total} currency={currency} isHidden={isBalanceHidden} />
          </div>
          <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", subSize)}>
            <span className="text-muted-foreground tabular-nums">{holdingsAccountsLabel}</span>
            {data.currencySplit.length > 1 &&
              data.currencySplit
                .slice(0, 4)
                .map((c, index) => (
                  <CurrencyExposurePill
                    key={c.currency}
                    currency={c.currency}
                    percentage={c.percentage}
                    color={paletteColor(index)}
                  />
                ))}
          </div>
        </div>
      )}
      {metric === "cash" && (
        <div data-value-content className={cn(gap, pad)}>
          <Eyebrow>{t("insights:insights.value_strip.cash_balance")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", secSize)}>
            <AmountDisplay value={data.cash} currency={currency} isHidden={isBalanceHidden} />
          </div>
          {data.cashCurrencySplit.length > 1 ? (
            <div className={cn("flex flex-wrap items-center gap-1.5", subSize)}>
              {data.cashCurrencySplit.slice(0, 4).map((c, index) => (
                <CurrencyValuePill
                  key={c.currency}
                  currency={c.currency}
                  value={c.value}
                  color={paletteColor(index)}
                  isHidden={isBalanceHidden}
                />
              ))}
            </div>
          ) : data.cashCurrencySplit.length === 0 ? (
            <div className={cn("text-muted-foreground", subSize)}>
              {t("insights:insights.value_strip.no_cash_balance")}
            </div>
          ) : (
            <div className={cn("text-muted-foreground", subSize)}>
              {t("insights:insights.value_strip.available_cash")}
            </div>
          )}
        </div>
      )}
      {metric === "invested" && (
        <div data-value-content className={cn(gap, pad)}>
          <Eyebrow>{t("insights:insights.value_strip.invested")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", secSize)}>
            <AmountDisplay value={data.invested} currency={currency} isHidden={isBalanceHidden} />
          </div>
          <div className={cn("text-muted-foreground tabular-nums", subSize)}>
            {t("insights:insights.value_strip.of_portfolio", {
              percent: formatting.formatPercent(data.investedPercent / 100),
            })}
          </div>
        </div>
      )}
      {metric === "pnl" && (
        <div data-value-content className={cn(gap, pad)}>
          <Eyebrow>{t("holdings:unrealized_pnl")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", secSize)}>
            {gain == null ? (
              <span className="text-muted-foreground">{isBalanceHidden ? "••••" : "—"}</span>
            ) : (
              <AmountDisplay
                value={gain}
                currency={currency}
                isHidden={isBalanceHidden}
                colorFormat={!isBalanceHidden && gain !== 0}
              />
            )}
          </div>
          <div className={cn("text-muted-foreground", subSize)}>
            {t("insights:insights.value_strip.pnl_current_holdings")}
          </div>
        </div>
      )}
      {metric === "bookCost" && (
        <div data-value-content className={cn(gap, pad)}>
          <Eyebrow>{t("insights:insights.value_strip.book_cost")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", secSize)}>
            <AmountDisplay value={data.bookCost} currency={currency} isHidden={isBalanceHidden} />
          </div>
          {data.bookCostCurrencySplit.length > 1 ? (
            <div className={cn("flex flex-wrap items-center gap-1.5", subSize)}>
              {data.bookCostCurrencySplit.slice(0, 4).map((c, index) => (
                <CurrencyValuePill
                  key={c.currency}
                  currency={c.currency}
                  value={c.value}
                  color={paletteColor(index)}
                  isHidden={isBalanceHidden}
                />
              ))}
            </div>
          ) : (
            <div className={cn("text-muted-foreground tabular-nums", subSize)}>
              {t("insights:insights.value_strip.of_portfolio", {
                percent: formatting.formatPercent(bookCostRatio),
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
