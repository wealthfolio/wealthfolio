import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import type { Activity } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import { Icons, PrivacyAmount, Skeleton } from "@wealthfolio/ui";

import { getActivitySpendingAmount } from "../lib/constants";
import { useEventSpendingSummaries } from "../hooks/use-spending-events";
import { themeBg, type Palette } from "../lib/theme";
import { CategoryIcon, type CategoryMetaMap } from "./category-chips";
import { useEventDialog } from "./event-dialog-provider";

export function EventsCard({
  activities,
  accountTypeById,
  categoriesMeta,
  eventSummaryEndDate,
  eventSummaryStartDate,
  periodEndDate,
  periodStartDate,
  theme,
}: {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  categoriesMeta: CategoryMetaMap;
  eventSummaryEndDate: string;
  eventSummaryStartDate: string;
  periodEndDate: string;
  periodStartDate: string;
  theme: Palette;
}) {
  const { t } = useTranslation();
  const eventSummaryRequest = useMemo(
    () => ({ startDate: eventSummaryStartDate, endDate: eventSummaryEndDate }),
    [eventSummaryEndDate, eventSummaryStartDate],
  );
  const {
    data: eventSummaries = [],
    isLoading: eventSummariesLoading,
    isError: eventSummariesErrored,
    refetch: refetchEventSummaries,
  } = useEventSpendingSummaries(eventSummaryRequest);
  const { openEventDialog } = useEventDialog();

  const pick = useMemo(() => {
    const todayKey = formatDateISO(new Date());
    const periodStartKey = periodStartDate.slice(0, 10);
    const periodEndKey = periodEndDate.slice(0, 10);
    const periodEvents = eventSummaries.filter(
      (e) => e.startDate.slice(0, 10) <= periodEndKey && e.endDate.slice(0, 10) >= periodStartKey,
    );

    const active = periodEvents.find(
      (e) => e.startDate.slice(0, 10) <= todayKey && e.endDate.slice(0, 10) >= todayKey,
    );
    if (active) return { mode: "active" as const, event: active };

    const upcoming = periodEvents
      .filter((e) => e.startDate.slice(0, 10) > todayKey)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (upcoming.length > 0) {
      const days = daysBetween(todayKey, upcoming[0].startDate.slice(0, 10));
      if (days <= 30) return { mode: "upcoming" as const, event: upcoming[0], days };
    }

    const recent = periodEvents
      .filter((e) => e.endDate.slice(0, 10) < todayKey)
      .sort((a, b) => b.endDate.localeCompare(a.endDate));
    if (recent.length > 0) {
      const days = daysBetween(recent[0].endDate.slice(0, 10), todayKey);
      if (days <= 14) return { mode: "recent" as const, event: recent[0], days };
      return { mode: "period" as const, event: recent[0] };
    }
    return null;
  }, [eventSummaries, periodEndDate, periodStartDate]);

  const ev = pick?.event;
  const start = ev ? new Date(ev.startDate.slice(0, 10) + "T00:00:00") : new Date();
  const end = ev ? new Date(ev.endDate.slice(0, 10) + "T00:00:00") : new Date();
  const totalDays = Math.floor((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;

  const eventSpent = Math.max(0, ev?.totalSpending ?? 0);
  const currency = ev?.currency ?? "USD";

  const topCategories = useMemo(() => {
    const totals = new Map<
      string,
      { name: string; color: string | null; icon: string | null; amount: number }
    >();
    Object.values(ev?.byCategory ?? {}).forEach((category) => {
      const meta = category.categoryId ? categoriesMeta.get(category.categoryId) : undefined;
      const topId = meta?.parentId ?? category.categoryId ?? "__unc__";
      const top = categoriesMeta.get(topId) ?? meta;
      const name = top?.name ?? category.categoryName ?? t("spending:eventsCard.uncategorized");
      const color = top?.color ?? category.color ?? null;
      const icon = meta?.icon ?? top?.icon ?? null;
      const e = totals.get(topId) ?? { name, color, icon, amount: 0 };
      e.amount += category.amount;
      totals.set(topId, e);
    });
    return Array.from(totals.values())
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 2);
  }, [categoriesMeta, ev, t]);

  const baselineDailyAvg = useMemo(() => {
    if (!ev) return 0;
    const evStartIso = ev.startDate.slice(0, 10);
    const evEndIso = ev.endDate.slice(0, 10);
    const baseline = activities.filter((a) => {
      if (getActivitySpendingAmount(a, accountTypeById?.get(a.accountId)) === 0) return false;
      const dateIso = a.activityDate.slice(0, 10);
      return dateIso < evStartIso || dateIso > evEndIso;
    });
    if (baseline.length === 0) return 0;
    const total = Math.max(
      0,
      baseline.reduce(
        (s, a) => s + getActivitySpendingAmount(a, accountTypeById?.get(a.accountId)),
        0,
      ),
    );
    const days = Math.max(1, 90 - totalDays);
    return total / days;
  }, [accountTypeById, activities, ev, totalDays]);

  // Surface query errors instead of silently rendering nothing — mirrors the
  // pattern in spending-insights-page after commit de0d4d89. Without this,
  // a server outage looks identical to "user has no events".
  if (eventSummariesErrored) {
    return (
      <div className="border-border/40 bg-card/70 rounded-xl border p-4 text-center text-xs backdrop-blur-xl md:p-5">
        <div className="text-muted-foreground">{t("spending:events.loadError")}</div>
        <button
          type="button"
          onClick={() => void refetchEventSummaries()}
          className="text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {t("common:retry")}
        </button>
      </div>
    );
  }

  if (eventSummariesLoading) {
    return (
      <div className="border-border/40 bg-card/70 rounded-xl border p-4 backdrop-blur-xl md:p-5">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }

  if (!pick) {
    return (
      <div className="border-border/40 bg-card/70 rounded-xl border p-4 backdrop-blur-xl md:p-5">
        <div className="flex items-center gap-2">
          <Icons.Calendar className="h-4 w-4 shrink-0" style={{ color: theme.deep }} />
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-sm font-semibold">
              {t("spending:eventsCard.title")}
            </div>
            <div className="text-muted-foreground/70 text-[11px]">
              {t("spending:eventsCard.noEventsInPeriod")}
            </div>
          </div>
        </div>

        <div className="text-muted-foreground/80 mt-3 text-xs leading-snug">
          {t("spending:eventsCard.createPrompt")}
        </div>

        <button
          type="button"
          onClick={() => openEventDialog()}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {t("spending:events.createEvent")}
          <Icons.ChevronRight className="h-3 w-3" />
        </button>
      </div>
    );
  }

  const dailyAvg = totalDays > 0 ? eventSpent / totalDays : 0;
  const baselineEquivalent = baselineDailyAvg * totalDays;
  const compareMultiple =
    baselineEquivalent > 0 && eventSpent > 0 ? eventSpent / baselineEquivalent : 0;

  const HeaderIcon =
    pick.mode === "upcoming"
      ? Icons.Calendar
      : pick.mode === "recent"
        ? (Icons.History ?? Icons.Calendar)
        : Icons.Calendar;
  const tag =
    pick.mode === "active"
      ? t("spending:eventsCard.tagActive")
      : pick.mode === "upcoming"
        ? t("spending:eventsCard.tagSoon")
        : pick.mode === "recent"
          ? t("spending:eventsCard.tagRecent")
          : t("spending:eventsCard.tagPeriod");

  const dateRangeLabel = (() => {
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    const sameMonth =
      start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const startStr = start.toLocaleDateString(undefined, opts);
    const endStr = sameMonth
      ? end.toLocaleDateString(undefined, { day: "numeric" })
      : end.toLocaleDateString(undefined, opts);
    return `${startStr} — ${endStr}`;
  })();

  let subLine: React.ReactNode = null;
  if (pick.mode === "active") {
    const todayKey = formatDateISO(new Date());
    const today = new Date(todayKey + "T00:00:00");
    const dayInto = Math.floor((today.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;
    const daysLeft = Math.max(0, totalDays - dayInto);
    subLine = t("spending:eventsCard.dayProgress", {
      dayInto,
      totalDays,
      daysLeft: t("spending:eventsCard.daysLeft", { count: daysLeft }),
    });
  } else if (pick.mode === "recent") {
    subLine = t("spending:eventsCard.wrappedAgo", { count: pick.days });
  } else if (pick.mode === "upcoming") {
    subLine = t("spending:eventsCard.untilStart", { count: pick.days });
  } else if (pick.mode === "period") {
    subLine = t("spending:eventsCard.inSelectedPeriod", { count: totalDays });
  }

  return (
    <div className="border-border/40 bg-card/70 rounded-xl border p-4 backdrop-blur-xl md:p-5">
      <div className="flex items-center gap-2">
        <HeaderIcon className="h-4 w-4 shrink-0" style={{ color: theme.deep }} />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-semibold">{ev!.eventName}</div>
          <div className="text-muted-foreground/70 text-[11px]">{dateRangeLabel}</div>
        </div>
        <span
          className="rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
          style={{ backgroundColor: themeBg(theme, 0.2), color: theme.deep }}
        >
          {tag}
        </span>
      </div>

      {pick.mode === "upcoming" && eventSpent <= 0 ? (
        <div className="mt-3">
          <div className="text-foreground text-2xl font-bold tabular-nums tracking-tight">
            {t("spending:eventsCard.daysValue", { count: pick.days })}
          </div>
          <div className="text-muted-foreground/80 text-xs">
            {t("spending:eventsCard.untilPlanned", {
              name: ev!.eventName,
              planned: t("spending:eventsCard.daysPlanned", { count: totalDays }),
            })}
          </div>
        </div>
      ) : eventSpent > 0 ? (
        <>
          <div className="mt-3">
            <div className="text-foreground text-2xl font-bold tabular-nums tracking-tight">
              <PrivacyAmount value={eventSpent} currency={currency} />
            </div>
            <div className="text-muted-foreground/80 text-xs">
              {pick.mode === "recent"
                ? t("spending:eventsCard.total")
                : t("spending:eventsCard.spentSoFar")}{" "}
              · {t("spending:eventsCard.transactionCount", { count: ev!.transactionCount })}
              {subLine && (
                <>
                  {" · "}
                  {subLine}
                </>
              )}
            </div>
          </div>

          <div className="border-border/40 text-muted-foreground/80 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px]">
            <span className="tabular-nums">
              <span className="text-foreground/90 font-semibold">
                <PrivacyAmount value={dailyAvg} currency={currency} />
              </span>{" "}
              {t("spending:eventsCard.perDay")}
            </span>
            {compareMultiple > 0 && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span
                  className={cn(
                    "tabular-nums",
                    compareMultiple >= 1.25
                      ? "text-destructive"
                      : compareMultiple >= 0.85
                        ? "text-muted-foreground/80"
                        : "text-success",
                  )}
                >
                  {compareMultiple >= 1 ? "↑" : "↓"}{" "}
                  {t("spending:eventsCard.vsTypical", {
                    multiple: compareMultiple.toFixed(1),
                    days: totalDays,
                  })}
                </span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/80 mt-3 text-xs">
          {subLine || t("spending:eventsCard.noTaggedYet")}
        </div>
      )}

      {eventSpent > 0 && topCategories.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground/60 text-[10px] font-semibold uppercase tracking-wide">
            {t("spending:eventsCard.top")}
          </span>
          {topCategories.map((c) => {
            const accent = c.color ?? theme.deep;
            return (
              <span
                key={c.name}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums"
                style={{
                  backgroundColor: c.color ? `${c.color}1F` : themeBg(theme, 0.12),
                  color: accent,
                }}
              >
                <CategoryIcon icon={c.icon} fallback={c.name} className="h-3.5 w-3.5" />
                <span className="text-foreground/85">{c.name}</span>
                <span className="opacity-70">
                  <PrivacyAmount value={c.amount} currency={currency} />
                </span>
              </span>
            );
          })}
        </div>
      )}

      {pick.mode === "upcoming" && eventSpent <= 0 ? (
        <button
          type="button"
          onClick={() => {
            const start = new Date();
            start.setDate(start.getDate() + 7);
            openEventDialog({ prefill: { startDate: start, endDate: start } });
          }}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {t("spending:eventsCard.planEvent")}
          <Icons.ChevronRight className="h-3 w-3" />
        </button>
      ) : (
        <Link
          to="/spending/insights?stage=when"
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {pick.mode === "recent"
            ? t("spending:eventsCard.seeBreakdown")
            : t("spending:eventsCard.openEvent")}
          <Icons.ChevronRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00").getTime();
  const b = new Date(bIso + "T00:00:00").getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}
