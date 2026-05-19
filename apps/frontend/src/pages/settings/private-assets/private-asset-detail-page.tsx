import HistoryChart from "@/components/history-chart-symbol";
import { getPrivateAssetDetail } from "@/adapters";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
import type { PrivateAssetDetail, PrivateSnapshot, PrivateSubAsset } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  formatPrivateAmount,
  formatPrivateAssetStatus,
  formatPrivateAssetStrategy,
  formatPrivateAssetVehicleKind,
  formatPrivateSnapshotCashFlowType,
  formatPrivateSubAssetReportingBasis,
  getPrivateStatementAmountLabel,
  getFreshnessBadgeClass,
  getStatusBadgeClass,
} from "./private-assets-utils";
import { FundManagerEditModal } from "./components/fund-manager-edit-modal";
import { PrivateAssetEditModal } from "./components/private-asset-edit-modal";
import { PrivateSnapshotEditModal } from "./components/private-snapshot-edit-modal";
import { PrivateSubAssetEditModal } from "./components/private-sub-asset-edit-modal";
import { SettingsHeader } from "../settings-header";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
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

function compareStatementsNewestFirst(left: PrivateSnapshot, right: PrivateSnapshot) {
  const asOfDateOrder = right.asOfDate.localeCompare(left.asOfDate);
  if (asOfDateOrder !== 0) {
    return asOfDateOrder;
  }

  return right.createdAt.localeCompare(left.createdAt);
}

