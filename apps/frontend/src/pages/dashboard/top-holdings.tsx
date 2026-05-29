import { DashboardCard } from "@/components/dashboard-card";
import { TickerAvatar } from "@/components/ticker-avatar";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { HoldingType, isAlternativeAssetKind, type AssetKind } from "@/lib/constants";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  AmountDisplay,
  Button,
  GainAmount,
  GainPercent,
  Icons,
  usePersistentState,
} from "@wealthfolio/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

const MAX_DISPLAYED_HOLDINGS = 7;
const MAX_STACKED_AVATARS = 5;
const SHOW_TOTAL_RETURN_KEY = "dashboard-holdings-widget-show-total-return";

interface TopHoldingsProps {
  holdings: Holding[];
  isLoading: boolean;
  baseCurrency: string;
}

interface HoldingRowProps {
  holding: Holding;
  baseCurrency: string;
  isHidden?: boolean;
  showTotalReturn: boolean;
  showName: boolean;
  onClick?: () => void;
}

function HoldingRow({
  holding,
  baseCurrency,
  isHidden,
  showTotalReturn,
  showName,
  onClick,
}: HoldingRowProps) {
  const symbol = holding.instrument?.symbol ?? holding.id;
  const parsedOption = parseOccSymbol(symbol);
  const symbolLabel = parsedOption ? parsedOption.underlying : symbol.split(".")[0];
  const nameLabel = holding.instrument?.name?.trim() || symbolLabel;
  const title = showName ? nameLabel : symbolLabel;
  const subtitle = parsedOption
    ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
    : `${(holding.quantity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} shares`;
  const avatarSymbol = parsedOption ? parsedOption.underlying : symbol;
  const marketValue = holding.marketValue?.base ?? 0;
  const gainAmount = showTotalReturn
    ? (holding.totalGain?.base ?? holding.unrealizedGain?.base ?? 0)
    : (holding.dayChange?.base ?? 0);
  const gainPercent = showTotalReturn
    ? (holding.totalGainPct ?? holding.unrealizedGainPct ?? 0)
    : (holding.dayChangePct ?? 0);

  return (
    <div
      className="border-border hover:bg-muted/30 group flex cursor-pointer items-center justify-between gap-3 border-b py-3 transition-colors last:border-0"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TickerAvatar symbol={avatarSymbol} className="size-9 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="text-muted-foreground text-xs">{subtitle}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <AmountDisplay
          value={marketValue}
          currency={baseCurrency}
          isHidden={isHidden}
          className="text-sm font-semibold"
        />
        <div className="flex items-center gap-2">
          <GainAmount
            value={gainAmount}
            currency={baseCurrency}
            displayCurrency={false}
            className="text-xs"
          />
          <GainPercent
            value={gainPercent}
            variant="badge"
            className="min-w-[60px] justify-center text-xs"
          />
        </div>
      </div>
    </div>
  );
}

interface StackedAvatarsProps {
  holdings: Holding[];
  totalRemaining: number;
  onClick?: () => void;
}

function StackedAvatars({ holdings, totalRemaining, onClick }: StackedAvatarsProps) {
  const displayedHoldings = holdings.slice(0, MAX_STACKED_AVATARS);
  const extraCount = totalRemaining - displayedHoldings.length;

  return (
    <div
      className="hover:bg-muted/50 border-border flex cursor-pointer items-center gap-2 border-t py-3 transition-colors"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
    >
      <div className="flex items-center">
        {displayedHoldings.map((holding, index) => {
          const symbol = holding.instrument?.symbol ?? holding.id;
          const parsed = parseOccSymbol(symbol);
          const avatarSym = parsed ? parsed.underlying : symbol;
          return (
            <div
              key={holding.id}
              className={cn("relative", index > 0 && "-ml-2")}
              style={{ zIndex: displayedHoldings.length - index }}
            >
              <TickerAvatar symbol={avatarSym} className="ring-background size-8 ring-2" />
            </div>
          );
        })}
      </div>
      <span className="text-muted-foreground text-xs">
        {extraCount > 0 ? `+${totalRemaining} more holdings` : `+${totalRemaining} more`}
      </span>
      <Icons.ChevronRight className="text-muted-foreground ml-auto h-3 w-3" />
    </div>
  );
}

function TopHoldingsSkeleton() {
  return (
    <DashboardCard title="Holdings" elevated>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="border-border border-b py-3 last:border-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-12" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-3.5 w-24" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-5 w-[60px] rounded-md" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </DashboardCard>
  );
}

function TopHoldingsEmptyState() {
  return (
    <DashboardCard title="Holdings" elevated>
      <div className="py-2 text-center">
        <p className="text-sm">No holdings yet.</p>
        <Link
          to="/activities/manage"
          className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          Add your first transaction
          <Icons.ChevronRight className="h-3 w-3" />
        </Link>
      </div>
    </DashboardCard>
  );
}

