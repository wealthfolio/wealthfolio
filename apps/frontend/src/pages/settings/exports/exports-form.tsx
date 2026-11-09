import type { ComponentType } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FileZipIcon } from "@phosphor-icons/react/dist/csr/FileZip";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { DatePickerInput } from "@wealthfolio/ui/components/ui/date-picker-input";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { getDataExportSummary } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { formatDateISO } from "@/lib/utils";
import {
  ExportDataType,
  ExportedFileFormat,
  type ExportDatasetGroup,
  type ExportDatasetSummary,
  type ExportOptions,
} from "@/lib/types";
import { BackupCardHeader, InfoPopover, PendingIcon } from "./backup-ui";
import { useExportData } from "./use-export-data";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const GROUPS: { group: ExportDatasetGroup; datasets: ExportDataType[] }[] = [
  { group: "accounts", datasets: [ExportDataType.ACCOUNTS, ExportDataType.ACTIVITIES] },
  {
    group: "investments",
    datasets: [
      ExportDataType.HOLDINGS,
      ExportDataType.LOTS,
      ExportDataType.REALIZED_GAINS,
      ExportDataType.MANUAL_PRICES,
      ExportDataType.INCOME,
      ExportDataType.INCOME_BY_SOURCE,
    ],
  },
  {
    group: "net-worth",
    datasets: [
      ExportDataType.ASSETS_AND_LIABILITIES,
      ExportDataType.ASSET_VALUATIONS,
      ExportDataType.LOAN_PAYMENTS,
      ExportDataType.NET_WORTH_HISTORY,
      ExportDataType.PORTFOLIO_HISTORY,
    ],
  },
  {
    group: "spending",
    datasets: [
      ExportDataType.BUDGETS,
      ExportDataType.BUDGET_ACTUALS,
      ExportDataType.BUDGET_GROUPS,
      ExportDataType.SPENDING_RULES,
      ExportDataType.SPENDING_EVENTS,
    ],
  },
  { group: "planning", datasets: [ExportDataType.GOALS, ExportDataType.CONTRIBUTION_LIMITS] },
  {
    group: "organization",
    datasets: [
      ExportDataType.PORTFOLIOS,
      ExportDataType.CATEGORIES,
      ExportDataType.CLASSIFICATIONS,
    ],
  },
];

const DATASET_ICONS: Record<ExportDataType, IconComponent> = {
  accounts: Icons.Wallet,
  activities: Icons.Activity,
  holdings: Icons.Holdings,
  lots: Icons.Rows3,
  "realized-gains": Icons.Receipt,
  "manual-prices": Icons.Tag,
  income: Icons.Income,
  "income-by-source": Icons.Coins,
  "assets-and-liabilities": Icons.House,
  "asset-valuations": Icons.History,
  "loan-payments": Icons.Banknote,
  "net-worth-history": Icons.TrendingUp,
  "portfolio-history": Icons.ChartBar,
  budgets: Icons.PiggyBank,
  "budget-actuals": Icons.Target,
  "budget-groups": Icons.Group,
  "spending-rules": Icons.Wand2,
  "spending-events": Icons.CalendarDots,
  goals: Icons.Goal,
  "contribution-limits": Icons.Percent,
  portfolios: Icons.Briefcase,
  categories: Icons.Grid3x3,
  classifications: Icons.PieChart,
};

const DAILY_DATASETS: ExportDataType[] = [
  ExportDataType.NET_WORTH_HISTORY,
  ExportDataType.PORTFOLIO_HISTORY,
];

interface DateOptions {
  startDate?: Date;
  endDate?: Date;
}

function toExportOptions(includeArchived: boolean, dates: DateOptions): ExportOptions {
  return {
    includeArchived,
    startDate: dates.startDate ? formatDateISO(dates.startDate) : undefined,
    endDate: dates.endDate ? formatDateISO(dates.endDate) : undefined,
  };
}