export default function PrivateAssetDetailPage() {
  const { privateAssetId = "" } = useParams();
  const { isBalanceHidden } = useBalancePrivacy();
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [managerModalOpen, setManagerModalOpen] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<PrivateSnapshot | null>(null);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [selectedSubAsset, setSelectedSubAsset] = useState<PrivateSubAsset | null>(null);
  const [subAssetModalOpen, setSubAssetModalOpen] = useState(false);

  const detailQuery = useQuery<PrivateAssetDetail | null, Error>({
    queryKey: QueryKeys.privateAssetDetail(privateAssetId),
    queryFn: () => getPrivateAssetDetail(privateAssetId),
    enabled: privateAssetId.length > 0,
  });

  const detail = detailQuery.data;
  const latestSnapshot = detail?.latestSnapshot ?? null;
  const snapshots = detail?.snapshots ?? [];
  const latestTotalToDateSnapshot = useMemo(
    () =>
      [...snapshots]
        .filter((candidate) => candidate.cashFlowType === "TOTAL_TO_DATE")
        .sort(compareStatementsNewestFirst)[0] ?? null,
    [snapshots],
  );
  const showManagerCard = Boolean(detail?.fundManager);
  const showFundManagerField = Boolean(detail?.fundManager);
  const showSubAssetsSection =
    detail?.asset.vehicleKind !== "DIRECT" || (detail?.subAssets.length ?? 0) > 0;

  const chartData = useMemo(
    () =>
      snapshots
        .slice()
        .sort((left, right) => left.asOfDate.localeCompare(right.asOfDate))
        .map((snapshot) => ({
          timestamp: snapshot.asOfDate,
          totalValue: snapshot.currentValue,
          currency: detail?.asset.currency ?? "USD",
        })),
    [detail?.asset.currency, snapshots],
  );

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        <SettingsHeader
          heading="Private Asset"
          text="Detail view"
          backTo="/settings/private-assets"
        />
        <Separator />
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Wallet" />
          <EmptyPlaceholder.Title>Private asset not found</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            This record may have been removed from the current data set.
          </EmptyPlaceholder.Description>
          <Button asChild>
            <Link to="/settings/private-assets">Back to private assets</Link>
          </Button>
        </EmptyPlaceholder>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <SettingsHeader
          heading={detail.asset.name}
          text=""
          backTo="/settings/private-assets"
          className="grid-cols-1 sm:grid-cols-[1fr_auto]"
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setAssetModalOpen(true)}>
              <Icons.Pencil className="mr-2 h-4 w-4" />
              Edit asset
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setSelectedSnapshot(null);
                setSnapshotModalOpen(true);
              }}
            >
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add statement
            </Button>
          </div>
        </SettingsHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={getFreshnessBadgeClass(detail.freshnessState)}>
            {detail.freshnessState}
          </Badge>
          <Badge variant="outline" className={getStatusBadgeClass(detail.asset.status)}>
            {formatPrivateAssetStatus(detail.asset.status)}
          </Badge>
          <Badge variant="outline">{formatPrivateAssetVehicleKind(detail.asset.vehicleKind)}</Badge>
          <Badge variant="outline">{formatPrivateAssetStrategy(detail.asset.strategyType)}</Badge>
        </div>

        <Separator />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <DetailMetric
            label="Current Value"
            value={
              latestSnapshot
                ? formatPrivateAmount(
                    latestSnapshot.currentValue,
                    detail.asset.currency,
                    isBalanceHidden,
                  )
                : "—"
            }
          />
          <DetailMetric
            label={
              latestSnapshot
                ? getPrivateStatementAmountLabel(latestSnapshot.cashFlowType, "contributed")
                : "Contributed"
            }
            value={
              latestSnapshot
                ? formatPrivateAmount(
                    latestSnapshot.contributedAmount,
                    detail.asset.currency,
                    isBalanceHidden,
                  )
                : "—"
            }
          />
          <DetailMetric
            label={
              latestSnapshot
                ? getPrivateStatementAmountLabel(latestSnapshot.cashFlowType, "distributed")
                : "Distributed"
            }
            value={
              latestSnapshot
                ? formatPrivateAmount(
                    latestSnapshot.distributedAmount,
                    detail.asset.currency,
                    isBalanceHidden,
                  )
                : "—"
            }
          />
          <DetailMetric label="Latest As-Of" value={formatDate(latestSnapshot?.asOfDate)} />
        </div>

        <div
          className={`grid gap-4 ${showManagerCard ? "xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : ""}`}
        >
          <Card>
            <CardHeader>
              <CardTitle>Asset Record</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {showFundManagerField ? (
                <MetadataItem label="Fund Manager" value={detail.fundManager?.name ?? "—"} />
              ) : null}
              <MetadataItem label="Currency" value={detail.asset.currency} />
              <MetadataItem
                label="Vehicle Kind"
                value={formatPrivateAssetVehicleKind(detail.asset.vehicleKind)}
              />
              <MetadataItem
                label="Strategy"
                value={formatPrivateAssetStrategy(detail.asset.strategyType)}
              />
              <MetadataItem
                label="Commitment"
                value={formatPrivateAmount(
                  detail.asset.commitmentAmount,
                  detail.asset.currency,
                  isBalanceHidden,
                )}
              />
              <MetadataItem label="Updated" value={formatDate(detail.asset.updatedAt)} />
              <div className="sm:col-span-2">
                <div className="text-muted-foreground text-sm">Notes</div>
                <div className="font-medium">
                  {detail.asset.notes?.trim() ? detail.asset.notes : "—"}
                </div>
              </div>
            </CardContent>
          </Card>

          {showManagerCard ? (
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>Fund Manager</CardTitle>
                </div>
                <Button variant="outline" size="sm" onClick={() => setManagerModalOpen(true)}>
                  <Icons.Pencil className="mr-2 h-4 w-4" />
                  Edit manager
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <MetadataItem label="Name" value={detail.fundManager?.name ?? "—"} />
                <MetadataItem label="Updated" value={formatDate(detail.fundManager?.updatedAt)} />
                <div>
                  <div className="text-muted-foreground text-sm">Notes</div>
                  <div className="font-medium">
                    {detail.fundManager?.notes?.trim() ? detail.fundManager.notes : "—"}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Statement History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {chartData.length > 0 ? (
                <HistoryChart data={chartData} height={240} />
              ) : (
                <div className="p-6">
                  <EmptyPlaceholder>
                    <EmptyPlaceholder.Icon name="Activity" />
                    <EmptyPlaceholder.Title>No statements yet</EmptyPlaceholder.Title>
                    <Button
                      onClick={() => {
                        setSelectedSnapshot(null);
                        setSnapshotModalOpen(true);
                      }}
                    >
                      <Icons.Plus className="mr-2 h-4 w-4" />
                      Add statement
                    </Button>
                  </EmptyPlaceholder>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="space-y-3">
                <CardTitle>Latest Statement</CardTitle>
                {latestSnapshot ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setSelectedSnapshot(latestSnapshot);
                      setSnapshotModalOpen(true);
                    }}
                  >
                    <Icons.Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {latestSnapshot ? (
                <>
                  <MetadataItem label="As-Of" value={formatDate(latestSnapshot.asOfDate)} />
                  <MetadataItem
                    label="Current Value"
                    value={formatPrivateAmount(
                      latestSnapshot.currentValue,
                      detail.asset.currency,
                      isBalanceHidden,
                    )}
                  />
                  <MetadataItem
                    label={getPrivateStatementAmountLabel(
                      latestSnapshot.cashFlowType,
                      "contributed",
                    )}
                    value={formatPrivateAmount(
                      latestSnapshot.contributedAmount,
                      detail.asset.currency,
                      isBalanceHidden,
                    )}
                  />
                  <MetadataItem
                    label={getPrivateStatementAmountLabel(
                      latestSnapshot.cashFlowType,
                      "distributed",
                    )}
                    value={formatPrivateAmount(
                      latestSnapshot.distributedAmount,
                      detail.asset.currency,
                      isBalanceHidden,
                    )}
                  />
                  <MetadataItem
                    label="Statement Basis"
                    value={formatPrivateSnapshotCashFlowType(latestSnapshot.cashFlowType)}
                  />
                  <div>
                    <div className="text-muted-foreground text-sm">Notes</div>
                    <div className="font-medium">
                      {latestSnapshot.notes?.trim() ? latestSnapshot.notes : "—"}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No statements have been recorded yet.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Statements</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshots.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>As-Of</TableHead>
                      <TableHead>Statement Basis</TableHead>
                      <TableHead className="text-right">Contributed</TableHead>
                      <TableHead className="text-right">Distributed</TableHead>
                      <TableHead className="text-right">Current Value</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...snapshots].sort(compareStatementsNewestFirst).map((snapshot) => (
                      <TableRow key={snapshot.id}>
                        <TableCell>{formatDate(snapshot.asOfDate)}</TableCell>
                        <TableCell>
                          {formatPrivateSnapshotCashFlowType(snapshot.cashFlowType)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatPrivateAmount(
                            snapshot.contributedAmount,
                            detail.asset.currency,
                            isBalanceHidden,
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatPrivateAmount(
                            snapshot.distributedAmount,
                            detail.asset.currency,
                            isBalanceHidden,
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatPrivateAmount(
                            snapshot.currentValue,
                            detail.asset.currency,
                            isBalanceHidden,
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="whitespace-nowrap"
                            onClick={() => {
                              setSelectedSnapshot(snapshot);
                              setSnapshotModalOpen(true);
                            }}
                          >
                            <Icons.Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">No statements recorded yet.</p>
            )}
          </CardContent>
        </Card>

        {showSubAssetsSection ? (
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Sub-Assets</CardTitle>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setSelectedSubAsset(null);
                  setSubAssetModalOpen(true);
                }}
              >
                <Icons.Plus className="mr-2 h-4 w-4" />
                Add sub-asset
              </Button>
            </CardHeader>
            <CardContent>
              {detail.subAssets.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Basis</TableHead>
                        <TableHead>Strategy</TableHead>
                        <TableHead className="w-[8rem] whitespace-nowrap text-right">
                          Current Value
                        </TableHead>
                        <TableHead className="w-[7rem] whitespace-nowrap text-right">
                          Ownership %
                        </TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.subAssets.map((subAsset) => (
                        <TableRow key={subAsset.id}>
                          <TableCell className="font-medium">{subAsset.name}</TableCell>
                          <TableCell>
                            {formatPrivateSubAssetReportingBasis(subAsset.reportingBasis)}
                          </TableCell>
                          <TableCell>
                            {subAsset.strategyType
                              ? formatPrivateAssetStrategy(subAsset.strategyType)
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatPrivateAmount(
                              subAsset.currentValue,
                              detail.asset.currency,
                              isBalanceHidden,
                            )}
                          </TableCell>
                          <TableCell className="w-[7rem] whitespace-nowrap text-right">
                            {subAsset.ownershipPercent ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="whitespace-nowrap"
                              onClick={() => {
                                setSelectedSubAsset(subAsset);
                                setSubAssetModalOpen(true);
                              }}
                            >
                              <Icons.Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <EmptyPlaceholder>
                  <EmptyPlaceholder.Icon name="Blocks" />
                  <EmptyPlaceholder.Title>No sub-assets yet</EmptyPlaceholder.Title>
                </EmptyPlaceholder>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <PrivateAssetEditModal
        asset={detail.asset}
        open={assetModalOpen}
        onClose={() => setAssetModalOpen(false)}
      />
      <FundManagerEditModal
        fundManager={detail.fundManager}
        open={managerModalOpen}
        onClose={() => setManagerModalOpen(false)}
      />
      <PrivateSnapshotEditModal
        privateAssetId={detail.asset.id}
        snapshot={selectedSnapshot}
        latestSnapshot={latestSnapshot}
        latestTotalToDateSnapshot={latestTotalToDateSnapshot}
        open={snapshotModalOpen}
        onClose={() => {
          setSnapshotModalOpen(false);
          setSelectedSnapshot(null);
        }}
      />
      <PrivateSubAssetEditModal
        privateAssetId={detail.asset.id}
        subAsset={selectedSubAsset}
        open={subAssetModalOpen}
        onClose={() => {
          setSubAssetModalOpen(false);
          setSelectedSubAsset(null);
        }}
      />
    </>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex h-full min-w-0 flex-col">
      <CardHeader className="min-h-[140px] min-w-0 flex-1 justify-between gap-4">
        <CardDescription className="min-h-[3rem] leading-snug">{label}</CardDescription>
        <CardTitle className="min-w-0 text-[clamp(1.35rem,0.5vw+1rem,1.75rem)] leading-[1.05] tracking-[-0.03em] [overflow-wrap:anywhere]">
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