export function TopHoldings({ holdings, isLoading, baseCurrency }: TopHoldingsProps) {
  const navigate = useNavigate();
  const { isBalanceHidden } = useBalancePrivacy();
  const [showTotalReturn, setShowTotalReturn] = usePersistentState<boolean>(
    SHOW_TOTAL_RETURN_KEY,
    true,
  );
  const [sortBy, setSortBy] = usePersistentState<"value" | "gain">(
    "holdings-widget-sort-by",
    "value",
  );
  const [displayMode, setDisplayMode] = usePersistentState<"symbol" | "name">(
    "holdings-widget-display-mode",
    "symbol",
  );

  // Filter out cash holdings and alternative assets, then sort by market value
  // Dashboard shows only investment holdings (securities, crypto, etc.)
  const sortedHoldings = useMemo(() => {
    return holdings
      .filter((h) => {
        // Exclude cash holdings
        if (h.holdingType === HoldingType.CASH) return false;
        // Exclude alternative assets (properties, vehicles, liabilities, etc.)
        if (h.assetKind && isAlternativeAssetKind(h.assetKind as AssetKind)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "gain") {
          const gainA = showTotalReturn
            ? (a.totalGain?.base ?? a.unrealizedGain?.base ?? 0)
            : (a.dayChange?.base ?? 0);
          const gainB = showTotalReturn
            ? (b.totalGain?.base ?? b.unrealizedGain?.base ?? 0)
            : (b.dayChange?.base ?? 0);
          return gainB - gainA;
        }
        return (b.marketValue?.base ?? 0) - (a.marketValue?.base ?? 0);
      });
  }, [holdings, sortBy, showTotalReturn]);

  // Show one extra holding directly rather than displaying "+1 more"
  const displayCount =
    sortedHoldings.length === MAX_DISPLAYED_HOLDINGS + 1
      ? MAX_DISPLAYED_HOLDINGS + 1
      : MAX_DISPLAYED_HOLDINGS;
  const topHoldings = sortedHoldings.slice(0, displayCount);
  const remainingHoldings = sortedHoldings.slice(displayCount);
  const hasRemainingHoldings = remainingHoldings.length > 0;

  if (isLoading) {
    return <TopHoldingsSkeleton />;
  }

  if (sortedHoldings.length === 0) {
    return <TopHoldingsEmptyState />;
  }

  return (
    <DashboardCard
      title="Holdings"
      elevated
      action={
        <div className="flex items-center gap-1">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-success/10 h-8 w-8 p-0"
              >
                <Icons.ListFilter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="border-border/50 bg-card min-w-[200px] rounded-2xl border p-2 shadow-lg backdrop-blur-xl"
            >
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Show
              </p>
              {(["total", "daily"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setShowTotalReturn(v === "total")}
                >
                  {v === "total" ? "Total Return" : "Daily Change"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      (v === "total") === showTotalReturn
                        ? "border-primary bg-primary"
                        : "border-muted-foreground",
                    )}
                  >
                    {(v === "total") === showTotalReturn && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Sort by
              </p>
              {(["value", "gain"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setSortBy(v)}
                >
                  {v === "value" ? "Total Value" : "Gain"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      sortBy === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {sortBy === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
              <div className="bg-border/70 mx-2 my-1.5 h-px" />
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium uppercase tracking-wider">
                Display
              </p>
              {(["symbol", "name"] as const).map((v) => (
                <button
                  key={v}
                  className="hover:bg-accent flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-medium transition-colors"
                  onClick={() => setDisplayMode(v)}
                >
                  {v === "symbol" ? "Symbol" : "Name"}
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border-2",
                      displayMode === v ? "border-primary bg-primary" : "border-muted-foreground",
                    )}
                  >
                    {displayMode === v && (
                      <span className="bg-primary-foreground h-1.5 w-1.5 rounded-full" />
                    )}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-success/10 text-xs"
            onClick={() => navigate("/holdings")}
          >
            View All
            <Icons.ChevronRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      }
    >
      {topHoldings.map((holding) => {
        const assetId = holding.instrument?.id ?? holding.id;
        return (
          <HoldingRow
            key={holding.id}
            holding={holding}
            baseCurrency={baseCurrency}
            isHidden={isBalanceHidden}
            showTotalReturn={showTotalReturn}
            showName={displayMode === "name"}
            onClick={() => navigate(`/holdings/${encodeURIComponent(assetId)}`)}
          />
        );
      })}
      {hasRemainingHoldings && (
        <StackedAvatars
          holdings={remainingHoldings}
          totalRemaining={remainingHoldings.length}
          onClick={() => navigate("/holdings")}
        />
      )}
    </DashboardCard>
  );
}

export default TopHoldings;