export const ExportForm = () => {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportedFileFormat>(ExportedFileFormat.CSV);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [dates, setDates] = useState<DateOptions>({});
  const { exportData, isExporting, exportingData } = useExportData();

  const datesOutOfOrder = !!dates.startDate && !!dates.endDate && dates.startDate > dates.endDate;
  const options = toExportOptions(includeArchived, dates);
  const summary = useQuery({
    queryKey: [QueryKeys.DATA_EXPORT_SUMMARY, options],
    queryFn: () => getDataExportSummary(options),
    enabled: !datesOutOfOrder,
  });
  const byDataset = new Map<ExportDataType, ExportDatasetSummary>(
    summary.data?.map((item) => [item.dataset, item]),
  );
  const nothingAtAll = summary.isSuccess && summary.data.every((item) => !item.available);
  const hasDates = !!(dates.startDate || dates.endDate);

  const run = (data: ExportDataType | "all") => {
    if (datesOutOfOrder) return;
    void exportData({ format, data, options });
  };

  const datasetMeta = (dataset: ExportDataType): string | null => {
    const item = byDataset.get(dataset);
    if (!item) return null;
    if (!item.available) return t("settings:data_export.none_yet");
    if (item.count !== null) return t("settings:data_export.rows", { count: item.count });
    if (dataset === ExportDataType.HOLDINGS) {
      return t("settings:data_export.holdings_today");
    }
    return DAILY_DATASETS.includes(dataset) ? t("settings:data_export.daily") : null;
  };

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">{t("settings:data_export.intro")}</p>

      <Card className="overflow-hidden">
        <CardHeader className="space-y-4 p-5 sm:p-6">
          <BackupCardHeader
            icon={<FileZipIcon weight="duotone" aria-hidden />}
            title={t("settings:data_export.all_title")}
            info={
              <InfoPopover label={t("settings:data_export.all_info_label")}>
                <p>{t("settings:data_export.intro")}</p>
                <p>{t("settings:data_export.all_info")}</p>
              </InfoPopover>
            }
            subtitle={
              <p className="text-muted-foreground text-sm">
                {t(
                  format === ExportedFileFormat.CSV
                    ? "settings:data_export.all_description_csv"
                    : "settings:data_export.all_description_json",
                )}
              </p>
            }
            action={
              <Button
                size="sm"
                className="aria-busy:opacity-100 pointer-coarse:h-11"
                disabled={isExporting || datesOutOfOrder || nothingAtAll}
                aria-busy={exportingData === "all"}
                onClick={() => run("all")}
              >
                <PendingIcon
                  pending={exportingData === "all"}
                  icon={<Icons.Download className="size-4" aria-hidden />}
                />
                {t(
                  exportingData === "all"
                    ? "settings:data_export.all_pending"
                    : "settings:data_export.all_button",
                )}
              </Button>
            }
          />
        </CardHeader>
        <CardContent className="space-y-4 border-t p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium" aria-hidden>
                {t("settings:data_export.format_label")}
              </span>
              <AnimatedToggleGroup<ExportedFileFormat>
                aria-label={t("settings:data_export.format_label")}
                value={format}
                onValueChange={setFormat}
                items={[
                  { value: ExportedFileFormat.CSV, label: "CSV" },
                  { value: ExportedFileFormat.JSON, label: "JSON" },
                ]}
                size="xs"
                rounded="md"
                className="bg-muted/30 border"
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="export-include-archived"
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
                aria-describedby="export-include-archived-help"
              />
              <div>
                <Label htmlFor="export-include-archived">
                  {t("settings:data_export.include_archived")}
                </Label>
                <p id="export-include-archived-help" className="text-muted-foreground text-xs">
                  {t("settings:data_export.include_archived_help")}
                </p>
              </div>
            </div>
          </div>

          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground -ms-2 pointer-coarse:min-h-11"
                />
              }
            >
              <Icons.Calendar className="size-4" aria-hidden />
              {t("settings:data_export.dates_title")}
              {hasDates && <span className="bg-primary size-1.5 rounded-full" aria-hidden />}
              <Icons.ChevronDown className="size-4" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("settings:data_export.start_date")}</Label>
                  <DatePickerInput
                    aria-label={t("settings:data_export.start_date")}
                    value={dates.startDate}
                    onChange={(date: Date | undefined) =>
                      setDates((current) => ({ ...current, startDate: date }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("settings:data_export.end_date")}</Label>
                  <DatePickerInput
                    aria-label={t("settings:data_export.end_date")}
                    value={dates.endDate}
                    onChange={(date: Date | undefined) =>
                      setDates((current) => ({ ...current, endDate: date }))
                    }
                  />
                </div>
              </div>
              {datesOutOfOrder && (
                <p role="alert" className="text-destructive text-sm">
                  {t("settings:data_export.date_order_error")}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("settings:data_export.dates_help")}
              </p>
              {hasDates && (
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={() => setDates({})}
                >
                  {t("settings:data_export.clear_dates")}
                </Button>
              )}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="space-y-1 p-5 sm:p-6">
          <h2 className="text-lg leading-6 font-semibold tracking-tight">
            {t("settings:data_export.datasets_title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("settings:data_export.datasets_description")}
          </p>
        </CardHeader>
        <CardContent className="space-y-6 p-5 pt-0 sm:p-6 sm:pt-0">
          {summary.isError && (
            <Alert>
              <Icons.Info aria-hidden />
              <AlertDescription>{t("settings:data_export.summary_error")}</AlertDescription>
            </Alert>
          )}
          {GROUPS.map(({ group, datasets }) => (
            <section key={group} aria-labelledby={`export-group-${group}`} className="space-y-1">
              <h3
                id={`export-group-${group}`}
                className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
              >
                {t(`settings:data_export.groups.${group}`)}
              </h3>
              <ul className="divide-y">
                {datasets.map((dataset) => (
                  <DatasetRow
                    key={dataset}
                    icon={DATASET_ICONS[dataset]}
                    name={t(`settings:data_export.datasets.${dataset}.name`)}
                    description={t(`settings:data_export.datasets.${dataset}.description`)}
                    meta={datasetMeta(dataset)}
                    loading={summary.isPending && !datesOutOfOrder}
                    available={byDataset.get(dataset)?.available ?? summary.isError}
                    pending={exportingData === dataset}
                    disabled={isExporting || datesOutOfOrder}
                    onExport={() => run(dataset)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </CardContent>
      </Card>
    </div>
  );
};

function DatasetRow({
  icon: Icon,
  name,
  description,
  meta,
  loading,
  available,
  pending,
  disabled,
  onExport,
}: {
  icon: IconComponent;
  name: string;
  description: string;
  meta: string | null;
  loading: boolean;
  available: boolean;
  pending: boolean;
  disabled: boolean;
  onExport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="bg-muted text-muted-foreground hidden size-9 shrink-0 items-center justify-center rounded-lg md:flex">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-medium">{name}</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-5">
          {description}
          {meta && (
            <>
              <span aria-hidden> · </span>
              <span className={available ? "text-foreground" : undefined}>{meta}</span>
            </>
          )}
        </p>
      </div>
      {loading ? (
        <Skeleton className="size-9 shrink-0 rounded-md" />
      ) : available ? (
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0 aria-busy:opacity-100 pointer-coarse:size-11"
          aria-label={t(
            pending ? "settings:data_export.downloading" : "settings:data_export.download",
            { name },
          )}
          aria-busy={pending}
          disabled={disabled}
          onClick={onExport}
        >
          <PendingIcon pending={pending} icon={<Icons.Download className="size-4" aria-hidden />} />
        </Button>
      ) : null}
    </li>
  );
}
