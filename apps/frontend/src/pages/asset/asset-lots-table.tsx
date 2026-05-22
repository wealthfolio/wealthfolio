import { useState } from "react";
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
  GainAmount,
  GainPercent,
  PrivacyAmount,
  formatAmount,
  formatPercent,
} from "@wealthfolio/ui";
import { formatDate, formatQuantity } from "@/lib/utils";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";

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
  if (!lots || lots.length === 0) {
    return null;
  }

  const groups = groupLotsByAccount(lots, marketPrice, contractMultiplier);
  const totals = computeTotals(groups);
  const isMultiAccount = groups.length > 1;

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
          {groups.map((group, index) => (
            <AccountLotGroup
              key={group.accountId}
              group={group}
              currency={currency}
              collapsible={isMultiAccount}
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
  gainLossAmount: number;
  gainLossPercent: number;
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
        .map((lot) => computeLot(lot, marketPrice, contractMultiplier));
      const shares = computed.reduce((acc, item) => acc + item.remainingQuantity, 0);
      const costBasis = computed.reduce((acc, item) => acc + item.lot.costBasis, 0);
      const marketValue = computed.reduce(
        (acc, item) => acc + (item.isValuable ? item.marketValue : 0),
        0,
      );
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
  const gainLossAmount = marketValue - lot.costBasis;
  const gainLossPercent = lot.costBasis !== 0 ? gainLossAmount / lot.costBasis : 0;
  const hasPartialSell =
    !isSnapshot && lot.originalQuantity > 0 && lot.remainingQuantity < lot.originalQuantity;

  return {
    lot,
    remainingQuantity,
    effectiveQuantity,
    marketValue,
    gainLossAmount,
    gainLossPercent,
    isValuable,
    hasPartialSell,
  };
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
  const hasDayChange = dayChangeAmount != null;
  const bigAmountClass = "text-xl font-medium tracking-tight tabular-nums";

  return (
    <div className="bg-border grid grid-cols-2 gap-px md:grid-cols-5">
      <KpiCell label="Market Value">
        <PrivacyAmount
          value={totals.marketValue}
          currency={currency}
          className={cn("text-foreground", bigAmountClass)}
        />
        <span className="text-muted-foreground text-[11px]">
          {formatQuantity(totals.shares)} shares
          {marketPrice ? ` @ ${formatAmount(marketPrice, currency)}` : null}
        </span>
      </KpiCell>

      <KpiCell label="Cost Basis">
        <PrivacyAmount
          value={totals.costBasis}
          currency={currency}
          className={cn("text-foreground", bigAmountClass)}
        />
        <span className="text-muted-foreground text-[11px]">
          avg {formatAmount(totals.averageUnitCost, currency)}
        </span>
      </KpiCell>

      <KpiCell label="Unrealized Gain">
        <GainAmount
          value={totals.gainLossAmount}
          currency={currency}
          displayCurrency={false}
          className={cn("items-start text-left", bigAmountClass)}
        />
        <GainPercent value={totals.gainLossPercent} className="justify-start text-[11px]" />
      </KpiCell>

      <KpiCell label="Day's Change">
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

      <KpiCell label="Allocation" className="col-span-2 md:col-span-1">
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
  collapsible,
  isFirst,
}: {
  group: AccountLotGroupData;
  currency: string;
  collapsible: boolean;
  isFirst: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  const showExpander = collapsible;
  const Chevron = expanded ? Icons.ChevronDown : Icons.ChevronRight;

  return (
    <div className={cn(!isFirst && "pt-6")}>
      <div
        className={cn(
          "from-muted/30 to-muted/5 flex min-h-[64px] flex-wrap items-center gap-x-4 gap-y-2 bg-gradient-to-b px-5 py-5",
          isFirst ? "border-b" : "border-y",
        )}
      >
        <button
          type="button"
          onClick={() => showExpander && setExpanded((v) => !v)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            showExpander ? "hover:text-foreground" : "cursor-default",
          )}
          disabled={!showExpander}
        >
          {showExpander && <Chevron className="text-muted-foreground h-4 w-4 shrink-0" />}
          <span className="text-foreground font-serif text-[18px] font-normal leading-none tracking-tight">
            {group.accountName}
          </span>
          {group.allSnapshot && (
            <Badge variant="secondary" className="ml-1 text-[10px] uppercase tracking-wider">
              From snapshot
            </Badge>
          )}
          <span className="text-muted-foreground truncate text-[11px]">
            {group.lots.length} {group.lots.length === 1 ? "lot" : "lots"} ·{" "}
            {formatQuantity(group.shares)} {group.shares === 1 ? "share" : "shares"}
          </span>
        </button>

        <div className="text-muted-foreground flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[11px]">
          <span>
            Basis{" "}
            <PrivacyAmount
              value={group.costBasis}
              currency={currency}
              className="text-foreground font-medium"
            />
          </span>
          <span>
            Value{" "}
            <PrivacyAmount
              value={group.marketValue}
              currency={currency}
              className="text-foreground font-medium"
            />
          </span>
          <div className="flex items-center gap-2">
            <GainAmount value={group.gainLossAmount} currency={currency} displayCurrency={false} />
            <GainPercent value={group.gainLossPercent} variant="badge" />
          </div>
        </div>
      </div>

      {expanded && (
        <>
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
                  <TableHead className="text-[10px] uppercase tracking-[0.1em]">Date</TableHead>
                  <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                    Qty
                  </TableHead>
                  <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                    Unit Cost
                  </TableHead>
                  <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                    Cost Basis
                  </TableHead>
                  <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                    Market Value
                  </TableHead>
                  <TableHead className="text-right text-[10px] uppercase tracking-[0.1em]">
                    Unrealized
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
        </>
      )}
    </div>
  );
}

function AssetLotTableRow({ item, currency }: { item: ComputedLot; currency: string }) {
  const { lot } = item;
  const isSnapshot = lot.source === "SNAPSHOT_POSITION";

  return (
    <TableRow className={cn("text-[13px]", lot.isClosed && "opacity-60")}>
      <TableCell className="font-medium">
        <div>{formatLotDate(lot)}</div>
        <div className="text-muted-foreground text-[11px]">
          {isSnapshot ? "as-of snapshot" : `held ${formatHoldingPeriod(lot.acquisitionDate)}`}
          {lot.isClosed && lot.closeDate && ` · closed ${formatDate(lot.closeDate)}`}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <div>{formatQuantity(item.remainingQuantity)}</div>
        {item.hasPartialSell && (
          <div className="text-muted-foreground text-[11px]">
            of {formatQuantity(lot.originalQuantity)}
          </div>
        )}
        {!isSnapshot && lot.splitRatio !== 1 && (
          <div className="text-muted-foreground text-[11px]">
            eff. {formatQuantity(item.effectiveQuantity)}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <PrivacyAmount value={lot.unitCost} currency={currency} />
        {!isSnapshot && lot.splitRatio !== 1 && (
          <div className="text-muted-foreground text-[11px]">
            adj. <PrivacyAmount value={lot.unitCost / lot.splitRatio} currency={currency} />
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <PrivacyAmount value={lot.costBasis} currency={currency} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.isValuable ? <PrivacyAmount value={item.marketValue} currency={currency} /> : "—"}
      </TableCell>
      <TableCell className="text-right">
        {item.isValuable ? (
          <div className="flex flex-col items-end">
            <GainAmount value={item.gainLossAmount} currency={currency} displayCurrency={false} />
            <GainPercent value={item.gainLossPercent} className="text-[11px]" />
          </div>
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

function AssetLotMobileRow({ item, currency }: { item: ComputedLot; currency: string }) {
  const { lot } = item;
  const isSnapshot = lot.source === "SNAPSHOT_POSITION";

  return (
    <div className={cn("space-y-2 p-4", lot.isClosed && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium">{formatLotDate(lot)}</div>
          <div className="text-muted-foreground text-[11px]">
            {isSnapshot ? "as-of snapshot" : `held ${formatHoldingPeriod(lot.acquisitionDate)}`}
            {lot.isClosed && lot.closeDate && ` · closed ${formatDate(lot.closeDate)}`}
          </div>
        </div>
        {item.isValuable && (
          <div className="flex shrink-0 flex-col items-end">
            <GainAmount value={item.gainLossAmount} currency={currency} displayCurrency={false} />
            <GainPercent value={item.gainLossPercent} className="text-[11px]" />
          </div>
        )}
      </div>

      <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <span>Qty</span>
        <span className="text-foreground text-right tabular-nums">
          {formatQuantity(item.remainingQuantity)}
          {item.hasPartialSell && (
            <span className="text-muted-foreground block text-[11px]">
              of {formatQuantity(lot.originalQuantity)}
            </span>
          )}
        </span>
        <span>Unit Cost</span>
        <span className="text-foreground text-right tabular-nums">
          <PrivacyAmount value={lot.unitCost} currency={currency} />
        </span>
        <span>Cost Basis</span>
        <span className="text-foreground text-right tabular-nums">
          <PrivacyAmount value={lot.costBasis} currency={currency} />
        </span>
        {item.isValuable && (
          <>
            <span>Market Value</span>
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

function formatHoldingPeriod(acquisitionDate: string | null | undefined): string {
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
    return months > 0 ? `${years}y ${months}mo` : `${years}y`;
  }
  if (months > 0) {
    return `${months}mo`;
  }
  return `${Math.max(days, 0)}d`;
}

export default AssetLotsTable;
