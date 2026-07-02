import { useMemo } from "react";
import { Link } from "react-router-dom";

import { useI18n } from "@/i18n/i18n-provider";
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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
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
      const name = top?.name ?? category.categoryName ?? "Uncategorized";
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
  }, [categoriesMeta, ev]);

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
        <div className="text-muted-foreground">
          {isChinese ? "无法加载事件。" : "Couldn't load events."}
        </div>
        <button
          type="button"
          onClick={() => void refetchEventSummaries()}
          className="text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {isChinese ? "重试" : "Retry"}
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
              {isChinese ? "事件" : "Events"}
            </div>
            <div className="text-muted-foreground/70 text-[11px]">
              {isChinese ? "本期间无事件" : "No events in this period"}
            </div>
          </div>
        </div>

        <div className="text-muted-foreground/80 mt-3 text-xs leading-snug">
          {isChinese
            ? "创建事件，追踪旅行、搬家或一次性期间的支出。"
            : "Create an event to track spending around trips, moves, or one-off periods."}
        </div>

        <button
          type="button"
          onClick={() => openEventDialog()}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {isChinese ? "创建事件" : "Create event"}
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
      ? isChinese
        ? "进行中"
        : "ACTIVE"
      : pick.mode === "upcoming"
        ? isChinese
          ? "即将开始"
          : "SOON"
        : pick.mode === "recent"
          ? isChinese
            ? "最近"
            : "RECENT"
          : isChinese
            ? "期间"
            : "PERIOD";

  const dateRangeLabel = (() => {
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    const sameMonth =
      start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const startStr = start.toLocaleDateString(isChinese ? "zh-CN" : undefined, opts);
    const endStr = sameMonth
      ? end.toLocaleDateString(isChinese ? "zh-CN" : undefined, { day: "numeric" })
      : end.toLocaleDateString(isChinese ? "zh-CN" : undefined, opts);
    return `${startStr} — ${endStr}`;
  })();

  let subLine: React.ReactNode = null;
  if (pick.mode === "active") {
    const todayKey = formatDateISO(new Date());
    const today = new Date(todayKey + "T00:00:00");
    const dayInto = Math.floor((today.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;
    const daysLeft = Math.max(0, totalDays - dayInto);
    subLine = isChinese
      ? `第 ${dayInto} / ${totalDays} 天 · 剩余 ${daysLeft} 天`
      : `Day ${dayInto} of ${totalDays} · ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
  } else if (pick.mode === "recent") {
    subLine = isChinese
      ? `${pick.days} 天前结束`
      : `Wrapped ${pick.days} ${pick.days === 1 ? "day" : "days"} ago`;
  } else if (pick.mode === "upcoming") {
    subLine = isChinese
      ? `还有 ${pick.days} 天开始`
      : `${pick.days} ${pick.days === 1 ? "day" : "days"} until start`;
  } else if (pick.mode === "period") {
    subLine = isChinese
      ? `所选期间 ${totalDays} 天`
      : `${totalDays} ${totalDays === 1 ? "day" : "days"} in selected period`;
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
            {isChinese ? `${pick.days} 天` : `${pick.days} ${pick.days === 1 ? "day" : "days"}`}
          </div>
          <div className="text-muted-foreground/80 text-xs">
            {isChinese
              ? `距离 ${ev!.eventName} · 计划 ${totalDays} 天`
              : `until ${ev!.eventName} · ${totalDays} ${totalDays === 1 ? "day" : "days"} planned`}
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
                ? isChinese
                  ? "合计"
                  : "total"
                : isChinese
                  ? "目前已支出"
                  : "spent so far"}{" "}
              · {ev!.transactionCount}{" "}
              {isChinese ? "笔交易" : ev!.transactionCount === 1 ? "transaction" : "transactions"}
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
              {isChinese ? "/天" : "/ day"}
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
                  {compareMultiple >= 1 ? "↑" : "↓"} {compareMultiple.toFixed(1)}×{" "}
                  {isChinese ? `对比通常 ${totalDays} 天支出` : `vs typical ${totalDays}-day spend`}
                </span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/80 mt-3 text-xs">
          {subLine || (isChinese ? "还没有已标记交易" : "No tagged transactions yet")}
        </div>
      )}

      {eventSpent > 0 && topCategories.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground/60 text-[10px] font-semibold uppercase tracking-wide">
            {isChinese ? "最高" : "Top"}
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
          {isChinese ? "规划事件" : "Plan event"}
          <Icons.ChevronRight className="h-3 w-3" />
        </button>
      ) : (
        <Link
          to="/spending/insights?stage=when"
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {pick.mode === "recent"
            ? isChinese
              ? "查看明细"
              : "See breakdown"
            : isChinese
              ? "打开事件"
              : "Open event"}
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
