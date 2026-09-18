import { HoldingPerformancePercent } from "@/components/holding-performance-percent";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  AmountDisplay,
  Button,
  Icons,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getConcentration, getTopMovers } from "./holdings-highlights";

interface HighlightProps {
  holdings: Holding[];
  currency: string;
  isLoading: boolean;
}

function HoldingRow({ holding, children }: { holding: Holding; children: ReactNode }) {
  const instrument = holding.instrument;
  const className =
    "border-border flex items-center justify-between gap-3 border-b py-3 transition-colors last:border-0";
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TickerAvatar
          symbol={instrument?.symbol ?? holding.id}
          exchangeMic={instrument?.exchangeMic}
          instrumentType={instrument?.instrumentType}
          assetId={instrument?.id}
          className="size-9 shrink-0"
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{instrument?.symbol ?? holding.id}</span>
          <span className="text-muted-foreground truncate text-xs">{instrument?.name}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">{children}</div>
    </>
  );
  return instrument?.id ? (
    <Link
      to={`/holdings/${encodeURIComponent(instrument.id)}`}
      className={cn(className, "hover:bg-muted/30")}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

function HighlightTitle({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <CardTitle className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
        {title}
      </CardTitle>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground/60 hover:text-foreground h-6 w-6 shrink-0 rounded-full p-0"
            aria-label={t("common:component.more_info_about", { label: title })}
          >
            <Icons.Info className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 text-xs" side="top" align="start">
          {description}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-4 py-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function TopMoversCard({ holdings, currency, isLoading }: HighlightProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const [mode, setMode] = useState<"amount" | "percent">("amount");
  const movers = useMemo(() => getTopMovers(holdings, mode), [holdings, mode]);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <HighlightTitle
          title={t("insights:highlights.movers")}
          description={t("insights:highlights.daily")}
        />
        <div
          className="bg-muted/50 flex rounded-full p-1"
          role="group"
          aria-label={t("insights:highlights.rank_by")}
        >
          {(["amount", "percent"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "amount" ? currency : "%"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingRows />
        ) : (
          (["gainers", "losers"] as const).map((group) => (
            <div key={group} className="mt-3 first:mt-0">
              <h3 className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
                {t(`insights:highlights.${group}`)}
              </h3>
              {movers[group].length === 0 ? (
                <p className="text-muted-foreground py-4 text-xs">
                  {t("insights:highlights.no_moves")}
                </p>
              ) : (
                movers[group].map((holding) => (
                  <HoldingRow key={holding.id} holding={holding}>
                    {holding.dayChange?.base != null && Number.isFinite(holding.dayChange.base) ? (
                      <AmountDisplay
                        value={holding.dayChange.base}
                        currency={currency}
                        isHidden={isBalanceHidden}
                        colorFormat={!isBalanceHidden}
                        className="text-sm font-semibold"
                      />
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                    {isBalanceHidden ? (
                      <span className="text-muted-foreground text-xs">••••</span>
                    ) : (
                      <HoldingPerformancePercent
                        value={
                          holding.dayChangePct != null && Number.isFinite(holding.dayChangePct)
                            ? holding.dayChangePct
                            : null
                        }
                        variant="badge"
                        className="min-w-[60px] justify-center text-xs"
                      />
                    )}
                  </HoldingRow>
                ))
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function ConcentrationCard({ holdings, currency, isLoading }: HighlightProps) {
  const { t } = useTranslation();
  const formatting = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const concentration = useMemo(() => getConcentration(holdings), [holdings]);
  const percent = (value: number) => (isBalanceHidden ? "••••" : formatting.formatPercent(value));
  return (
    <Card>
      <CardHeader className="pb-3">
        <HighlightTitle
          title={t("insights:highlights.concentration")}
          description={t("insights:highlights.portfolio_share")}
        />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingRows />
        ) : concentration && concentration.holdings.length > 0 ? (
          <>
            <div className="bg-muted/30 mb-2 grid grid-cols-2 divide-x rounded-lg border py-3">
              <div className="px-4">
                <div className="text-muted-foreground text-xs">
                  {t("insights:highlights.largest")}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {percent(concentration.largestWeight)}
                </div>
              </div>
              <div className="px-4">
                <div className="text-muted-foreground text-xs">
                  {t("insights:highlights.top_five")}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {percent(concentration.topFiveWeight)}
                </div>
              </div>
            </div>
            {concentration.holdings.map((holding) => (
              <HoldingRow key={holding.id} holding={holding}>
                <span className="text-sm font-semibold tabular-nums">
                  {percent(holding.marketValue.base / concentration.total)}
                </span>
                <AmountDisplay
                  value={holding.marketValue.base}
                  currency={currency}
                  isHidden={isBalanceHidden}
                  className="text-muted-foreground text-xs"
                />
              </HoldingRow>
            ))}
          </>
        ) : (
          <p className="text-muted-foreground py-6 text-sm">
            {t("insights:highlights.concentration_unavailable")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
