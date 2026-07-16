import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import {
  Button,
  Icons,
  PrivacyAmount,
  Sheet,
  SheetContent,
  SheetTitle,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Account, Activity } from "@/lib/types";
import { cn, formatDateISO, resolveDisplayTimezone } from "@/lib/utils";

import { isCashActivityOutflow } from "../../lib/constants";
import { createZonedDayHourFormatter } from "../../lib/timezone";

interface HeatmapCellSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filtered activities for the selected weekday + hour bucket. */
  activities: Activity[];
  /** Localized weekday name (e.g. "Mon"). Null while closed. */
  dayLabel: string | null;
  /** Hour-of-day 0..23 of the bucket. Null while closed. */
  hour: number | null;
  /** Exclusive hour-of-day upper bound. Null while closed. */
  endHour: number | null;
  timezone?: string | null;
  currency: string;
}

/**
 * Right-side drawer listing cash activities that fell in a single weekday-hour
 * bucket of the last-12-weeks heatmap. Activities are filtered upstream — this
 * component is purely presentational.
 */
export function HeatmapCellSheet({
  open,
  onOpenChange,
  activities,
  dayLabel,
  hour,
  endHour,
  timezone,
  currency,
}: HeatmapCellSheetProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { accounts = [] } = useAccounts({ filterActive: false });
  const accountById = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  // Header stats: total, count, average, largest single outflow.
  const stats = useMemo(() => {
    let total = 0;
    let largest = 0;
    const outflowAmounts: number[] = [];
    for (const it of activities) {
      const account = accountById.get(it.accountId);
      const amt = parseFloat(it.amount ?? "0");
      if (!Number.isFinite(amt)) continue;
      if (!isCashActivityOutflow(it.activityType, account?.accountType)) continue;
      total += amt;
      if (amt > largest) largest = amt;
      outflowAmounts.push(amt);
    }
    const count = outflowAmounts.length;
    const avg = count > 0 ? total / count : 0;
    // Median used to flag outliers in the list — avoids the mean being dragged
    // by a single huge purchase (e.g. a $3,550 vacation) in a 12-row set.
    const sorted = outflowAmounts.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
    return { total, count, avg, largest, median };
  }, [activities, accountById]);

  // Group by ISO week (Mon-start) so the dense list breaks into legible chunks.
  const grouped = useMemo(() => groupByWeek(activities, timezone, t), [activities, timezone, t]);

  const hourLabel = hour == null ? "" : formatHourRange(hour, endHour);

  // The transactions page filters can't pin to a specific weekday+hour, but we
  // can deep-link to the same 12-week window so the user keeps context.
  const transactionsLink = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 12 * 7);
    const params = new URLSearchParams();
    params.set("tab", "spending");
    params.set("from", formatDateISO(start));
    params.set("to", formatDateISO(end));
    return `/activities?${params.toString()}`;
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
        // SheetContent injects an inline paddingTop (safe-area + 1.5rem) that a
        // className can't override. Zero it here and reapply safe-area inside
        // the header so the gradient runs edge-to-edge from the very top.
        style={{ paddingTop: 0 }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header
          className="border-border/60 relative border-b px-6 pb-5"
          style={{
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)",
            backgroundImage:
              "linear-gradient(to bottom, color-mix(in oklch, var(--heatmap-accent) 25%, transparent) 0%, color-mix(in oklch, var(--heatmap-accent) 10%, transparent) 55%, transparent 100%)",
          }}
        >
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--heatmap-accent)" }}
          >
            {t("spending:heatmapSheet.eyebrow")}
          </div>
          <div className="mt-2 flex items-start gap-3">
            <span
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: "color-mix(in oklch, var(--heatmap-accent) 12%, transparent)",
                color: "var(--heatmap-accent)",
              }}
            >
              <Icons.Calendar className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-foreground text-lg font-semibold tracking-tight">
                {dayLabel ? `${dayLabel} · ${hourLabel}` : t("spending:heatmapSheet.activity")}
              </SheetTitle>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("spending:heatmapSheet.subtitle")}
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-3">
            <Stat
              label={t("spending:heatmapSheet.total")}
              value={isBalanceHidden ? "••••" : formatCompactAmount(stats.total, currency)}
              hint={null}
            />
            <Stat
              label={t("spending:heatmapSheet.tx")}
              value={stats.count.toLocaleString()}
              hint={stats.count === 0 ? t("spending:heatmapSheet.none") : null}
            />
            <Stat
              label={t("spending:heatmapSheet.avgPerTx")}
              value={isBalanceHidden ? "••••" : formatCompactAmount(stats.avg, currency)}
              hint={null}
            />
            <Stat
              label={t("spending:heatmapSheet.largest")}
              value={isBalanceHidden ? "••••" : formatCompactAmount(stats.largest, currency)}
              hint={null}
            />
          </div>
        </header>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activities.length === 0 ? (
            <div className="text-muted-foreground border-border/60 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center text-sm">
              <Icons.Activity className="h-6 w-6 opacity-50" aria-hidden />
              <div>{t("spending:heatmapSheet.noSpending")}</div>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((group) => (
                <section key={group.key}>
                  <header className="mb-2 flex items-baseline justify-between">
                    <h3 className="text-foreground text-xs font-semibold uppercase tracking-wide">
                      {group.label}
                    </h3>
                    <span className="text-muted-foreground/80 text-[11px] tabular-nums">
                      {group.items.length} ·{" "}
                      {isBalanceHidden ? "••••" : formatCompactAmount(group.total, currency)}
                    </span>
                  </header>
                  <ul className="divide-border/40 divide-y">
                    {group.items.map((it) => {
                      const account = accountById.get(it.accountId);
                      const amt = parseFloat(it.amount ?? "0");
                      const safeAmt = Number.isFinite(amt) ? amt : 0;
                      const isOutflow = isCashActivityOutflow(
                        it.activityType,
                        account?.accountType,
                      );
                      const isOutlier =
                        isOutflow && stats.median > 0 && safeAmt >= stats.median * 3;
                      return (
                        <li
                          key={it.id}
                          className="hover:bg-muted/30 flex items-center gap-2.5 px-1 py-2 transition-colors"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-foreground truncate text-[13px] font-medium leading-tight">
                                {it.notes ?? (
                                  <span className="text-muted-foreground italic">
                                    {it.activityType.toLowerCase()}
                                  </span>
                                )}
                              </span>
                              {isOutlier && (
                                <span className="rounded-full bg-amber-100/80 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                                  {t("spending:heatmapSheet.outlier")}
                                </span>
                              )}
                            </div>
                            <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-1 text-[10px] leading-tight">
                              <span className="tabular-nums">
                                {formatZonedTime(it.activityDate, timezone)}
                              </span>
                              <span aria-hidden>·</span>
                              <span>{formatZonedDate(it.activityDate, timezone)}</span>
                              <span aria-hidden>·</span>
                              <span className="truncate">{account?.name ?? it.accountId}</span>
                            </div>
                          </div>
                          <div
                            className={cn(
                              "shrink-0 text-right text-[13px] font-semibold tabular-nums leading-tight",
                              isOutflow ? "text-foreground" : "text-success",
                            )}
                          >
                            {isOutflow ? "−" : "+"}
                            <PrivacyAmount value={safeAmt} currency={it.currency} />
                            {it.currency !== currency && (
                              <span className="text-muted-foreground/70 ml-1 text-[9px] uppercase tracking-wide">
                                {it.currency}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="border-border/60 bg-background/70 border-t px-6 py-3 backdrop-blur">
          <Button asChild size="sm" className="w-full">
            <Link to={transactionsLink} onClick={() => onOpenChange(false)}>
              {t("spending:categorySheet.openInTransactions")}
              <Icons.ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint: string | null;
}) {
  return (
    <div>
      <div className="text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-[0.12em]">
        {label}
      </div>
      <div className="text-foreground mt-1 text-base font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      {hint && <div className="text-muted-foreground/70 mt-0.5 truncate text-[10px]">{hint}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface WeekGroup {
  key: string;
  label: string;
  items: Activity[];
  total: number;
}

/** Bucket activities into Monday-anchored ISO weeks, newest first. */
function groupByWeek(
  activities: Activity[],
  timezone: string | null | undefined,
  t: TFunction,
): WeekGroup[] {
  const byKey = new Map<string, { label: string; items: Activity[] }>();
  const getZonedDayHour = createZonedDayHourFormatter(timezone);
  for (const it of activities) {
    const d = new Date(it.activityDate);
    if (isNaN(d.getTime())) continue;
    const zoned = getZonedDayHour(d);
    if (!zoned) continue;
    const key = mondayKeyForDayKey(zoned.dayKey);
    const entry = byKey.get(key) ?? {
      label: t("spending:heatmapSheet.weekOf", { date: formatDateKeyLabel(key) }),
      items: [],
    };
    entry.items.push(it);
    byKey.set(key, entry);
  }
  const groups: WeekGroup[] = [];
  for (const [key, entry] of byKey) {
    entry.items.sort((a, b) => b.activityDate.localeCompare(a.activityDate));
    const total = entry.items.reduce((s, a) => s + (parseFloat(a.amount ?? "0") || 0), 0);
    groups.push({
      key,
      label: entry.label,
      items: entry.items,
      total,
    });
  }
  groups.sort((a, b) => b.key.localeCompare(a.key));
  return groups;
}

function mondayKeyForDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - weekday);
  return formatUtcDateKey(date);
}

function formatUtcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function formatDateKeyLabel(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day, 12));
}

function formatZonedTime(value: string, timezone?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveDisplayTimezone(timezone),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatZonedDate(value: string, timezone?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveDisplayTimezone(timezone),
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatHourRange(hour: number, endHour: number | null): string {
  const start = formatHour(hour);
  const end = formatHour(endHour ?? hour + 1);
  return `${start} – ${end}`;
}

function formatHour(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  if (h === 24) return "12am";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
