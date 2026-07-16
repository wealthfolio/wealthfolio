import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import type { AssetLotView } from "@/lib/types";
import {
  Button,
  GainAmount,
  GainPercent,
  PrivacyAmount,
  formatPrice,
  formatPercent,
} from "@wealthfolio/ui";
import { cn, formatDate, formatQuantity, normalizeCurrency } from "@/lib/utils";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

const ALLOCATION_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-3)",
  "var(--color-chart-5)",
  "var(--color-chart-7)",
  "var(--color-chart-9)",
];

interface AssetLotsTableProps {
  lots: AssetLotView[];
  currency: string;
  marketPrice: number;
  contractMultiplier?: number;
  dayChangeAmount?: number | null;
  dayChangePct?: number | null;
}

export const AssetLotsTable = ({
  lots,
  currency,
  marketPrice,
  contractMultiplier = 1,
  dayChangeAmount = null,
  dayChangePct = null,
}: AssetLotsTableProps) => {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      lots && lots.length > 0
        ? groupLotsByAccount(lots, currency, marketPrice, contractMultiplier)
        : [],
    [lots, currency, marketPrice, contractMultiplier],
  );
  const totals = useMemo(() => computeTotals(groups), [groups]);
  const totalLots = useMemo(() => groups.reduce((acc, g) => acc + g.lots.length, 0), [groups]);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

  if (!lots || lots.length === 0) {
    return null;
  }

  const toggleAccount = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const allExpanded = groups.length > 0 && groups.every((g) => expandedAccounts.has(g.accountId));
  const toggleAll = () => {
    if (allExpanded) {
      setExpandedAccounts(new Set());
    } else {
      setExpandedAccounts(new Set(groups.map((g) => g.accountId)));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <KpiStrip
            totals={totals}
            currency={currency}
            marketPrice={marketPrice}
            groups={groups}
            dayChangeAmount={dayChangeAmount}
            dayChangePct={dayChangePct}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-foreground text-sm font-medium">
                {t("asset:lots.lots_by_account")}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("asset:lots.account", { count: groups.length })} ·{" "}
                {t("asset:lots.lot", { count: totalLots })}
              </span>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleAll}>
              {allExpanded ? (
                <>
                  <Icons.ChevronUp className="mr-1 h-3.5 w-3.5" />
                  {t("asset:lots.collapse_all")}
                </>
              ) : (
                <>
                  <Icons.ChevronDown className="mr-1 h-3.5 w-3.5" />
                  {t("asset:lots.expand_all")}
                </>
              )}
            </Button>
          </div>
          {groups.map((group, index) => (
            <AccountLotGroup
              key={group.accountId}
              group={group}
              currency={currency}
              expanded={expandedAccounts.has(group.accountId)}
              onToggle={() => toggleAccount(group.accountId)}
              isFirst={index === 0}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
};

interface ComputedLot {
  lot: AssetLotView;
  remainingQuantity: number;
  effectiveQuantity: number;
  marketValue: number;
  aggregateMarketValue: number;
  valuationCurrency: string;
  valuationUnitCost: number | null;
  valuationCostBasis: number | null;
  gainLossAmount: number | null;
  gainLossPercent: number | null;
  canAggregate: boolean;
  isValuable: boolean;
  hasPartialSell: boolean;
}

interface AccountLotGroupData {
  accountId: string;
  accountName: string;
  lots: ComputedLot[];
  shares: number;
  costBasis: number;
  marketValue: number;
  gainLossAmount: number;
  gainLossPercent: number;
  allSnapshot: boolean;
}

interface LotTotals {
  marketValue: number;
  costBasis: number;
  gainLossAmount: number;
  gainLossPercent: number;
  shares: number;
  averageUnitCost: number;
}

function groupLotsByAccount(
  lots: AssetLotView[],
  currency: string,
  marketPrice: number,
  contractMultiplier: number,
): AccountLotGroupData[] {
  const byAccount = new Map<
    string,
    { accountId: string; accountName: string; lots: AssetLotView[] }
  >();

  for (const lot of lots) {
    const existing = byAccount.get(lot.accountId) ?? {
      accountId: lot.accountId,
      accountName: lot.accountName || lot.accountId,
      lots: [],
    };
    existing.lots.push(lot);
    byAccount.set(lot.accountId, existing);
  }

  return [...byAccount.values()]
    .map((group) => {
      const computed = [...group.lots]
        .sort(compareLots)
        .map((lot) => computeLot(lot, currency, marketPrice, contractMultiplier));
      const shares = computed.reduce((acc, item) => acc + item.remainingQuantity, 0);
      const costBasis = computed.reduce(
        (acc, item) => acc + (item.canAggregate ? (item.valuationCostBasis ?? 0) : 0),
        0,
      );
      const marketValue = computed.reduce((acc, item) => acc + item.aggregateMarketValue, 0);
      const gainLossAmount = marketValue - costBasis;
      const gainLossPercent = costBasis !== 0 ? gainLossAmount / costBasis : 0;
      const allSnapshot = computed.every((item) => item.lot.source === "SNAPSHOT_POSITION");

      return {
        accountId: group.accountId,
        accountName: group.accountName,
        lots: computed,
        shares,
        costBasis,
        marketValue,
        gainLossAmount,
        gainLossPercent,
        allSnapshot,
      };
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

function computeLot(
  lot: AssetLotView,
  currency: string,
  marketPrice: number,
  contractMultiplier: number,
): ComputedLot {
  const isSnapshot = lot.source === "SNAPSHOT_POSITION";
  const splitRatio = lot.splitRatio || 1;
  const rowContractMultiplier = lot.contractMultiplier || contractMultiplier || 1;
  const remainingQuantity = isSnapshot ? lot.quantity : lot.remainingQuantity;
  const effectiveQuantity = isSnapshot ? lot.quantity : remainingQuantity * splitRatio;
  const isValuable = !lot.isClosed;
  const marketValue = effectiveQuantity * marketPrice * rowContractMultiplier;
  const valuationCurrency = lot.valuationCurrency || currency;
  const valuationUnitCost = finiteAmount(lot.valuationUnitCost);
  const valuationCostBasis = finiteAmount(lot.valuationCostBasis);
  const canAggregate =
    isValuable && valuationCostBasis != null && sameCurrency(valuationCurrency, currency);
  const aggregateMarketValue = canAggregate ? marketValue : 0;
  const gainLossAmount =
    canAggregate && valuationCostBasis != null ? marketValue - valuationCostBasis : null;
  const gainLossPercent =
    gainLossAmount != null && valuationCostBasis != null && valuationCostBasis !== 0
      ? gainLossAmount / valuationCostBasis
      : null;
  const hasPartialSell =
    !isSnapshot && lot.originalQuantity > 0 && lot.remainingQuantity < lot.originalQuantity;

  return {
    lot,
    remainingQuantity,
    effectiveQuantity,
    marketValue,
    aggregateMarketValue,
    valuationCurrency,
    valuationUnitCost,
    valuationCostBasis,
    gainLossAmount,
    gainLossPercent,
    canAggregate,
    isValuable,
    hasPartialSell,
  };
}

function finiteAmount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameCurrency(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeCurrency(left)?.toUpperCase();
  const normalizedRight = normalizeCurrency(right)?.toUpperCase();
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function compareLots(a: AssetLotView, b: AssetLotView) {
  const aRank = a.isClosed ? 2 : a.source === "SNAPSHOT_POSITION" ? 1 : 0;
  const bRank = b.isClosed ? 2 : b.source === "SNAPSHOT_POSITION" ? 1 : 0;
  if (aRank !== bRank) return aRank - bRank;

  const aDate = new Date(a.acquisitionDate ?? a.snapshotDate ?? "").getTime();
  const bDate = new Date(b.acquisitionDate ?? b.snapshotDate ?? "").getTime();
  return aDate - bDate || a.id.localeCompare(b.id);
}

function computeTotals(groups: AccountLotGroupData[]): LotTotals {
  const marketValue = groups.reduce((acc, g) => acc + g.marketValue, 0);
  const costBasis = groups.reduce((acc, g) => acc + g.costBasis, 0);
  const shares = groups.reduce((acc, g) => acc + g.shares, 0);
  const gainLossAmount = marketValue - costBasis;
  const gainLossPercent = costBasis !== 0 ? gainLossAmount / costBasis : 0;
  const averageUnitCost = shares !== 0 ? costBasis / shares : 0;
  return { marketValue, costBasis, gainLossAmount, gainLossPercent, shares, averageUnitCost };
}

function KpiStrip({
  totals,
  currency,
  marketPrice,
  groups,
  dayChangeAmount,
  dayChangePct,
}: {
  totals: LotTotals;
  currency: string;
  marketPrice: number;
  groups: AccountLotGroupData[];
  dayChangeAmount: number | null;
  dayChangePct: number | null;
}) {
  const { t } = useTranslation();
  const hasDayChange = dayChangeAmount != null;
  const bigAmountClass = "text-xl font-medium tracking-tight tabular-nums";

  return (
    <div className="bg-border grid grid-cols-2 gap-px md:grid-cols-5">
      <KpiCell label={t("asset:lots.market_value")}>
        <PrivacyAmount
          value={totals.marketValue}
          currency={currency}
          className={cn("text-foreground", bigAmountClass)}
        />
        <span className="text-muted-foreground text-[11px]">
          {formatQuantity(totals.shares)} {t("asset:lots.shares_suffix")}
          {marketPrice ? ` @ ${formatPrice(marketPrice, currency)}` : null}
        </span>
      </KpiCell>

      <KpiCell label={t("asset:lots.cost_basis")}>
        <PrivacyAmount
          value={totals.costBasis}
          currency={currency}
          className={cn("text-foreground", bigAmountClass)}
        />
        <span className="text-muted-foreground text-[11px]">
          {t("asset:lots.avg", { amount: formatPrice(totals.averageUnitCost, currency) })}
        </span>
      </KpiCell>

      <KpiCell label={t("asset:lots.unrealized_gain")}>
        <GainAmount
          value={totals.gainLossAmount}
          currency={currency}
          displayCurrency={false}
          className={cn("items-start text-left", bigAmountClass)}
        />
        <GainPercent value={totals.gainLossPercent} className="justify-start text-[11px]" />
      </KpiCell>

      <KpiCell label={t("asset:lots.days_change")}>
        {hasDayChange ? (
          <>
            <GainAmount
              value={dayChangeAmount ?? 0}
              currency={currency}
              displayCurrency={false}
              className={cn("items-start text-left", bigAmountClass)}
            />
            {dayChangePct != null && (
              <GainPercent value={dayChangePct} className="justify-start text-[11px]" />
            )}
          </>
        ) : (
          <span className="text-muted-foreground text-base">—</span>
        )}
      </KpiCell>

      <KpiCell label={t("asset:lots.allocation")} className="col-span-2 md:col-span-1">
        <AllocationBar groups={groups} totalValue={totals.marketValue} />
      </KpiCell>
    </div>
  );
}

function KpiCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("bg-card flex flex-col gap-1.5 px-4 py-5 tabular-nums", className)}>
      <span className="text-muted-foreground text-[11px] uppercase tracking-[0.1em]">{label}</span>
      {children}
    </div>
  );
}

function AllocationBar({
  groups,
  totalValue,
}: {
  groups: AccountLotGroupData[];
  totalValue: number;
}) {
  if (totalValue <= 0) {
    return <span className="text-muted-foreground text-[11px]">—</span>;
  }

  const segments = groups
    .map((group, index) => ({
      accountId: group.accountId,
      accountName: group.accountName,
      pct: group.marketValue / totalValue,
      color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length],
    }))
    .filter((segment) => segment.pct > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="bg-muted flex h-1.5 w-full overflow-hidden rounded-full">
        {segments.map((segment) => (
          <div
            key={segment.accountId}
            className="h-full"
            style={{ width: `${segment.pct * 100}%`, backgroundColor: segment.color }}
            title={`${segment.accountName}: ${formatPercent(segment.pct)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {segments.map((segment) => (
          <div
            key={segment.accountId}
            className="text-muted-foreground inline-flex items-center gap-1.5"
          >
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: segment.color }}
              aria-hidden
            />
            <span className="text-foreground">{segment.accountName}</span>
            <span>{formatPercent(segment.pct)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountLotGroup({
  group,
  currency,
  expanded,
  onToggle,
  isFirst,
}: {
  group: AccountLotGroupData;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
  isFirst: boolean;
}) {
  const { t } = useTranslation();
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;

  return (
    <div className={cn(!isFirst && "border-t", expanded && "bg-muted/20")}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors",
          !expanded && "hover:bg-muted/30",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          className="group flex min-w-0 flex-1 items-center gap-2"
        >
          <Chevron
            className={cn(
              "h-4 w-4 shrink-0 transition-colors",
              expanded ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
            )}
          />
          <span className="text-foreground truncate text-sm font-medium">{group.accountName}</span>
          {group.allSnapshot && (
            <Badge variant="secondary" className="ml-1 text-[10px] uppercase tracking-wider">
              {t("asset:lots.from_snapshot")}
            </Badge>
          )}
          <span className="text-muted-foreground truncate text-xs">
            {t("asset:lots.lot", { count: group.lots.length })} · {formatQuantity(group.shares)}{" "}
            {t("asset:lots.share", { count: group.shares })}
          </span>
        </button>

        <div className="text-muted-foreground flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider">{t("asset:lots.basis")}</span>
            <PrivacyAmount
              value={group.costBasis}
              currency={currency}
              className="text-foreground font-medium"
            />
          </span>
          <span className="bg-border hidden h-3 w-px sm:block" aria-hidden />
          <span className="inline-flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider">{t("asset:lots.value")}</span>
            <PrivacyAmount
              value={group.marketValue}
              currency={currency}
              className="text-foreground font-medium"
            />
          </span>
          <span className="bg-border hidden h-3 w-px sm:block" aria-hidden />
          <div className="flex items-center gap-2">
            <GainAmount
              value={group.gainLossAmount}
              currency={currency}
              displayCurrency={false}
              className="text-xs"
            />
            <GainPercent value={group.gainLossPercent} variant="badge" className="text-xs" />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-2 pb-2 md:px-3 md:pb-3">
          <div className="bg-card overflow-hidden rounded-lg border">
            <div className="hidden overflow-x-auto md:block">
              <Table className="table-fixed">
                <colgroup>
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.date")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.qty")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.unit_cost")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.cost_basis_col")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.market_value_col")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                      {t("asset:lots.unrealized")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.lots.map((item) => (
                    <AssetLotTableRow key={item.lot.id} item={item} currency={currency} />
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="divide-y md:hidden">
              {group.lots.map((item) => (
                <AssetLotMobileRow key={item.lot.id} item={item} currency={currency} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AssetLotTableRow({ item, currency }: { item: ComputedLot; currency: string }) {
  const { t } = useTranslation();
  const { lot } = item;
  const isSnapshot = lot.source === "SNAPSHOT_POSITION";

  return (
    <TableRow
      className={cn(
        "hover:bg-muted/40 text-[13px] transition-colors",
        lot.isClosed && "opacity-60",
      )}
    >
      <TableCell className="font-medium">
        <div>{formatLotDate(lot)}</div>
        <div className="text-muted-foreground text-[11px]">
          {isSnapshot
            ? t("asset:lots.as_of_snapshot")
            : t("asset:lots.held", { period: formatHoldingPeriod(lot.acquisitionDate, t) })}
          {lot.isClosed &&
            lot.closeDate &&
            ` · ${t("asset:lots.closed", { date: formatDate(lot.closeDate) })}`}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{formatQuantity(item.remainingQuantity)}</div>
        {item.hasPartialSell && (
          <div className="text-muted-foreground text-[11px]">
            {t("asset:lots.of", { quantity: formatQuantity(lot.originalQuantity) })}
          </div>
        )}
        {!isSnapshot && lot.splitRatio !== 1 && (
          <div className="text-muted-foreground text-[11px]">
            {t("asset:lots.eff", { quantity: formatQuantity(item.effectiveQuantity) })}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.valuationUnitCost != null ? (
          <PrivacyAmount value={item.valuationUnitCost} currency={item.valuationCurrency} />
        ) : (
          "—"
        )}
        {!isSnapshot && lot.splitRatio !== 1 && (
          <div className="text-muted-foreground text-[11px]">
            {t("asset:lots.adj")}{" "}
            {item.valuationUnitCost != null ? (
              <PrivacyAmount
                value={item.valuationUnitCost / lot.splitRatio}
                currency={item.valuationCurrency}
              />
            ) : (
              "—"
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.valuationCostBasis != null ? (
          <PrivacyAmount value={item.valuationCostBasis} currency={item.valuationCurrency} />
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.isValuable ? <PrivacyAmount value={item.marketValue} currency={currency} /> : "—"}
      </TableCell>
      <TableCell className="text-right">
        {item.gainLossAmount != null ? (
          <div className="flex flex-col items-end">
            <GainAmount value={item.gainLossAmount} currency={currency} displayCurrency={false} />
            <GainPercent value={item.gainLossPercent ?? 0} className="text-[11px]" />
          </div>
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

function AssetLotMobileRow({ item, currency }: { item: ComputedLot; currency: string }) {
  const { t } = useTranslation();
  const { lot } = item;
  const isSnapshot = lot.source === "SNAPSHOT_POSITION";

  return (
    <div className={cn("space-y-2 p-4", lot.isClosed && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium">{formatLotDate(lot)}</div>
          <div className="text-muted-foreground text-[11px]">
            {isSnapshot
              ? t("asset:lots.as_of_snapshot")
              : t("asset:lots.held", { period: formatHoldingPeriod(lot.acquisitionDate, t) })}
            {lot.isClosed &&
              lot.closeDate &&
              ` · ${t("asset:lots.closed", { date: formatDate(lot.closeDate) })}`}
          </div>
        </div>
        {item.gainLossAmount != null && (
          <div className="flex shrink-0 flex-col items-end">
            <GainAmount value={item.gainLossAmount} currency={currency} displayCurrency={false} />
            <GainPercent value={item.gainLossPercent ?? 0} className="text-[11px]" />
          </div>
        )}
      </div>

      <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <span>{t("asset:lots.qty")}</span>
        <span className="text-foreground text-right tabular-nums">
          {formatQuantity(item.remainingQuantity)}
          {item.hasPartialSell && (
            <span className="text-muted-foreground block text-[11px]">
              {t("asset:lots.of", { quantity: formatQuantity(lot.originalQuantity) })}
            </span>
          )}
        </span>
        <span>{t("asset:lots.unit_cost")}</span>
        <span className="text-foreground text-right tabular-nums">
          {item.valuationUnitCost != null ? (
            <PrivacyAmount value={item.valuationUnitCost} currency={item.valuationCurrency} />
          ) : (
            "—"
          )}
        </span>
        <span>{t("asset:lots.cost_basis_col")}</span>
        <span className="text-foreground text-right tabular-nums">
          {item.valuationCostBasis != null ? (
            <PrivacyAmount value={item.valuationCostBasis} currency={item.valuationCurrency} />
          ) : (
            "—"
          )}
        </span>
        {item.isValuable && (
          <>
            <span>{t("asset:lots.market_value_col")}</span>
            <span className="text-foreground text-right tabular-nums">
              <PrivacyAmount value={item.marketValue} currency={currency} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function formatLotDate(lot: AssetLotView) {
  const date = lot.acquisitionDate ?? lot.snapshotDate;
  return date ? formatDate(date) : "—";
}

function formatHoldingPeriod(acquisitionDate: string | null | undefined, t: TFunction): string {
  if (!acquisitionDate) return "—";
  const start = new Date(acquisitionDate);
  if (Number.isNaN(start.getTime())) return "—";

  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years > 0) {
    return months > 0
      ? t("asset:lots.period_year_month", { years, months })
      : t("asset:lots.period_year", { years });
  }
  if (months > 0) {
    return t("asset:lots.period_month", { months });
  }
  return t("asset:lots.period_day", { days: Math.max(days, 0) });
}

export default AssetLotsTable;
