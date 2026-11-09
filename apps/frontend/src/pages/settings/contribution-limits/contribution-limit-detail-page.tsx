import { searchActivities } from "@/adapters";
import { ProgressBar } from "@/features/goals/components/goal-card";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { ActivityForm, type AccountSelectOption } from "@/pages/activity/components/activity-form";
import { MobileActivityForm } from "@/pages/activity/components/mobile-forms/mobile-activity-form";
import { useActivityActionDialogs } from "@/pages/activity/hooks/use-activity-action-dialogs";
import { useAccounts } from "@/hooks/use-accounts";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { cn } from "@/lib/utils";
import type { ContributionActivityDetail } from "@/lib/types";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Icons,
  PrivacyAmount,
  Skeleton,
  Switch,
  useDateFormatting,
  useNumberFormatting,
  buttonVariants,
} from "@wealthfolio/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { SettingsHeader } from "../settings-header";
import { ContributionLimitEditModal } from "./components/contribution-limit-edit-modal";
import { parseAccountIds } from "./contribution-limit-accounts";
import { hasFormerDefaultDates } from "./contribution-limit-dates";
import {
  useContributionActivityExclusion,
  useContributionLimitDetails,
} from "./use-contribution-limit-details";

export function ContributionLimitDetailPage() {
  const { limitId = "" } = useParams();
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const numbers = useNumberFormatting();
  const { accounts, isLoading: accountsLoading } = useAccounts({ filterActive: false });
  const { data, isLoading, isError, refetch } = useContributionLimitDetails(limitId);
  const exclusion = useContributionActivityExclusion(limitId);
  const [editing, setEditing] = useState(false);
  const isMobile = useIsMobileViewport();
  const activityDialogs = useActivityActionDialogs();
  const [openingActivityId, setOpeningActivityId] = useState<string | null>(null);
  const activityFormAccounts: AccountSelectOption[] = accounts
    .filter((account) => !account.isArchived)
    .map((account) => ({
      value: account.id,
      label: account.name,
      currency: account.currency,
      accountType: account.accountType,
      restrictionLevel: getActivityRestrictionLevel(account),
    }));
  // Opens the activity's own edit form, where a transfer can be marked external.
  const editActivity = async (activityId: string) => {
    setOpeningActivityId(activityId);
    try {
      const found = await searchActivities(0, 1, { activityIds: [activityId] }, "");
      const details = found.data[0];
      if (!details) throw new Error("Activity not found");
      await activityDialogs.openForm(details);
    } catch {
      toast({
        description: t("settings:limits_detail.edit_activity_error"),
        variant: "destructive",
      });
    } finally {
      setOpeningActivityId(null);
    }
  };
  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? t("common:account");

  if (isLoading || accountsLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data)
    return (
      <Alert variant="destructive">
        <AlertDescription className="space-y-3">
          <p>{t("settings:limits_detail.load_error")}</p>
          <Button variant="outline" onClick={() => void refetch()}>
            {t("common:retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );

  const { limit, calculation, activities } = data;
  const currency = calculation.baseCurrency;
  const total = Number(calculation.total);
  const cap = limit.limitAmount;
  const over = total > cap;
  const reached = cap > 0 && total === cap;
  const share = cap > 0 ? total / cap : 0;
  const formatDate = hasFormerDefaultDates(limit)
    ? (value: string) => dates.formatCalendarDate(value.slice(0, 10))
    : (value: string) => dates.formatDate(value);
  const period =
    limit.startDate && limit.endDate
      ? `${formatDate(limit.startDate)} – ${formatDate(limit.endDate)}`
      : String(limit.contributionYear);
  const daysLeft = limit.endDate
    ? Math.ceil((new Date(limit.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  // An account deleted since the limit was saved is left out, as on the list card.
  const limitAccountIds = parseAccountIds(limit.accountIds).filter((id) =>
    accounts.some((account) => account.id === id),
  );
  const status = over
    ? { label: t("settings:limits_detail.over"), className: "text-destructive" }
    : reached
      ? { label: t("settings:limits_limit_reached"), className: "text-success" }
      : {
          label: t("settings:limits_detail.used_percent", {
            percent: numbers.formatPercent(share, { digits: 0 }),
          }),
          className: "text-muted-foreground",
        };

  // Rows with a switch first; rows that never count on their own below, with their reason.
  const countedActivities = activities.filter((activity) => activity.canExclude);
  const notCountedActivities = activities.filter((activity) => !activity.canExclude);

  // While a switch saves, it shows the value being saved.
  const counts = (activity: ContributionActivityDetail) =>
    exclusion.isPending && exclusion.variables?.activityId === activity.id
      ? !exclusion.variables.excluded
      : activity.treatment !== "excludedByUser";

  return (
    <div className="space-y-6">
      <Link
        className={buttonVariants({ variant: "ghost", size: "sm" })}
        to="/settings/contribution-limits"
      >
        <Icons.ArrowLeft className="size-4 rtl:rotate-180" />
        {t("settings:limits_detail.back")}
      </Link>
      <SettingsHeader
        heading={limit.groupName}
        text={period}
        showBackOnMobile={false}
        actionsInline
      >
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          {t("common:edit")}
        </Button>
      </SettingsHeader>

      <Card className="overflow-hidden" aria-live="polite">
        <CardContent className="p-0">
          <div className="space-y-4 p-6">
            <div className="text-muted-foreground text-sm">
              {t("settings:limits_detail.counted")}
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <PrivacyAmount
                  className={cn(
                    "text-3xl font-semibold tracking-tight tabular-nums",
                    over && "text-destructive",
                  )}
                  value={total}
                  currency={currency}
                />
                <span className="text-muted-foreground tabular-nums">
                  / <PrivacyAmount value={cap} currency={currency} />
                </span>
              </div>
              <span className={cn("text-sm font-medium", status.className)}>{status.label}</span>
            </div>
            <div
              className="bg-muted overflow-hidden rounded-full"
              role="progressbar"
              aria-label={t("settings:limits_detail.counted")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(share, 1) * 100)}
            >
              <ProgressBar
                progress={share}
                fillClass={over ? "bg-destructive" : reached ? "bg-success" : "bg-primary"}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 divide-y border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <HeroMetric
              label={
                over ? t("settings:limits_detail.over") : t("settings:limits_detail.remaining")
              }
              className={over ? "text-destructive" : undefined}
            >
              <PrivacyAmount value={Math.abs(cap - total)} currency={currency} />
            </HeroMetric>
            <HeroMetric label={t("settings:limits_detail.annual_limit")}>
              <PrivacyAmount value={cap} currency={currency} />
            </HeroMetric>
            <HeroMetric label={t("settings:limits_detail.period_ends")}>
              {limit.endDate ? formatDate(limit.endDate) : String(limit.contributionYear)}
              {daysLeft !== null && daysLeft > 0 && (
                <span className="text-muted-foreground ms-2 text-sm font-normal">
                  {t("settings:limits_days_left", { days: daysLeft })}
                </span>
              )}
            </HeroMetric>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings:limits_form_accounts_label")}</CardTitle>
        </CardHeader>
        <CardContent>
          {limitAccountIds.length ? (
            <ul
              className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
              aria-label={t("settings:limits_form_accounts_label")}
            >
              {limitAccountIds.map((id) => (
                <li
                  key={id}
                  className="bg-muted/40 flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5"
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    <bdi>{accountName(id)}</bdi>
                  </span>
                  <PrivacyAmount
                    className="text-muted-foreground shrink-0 text-sm tabular-nums"
                    value={calculation.byAccount[id]?.convertedAmount ?? 0}
                    currency={currency}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                {t("settings:limits_no_accounts_selected")}
              </p>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t("settings:limits_choose_accounts")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{t("settings:limits_detail.activities")}</CardTitle>
          <CardDescription>{t("settings:limits_detail.activity_unchanged")}</CardDescription>
        </CardHeader>
        <CardContent>
          {activities.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("settings:limits_detail.no_activities")}</EmptyTitle>
                <EmptyDescription>{period}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-6">
              {countedActivities.length > 0 && (
                <ActivityGroup title={t("settings:limits_detail.group_counted")}>
                  {countedActivities.map((activity) => {
                    const activityName = localizeActivityTypeName(t, activity.activityType);
                    const counted = counts(activity);
                    return (
                      <ActivityRow
                        key={activity.id}
                        name={activityName}
                        meta={
                          <>
                            {dates.formatDate(activity.activityInstant)} ·{" "}
                            <bdi>{accountName(activity.accountId)}</bdi>
                          </>
                        }
                        muted={!counted}
                        badge={
                          activity.treatment === "excludedByUser"
                            ? t("settings:limits_detail.treatments.excludedByUser")
                            : undefined
                        }
                        amount={
                          <ActivityAmount
                            activity={activity}
                            className={cn(!counted && "text-muted-foreground line-through")}
                          />
                        }
                        action={
                          <Switch
                            checked={counted}
                            disabled={exclusion.isPending}
                            onCheckedChange={(checked) =>
                              exclusion.mutate({ activityId: activity.id, excluded: !checked })
                            }
                            aria-label={t("settings:limits_detail.count_activity", {
                              activity: `${activityName} · ${dates.formatDate(activity.activityInstant)}`,
                            })}
                          />
                        }
                      />
                    );
                  })}
                </ActivityGroup>
              )}
              {notCountedActivities.length > 0 && (
                <ActivityGroup
                  title={t("settings:limits_detail.group_not_counted")}
                  description={t("settings:limits_detail.group_not_counted_hint")}
                >
                  {notCountedActivities.map((activity) => {
                    const activityName = localizeActivityTypeName(t, activity.activityType);
                    return (
                      <ActivityRow
                        key={activity.id}
                        name={activityName}
                        meta={
                          <>
                            {dates.formatDate(activity.activityInstant)} ·{" "}
                            <bdi>{accountName(activity.accountId)}</bdi>
                          </>
                        }
                        muted
                        badge={t(`settings:limits_detail.treatments.${activity.treatment}`)}
                        amount={
                          <ActivityAmount activity={activity} className="text-muted-foreground" />
                        }
                        // An empty switch column keeps amounts aligned with the group above.
                        action={null}
                        footer={
                          // The edit form has the External toggle for transfers only.
                          activity.treatment === "notExternal" &&
                          activity.activityType === "TRANSFER_IN" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-1"
                              disabled={openingActivityId !== null}
                              onClick={() => void editActivity(activity.id)}
                              aria-label={t("settings:limits_detail.edit_activity_aria", {
                                activity: `${activityName} · ${dates.formatDate(activity.activityInstant)}`,
                              })}
                            >
                              {t("settings:limits_detail.edit_activity")}
                            </Button>
                          ) : null
                        }
                      />
                    );
                  })}
                </ActivityGroup>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <ContributionLimitEditModal limit={limit} open={editing} onClose={() => setEditing(false)} />
      {isMobile ? (
        <MobileActivityForm
          key={activityDialogs.selectedActivity?.id ?? "none"}
          accounts={activityFormAccounts}
          transferAccounts={activityFormAccounts}
          activity={activityDialogs.selectedActivity}
          open={activityDialogs.formOpen}
          onClose={activityDialogs.closeForm}
        />
      ) : (
        <ActivityForm
          accounts={activityFormAccounts}
          transferAccounts={activityFormAccounts}
          activity={activityDialogs.selectedActivity}
          open={activityDialogs.formOpen}
          onClose={activityDialogs.closeForm}
        />
      )}
    </div>
  );
}

function HeroMetric({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 px-6 py-4">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", className)}>{children}</div>
    </div>
  );
}

function ActivityGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-muted-foreground text-sm font-medium">{title}</h3>
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

function ActivityRow({
  name,
  meta,
  muted,
  badge,
  amount,
  action,
  footer,
}: {
  name: string;
  meta: ReactNode;
  muted?: boolean;
  badge?: string;
  amount: ReactNode;
  /** A control in its own column at the row's end, such as a switch. */
  action?: ReactNode;
  /** Shown under the row's details, where a longer label has room. */
  footer?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className={cn("font-medium", muted && "text-muted-foreground")}>{name}</div>
        <div className="text-muted-foreground text-xs">{meta}</div>
        {badge && (
          <Badge className="max-w-full text-start whitespace-normal" variant="secondary">
            {badge}
          </Badge>
        )}
        {footer && <div>{footer}</div>}
      </div>
      <div className="shrink-0 text-end text-sm tabular-nums">{amount}</div>
      {action !== undefined && <div className="flex w-12 shrink-0 justify-end">{action}</div>}
    </li>
  );
}

function ActivityAmount({
  activity,
  className,
}: {
  activity: ContributionActivityDetail;
  className?: string;
}) {
  return (
    <span className={className}>
      {activity.amount == null ? (
        "—"
      ) : (
        <PrivacyAmount value={Number(activity.amount)} currency={activity.currency} />
      )}
    </span>
  );
}
