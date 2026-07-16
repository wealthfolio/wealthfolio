import { TickerAvatar } from "@/components/ticker-avatar";
import {
  calculateActivityCashImpact,
  calculateActivityValue,
  isAssetBackedIncomeActivity,
  isCashActivity,
  isCashTransfer,
  isFeeActivity,
  isIncomeActivity,
  isSplitActivity,
} from "@/lib/activity-utils";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { useSettingsContext } from "@/lib/settings-provider";
import type { ActivityDetails } from "@/lib/types";
import { cn, formatDateTime, parseLocalDate } from "@/lib/utils";
import type { CashAuditReviewTarget } from "@/pages/account/cash-audit";
import { Button, Card, EmptyPlaceholder, formatAmount, Icons } from "@wealthfolio/ui";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { buildActivityFilterUrl } from "../utils/activity-links";

type CashAuditFilter = "all" | "cash-impacting" | "possible-missing";

interface ActivityCashLedgerRow {
  activity: ActivityDetails;
  cashImpact: number;
  runningBalance?: number;
  crossesNegative: boolean;
}

interface ActivityDateListProps {
  activities: ActivityDetails[];
  endingCashBalance?: number;
  cashCurrency?: string;
  cashAuditTarget?: CashAuditReviewTarget;
}

export function ActivityDateList({
  activities,
  endingCashBalance,
  cashCurrency,
  cashAuditTarget,
}: ActivityDateListProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;
  const [cashAuditFilter, setCashAuditFilter] = useState<CashAuditFilter>("all");

  const cashLedger = useMemo(
    () => buildCashLedger(activities, endingCashBalance),
    [activities, endingCashBalance],
  );
  const hasCashContext =
    cashLedger.startingCashBalance !== undefined &&
    cashAuditTarget?.hasExplainingActivity !== false;

  const filteredLedgerRows = useMemo(() => {
    if (!hasCashContext) return cashLedger.rows;
    if (cashAuditFilter === "cash-impacting") {
      return cashLedger.rows.filter((row) => row.cashImpact !== 0);
    }
    if (cashAuditFilter === "possible-missing") {
      return cashLedger.rows.filter(
        (row) =>
          row.cashImpact < 0 &&
          (row.crossesNegative || (row.runningBalance !== undefined && row.runningBalance < 0)),
      );
    }
    return cashLedger.rows;
  }, [cashAuditFilter, cashLedger.rows, hasCashContext]);

  if (activities.length === 0) {
    return (
      <div className="space-y-3">
        {cashAuditTarget ? <CashAuditCallout cashAuditTarget={cashAuditTarget} /> : null}
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Activity" />
          <EmptyPlaceholder.Title>{t("activity:date_list.no_activities")}</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            {t("activity:date_list.no_activities_desc")}
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </div>
    );
  }

  const currency =
    cashCurrency ?? activities[0]?.accountCurrency ?? activities[0]?.currency ?? "USD";
  const crossingRow = cashLedger.rows.find((row) => row.crossesNegative);
  const accountId = activities[0]?.accountId;

  return (
    <div className="space-y-3">
      {hasCashContext ? (
        <CashAuditSummary
          startingCashBalance={cashLedger.startingCashBalance}
          endingCashBalance={endingCashBalance}
          totalCashImpact={cashLedger.totalCashImpact}
          currency={currency}
          crossingRow={crossingRow}
          accountId={accountId}
          cashAuditTarget={cashAuditTarget}
        />
      ) : null}

      {hasCashContext ? (
        <div className="flex flex-wrap gap-2">
          <CashAuditFilterButton
            label={t("activity:date_list.filter_all")}
            active={cashAuditFilter === "all"}
            onClick={() => setCashAuditFilter("all")}
          />
          <CashAuditFilterButton
            label={t("activity:date_list.filter_cash_impacting")}
            active={cashAuditFilter === "cash-impacting"}
            onClick={() => setCashAuditFilter("cash-impacting")}
          />
          <CashAuditFilterButton
            label={t("activity:date_list.filter_possible_missing")}
            active={cashAuditFilter === "possible-missing"}
            onClick={() => setCashAuditFilter("possible-missing")}
          />
        </div>
      ) : null}

      {filteredLedgerRows.length === 0 ? (
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Activity" />
          <EmptyPlaceholder.Title>
            {t("activity:date_list.no_matching_activities")}
          </EmptyPlaceholder.Title>
        </EmptyPlaceholder>
      ) : null}

      {filteredLedgerRows.map((row) => (
        <ActivityDateListItem
          key={row.activity.id}
          row={row}
          appTimezone={appTimezone}
          currency={currency}
          showCashLedger={hasCashContext}
        />
      ))}
    </div>
  );
}

