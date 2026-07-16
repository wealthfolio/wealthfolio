import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";
import { AmountDisplay, Card, formatPercent, Skeleton } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { paletteColor, type ValueStripData } from "./allocation-derivations";

interface ValueStripProps {
  data: ValueStripData;
  currency: string;
  isLoading?: boolean;
  /** Tighter padding + smaller numbers for a denser dashboard header. */
  compact?: boolean;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
      {children}
    </div>
  );
}

function MobileEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground text-[9px] font-semibold uppercase leading-3 tracking-[0.18em]">
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
  return (
    <span className="bg-muted/45 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5">
      <span className="h-2 w-1 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{currency}</span>
      <span className="text-foreground font-semibold tabular-nums">
        {formatPercent(percentage / 100)}
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

export function ValueStrip({ data, currency, isLoading, compact }: ValueStripProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const holdingsAccountsLabel = `${t("insights:insights.value_strip.holdings_count", {
    count: data.holdingsCount,
  })} · ${t("insights:insights.value_strip.accounts_count", { count: data.accountsCount })}`;

  const cashRatio = data.total > 0 ? data.cash / data.total : 0;
  const bookCostRatio = data.total > 0 ? data.bookCost / data.total : 0;
  const pad = compact ? "px-3.5 py-2.5" : "p-5";
  const gap = compact ? "space-y-0.5" : "space-y-2";
  const totalSize = compact ? "text-[22px] leading-7" : "text-3xl";
  const secSize = compact ? "text-[18px] leading-6" : "text-[22px]";
  const subSize = compact ? "text-[11px] leading-4" : "text-[12px]";

  if (isLoading) {
    return (
      <>
        <Card className="overflow-hidden sm:hidden">
          <div className="from-muted/60 space-y-1.5 bg-gradient-to-b to-transparent px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="grid grid-cols-3 divide-x border-t">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1.5 px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            ))}
          </div>
        </Card>
        <Card className="hidden grid-cols-1 divide-y overflow-hidden sm:grid sm:grid-cols-[2.25fr_1.35fr_1fr_1fr] sm:divide-x sm:divide-y-0">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(gap, pad)}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className={compact ? "h-6 w-32" : "h-7 w-32"} />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </Card>
      </>
    );
  }

  return (
    <>
      <Card className="overflow-hidden sm:hidden">
        <div className="from-muted/60 space-y-1.5 bg-gradient-to-b to-transparent to-[65%] px-4 py-3.5">
          <MobileEyebrow>{t("insights:insights.value_strip.portfolio_value")}</MobileEyebrow>
          <div className="text-foreground text-[24px] font-bold leading-7 tracking-tight">
            <AmountDisplay value={data.total} currency={currency} isHidden={isBalanceHidden} />
          </div>
          <div className="text-muted-foreground leading-3.5 text-[10px] tabular-nums">
            {holdingsAccountsLabel}
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x border-t">
          <div className="space-y-1.5 px-4 py-3.5">
            <MobileEyebrow>{t("insights:insights.value_strip.cash_balance")}</MobileEyebrow>
            <div className="text-foreground text-[15px] font-bold leading-5 tracking-tight">
              <AmountDisplay value={data.cash} currency={currency} isHidden={isBalanceHidden} />
            </div>
            {data.cashCurrencySplit.length === 0 ? (
              <div className="text-muted-foreground leading-3.5 text-[10px]">
                {t("insights:insights.value_strip.no_cash_balance")}
              </div>
            ) : (
              <div className="text-muted-foreground leading-3.5 text-[10px] tabular-nums">
                {t("insights:insights.value_strip.of_portfolio", {
                  percent: formatPercent(cashRatio),
                })}
              </div>
            )}
          </div>

          <div className="space-y-1.5 px-4 py-3.5">
            <MobileEyebrow>{t("insights:insights.value_strip.invested")}</MobileEyebrow>
            <div className="text-foreground text-[15px] font-bold leading-5 tracking-tight">
              <AmountDisplay value={data.invested} currency={currency} isHidden={isBalanceHidden} />
            </div>
            <div className="text-muted-foreground leading-3.5 text-[10px] tabular-nums">
              {t("insights:insights.value_strip.of_portfolio", {
                percent: formatPercent(data.investedPercent / 100),
              })}
            </div>
          </div>

          <div className="space-y-1.5 px-4 py-3.5">
            <MobileEyebrow>{t("insights:insights.value_strip.book_cost")}</MobileEyebrow>
            <div className="text-foreground text-[15px] font-bold leading-5 tracking-tight">
              <AmountDisplay value={data.bookCost} currency={currency} isHidden={isBalanceHidden} />
            </div>
            <div className="text-muted-foreground leading-3.5 text-[10px] tabular-nums">
              {t("insights:insights.value_strip.of_portfolio", {
                percent: formatPercent(bookCostRatio),
              })}
            </div>
          </div>
        </div>
      </Card>

      <Card className="hidden grid-cols-1 divide-y overflow-hidden sm:grid sm:grid-cols-[2.25fr_1.35fr_1fr_1fr] sm:divide-x sm:divide-y-0">
        {/* Portfolio value — hero cell with a slight top-to-center gradient wash */}
        <div className={cn(gap, pad, "from-muted/60 bg-gradient-to-b to-transparent to-[60%]")}>
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

        {/* Cash balance */}
        <div className={cn(gap, pad)}>
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

        {/* Invested */}
        <div className={cn(gap, pad)}>
          <Eyebrow>{t("insights:insights.value_strip.invested")}</Eyebrow>
          <div className={cn("text-foreground font-bold tabular-nums tracking-tight", secSize)}>
            <AmountDisplay value={data.invested} currency={currency} isHidden={isBalanceHidden} />
          </div>
          <div className={cn("text-muted-foreground tabular-nums", subSize)}>
            {t("insights:insights.value_strip.of_portfolio", {
              percent: formatPercent(data.investedPercent / 100),
            })}
          </div>
        </div>

        {/* Book cost — total cost basis of invested (non-cash) holdings */}
        <div className={cn(gap, pad)}>
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
                percent: formatPercent(bookCostRatio),
              })}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
