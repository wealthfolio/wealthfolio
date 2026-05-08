import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { LotView } from "@/lib/types";
import { formatAmount } from "@wealthfolio/ui";
import { formatDate, formatQuantity } from "@/lib/utils";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { GainAmount } from "@wealthfolio/ui";
import { GainPercent } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useAccounts } from "@/hooks/use-accounts";

interface AssetLotsTableProps {
  lotDetails?: LotView[] | null;
  currency: string;
  marketPrice: number;
}

export const AssetLotsTable = ({ lotDetails, currency, marketPrice }: AssetLotsTableProps) => {
  if (!lotDetails || lotDetails.length === 0) {
    return null;
  }

  return <LotDetailsView lotDetails={lotDetails} currency={currency} marketPrice={marketPrice} />;
};

// ─── Rich lot details view with account grouping and open/closed status ───

function LotDetailsView({
  lotDetails,
  currency,
  marketPrice,
}: {
  lotDetails: LotView[];
  currency: string;
  marketPrice: number;
}) {
  const { accounts } = useAccounts();
  const accountMap = new Map(accounts?.map((a) => [a.id, a.name]) ?? []);

  // Group by account
  const byAccount = new Map<string, LotView[]>();
  for (const lot of lotDetails) {
    const list = byAccount.get(lot.accountId) ?? [];
    list.push(lot);
    byAccount.set(lot.accountId, list);
  }

  const multiAccount = byAccount.size > 1;

  // Sort each group: open lots first (by date), then closed lots (by close date)
  for (const [, groupLots] of byAccount) {
    groupLots.sort((a, b) => {
      if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
      return new Date(a.acquisitionDate).getTime() - new Date(b.acquisitionDate).getTime();
    });
  }

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        {Array.from(byAccount.entries()).map(([accountId, groupLots]) => (
          <AccountLotGroup
            key={accountId}
            accountName={accountMap.get(accountId) ?? accountId}
            lots={groupLots}
            currency={currency}
            marketPrice={marketPrice}
            collapsible={multiAccount}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function AccountLotGroup({
  accountName,
  lots,
  currency,
  marketPrice,
  collapsible,
}: {
  accountName: string;
  lots: LotView[];
  currency: string;
  marketPrice: number;
  collapsible: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const openCount = lots.filter((l) => !l.isClosed).length;
  const closedCount = lots.filter((l) => l.isClosed).length;

  return (
    <div>
      {collapsible && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="hover:bg-muted flex w-full items-center gap-2 px-4 py-2 text-sm font-medium"
        >
          {expanded ? (
            <Icons.ChevronDown className="h-4 w-4" />
          ) : (
            <Icons.ChevronRight className="h-4 w-4" />
          )}
          {accountName}
          <span className="text-muted-foreground ml-auto text-xs">
            {openCount} open{closedCount > 0 ? `, ${closedCount} closed` : ""}
          </span>
        </button>
      )}
      {(!collapsible || expanded) && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="whitespace-nowrap">Acquired</TableHead>
                  <TableHead className="text-right">Original Qty</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right">Cost/Unit</TableHead>
                  <TableHead className="text-right">Fees</TableHead>
                  <TableHead className="text-right">Cost Basis</TableHead>
                  <TableHead className="text-right">Market Value</TableHead>
                  <TableHead className="text-right">Gain/Loss</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lots.map((lot) => {
                  // remainingQuantity is in as-acquired (pre-split) units;
                  // effective shares for market valuation use splitRatio.
                  const effectiveRemaining = lot.remainingQuantity * lot.splitRatio;
                  const marketValue = effectiveRemaining * marketPrice;
                  const gainLoss = marketValue - lot.remainingCostBasis;
                  const gainPct =
                    lot.remainingCostBasis !== 0 ? gainLoss / lot.remainingCostBasis : 0;
                  const hasSplit = lot.splitRatio !== 1;

                  return (
                    <TableRow key={lot.id} className={lot.isClosed ? "opacity-50" : ""}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            variant={lot.isClosed ? "secondary" : "outline"}
                            className="text-xs"
                          >
                            {lot.isClosed ? "Closed" : "Open"}
                          </Badge>
                          {hasSplit && (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              title={`Quantities and unit price shown as-purchased (pre-split). Effective shares = displayed × ${lot.splitRatio}.`}
                            >
                              {`${lot.splitRatio}:1 split`}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatDate(lot.acquisitionDate)}
                        {lot.isClosed && lot.closeDate && (
                          <div className="text-muted-foreground text-xs">
                            Closed {formatDate(lot.closeDate)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatQuantity(lot.originalQuantity)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatQuantity(lot.remainingQuantity)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatAmount(lot.costPerUnit, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatAmount(lot.fees, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatAmount(lot.remainingCostBasis, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {lot.isClosed ? "—" : formatAmount(marketValue, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {lot.isClosed ? (
                          "—"
                        ) : (
                          <div className="flex flex-row items-center justify-end space-x-2">
                            <GainAmount
                              value={gainLoss}
                              currency={currency}
                              displayCurrency={false}
                            />
                            <GainPercent value={gainPct} variant="badge" />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile card list */}
          <div className="divide-y md:hidden">
            {lots.map((lot) => {
              const effectiveRemaining = lot.remainingQuantity * lot.splitRatio;
              const marketValue = effectiveRemaining * marketPrice;
              const gainLoss = marketValue - lot.remainingCostBasis;
              const gainPct = lot.remainingCostBasis !== 0 ? gainLoss / lot.remainingCostBasis : 0;
              const hasSplit = lot.splitRatio !== 1;

              return (
                <div key={lot.id} className={`space-y-2 p-4 ${lot.isClosed ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={lot.isClosed ? "secondary" : "outline"} className="text-xs">
                        {lot.isClosed ? "Closed" : "Open"}
                      </Badge>
                      {hasSplit && (
                        <Badge
                          variant="outline"
                          className="text-xs"
                          title={`As-purchased (pre-split). Effective = displayed × ${lot.splitRatio}.`}
                        >
                          {`${lot.splitRatio}:1 split`}
                        </Badge>
                      )}
                      <span className="text-sm font-medium">{formatDate(lot.acquisitionDate)}</span>
                    </div>
                    {!lot.isClosed && (
                      <div className="flex items-center space-x-2">
                        <GainAmount value={gainLoss} currency={currency} displayCurrency={false} />
                        <GainPercent value={gainPct} variant="badge" />
                      </div>
                    )}
                  </div>
                  <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span>Remaining</span>
                    <span className="text-foreground text-right">
                      {formatQuantity(lot.remainingQuantity)} /{" "}
                      {formatQuantity(lot.originalQuantity)}
                    </span>
                    <span>Cost/Unit</span>
                    <span className="text-foreground text-right">
                      {formatAmount(lot.costPerUnit, currency)}
                    </span>
                    <span>Cost Basis</span>
                    <span className="text-foreground text-right">
                      {formatAmount(lot.remainingCostBasis, currency)}
                    </span>
                    {!lot.isClosed && (
                      <>
                        <span>Market Value</span>
                        <span className="text-foreground text-right">
                          {formatAmount(marketValue, currency)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default AssetLotsTable;