interface ActivityDateListItemProps {
  row: ActivityCashLedgerRow;
  appTimezone?: string;
  currency: string;
  showCashLedger: boolean;
}

function ActivityDateListItem({
  row,
  appTimezone,
  currency,
  showCashLedger,
}: ActivityDateListItemProps) {
  const { t } = useTranslation();
  const { activity } = row;
  const symbol = activity.assetSymbol;
  const activityType = activity.activityType;
  const isTransferActivity =
    activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
  const isAssetBackedIncome = isAssetBackedIncomeActivity(activityType, symbol, activity.assetId);
  const isCash = isTransferActivity
    ? isCashTransfer(activityType, symbol, activity.assetId)
    : isCashActivity(activityType) && !isAssetBackedIncome;
  const isOptionActivity = activity.instrumentType === "OPTION";
  const parsedOption = isOptionActivity ? parseOccSymbol(symbol) : null;
  const displaySymbol = isCash
    ? t("activity:date_list.cash")
    : parsedOption
      ? parsedOption.underlying
      : symbol;
  const avatarSymbol = isCash ? "$CASH" : symbol;
  const optionSubtitle = parsedOption
    ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
    : null;
  const formattedDate = formatDateTime(activity.date, appTimezone);
  const displayValue = calculateActivityValue(activity);
  const activityTypeLabel = localizeActivityTypeName(t, activity.activityType);
  const activityTone = getActivityTone(activity.activityType);
  const quantityLabel =
    !isCash &&
    !(isIncomeActivity(activity.activityType) && !isAssetBackedIncome) &&
    !isSplitActivity(activity.activityType) &&
    !isFeeActivity(activity.activityType) &&
    activity.quantity
      ? `${activity.quantity} ${isOptionActivity ? t("activity:date_list.contracts") : t("activity:date_list.shares")}`
      : null;
  const activityFilterUrl = buildActivityFilterUrl(activity);

  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TickerAvatar symbol={avatarSymbol} className="h-10 w-10 flex-shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3">
          <p className="truncate text-base font-semibold leading-5">{displaySymbol}</p>
          {activity.activityType !== ActivityType.SPLIT ? (
            <p className="text-right text-base font-semibold leading-5">
              {formatAmount(displayValue, activity.currency)}
            </p>
          ) : (
            <span />
          )}
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm leading-5">
            <span className={cn("font-semibold", activityTone.text)}>{activityTypeLabel}</span>
            {activity.accountName ? (
              <span className="text-muted-foreground min-w-0 truncate">{activity.accountName}</span>
            ) : null}
            <span className="text-muted-foreground shrink-0">•</span>
            <span className="text-muted-foreground shrink-0">{formattedDate.date}</span>
            {optionSubtitle ? (
              <>
                <span className="text-muted-foreground shrink-0">•</span>
                <span className="text-muted-foreground truncate">{optionSubtitle}</span>
              </>
            ) : null}
          </div>
          {activity.activityType !== ActivityType.SPLIT ? (
            <p className="text-muted-foreground text-right text-sm leading-5">{quantityLabel}</p>
          ) : null}
        </div>
      </div>
      {showCashLedger ? <CashLedgerMeta row={row} currency={currency} /> : null}
    </>
  );

  return (
    <Card
      key={activity.id}
      className={cn("p-0", row.crossesNegative && "border-destructive/40 bg-destructive/5")}
    >
      <Link to={activityFilterUrl} className="block p-4">
        {content}
      </Link>
    </Card>
  );
}

