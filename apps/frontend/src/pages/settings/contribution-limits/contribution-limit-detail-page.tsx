import { useAccounts } from "@/hooks/use-accounts";
import { useIsCompactTableViewport } from "@/hooks/use-platform";
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
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Icons,
  PrivacyAmount,
  Progress,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useDateFormatting,
  buttonVariants,
} from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { SettingsHeader } from "../settings-header";
import { AccountSelection } from "./components/account-selection";
import { ContributionActivityReview } from "./components/contribution-activity-review";
import { ContributionLimitEditModal } from "./components/contribution-limit-edit-modal";
import { hasFormerDefaultDates } from "./contribution-limit-dates";
import { useContributionLimitDetails } from "./use-contribution-limit-details";

export function ContributionLimitDetailPage() {
  const { limitId = "" } = useParams();
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const { accounts } = useAccounts({ filterActive: false });
  const { data, isLoading, isError, refetch } = useContributionLimitDetails(limitId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const compact = useIsCompactTableViewport();
  const selected = data?.activities.find((activity) => activity.id === selectedId) ?? null;
  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? t("common:account");

  if (isLoading) return <Skeleton className="h-64 w-full" />;
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
  const percentage = cap > 0 ? Math.min((total / cap) * 100, 100) : 0;
  const formatDate = hasFormerDefaultDates(limit)
    ? (value: string) => dates.formatCalendarDate(value.slice(0, 10))
    : (value: string) => dates.formatDate(value);
  const period =
    limit.startDate && limit.endDate
      ? `${formatDate(limit.startDate)} – ${formatDate(limit.endDate)}`
      : String(limit.contributionYear);
  const review = selected && (
    <ContributionActivityReview
      key={`${limitId}:${selected.id}:${selected.treatment}`}
      limitId={limitId}
      activity={selected}
      accountName={accountName(selected.accountId)}
      total={total}
      baseCurrency={currency}
    />
  );
  const summary = [
    { label: t("settings:limits_detail.counted"), value: total },
    { label: t("settings:limits_detail.annual_limit"), value: cap },
    {
      label: over ? t("settings:limits_detail.over") : t("settings:limits_detail.remaining"),
      value: Math.abs(cap - total),
      danger: over,
    },
  ];

  const activityLabel = (activity: ContributionActivityDetail) =>
    t("settings:limits_detail.review_activity", {
      activity: `${localizeActivityTypeName(t, activity.activityType)} · ${dates.formatDate(activity.activityInstant)}`,
    });

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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-live="polite">
        {summary.map(({ label, value, danger }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-normal">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <PrivacyAmount
                className={cn("text-2xl font-semibold tabular-nums", danger && "text-destructive")}
                value={value}
                currency={currency}
              />
            </CardContent>
          </Card>
        ))}
      </div>
      <Progress
        value={percentage}
        aria-label={t("settings:limits_detail.counted")}
        className={over ? "bg-destructive-subtle" : undefined}
      />
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("settings:limits_select_accounts")}
        </summary>
        <div className="pt-4">
          <AccountSelection
            key={`${limit.id}:${limit.accountIds}`}
            limit={limit}
            accounts={accounts}
            deposits={calculation}
            isLoading={false}
          />
        </div>
      </details>
      <div
        className={cn(
          "grid min-w-0 grid-cols-1 gap-5",
          selected && !compact && "lg:grid-cols-[minmax(0,1fr)_18rem]",
        )}
      >
        <section className="min-w-0 space-y-3" aria-label={t("settings:limits_detail.activities")}>
          <h2 className="font-medium">{t("settings:limits_detail.activities")}</h2>
          {activities.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("settings:limits_detail.no_activities")}</EmptyTitle>
                <EmptyDescription>{period}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common:activity")}</TableHead>
                  <TableHead className="text-end">{t("common:amount")}</TableHead>
                  <TableHead>
                    <span className="sr-only">
                      {t("settings:limits_detail.transaction_details")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activities.map((activity) => (
                  <TableRow
                    key={activity.id}
                    data-state={activity.id === selectedId ? "selected" : undefined}
                  >
                    <TableCell className="space-y-1 px-2">
                      <div className="font-medium">
                        {localizeActivityTypeName(t, activity.activityType)}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {dates.formatDate(activity.activityInstant)} ·{" "}
                        <bdi>{accountName(activity.accountId)}</bdi>
                      </div>
                      <Badge
                        className="max-w-full text-start whitespace-normal"
                        variant={activity.treatment === "counted" ? "success-subtle" : "secondary"}
                      >
                        {t(`settings:limits_detail.treatments.${activity.treatment}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-2 text-end tabular-nums">
                      {activity.amount == null ? (
                        "—"
                      ) : (
                        <PrivacyAmount
                          value={Number(activity.amount)}
                          currency={activity.currency}
                        />
                      )}
                    </TableCell>
                    <TableCell className="px-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={activityLabel(activity)}
                        aria-pressed={activity.id === selectedId}
                        onClick={() => setSelectedId(activity.id)}
                      >
                        <Icons.ChevronRight className="size-4 rtl:rotate-180" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
        {selected && !compact && (
          <Card className="self-start" aria-label={t("settings:limits_detail.transaction_details")}>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm">
                {t("settings:limits_detail.transaction_details")}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common:close")}
                onClick={() => setSelectedId(null)}
              >
                <Icons.X className="size-4" />
              </Button>
            </CardHeader>
            <CardContent>{review}</CardContent>
          </Card>
        )}
      </div>
      {selected && compact && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
        >
          <SheetContent side="inline-end" className="overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{t("settings:limits_detail.transaction_details")}</SheetTitle>
            </SheetHeader>
            <div className="p-6">{review}</div>
          </SheetContent>
        </Sheet>
      )}
      <ContributionLimitEditModal limit={limit} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
