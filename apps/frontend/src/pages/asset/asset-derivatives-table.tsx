import { getDerivativeHoldingsForAsset } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { QueryKeys } from "@/lib/query-keys";
import type { Holding } from "@/lib/types";
import { AmountDisplay, GainAmount, GainPercent } from "@wealthfolio/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";

interface AssetDerivativesTableProps {
  assetId: string;
  baseCurrency: string;
}

interface ContractGroup {
  contractId: string;
  symbol: string;
  parsed: ReturnType<typeof parseOccSymbol>;
  currency: string;
  totalQuantity: number;
  totalMarketValue: number;
  totalUnrealizedGain: number | null;
  totalUnrealizedGainPct: number | null;
  accountRows: Holding[];
}

export function AssetDerivativesTable({ assetId, baseCurrency }: AssetDerivativesTableProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { accounts } = useAccounts();
  const { data: holdings = [] } = useQuery<Holding[]>({
    queryKey: [QueryKeys.ASSET_DERIVATIVE_HOLDINGS, assetId],
    queryFn: () => getDerivativeHoldingsForAsset(assetId),
    enabled: !!assetId,
  });

  const accountNameById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const groups: ContractGroup[] = useMemo(() => {
    const map = new Map<string, ContractGroup>();
    for (const h of holdings) {
      const contractId = h.instrument?.id ?? "";
      const symbol = h.instrument?.symbol ?? "";
      if (!contractId || !symbol) continue;

      let group = map.get(contractId);
      if (!group) {
        group = {
          contractId,
          symbol,
          parsed: parseOccSymbol(symbol),
          currency: h.localCurrency ?? h.instrument?.currency ?? baseCurrency,
          totalQuantity: 0,
          totalMarketValue: 0,
          totalUnrealizedGain: null,
          totalUnrealizedGainPct: null,
          accountRows: [],
        };
        map.set(contractId, group);
      }
      group.accountRows.push(h);
      group.totalQuantity += Number(h.quantity ?? 0);
      group.totalMarketValue += Number(h.marketValue?.local ?? 0);
      const gain = h.unrealizedGain?.local;
      if (gain != null) {
        group.totalUnrealizedGain = (group.totalUnrealizedGain ?? 0) + Number(gain);
      }
    }
    // Compute percent from totals
    for (const group of map.values()) {
      const totalCost = group.accountRows.reduce((s, h) => s + Number(h.costBasis?.local ?? 0), 0);
      if (group.totalUnrealizedGain != null && totalCost > 0) {
        group.totalUnrealizedGainPct = group.totalUnrealizedGain / totalCost;
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const exA = a.parsed?.expiration ?? "";
      const exB = b.parsed?.expiration ?? "";
      if (exA !== exB) return exA.localeCompare(exB);
      const stA = a.parsed?.strikePrice ?? 0;
      const stB = b.parsed?.strikePrice ?? 0;
      return stA - stB;
    });
  }, [holdings, baseCurrency]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-medium">Derivatives</h3>
      <p className="text-muted-foreground mb-3 text-xs">
        Open option positions on this underlying asset.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contract</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Strike</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead className="text-right">Contracts</TableHead>
            <TableHead className="text-right">Market Value</TableHead>
            <TableHead className="text-right">Unrealized</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => {
            const showAccountRows = g.accountRows.length > 1;
            return (
              <>
                <TableRow key={g.contractId} className="font-medium">
                  <TableCell>
                    <Link
                      to={`/holdings/${encodeURIComponent(g.contractId)}`}
                      className="text-primary hover:underline"
                    >
                      {g.symbol}
                    </Link>
                  </TableCell>
                  <TableCell>{g.parsed?.optionType ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {g.parsed ? (
                      <AmountDisplay
                        value={g.parsed.strikePrice}
                        currency={g.currency}
                        isHidden={isBalanceHidden}
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>{g.parsed?.expiration ?? "—"}</TableCell>
                  <TableCell className="text-right">{g.totalQuantity}</TableCell>
                  <TableCell className="text-right">
                    <AmountDisplay
                      value={g.totalMarketValue}
                      currency={g.currency}
                      isHidden={isBalanceHidden}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {g.totalUnrealizedGain != null ? (
                      <div className="flex flex-col items-end">
                        <GainAmount
                          value={g.totalUnrealizedGain}
                          currency={g.currency}
                          displayCurrency={false}
                          showSign={false}
                        />
                        {g.totalUnrealizedGainPct != null && (
                          <GainPercent value={g.totalUnrealizedGainPct} />
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
                {showAccountRows &&
                  g.accountRows.map((h) => {
                    const accountName = accountNameById.get(h.accountId) ?? h.accountId;
                    const currency = h.localCurrency ?? h.instrument?.currency ?? g.currency;
                    return (
                      <TableRow
                        key={`${g.contractId}-${h.accountId}`}
                        className="text-muted-foreground"
                      >
                        <TableCell className="pl-8 text-xs">↳ {accountName}</TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                        <TableCell className="text-right text-xs">{h.quantity}</TableCell>
                        <TableCell className="text-right text-xs">
                          <AmountDisplay
                            value={h.marketValue.local}
                            currency={currency}
                            isHidden={isBalanceHidden}
                          />
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {h.unrealizedGain ? (
                            <GainAmount
                              value={h.unrealizedGain.local}
                              currency={currency}
                              displayCurrency={false}
                              showSign={false}
                            />
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Hook used by the equity profile page to know whether to show a "Shares"
 * section heading. Returns true when this asset has any open derivative
 * positions linked to it.
 */
export function useHasDerivatives(assetId: string): boolean {
  const { data: holdings = [] } = useQuery<Holding[]>({
    queryKey: [QueryKeys.ASSET_DERIVATIVE_HOLDINGS, assetId],
    queryFn: () => getDerivativeHoldingsForAsset(assetId),
    enabled: !!assetId,
  });
  return holdings.length > 0;
}
