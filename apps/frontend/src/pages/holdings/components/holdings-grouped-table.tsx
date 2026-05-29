import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { AmountDisplay, GainPercent, QuantityDisplay } from "@wealthfolio/ui";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { Holding, HOLDING_GROUP_ORDER } from "@/lib/types";
import { AccountType, AssetKind } from "@/lib/constants";
import { cn, safeDivide } from "@/lib/utils";
import { useSettingsContext } from "@/lib/settings-provider";
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";

interface HoldingsGroupedTableProps {
  holdings: Holding[];
  accountTypeMap: Map<string, string>; // accountId -> accountType
  linkedLiabilities: Map<string, Holding[]>; // assetId -> linked liabilities
  showTotalReturn: boolean;
  showConvertedValues: boolean;
  isLoading: boolean;
}

interface HoldingGroup {
  name: string;
  holdings: HoldingWithMeta[];
  totalValue: number;
  order: number;
}

interface HoldingWithMeta extends Holding {
  isLiability: boolean;
  linkedLiabilities?: Holding[];
}

/**
 * Grouped holdings table with collapsible sections.
 * Holdings are grouped by asset category (Investments, Properties, etc.)
 * and sorted by value descending within each group.
 */
export function HoldingsGroupedTable({
  holdings,
  accountTypeMap,
  linkedLiabilities,
  showTotalReturn,
  showConvertedValues,
  isLoading,
}: HoldingsGroupedTableProps) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const navigate = useNavigate();

  // Track collapsed state for each group
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  // Group holdings by category
  const groups = useMemo(() => {
    const groupMap = new Map<string, HoldingWithMeta[]>();

    holdings.forEach((holding) => {
      const accountType = accountTypeMap.get(holding.accountId);
      const groupName = getGroupName(accountType);
      const isLiability = holding.assetKind === AssetKind.LIABILITY;

      const holdingWithMeta: HoldingWithMeta = {
        ...holding,
        isLiability,
        linkedLiabilities: linkedLiabilities.get(holding.instrument?.id ?? holding.id),
      };

      if (!groupMap.has(groupName)) {
        groupMap.set(groupName, []);
      }
      groupMap.get(groupName)!.push(holdingWithMeta);
    });

    // Convert to array and sort by group order
    const groupArray: HoldingGroup[] = Array.from(groupMap.entries()).map(([name, holdings]) => ({
      name,
      holdings: holdings.sort((a, b) => {
        // Sort by absolute value descending within each group
        const valueA = Math.abs(a.marketValue?.base ?? 0);
        const valueB = Math.abs(b.marketValue?.base ?? 0);
        return valueB - valueA;
      }),
      totalValue: holdings.reduce((sum, h) => {
        const value = h.marketValue?.base ?? 0;
        // Liabilities are stored as positive but should reduce total
        return sum + (h.isLiability ? -value : value);
      }, 0),
      order: HOLDING_GROUP_ORDER[name] ?? 99,
    }));

    return groupArray.sort((a, b) => a.order - b.order);
  }, [holdings, accountTypeMap, linkedLiabilities]);

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <Collapsible
          key={group.name}
          open={!collapsedGroups.has(group.name)}
          onOpenChange={() => toggleGroup(group.name)}
        >
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="hover:bg-muted/50 flex w-full items-center justify-between px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Icons.ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    collapsedGroups.has(group.name) && "-rotate-90",
                  )}
                />
                <span className="font-medium">{group.name}</span>
                <span className="text-muted-foreground text-sm">({group.holdings.length})</span>
              </div>
              <AmountDisplay
                value={group.totalValue}
                currency={group.holdings[0]?.baseCurrency ?? baseCurrency}
                isHidden={isBalanceHidden}
                colorFormat={group.name === "Liabilities"}
                className="font-medium"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y">
              {group.holdings.map((holding) => (
                <HoldingRow
                  key={holding.id}
                  holding={holding}
                  showTotalReturn={showTotalReturn}
                  showConvertedValues={showConvertedValues}
                  isBalanceHidden={isBalanceHidden}
                  navigate={navigate}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

interface HoldingRowProps {
  holding: HoldingWithMeta;
  showTotalReturn: boolean;
  showConvertedValues: boolean;
  isBalanceHidden: boolean;
  navigate: (path: string, options?: { state?: { holding: Holding } }) => void;
  isIndented?: boolean;
}

function HoldingRow({
  holding,
  showTotalReturn,
  showConvertedValues,
  isBalanceHidden,
  navigate,
  isIndented = false,
}: HoldingRowProps) {
  const symbol = holding.instrument?.symbol ?? holding.id;

  const handleNavigate = () => {
    // Use instrument.id (asset ID) for navigation, not symbol (which may be stripped)
    const assetId = holding.instrument?.id;
    if (assetId) {
      navigate(`/holdings/${encodeURIComponent(assetId)}`, { state: { holding } });
    }
  };

  const isClickable = !!holding.instrument?.id;

  // Calculate display values
  const fxRate = holding.fxRate ?? 1;
  const marketValueBase = holding.marketValue?.base ?? 0;
  const marketValue = showConvertedValues ? marketValueBase : safeDivide(marketValueBase, fxRate);
  const currency = showConvertedValues ? holding.baseCurrency : holding.localCurrency;

  // For liabilities, display value as negative
  const displayValue = holding.isLiability ? -Math.abs(marketValue) : marketValue;

  const valueBase = showTotalReturn ? holding.totalGain?.base : holding.dayChange?.base;
  const gainValue = showConvertedValues ? valueBase : safeDivide(valueBase ?? 0, fxRate);
  const gainPct = showTotalReturn ? holding.totalGainPct : holding.dayChangePct;

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-4 px-3 py-3",
          isClickable && "hover:bg-muted/50 cursor-pointer transition-colors",
          isIndented && "pl-10",
        )}
        onClick={isClickable ? handleNavigate : undefined}
      >
        {/* Symbol/Name Column */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <TickerAvatar symbol={symbol} className="h-8 w-8 flex-shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{symbol}</span>
              {holding.isLiability && (
                <Badge variant="destructive" className="text-xs">
                  Debt
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground truncate text-sm">
              {holding.instrument?.name ?? holding.id}
            </span>
          </div>
        </div>

        {/* Quantity Column */}
        <div className="hidden w-24 flex-shrink-0 text-right md:block">
          <QuantityDisplay value={holding.quantity} isHidden={isBalanceHidden} />
        </div>

        {/* Value Column */}
        <div className="w-28 flex-shrink-0 text-right">
          <AmountDisplay
            value={displayValue}
            currency={currency}
            isHidden={isBalanceHidden}
            colorFormat={holding.isLiability}
          />
          <div className="text-muted-foreground text-xs">{currency}</div>
        </div>

        {/* Gain/Loss Column */}
        <div className="hidden w-28 flex-shrink-0 text-right sm:block">
          {!holding.isLiability && (
            <>
              <AmountDisplay
                value={gainValue ?? 0}
                currency={currency}
                isHidden={isBalanceHidden}
                colorFormat={true}
              />
              <GainPercent className="text-xs" value={gainPct ?? 0} />
            </>
          )}
          {holding.isLiability && <span className="text-muted-foreground text-sm">--</span>}
        </div>

        {/* Actions Column */}
        <div className="w-8 flex-shrink-0">
          {isClickable && <Icons.ChevronRight className="text-muted-foreground h-4 w-4" />}
        </div>
      </div>

      {/* Render linked liabilities indented below the asset */}
      {holding.linkedLiabilities?.map((liability) => (
        <HoldingRow
          key={liability.id}
          holding={{ ...liability, isLiability: true } as HoldingWithMeta}
          showTotalReturn={showTotalReturn}
          showConvertedValues={showConvertedValues}
          isBalanceHidden={isBalanceHidden}
          navigate={navigate}
          isIndented={true}
        />
      ))}
    </>
  );
}

function getGroupName(accountType: string | undefined): string {
  switch (accountType) {
    case AccountType.SECURITIES:
    case AccountType.CRYPTOCURRENCY:
      return "Investments";
    case AccountType.CASH:
      return "Cash";
    case AccountType.CREDIT_CARD:
      return "Liabilities";
    default:
      return "Investments";
  }
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <div className="bg-muted h-10 animate-pulse rounded" />
          <div className="bg-muted/50 h-16 animate-pulse rounded" />
          <div className="bg-muted/50 h-16 animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}

export default HoldingsGroupedTable;
