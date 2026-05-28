import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { HistoryChart } from "@/components/history-chart";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatDate } from "@/lib/utils";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@wealthfolio/ui";
import { useMemo } from "react";

interface PrivateSnapshotDto {
  contributedAmount: number;
  currentValue: number;
  distributedAmount: number;
  asOfDate: string;
}

interface PrivateAssetRowDto {
  assetId: string;
  name: string;
  fundManagerName?: string | null;
  strategyType: string;
  vehicleKind: string;
  currency: string;
  status: string;
  freshnessState: string;
  latestSnapshot?: PrivateSnapshotDto | null;
}

interface PrivateAssetDetailDto {
  asset: {
    id: string;
    name: string;
    currency: string;
    vehicleKind: string;
    strategyType: string;
    status: string;
    commitmentAmount?: number | null;
  };
  fundManager?: { name: string } | null;
  latestSnapshot?: PrivateSnapshotDto | null;
  freshnessState: string;
  subAssets: unknown[];
  snapshots: unknown[];
}

interface PrivateAssetTotalsDto {
  totalCurrentValue: number;
  totalContributed: number;
  totalDistributed: number;
  latestAsOfDate?: string | null;
}

interface PrivateAssetHistoryPointDto {
  asOfDate: string;
  totalCurrentValue: number;
}

interface ListPrivateAssetRowsResult {
  rows: PrivateAssetRowDto[];
  count: number;
  truncated?: boolean;
}

interface GetPrivateAssetDetailResult {
  privateAssetId?: string;
  detail?: PrivateAssetDetailDto | null;
}

interface GetPrivateAssetCurrentTotalsResult {
  includeArchived?: boolean;
  totals?: PrivateAssetTotalsDto | null;
}

interface GetPrivateAssetHistoricalSeriesResult {
  includeArchived?: boolean;
  series: PrivateAssetHistoryPointDto[];
  count: number;
}