function CashLedgerMeta({ row, currency }: { row: ActivityCashLedgerRow; currency: string }) {
  const { t } = useTranslation();
  const runningBalanceIsNegative = row.runningBalance !== undefined && row.runningBalance < 0;

  return (
    <div className="bg-muted/40 mt-3 grid grid-cols-2 gap-2 rounded-md p-2 text-xs sm:grid-cols-[1fr_1fr_auto]">
      <div>
        <p className="text-muted-foreground">{t("activity:date_list.cash_impact")}</p>
        <p
          className={cn(
            "font-semibold",
            row.cashImpact > 0 && "text-success",
            row.cashImpact < 0 && "text-destructive",
          )}
        >
          {formatSignedAmount(row.cashImpact, currency)}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">{t("activity:date_list.running_cash")}</p>
        <p className={cn("font-semibold", runningBalanceIsNegative && "text-destructive")}>
          {row.runningBalance === undefined ? "—" : formatAmount(row.runningBalance, currency)}
        </p>
      </div>
      {row.crossesNegative ? (
        <div className="text-destructive col-span-2 flex items-center gap-1 font-medium sm:col-span-1 sm:justify-end">
          <Icons.AlertTriangle className="size-3.5" />
          <span>{t("activity:date_list.cash_goes_negative")}</span>
        </div>
      ) : null}
    </div>
  );
}

function CashAuditSummary({
  startingCashBalance,
  endingCashBalance,
  totalCashImpact,
  currency,
  crossingRow,
  accountId,
  cashAuditTarget,
}: {
  startingCashBalance: number | undefined;
  endingCashBalance: number | undefined;
  totalCashImpact: number;
  currency: string;
  crossingRow?: ActivityCashLedgerRow;
  accountId?: string;
  cashAuditTarget?: CashAuditReviewTarget;
}) {
  const { t } = useTranslation();
  const isEndingNegative = endingCashBalance !== undefined && endingCashBalance < 0;
  const redirectTo = accountId ? `/accounts/${encodeURIComponent(accountId)}` : undefined;

  return (
    <Card className={cn("p-3", isEndingNegative && "border-destructive/30 bg-destructive/5")}>
      <div className="space-y-3">
        {cashAuditTarget ? <CashAuditCallout cashAuditTarget={cashAuditTarget} /> : null}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <CashAuditAmount
            label={t("activity:date_list.starting_cash")}
            value={startingCashBalance}
            currency={currency}
          />
          <CashAuditAmount
            label={t("activity:date_list.net_cash_impact")}
            value={totalCashImpact}
            currency={currency}
          />
          <CashAuditAmount
            label={t("activity:date_list.ending_cash")}
            value={endingCashBalance}
            currency={currency}
          />
        </div>
        {crossingRow ? (
          <div className="text-destructive flex items-start gap-2 text-xs">
            <Icons.AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t("activity:date_list.cash_negative_after", {
                type: localizeActivityTypeName(t, crossingRow.activity.activityType),
              })}
            </span>
          </div>
        ) : isEndingNegative ? (
          <div className="text-destructive flex items-start gap-2 text-xs">
            <Icons.AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("activity:date_list.cash_already_negative")}</span>
          </div>
        ) : null}
        {isEndingNegative && accountId ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to={buildActivityManagerUrl(accountId, ActivityType.DEPOSIT, redirectTo)}>
                {t("activity:date_list.add_deposit")}
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to={buildActivityManagerUrl(accountId, ActivityType.TRANSFER_IN, redirectTo)}>
                {t("activity:date_list.add_transfer")}
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function CashAuditCallout({ cashAuditTarget }: { cashAuditTarget: CashAuditReviewTarget }) {
  const { t } = useTranslation();
  const valuationDate = formatAuditDate(cashAuditTarget.valuationDate);
  const activityDate = formatAuditDate(cashAuditTarget.activityDate);

  return (
    <div className="border-warning/10 bg-warning/10 rounded-md border p-3">
      <div className="flex items-start gap-2">
        <Icons.AlertCircle className="text-warning mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium">
            {t("activity:date_list.cash_went_negative_on", { date: valuationDate })}
          </p>
          <p className="text-muted-foreground text-xs">
            {cashAuditTarget.hasExplainingActivity
              ? cashAuditTarget.isCarryForwardDate
                ? t("activity:date_list.carry_forward", { date: activityDate })
                : t("activity:date_list.review_to_identify")
              : t("activity:date_list.no_activity_found")}
          </p>
        </div>
      </div>
    </div>
  );
}

function CashAuditAmount({
  label,
  value,
  currency,
}: {
  label: string;
  value?: number;
  currency: string;
}) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={cn("font-semibold", value !== undefined && value < 0 && "text-destructive")}>
        {value === undefined ? "—" : formatAmount(value, currency)}
      </p>
    </div>
  );
}

function CashAuditFilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant={active ? "default" : "outline"} onClick={onClick}>
      {label}
    </Button>
  );
}

function getActivityTone(type: ActivityType) {
  switch (type) {
    case ActivityType.BUY:
    case ActivityType.DEPOSIT:
    case ActivityType.TRANSFER_IN:
    case ActivityType.DIVIDEND:
    case ActivityType.INTEREST:
      return {
        text: "text-success",
      };
    case ActivityType.SELL:
    case ActivityType.WITHDRAWAL:
    case ActivityType.TRANSFER_OUT:
    case ActivityType.FEE:
    case ActivityType.TAX:
      return {
        text: "text-destructive",
      };
    default:
      return {
        text: "text-muted-foreground",
      };
  }
}

function buildCashLedger(
  activities: ActivityDetails[],
  endingCashBalance?: number,
): {
  rows: ActivityCashLedgerRow[];
  startingCashBalance?: number;
  totalCashImpact: number;
} {
  const sortedActivities = [...activities].sort(compareActivitiesForCashLedger);
  const impacts = sortedActivities.map((activity) => calculateActivityCashImpact(activity));
  const totalCashImpact = impacts.reduce((sum, impact) => sum + impact, 0);
  const startingCashBalance =
    endingCashBalance === undefined ? undefined : endingCashBalance - totalCashImpact;
  let runningBalance = startingCashBalance;

  const rows = sortedActivities.map((activity, index) => {
    const cashImpact = impacts[index] ?? 0;
    const previousBalance = runningBalance;
    runningBalance = runningBalance === undefined ? undefined : runningBalance + cashImpact;

    return {
      activity,
      cashImpact,
      runningBalance,
      crossesNegative:
        previousBalance !== undefined &&
        runningBalance !== undefined &&
        previousBalance >= 0 &&
        runningBalance < 0,
    };
  });

  return {
    rows,
    startingCashBalance,
    totalCashImpact,
  };
}

function compareActivitiesForCashLedger(a: ActivityDetails, b: ActivityDetails) {
  const dateDiff = toTimestamp(a.date) - toTimestamp(b.date);
  if (dateDiff !== 0) return dateDiff;
  const createdDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
  if (createdDiff !== 0) return createdDiff;
  return a.id.localeCompare(b.id);
}

function toTimestamp(value: Date | string | undefined) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatSignedAmount(value: number, currency: string) {
  if (value > 0) return `+${formatAmount(value, currency)}`;
  return formatAmount(value, currency);
}

function buildActivityManagerUrl(
  accountId: string,
  activityType: ActivityType,
  redirectTo?: string,
) {
  const params = new URLSearchParams({
    account: accountId,
    type: activityType,
  });
  if (redirectTo) {
    params.set("redirect-to", redirectTo);
  }
  return `/activities/manage?${params.toString()}`;
}

function formatAuditDate(date: string) {
  try {
    return format(parseLocalDate(date), "MMM d, yyyy");
  } catch {
    return date;
  }
}
