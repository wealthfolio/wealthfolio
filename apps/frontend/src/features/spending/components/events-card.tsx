import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { QueryKeys } from "@/lib/query-keys";
import type { Activity } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import { Icons, PrivacyAmount } from "@wealthfolio/ui";

import { getActivityAssignments } from "../adapters/cash-activities";
import { getActivitySpendingAmount } from "../lib/constants";
import { useSpendingEvents } from "../hooks/use-spending-events";
import { themeBg, type Palette } from "../lib/theme";
import { CategoryIcon, type CategoryMetaMap } from "./category-chips";
import { useEventDialog } from "./event-dialog-provider";

const SPENDING_TAXONOMY = "spending_categories";

export function EventsCard({
  activities,
  accountTypeById,
  categoriesMeta,
  theme,
}: {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  categoriesMeta: CategoryMetaMap;
  theme: Palette;
}) {
  const { data: events = [], isError: eventsErrored, refetch: refetchEvents } = useSpendingEvents();
  const { openEventDialog } = useEventDialog();

  const pick = useMemo(() => {
    const todayKey = formatDateISO(new Date());

    const active = events.find(
      (e) => e.startDate.slice(0, 10) <= todayKey && e.endDate.slice(0, 10) >= todayKey,
    );
    if (active) return { mode: "active" as const, event: active };

    const upcoming = events
      .filter((e) => e.startDate.slice(0, 10) > todayKey)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (upcoming.length > 0) {
      const days = daysBetween(todayKey, upcoming[0].startDate.slice(0, 10));
      if (days <= 30) return { mode: "upcoming" as const, event: upcoming[0], days };
    }

    const recent = events
      .filter((e) => e.endDate.slice(0, 10) < todayKey)
      .sort((a, b) => b.endDate.localeCompare(a.endDate));
    if (recent.length > 0) {
      const days = daysBetween(recent[0].endDate.slice(0, 10), todayKey);
      if (days <= 14) return { mode: "recent" as const, event: recent[0], days };
    }
    return null;
  }, [events]);

  // Surface query errors instead of silently rendering nothing — mirrors the
  // pattern in spending-insights-page after commit de0d4d89. Without this,
  // a server outage looks identical to "user has no events".
  if (eventsErrored) {
    return (
      <div className="border-border/60 bg-card/40 rounded-xl border p-4 text-center text-xs backdrop-blur-xl md:p-5">
        <div className="text-muted-foreground">Couldn't load events.</div>
        <button
          type="button"
          onClick={() => void refetchEvents()}
          className="text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const ev = pick?.event;
  const start = ev ? new Date(ev.startDate.slice(0, 10) + "T00:00:00") : new Date();
  const end = ev ? new Date(ev.endDate.slice(0, 10) + "T00:00:00") : new Date();
  const totalDays = Math.floor((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;

  const eventActivities = useMemo(
    () =>
      ev
        ? activities.filter(
            (a) =>
              (a as { eventId?: string | null }).eventId === ev.id &&
              getActivitySpendingAmount(a, accountTypeById?.get(a.accountId)) !== 0,
          )
        : [],
    [accountTypeById, activities, ev],
  );
  const eventSpent = Math.max(
    0,
    eventActivities.reduce(
      (s, a) => s + getActivitySpendingAmount(a, accountTypeById?.get(a.accountId)),
      0,
    ),
  );
  const currency = eventActivities[0]?.currency ?? "USD";

  const assignmentQueries = useQueries({
    queries: eventActivities.map((a) => ({
      queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", a.id],
      queryFn: () => getActivityAssignments(a.id),
      staleTime: 30_000,
    })),
  });

  const topCategories = useMemo(() => {
    const totals = new Map<
      string,
      { name: string; color: string | null; icon: string | null; amount: number }
    >();
    eventActivities.forEach((a, i) => {
      const assignments = assignmentQueries[i]?.data ?? [];
      const spending = assignments.find((x) => x.taxonomyId === SPENDING_TAXONOMY);
      const amount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
      const meta = spending ? categoriesMeta.get(spending.categoryId) : undefined;
      const topId = meta?.parentId ?? spending?.categoryId ?? "__unc__";
      const top = categoriesMeta.get(topId) ?? meta;
      const name = top?.name ?? "Uncategorized";
      const color = top?.color ?? null;
      const icon = meta?.icon ?? top?.icon ?? null;
      const e = totals.get(topId) ?? { name, color, icon, amount: 0 };
      e.amount += amount;
      totals.set(topId, e);
    });
    return Array.from(totals.values())
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 2);
  }, [accountTypeById, eventActivities, assignmentQueries, categoriesMeta]);

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

  if (!pick) return null;

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
  const tag = pick.mode === "active" ? "ACTIVE" : pick.mode === "upcoming" ? "SOON" : "RECENT";

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
    subLine = `Day ${dayInto} of ${totalDays} · ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
  } else if (pick.mode === "recent") {
    subLine = `Wrapped ${pick.days} ${pick.days === 1 ? "day" : "days"} ago`;
  }

  return (
    <div className="border-border/60 bg-card/40 rounded-xl border p-4 backdrop-blur-xl md:p-5">
      <div className="flex items-center gap-2">
        <HeaderIcon className="h-4 w-4 shrink-0" style={{ color: theme.deep }} />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-semibold">{ev!.name}</div>
          <div className="text-muted-foreground/70 text-[11px]">{dateRangeLabel}</div>
        </div>
        <span
          className="rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
          style={{ backgroundColor: themeBg(theme, 0.2), color: theme.deep }}
        >
          {tag}
        </span>
      </div>

      {pick.mode === "upcoming" ? (
        <div className="mt-3">
          <div className="text-foreground text-2xl font-bold tabular-nums tracking-tight">
            {pick.days} {pick.days === 1 ? "day" : "days"}
          </div>
          <div className="text-muted-foreground/80 text-xs">
            until {ev!.name} · {totalDays} {totalDays === 1 ? "day" : "days"} planned
          </div>
        </div>
      ) : eventSpent > 0 ? (
        <>
          <div className="mt-3">
            <div className="text-foreground text-2xl font-bold tabular-nums tracking-tight">
              <PrivacyAmount value={eventSpent} currency={currency} />
            </div>
            <div className="text-muted-foreground/80 text-xs">
              {pick.mode === "recent" ? "total" : "spent so far"} · {eventActivities.length}{" "}
              {eventActivities.length === 1 ? "transaction" : "transactions"}
              {subLine && (
                <>
                  {" · "}
                  {subLine}
                </>
              )}
            </div>
          </div>

          <div className="border-border/40 text-muted-foreground/80 mt-3 flex items-center gap-3 border-t pt-2 text-[11px]">
            <span className="tabular-nums">
              <span className="text-foreground/90 font-semibold">
                <PrivacyAmount value={dailyAvg} currency={currency} />
              </span>{" "}
              / day
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
                  {compareMultiple >= 1 ? "↑" : "↓"} {compareMultiple.toFixed(1)}× vs typical{" "}
                  {totalDays}-day spend
                </span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/80 mt-3 text-xs">
          {subLine || "No tagged transactions yet"}
        </div>
      )}

      {pick.mode !== "upcoming" && topCategories.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground/60 text-[10px] font-semibold uppercase tracking-wide">
            Top
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

      {pick.mode === "upcoming" ? (
        <button
          type="button"
          onClick={() => {
            const start = new Date();
            start.setDate(start.getDate() + 7);
            openEventDialog({ prefill: { startDate: start, endDate: start } });
          }}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          Plan event
          <Icons.ChevronRight className="h-3 w-3" />
        </button>
      ) : (
        <Link
          to="/spending/insights?stage=when"
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {pick.mode === "recent" ? "See breakdown" : "Open event"}
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