function parseJson(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unwrapData(value: unknown) {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  const candidate = parsed as Record<string, unknown>;
  if ("data" in candidate && candidate.data && typeof candidate.data === "object") {
    return candidate.data;
  }

  return parsed;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = "—") {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatCurrency(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatEnumLabel(value: string | null | undefined) {
  if (!value) {
    return "—";
  }

  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSnapshot(value: unknown): PrivateSnapshotDto | null {
  const candidate = asObject(value);
  if (!candidate) {
    return null;
  }

  return {
    contributedAmount: asNumber(candidate.contributedAmount ?? candidate.contributed_amount),
    currentValue: asNumber(candidate.currentValue ?? candidate.current_value),
    distributedAmount: asNumber(candidate.distributedAmount ?? candidate.distributed_amount),
    asOfDate: asString(candidate.asOfDate ?? candidate.as_of_date, ""),
  };
}

function normalizeListResult(result: unknown): ListPrivateAssetRowsResult | null {
  const candidate = asObject(unwrapData(result));
  if (!candidate) {
    return null;
  }

  const rows = asArray(candidate.rows).map((row) => {
    const item = asObject(row) ?? {};
    return {
      assetId: asString(item.assetId ?? item.asset_id, ""),
      name: asString(item.name, "Unnamed private asset"),
      fundManagerName: asOptionalString(item.fundManagerName ?? item.fund_manager_name),
      strategyType: asString(item.strategyType ?? item.strategy_type, "OTHER"),
      vehicleKind: asString(item.vehicleKind ?? item.vehicle_kind, "OTHER"),
      currency: asString(item.currency, "USD"),
      status: asString(item.status, "ACTIVE"),
      freshnessState: asString(item.freshnessState ?? item.freshness_state, "MISSING"),
      latestSnapshot: normalizeSnapshot(item.latestSnapshot ?? item.latest_snapshot),
    } satisfies PrivateAssetRowDto;
  });

  return {
    rows,
    count: asNumber(candidate.count, rows.length),
    truncated: candidate.truncated === true,
  };
}

function normalizeDetailResult(result: unknown): GetPrivateAssetDetailResult | null {
  const candidate = asObject(unwrapData(result));
  if (!candidate) {
    return null;
  }

  const detail = asObject(candidate.detail);
  const asset = asObject(detail?.asset);
  if (!detail || !asset) {
    return null;
  }

  return {
    privateAssetId:
      asOptionalString(candidate.privateAssetId ?? candidate.private_asset_id) ?? undefined,
    detail: {
      asset: {
        id: asString(asset.id, ""),
        name: asString(asset.name, "Unnamed private asset"),
        currency: asString(asset.currency, "USD"),
        vehicleKind: asString(asset.vehicleKind ?? asset.vehicle_kind, "OTHER"),
        strategyType: asString(asset.strategyType ?? asset.strategy_type, "OTHER"),
        status: asString(asset.status, "ACTIVE"),
        commitmentAmount:
          (asset.commitmentAmount ?? asset.commitment_amount)
            ? asNumber(asset.commitmentAmount ?? asset.commitment_amount)
            : null,
      },
      fundManager:
        detail.fundManager && typeof detail.fundManager === "object"
          ? {
              name: asString(
                (detail.fundManager as Record<string, unknown>).name,
                "Unknown manager",
              ),
            }
          : null,
      latestSnapshot: normalizeSnapshot(detail.latestSnapshot ?? detail.latest_snapshot),
      freshnessState: asString(detail.freshnessState ?? detail.freshness_state, "MISSING"),
      subAssets: asArray(detail.subAssets ?? detail.sub_assets),
      snapshots: asArray(detail.snapshots),
    },
  };
}

function normalizeTotalsResult(result: unknown): GetPrivateAssetCurrentTotalsResult | null {
  const candidate = asObject(unwrapData(result));
  if (!candidate) {
    return null;
  }

  const totals = asObject(candidate.totals);
  if (!totals) {
    return null;
  }

  return {
    includeArchived: candidate.includeArchived === true || candidate.include_archived === true,
    totals: {
      totalCurrentValue: asNumber(totals.totalCurrentValue ?? totals.total_current_value),
      totalContributed: asNumber(totals.totalContributed ?? totals.total_contributed),
      totalDistributed: asNumber(totals.totalDistributed ?? totals.total_distributed),
      latestAsOfDate: asOptionalString(totals.latestAsOfDate ?? totals.latest_as_of_date),
    },
  };
}

function normalizeHistoryResult(result: unknown): GetPrivateAssetHistoricalSeriesResult | null {
  const candidate = asObject(unwrapData(result));
  if (!candidate) {
    return null;
  }

  const series = asArray(candidate.series).map((point) => {
    const item = asObject(point) ?? {};
    return {
      asOfDate: asString(item.asOfDate ?? item.as_of_date, ""),
      totalCurrentValue: asNumber(item.totalCurrentValue ?? item.total_current_value),
    } satisfies PrivateAssetHistoryPointDto;
  });

  return {
    includeArchived: candidate.includeArchived === true || candidate.include_archived === true,
    series,
    count: asNumber(candidate.count, series.length),
  };
}

function ToolShell({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function PrivateAssetsLoadingCard({ title }: { title: string }) {
  return (
    <ToolShell title={title} description="Loading private-assets data...">
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </ToolShell>
  );
}

export const PrivateAssetRowsToolUI = makeAssistantToolUI<
  Record<string, never>,
  ListPrivateAssetRowsResult
>({
  toolName: "list_private_asset_rows",
  render: (props) => <PrivateAssetRowsContent {...props} />,
});

function PrivateAssetRowsContent({
  result,
  status,
}: ToolCallMessagePartProps<Record<string, never>, ListPrivateAssetRowsResult>) {
  const parsed = useMemo(() => normalizeListResult(result), [result]);

  if (status?.type === "running") {
    return <PrivateAssetsLoadingCard title="Private assets" />;
  }

  if (!parsed || parsed.rows.length === 0) {
    return null;
  }

  return (
    <ToolShell
      title="Private assets"
      description="Current private-asset rows from the private-assets ledger."
      badge={`${parsed.count} rows`}
    >
      <div className="space-y-2">
        {parsed.rows.slice(0, 5).map((row) => (
          <div key={row.assetId} className="bg-background/60 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{row.name}</p>
                <p className="text-muted-foreground text-xs">
                  {formatEnumLabel(row.strategyType)} • {row.fundManagerName ?? "Direct investment"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold">
                  {formatCurrency(row.latestSnapshot?.currentValue ?? null, row.currency)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatEnumLabel(row.freshnessState)}
                </p>
              </div>
            </div>
          </div>
        ))}
        {parsed.truncated ? (
          <p className="text-muted-foreground text-xs">
            Showing the first few rows. Ask for a specific private asset if you want more detail.
          </p>
        ) : null}
      </div>
    </ToolShell>
  );
}

export const PrivateAssetDetailToolUI = makeAssistantToolUI<
  { privateAssetId: string },
  GetPrivateAssetDetailResult
>({
  toolName: "get_private_asset_detail",
  render: (props) => <PrivateAssetDetailContent {...props} />,
});

function PrivateAssetDetailContent({
  result,
  status,
}: ToolCallMessagePartProps<{ privateAssetId: string }, GetPrivateAssetDetailResult>) {
  const parsed = useMemo(() => normalizeDetailResult(result), [result]);

  if (status?.type === "running") {
    return <PrivateAssetsLoadingCard title="Private asset detail" />;
  }

  if (!parsed?.detail) {
    return null;
  }

  const { asset, fundManager, latestSnapshot, freshnessState, snapshots, subAssets } =
    parsed.detail;

  return (
    <ToolShell
      title={asset.name}
      description="Private-asset detail from the dedicated private-assets ledger."
      badge={formatEnumLabel(freshnessState)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          label="Current Value"
          value={formatCurrency(latestSnapshot?.currentValue ?? null, asset.currency)}
        />
        <MetricCard
          label="Latest As-Of"
          value={latestSnapshot?.asOfDate ? formatDate(latestSnapshot.asOfDate) : "—"}
        />
        <MetricCard
          label="Contributed"
          value={formatCurrency(latestSnapshot?.contributedAmount ?? null, asset.currency)}
        />
        <MetricCard
          label="Distributed"
          value={formatCurrency(latestSnapshot?.distributedAmount ?? null, asset.currency)}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Badge variant="secondary">{formatEnumLabel(asset.strategyType)}</Badge>
        <Badge variant="secondary">{formatEnumLabel(asset.vehicleKind)}</Badge>
        <Badge variant="secondary">{fundManager?.name ?? "Direct investment"}</Badge>
        <Badge variant="secondary">{formatEnumLabel(asset.status)}</Badge>
        <Badge variant="secondary">{subAssets.length} sub-assets</Badge>
        <Badge variant="secondary">{snapshots.length} snapshots</Badge>
      </div>
    </ToolShell>
  );
}

export const PrivateAssetTotalsToolUI = makeAssistantToolUI<
  { includeArchived?: boolean },
  GetPrivateAssetCurrentTotalsResult
>({
  toolName: "get_private_asset_current_totals",
  render: (props) => <PrivateAssetTotalsContent {...props} />,
});

function PrivateAssetTotalsContent({
  result,
  status,
}: ToolCallMessagePartProps<{ includeArchived?: boolean }, GetPrivateAssetCurrentTotalsResult>) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const parsed = useMemo(() => normalizeTotalsResult(result), [result]);

  if (status?.type === "running") {
    return <PrivateAssetsLoadingCard title="Private-assets totals" />;
  }

  if (!parsed?.totals) {
    return null;
  }

  const totals = parsed.totals;

  return (
    <ToolShell
      title="Private-assets totals"
      description="Current private-assets totals based on the latest snapshot for each asset."
      badge={parsed.includeArchived ? "Including archived" : "Active only"}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          label="Current Value"
          value={formatCurrency(totals.totalCurrentValue, baseCurrency)}
        />
        <MetricCard
          label="Contributed"
          value={formatCurrency(totals.totalContributed, baseCurrency)}
        />
        <MetricCard
          label="Distributed"
          value={formatCurrency(totals.totalDistributed, baseCurrency)}
        />
        <MetricCard
          label="Latest As-Of"
          value={totals.latestAsOfDate ? formatDate(totals.latestAsOfDate) : "—"}
        />
      </div>
    </ToolShell>
  );
}

export const PrivateAssetHistoryToolUI = makeAssistantToolUI<
  { includeArchived?: boolean },
  GetPrivateAssetHistoricalSeriesResult
>({
  toolName: "get_private_asset_historical_series",
  render: (props) => <PrivateAssetHistoryContent {...props} />,
});

function PrivateAssetHistoryContent({
  result,
  status,
}: ToolCallMessagePartProps<{ includeArchived?: boolean }, GetPrivateAssetHistoricalSeriesResult>) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const parsed = useMemo(() => normalizeHistoryResult(result), [result]);

  if (status?.type === "running") {
    return <PrivateAssetsLoadingCard title="Private-assets history" />;
  }

  if (!parsed || parsed.series.length === 0) {
    return null;
  }

  const chartData = parsed.series.map((point) => ({
    date: point.asOfDate,
    totalValue: point.totalCurrentValue,
    netContribution: 0,
    currency: baseCurrency,
  }));

  return (
    <ToolShell
      title="Private-assets history"
      description="Carry-forward private-assets history based on reported marks."
      badge={parsed.includeArchived ? "Including archived" : "Active only"}
    >
      <div className="bg-background/60 rounded-xl border p-3 shadow-inner">
        <HistoryChart data={chartData} />
      </div>
    </ToolShell>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background/60 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}
