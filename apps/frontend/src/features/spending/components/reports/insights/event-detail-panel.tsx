/**
 * Rich, focused panel that renders the currently-selected event:
 *   header  → stat block → takeaway → DAY BY DAY + WHAT DROVE IT →
 *   AFTER rhythm → JUMP TO chips
 *
 * Pure presentation — all derived data comes from `useEventChartData`. The
 * component is consumed by `WhenWhereStage` on both desktop (paired with the
 * timeline card) and phone (paired with the calendar card).
 */
import { useMemo, type FC } from "react";
import { useNavigate } from "react-router-dom";

import {
  Button,
  Icons,
  PrivacyAmount,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { Activity, TaxonomyCategory } from "@/lib/types";
import { cn, formatAmount, parseLocalDate } from "@/lib/utils";

import { useEventDialog } from "../../event-dialog-provider";
import { useEventChartData } from "../../../hooks/use-event-chart-data";
import { useSpendingEvents, useSpendingEventMutations } from "../../../hooks/use-spending-events";
import { buildCashflowUrl } from "../../../lib/navigation";
import type { EventSpendingSummary } from "../../../types/event";
import { getEventColors } from "./event-colors";
import { formatMonthDay } from "./format";
import { CARD_CLASS, LABEL_CLASS, MONTH_LABELS } from "./insights-shared";

export interface EventDetailPanelProps {
  event: EventSpendingSummary;
  events: EventSpendingSummary[];
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  heatmapActivities: Activity[];
  accountTypeById?: Map<string, string>;
  dailySpendByDate?: Map<string, number>;
  onSelect: (id: string) => void;
}

export const EventDetailPanel: FC<EventDetailPanelProps> = ({
  event,
  events,
  taxonomyCategories,
  currency,
  heatmapActivities,
  accountTypeById,
  dailySpendByDate,
  onSelect,
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const isPhone = useIsMobileViewport();
  const chart = useEventChartData(
    event,
    heatmapActivities,
    accountTypeById,
    taxonomyCategories,
    dailySpendByDate,
  );
  const {
    startDate,
    endDate,
    days,
    dailyDuring,
    baseline,
    expected,
    lift,
    dailyDeltaPct,
    categories,
    categoriesTotal,
    dailySeries,
    tagged,
    peak,
    beforeSeries,
    afterSeries,
    beforeAvg,
    afterAvg,
    hangoverPct,
    outOfRange,
  } = chart;

  const tagColor = event.eventTypeColor ?? "var(--event-default)";

  const currentIdx = events.findIndex((e) => e.eventId === event.eventId);
  const canNav = events.length > 1;
  const prevEvent = canNav ? events[(currentIdx - 1 + events.length) % events.length] : null;
  const nextEvent = canNav ? events[(currentIdx + 1) % events.length] : null;

  const caption = useMemo(
    () => buildEventCaption({ days, lift, currency, top: categories, isBalanceHidden }),
    [days, lift, currency, categories, isBalanceHidden],
  );

  const { update } = useSpendingEventMutations();
  const expandWindow = () => {
    if (outOfRange.length === 0) return;
    const all = [...outOfRange, event.startDate.slice(0, 10), event.endDate.slice(0, 10)].sort();
    update.mutate({
      id: event.eventId,
      patch: { startDate: all[0], endDate: all[all.length - 1] },
    });
  };

  const navigate = useNavigate();
  const { openEventDialog } = useEventDialog();
  const { data: allEvents = [] } = useSpendingEvents();
  const fullEvent = useMemo(
    () => allEvents.find((e) => e.id === event.eventId),
    [allEvents, event.eventId],
  );

  const handleEdit = () => {
    if (!fullEvent) return;
    openEventDialog({ event: fullEvent });
  };
  const handleViewTransactions = () => {
    navigate(
      buildCashflowUrl({
        startDate: event.startDate.slice(0, 10),
        endDate: event.endDate.slice(0, 10),
      }),
    );
  };

  return (
    <div className={cn(CARD_CLASS, "font-mono")}>
      {/* HEADER */}
      <div className="mb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: `${tagColor}26`, border: `1.5px solid ${tagColor}` }}
            />
            <div className="text-foreground truncate text-base font-semibold tracking-tight">
              {event.eventName}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous event"
                  className="h-7 w-7"
                  onClick={() => prevEvent && onSelect(prevEvent.eventId)}
                  disabled={!canNav}
                >
                  <Icons.ChevronLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next event"
                  className="h-7 w-7"
                  onClick={() => nextEvent && onSelect(nextEvent.eventId)}
                  disabled={!canNav}
                >
                  <Icons.ChevronRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Edit event"
                  className="h-7 w-7"
                  onClick={handleEdit}
                  disabled={!fullEvent}
                >
                  <Icons.Pencil className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Tag transactions in this period"
                  className="h-7 w-7"
                  onClick={handleViewTransactions}
                >
                  <Icons.Activity className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tag transactions</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="text-muted-foreground/80 mt-1 text-[11px]">
          {formatRange(startDate, endDate)} · {days} day{days === 1 ? "" : "s"} ·{" "}
          {event.transactionCount} transaction{event.transactionCount === 1 ? "" : "s"}
          {event.eventTypeName ? ` · ${event.eventTypeName.toLowerCase()}` : ""}
        </div>
      </div>

      {outOfRange.length > 0 && (
        <div className="bg-warning/10 border-warning/40 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px]">
          <span className="text-foreground/90">
            <span className="font-medium tabular-nums">{outOfRange.length}</span> tagged transaction
            {outOfRange.length === 1 ? "" : "s"} outside event dates
            <span className="text-muted-foreground/80 ml-1 tabular-nums">
              ({formatOutOfRangeDate(outOfRange[0])}
              {outOfRange.length > 1
                ? `–${formatOutOfRangeDate(outOfRange[outOfRange.length - 1])}`
                : ""}
              )
            </span>
          </span>
          <button
            type="button"
            onClick={expandWindow}
            disabled={update.isPending}
            className="text-foreground hover:bg-warning/15 rounded px-2 py-0.5 text-[11px] font-medium underline-offset-2 hover:underline disabled:opacity-50"
          >
            {update.isPending ? "Expanding…" : "Expand event window →"}
          </button>
        </div>
      )}

      {/* STAT BLOCK */}
      <div className="mt-2 grid grid-cols-2 gap-y-3 md:grid-cols-4 md:gap-x-0 md:gap-y-4">
        <StatCell label="EVENT TOTAL">
          <div className="text-foreground text-sm font-semibold tabular-nums tracking-tight md:text-base">
            <PrivacyAmount value={event.totalSpending} currency={currency} />
          </div>
          <div className="text-muted-foreground/80 mt-1 text-[10px]">
            across {event.transactionCount} transactions
          </div>
        </StatCell>
        <StatCell label={isPhone ? "LIFT" : "LIFT VS NORMAL"} divided>
          <div
            className={cn(
              "text-sm font-semibold tabular-nums tracking-tight md:text-base",
              lift >= 0 ? "text-destructive" : "text-success",
            )}
          >
            {lift >= 0 ? "+" : "−"}
            <PrivacyAmount value={Math.abs(lift)} currency={currency} />
          </div>
          <div className="text-muted-foreground/80 mt-1 text-[10px]">
            vs <PrivacyAmount value={Math.max(0, expected)} currency={currency} /> expected
          </div>
        </StatCell>
        <StatCell label={isPhone ? "DAILY" : "DAILY DURING"} divided>
          <div className="text-foreground text-sm font-semibold tabular-nums tracking-tight md:text-base">
            <PrivacyAmount value={dailyDuring} currency={currency} />
          </div>
          <div className="text-muted-foreground/80 mt-1 text-[10px]">
            {baseline > 0
              ? `${dailyDeltaPct >= 0 ? "+" : "−"}${Math.abs(dailyDeltaPct)}% vs ${
                  isBalanceHidden ? "••••" : formatAmount(baseline, currency)
                }`
              : "no baseline available"}
          </div>
        </StatCell>
        <StatCell label="PEAK DAY" divided>
          <div className="text-foreground text-sm font-semibold tabular-nums tracking-tight md:text-base">
            {peak ? <PrivacyAmount value={peak.amount} currency={currency} /> : "—"}
          </div>
          <div className="text-muted-foreground/80 mt-1 text-[10px]">
            {peak ? formatPeakDay(peak.date) : ""}
          </div>
        </StatCell>
      </div>

      {/* TAKEAWAY */}
      <p className="text-foreground/90 mt-6 text-[13px] leading-relaxed">
        <span className="text-primary mr-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
          TAKEAWAY
        </span>
        {caption}
      </p>

      {/* DAY BY DAY · WHAT DROVE IT */}
      <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {/* LEFT: DAY BY DAY */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className={LABEL_CLASS}>DAY BY DAY</div>
            <div className={cn(LABEL_CLASS, "text-right")}>
              {isBalanceHidden
                ? `BASELINE ••••${peak ? " · PEAK ••••" : ""}`
                : isPhone
                  ? `BASELINE ${formatCompactAmount(baseline, currency)}`
                  : peak
                    ? `PEAK ${formatAmount(peak.amount, currency)} · BASELINE ${formatAmount(baseline, currency)}`
                    : `BASELINE ${formatAmount(baseline, currency)}`}
            </div>
          </div>
          <DailyBars
            series={tagged.series}
            inWindow={tagged.inWindow}
            chartStartDate={tagged.chartStartDate}
            chartEndDate={tagged.chartEndDate}
            eventDays={days}
            baseline={baseline}
            currency={currency}
            compact={isPhone}
            isBalanceHidden={isBalanceHidden}
          />
        </div>

        {/* RIGHT: WHAT DROVE IT */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className={LABEL_CLASS}>WHAT DROVE IT</div>
            <div className={cn(LABEL_CLASS, "text-right")}>
              {categories.length} CATEGOR{categories.length === 1 ? "Y" : "IES"}
            </div>
          </div>
          {categories.length > 0 && (
            <>
              <div className="mt-3 flex h-1.5 items-stretch gap-0.5">
                {categories.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-full"
                    title={`${c.name} · ${
                      isBalanceHidden ? "••••" : formatAmount(c.amount, currency)
                    }`}
                    style={{ flex: `${c.amount} 0 0`, background: c.color }}
                  />
                ))}
              </div>
              <div className="mt-2">
                {categories.map((c) => {
                  const pct =
                    categoriesTotal > 0 ? Math.round((c.amount / categoriesTotal) * 1000) / 10 : 0;
                  return (
                    <div
                      key={c.id}
                      className="border-border/30 flex items-center gap-3 border-b py-1.5 last:border-b-0"
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: c.color }}
                      />
                      <span className="text-foreground/90 min-w-0 flex-1 truncate text-[12px]">
                        {c.name}
                      </span>
                      <span className="text-muted-foreground/80 text-[11px] tabular-nums">
                        {pct.toFixed(1)}%
                      </span>
                      <span className="text-foreground/90 text-right text-[12px] font-medium tabular-nums">
                        <PrivacyAmount value={c.amount} currency={currency} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <Hr />

      {/* AFTER */}
      <SubLabel right={isPhone ? `${days}D WINDOW` : `${days}D EVENT WINDOW`}>
        {isPhone ? "AFTER" : "AFTER · DID YOUR RHYTHM RETURN?"}
      </SubLabel>
      <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-3">
        <RhythmCard
          label="7D BEFORE"
          value={beforeAvg}
          currency={currency}
          series={beforeSeries}
          accent="muted"
        />
        <RhythmCard
          label="DURING"
          value={dailyDuring}
          currency={currency}
          series={dailySeries}
          accent="during"
        />
        <RhythmCard
          label="3D AFTER"
          value={afterAvg}
          currency={currency}
          series={afterSeries}
          accent={hangoverPct > 5 ? "warn" : hangoverPct < -5 ? "good" : "muted"}
          hangoverPct={afterSeries.length > 0 ? hangoverPct : undefined}
        />
      </div>

      <Hr />

      {/* JUMP TO */}
      <SubLabel>JUMP TO</SubLabel>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {events.map((ev) => {
          const c = getEventColors(ev);
          const isSel = ev.eventId === event.eventId;
          return (
            <button
              key={ev.eventId}
              type="button"
              onClick={() => onSelect(ev.eventId)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] transition-colors",
                isSel
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
              )}
              style={{
                background: isSel ? c.fill : "transparent",
                borderColor: isSel ? c.stroke : "transparent",
              }}
            >
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: c.fill, border: `1.5px solid ${c.stroke}` }}
              />
              {ev.eventName}
              <span className="text-muted-foreground/80 ml-1">
                · {formatChipDate(parseLocalDate(ev.startDate))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── Subcomponents ───────────────────────────────────────────────────────

function StatCell({
  label,
  divided,
  children,
}: {
  label: string;
  divided?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(divided && "md:border-border/40 md:border-l md:pl-4")}>
      <div className={LABEL_CLASS}>{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function SubLabel({ children, right }: { children: React.ReactNode; right?: string }) {
  return (
    <div className="mt-5 flex items-center justify-between gap-3">
      <div className={LABEL_CLASS}>{children}</div>
      {right ? <div className={cn(LABEL_CLASS, "text-right")}>{right}</div> : null}
    </div>
  );
}

function Hr() {
  return <div className="bg-border/40 my-5 h-px" />;
}

function DailyBars({
  series,
  inWindow,
  chartStartDate,
  chartEndDate,
  eventDays,
  baseline,
  currency,
  compact,
  isBalanceHidden,
}: {
  isBalanceHidden: boolean;
  series: number[];
  inWindow: boolean[];
  chartStartDate: Date;
  chartEndDate: Date;
  eventDays: number;
  baseline: number;
  currency: string;
  compact?: boolean;
}) {
  const max = Math.max(1, baseline, ...series);
  const hasOutOfWindow = inWindow.some((v) => !v);

  return (
    <div className="mt-3">
      <div className={cn("relative flex items-end gap-[3px]", compact ? "h-20" : "h-28")}>
        {baseline > 0 && (
          <div
            className="border-foreground/30 pointer-events-none absolute left-0 right-0 border-t border-dashed"
            style={{ bottom: `${(baseline / max) * 100}%` }}
          />
        )}
        {series.map((v, i) => {
          const isOut = !inWindow[i];
          const boundary = i > 0 && inWindow[i - 1] !== inWindow[i];
          const bar = (
            <div
              key={`bar-${i}`}
              className={cn(
                "min-w-[2px] flex-1 rounded-t-[2px]",
                isOut ? "bg-warning/70" : "bg-success/80",
              )}
              style={{ height: `${(Math.max(v, 0) / max) * 100}%` }}
              title={
                (isBalanceHidden ? "••••" : formatAmount(v, currency)) +
                (isOut ? " · outside event window" : "")
              }
            />
          );
          if (!boundary) return bar;
          return [
            <div
              key={`sep-${i}`}
              className="bg-foreground/40 -my-1 w-px self-stretch"
              aria-hidden
            />,
            bar,
          ];
        })}
      </div>
      <div className="text-muted-foreground/80 mt-2 flex items-center justify-between text-[10px] tracking-wide">
        <span className="tabular-nums">{formatPeakDay(chartStartDate)}</span>
        <span className="text-muted-foreground/60">
          {eventDays} day{eventDays === 1 ? "" : "s"}
          {hasOutOfWindow ? " · incl. outside window" : ""}
        </span>
        <span className="tabular-nums">{formatPeakDay(chartEndDate)}</span>
      </div>
    </div>
  );
}

type RhythmAccent = "muted" | "during" | "warn" | "good";

function RhythmCard({
  label,
  value,
  currency,
  series,
  accent,
  hangoverPct,
}: {
  label: string;
  value: number;
  currency: string;
  series: number[];
  accent: RhythmAccent;
  hangoverPct?: number;
}) {
  const palette = {
    muted: {
      bg: "bg-muted/20",
      border: "border-border/40",
      stroke: "var(--muted-foreground)",
      fill: null as string | null,
    },
    during: {
      bg: "bg-success/10",
      border: "border-success/30",
      stroke: "var(--success)",
      fill: "var(--success)",
    },
    warn: {
      bg: "bg-destructive/10",
      border: "border-destructive/30",
      stroke: "var(--destructive)",
      fill: null as string | null,
    },
    good: {
      bg: "bg-success/10",
      border: "border-success/30",
      stroke: "var(--success)",
      fill: null as string | null,
    },
  }[accent];

  return (
    <div className={cn("rounded-md border px-3 py-2", palette.bg, palette.border)}>
      <div className="flex items-baseline justify-between gap-2">
        <div className={LABEL_CLASS}>{label}</div>
        {typeof hangoverPct === "number" && Math.abs(hangoverPct) > 5 && (
          <span
            className={cn(
              "rounded-sm px-1 py-0.5 text-[9px] tracking-wider",
              hangoverPct > 0 ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
            )}
          >
            {hangoverPct > 0 ? `HANGOVER +${hangoverPct}%` : `UNDER ${Math.abs(hangoverPct)}%`}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-foreground text-[13px] font-medium tabular-nums">
          {series.length === 0 ? (
            "—"
          ) : (
            <>
              <PrivacyAmount value={value} currency={currency} />
              <span className="text-muted-foreground/70 font-normal">/d</span>
            </>
          )}
        </span>
        {series.length > 0 && (
          <Sparkline data={series} stroke={palette.stroke} fill={palette.fill} />
        )}
      </div>
    </div>
  );
}

function Sparkline({
  data,
  stroke,
  fill,
}: {
  data: number[];
  stroke: string;
  fill: string | null;
}) {
  const w = 80;
  const h = 22;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} className="shrink-0">
      {fill && <path d={area} fill={fill} opacity={0.25} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}

// ─── Formatters / text builders ──────────────────────────────────────────

function formatPeakDay(d: Date): string {
  const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return `${dayNames[d.getDay()]}, ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}

function formatChipDate(d: Date): string {
  return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}

function buildEventCaption({
  days,
  lift,
  currency,
  top,
  isBalanceHidden,
}: {
  days: number;
  lift: number;
  currency: string;
  top: readonly { readonly name: string }[];
  isBalanceHidden: boolean;
}): string {
  const amt = (v: number) => (isBalanceHidden ? "••••" : formatAmount(v, currency));
  if (top.length === 0) {
    return lift > 0
      ? `Lift vs your normal week: +${amt(lift)} over ${days} days.`
      : `In line with your normal week.`;
  }
  if (lift > 0 && days <= 4) {
    if (top.length === 1) {
      return `One-off — ${top[0].name} drove the spike.`;
    }
    return `One-off — ${top[0].name} and ${top[1].name} drove the spike.`;
  }
  if (Math.abs(lift) < 50) {
    return `Mostly ${top[0].name.toLowerCase()} — modest lift over a normal stretch.`;
  }
  return `Lift vs your normal week: ${lift >= 0 ? "+" : "−"}${amt(Math.abs(lift))} over ${days} days.`;
}

function formatRange(start: Date, end: Date): string {
  const sameMonth =
    start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  return sameMonth
    ? `${formatMonthDay(start)}–${end.getDate()}`.toUpperCase()
    : `${formatMonthDay(start)} – ${formatMonthDay(end)}`.toUpperCase();
}

/** "2026-05-08" → "May 8" (parsed at noon to avoid UTC drift). */
function formatOutOfRangeDate(dateKey: string): string {
  return formatMonthDay(new Date(`${dateKey.slice(0, 10)}T12:00:00`));
}
