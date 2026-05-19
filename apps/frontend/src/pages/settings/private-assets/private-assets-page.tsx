import HistoryChart from "@/components/history-chart-symbol";
import {
  getPrivateAssetCurrentTotals,
  getPrivateAssetHistoricalSeries,
  listPrivateAssetRows,
} from "@/adapters";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  PrivateAssetCurrentTotals,
  PrivateAssetHistoricalPoint,
  PrivateAssetListRow,
} from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  formatPrivateAmount,
  formatPrivateAssetStatus,
  formatPrivateAssetStrategy,
  formatPrivateAssetVehicleKind,
  formatPrivateSnapshotValueSource,
  getPrivateStatementAmountLabel,
  getFreshnessBadgeClass,
  getStatusBadgeClass,
} from "./private-assets-utils";
import { PrivateAssetEditModal } from "./components/private-asset-edit-modal";
import { SettingsHeader } from "../settings-header";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import { Badge } from "@wealthfolio/ui/components/ui/badge";

export default function PrivateAssetsPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();

  const rowsQuery = useQuery<PrivateAssetListRow[], Error>({
    queryKey: QueryKeys.privateAssetRows(includeArchived),
    queryFn: () => listPrivateAssetRows(includeArchived),
  });

  const totalsQuery = useQuery<PrivateAssetCurrentTotals, Error>({
    queryKey: QueryKeys.privateAssetTotals(includeArchived),
    queryFn: () => getPrivateAssetCurrentTotals(includeArchived),
  });

  const historyQuery = useQuery<PrivateAssetHistoricalPoint[], Error>({
    queryKey: QueryKeys.privateAssetHistory(includeArchived),
    queryFn: () => getPrivateAssetHistoricalSeries(includeArchived),
  });

  const chartCurrency = rowsQuery.data?.[0]?.currency ?? settings?.baseCurrency ?? "USD";

  const chartData = useMemo(
    () =>
      (historyQuery.data ?? []).map((point) => ({
        timestamp: point.asOfDate,
        totalValue: point.totalCurrentValue,
        currency: chartCurrency,
      })),
    [chartCurrency, historyQuery.data],
  );

  const latestHistoryRows = useMemo(
    () => [...(historyQuery.data ?? [])].slice(-6).reverse(),
    [historyQuery.data],
  );

  const isLoading = rowsQuery.isLoading || totalsQuery.isLoading || historyQuery.isLoading;

  return (
    <>
      <div className="space-y-6">
        <SettingsHeader
          heading="Private Assets"
          text="Track private vehicles, latest marks, and carry-forward history through the private-assets projection layer."
          className="grid-cols-1 sm:grid-cols-[1fr_auto]"
        >
          <Button size="sm" onClick={() => setCreateModalOpen(true)}>
            <Icons.Plus className="mr-2 h-4 w-4" />
            Add private asset
          </Button>
        </SettingsHeader>

        <Separator />

        <div className="flex items-center gap-3 rounded-lg border px-4 py-3">
          <Checkbox
            id="include-archived-private-assets"
            checked={includeArchived}
            onCheckedChange={(checked) => setIncludeArchived(checked === true)}
          />
          <label
            htmlFor="include-archived-private-assets"
            className="text-sm font-medium leading-none"
          >
            Show archived assets
          </label>
          <span className="text-muted-foreground text-sm">
            Archived rows stay hidden by default in the narrow v1 flow.
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            title="Current Value"
            value={formatPrivateAmount(
              totalsQuery.data?.totalCurrentValue,
              chartCurrency,
              isBalanceHidden,
            )}
            subtitle="Latest reported value only"
            isLoading={totalsQuery.isLoading}
          />
          <SummaryCard
            title="Contributed"
            value={formatPrivateAmount(
              totalsQuery.data?.totalContributed,
              chartCurrency,
              isBalanceHidden,
            )}
            subtitle="From latest statements"
            isLoading={totalsQuery.isLoading}
          />
          <SummaryCard
            title="Distributed"
            value={formatPrivateAmount(
              totalsQuery.data?.totalDistributed,
              chartCurrency,
              isBalanceHidden,
            )}
            subtitle="From latest statements"
            isLoading={totalsQuery.isLoading}
          />
          <SummaryCard
            title="Latest As-Of"
            value={formatDate(totalsQuery.data?.latestAsOfDate)}
            subtitle="Newest statement in view"
            isLoading={totalsQuery.isLoading}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Historical Series</CardTitle>
              <CardDescription>
                Carry-forward marks only. No inferred between-mark behavior in v1.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {historyQuery.isLoading ? (
                <div className="space-y-3 p-6">
                  <Skeleton className="h-56 w-full" />
                </div>
              ) : chartData.length > 0 ? (
                <HistoryChart data={chartData} height={260} />
              ) : (
                <div className="p-6">
                  <EmptyPlaceholder>
                    <EmptyPlaceholder.Icon name="Activity" />
                    <EmptyPlaceholder.Title>No private history yet</EmptyPlaceholder.Title>
                    <EmptyPlaceholder.Description>
                      Add the first statement to start the carry-forward series.
                    </EmptyPlaceholder.Description>
                  </EmptyPlaceholder>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Series Points</CardTitle>
              <CardDescription>The last reported points in chronological order.</CardDescription>
            </CardHeader>
            <CardContent>
              {historyQuery.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : latestHistoryRows.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>As-Of</TableHead>
                      <TableHead className="text-right">Total Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {latestHistoryRows.map((point) => (
                      <TableRow key={point.asOfDate}>
                        <TableCell>{formatDate(point.asOfDate)}</TableCell>
                        <TableCell className="text-right">
                          {formatPrivateAmount(
                            point.totalCurrentValue,
                            chartCurrency,
                            isBalanceHidden,
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground text-sm">No historical points yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Assets</CardTitle>
            <CardDescription>
              Freshness comes from the latest statement. Rows without a statement stay visible but
              do not add value yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : rowsQuery.data && rowsQuery.data.length > 0 ? (
              <div className="space-y-3">
                {rowsQuery.data.map((row) => (
                  <Link
                    key={row.assetId}
                    to={`/settings/private-assets/${row.assetId}`}
                    className="hover:bg-muted/40 block rounded-lg border p-4 transition-colors"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-semibold">{row.name}</h3>
                          <Badge
                            variant="outline"
                            className={getFreshnessBadgeClass(row.freshnessState)}
                          >
                            {row.freshnessState}
                          </Badge>
                          <Badge variant="outline" className={getStatusBadgeClass(row.status)}>
                            {formatPrivateAssetStatus(row.status)}
                          </Badge>
                        </div>
                        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
                          <span>{row.fundManagerName ?? "Direct investment"}</span>
                          <span>{formatPrivateAssetVehicleKind(row.vehicleKind)}</span>
                          <span>{formatPrivateAssetStrategy(row.strategyType)}</span>
                          {row.latestSnapshot ? (
                            <span>
                              {formatPrivateSnapshotValueSource(row.latestSnapshot.valueSourceType)}{" "}
                              mark
                            </span>
                          ) : (
                            <span>No statements yet</span>
                          )}
                        </div>
                      </div>

                      <div className="grid w-full gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:w-auto lg:min-w-[340px] lg:text-right xl:min-w-[380px]">
                        <div>
                          <div className="text-muted-foreground leading-snug">Current Value</div>
                          <div className="font-semibold">
                            {row.latestSnapshot
                              ? formatPrivateAmount(
                                  row.latestSnapshot.currentValue,
                                  row.currency,
                                  isBalanceHidden,
                                )
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground leading-snug">Latest As-Of</div>
                          <div className="font-semibold">
                            {formatDate(row.latestSnapshot?.asOfDate)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground leading-snug">
                            {row.latestSnapshot
                              ? getPrivateStatementAmountLabel(
                                  row.latestSnapshot.cashFlowType,
                                  "contributed",
                                )
                              : "Contributed"}
                          </div>
                          <div className="font-semibold">
                            {row.latestSnapshot
                              ? formatPrivateAmount(
                                  row.latestSnapshot.contributedAmount,
                                  row.currency,
                                  isBalanceHidden,
                                )
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground leading-snug">Commitment</div>
                          <div className="font-semibold">
                            {formatPrivateAmount(
                              row.commitmentAmount,
                              row.currency,
                              isBalanceHidden,
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyPlaceholder>
                <EmptyPlaceholder.Icon name="Wallet" />
                <EmptyPlaceholder.Title>No private assets yet</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Start by adding a private asset, then add its first statement from the detail
                  page.
                </EmptyPlaceholder.Description>
                <Button onClick={() => setCreateModalOpen(true)}>
                  <Icons.Plus className="mr-2 h-4 w-4" />
                  Add private asset
                </Button>
              </EmptyPlaceholder>
            )}
          </CardContent>
        </Card>
      </div>

      <PrivateAssetEditModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} />
    </>
  );
}

function SummaryCard({
  title,
  value,
  subtitle,
  isLoading,
}: {
  title: string;
  value: string;
  subtitle: string;
  isLoading: boolean;
}) {
  return (
    <Card className="flex h-full min-w-0 flex-col">
      <CardHeader className="min-h-[140px] min-w-0 flex-1 gap-4 pb-4">
        <CardDescription className="min-h-[3rem] leading-snug">{title}</CardDescription>
        <CardTitle className="min-w-0 text-[clamp(1.35rem,0.5vw+1rem,1.75rem)] leading-[1.05] tracking-[-0.03em] [overflow-wrap:anywhere]">
          {isLoading ? <Skeleton className="h-8 w-32" /> : value}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
