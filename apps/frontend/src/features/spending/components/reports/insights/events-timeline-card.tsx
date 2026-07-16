/**
 * Desktop SVG timeline of events overlaid on a daily-spend area chart, with a
 * 4-cell summary strip below. The mobile alternative is `events-calendar-card`.
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useTranslation } from "react-i18next";

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
import type { Activity } from "@/lib/types";
import { cn, parseLocalDate } from "@/lib/utils";

import { useEventDialog } from "../../event-dialog-provider";
import { useEventsAggregate } from "../../../hooks/use-events-aggregate";
import { getActivitySpendingAmount } from "../../../lib/constants";
import { inclusiveDays } from "../../../lib/date-utils";
import type { EventSpendingSummary } from "../../../types/event";
import { getEventColors } from "./event-colors";
import { CARD_CLASS, LABEL_CLASS, MONTH_LABELS } from "./insights-shared";

export interface EventsTimelineCardProps {
  events: EventSpendingSummary[];
  currency: string;
  rangeStart: Date;
  rangeEnd: Date;
  /** Last 12 weeks of cash activities; used for daily series + normal pace. */
  heatmapActivities: Activity[];
  accountTypeById?: Map<string, string>;
  dailySpendByDate?: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 0 = current window, 1+ = N windows back. */
  windowOffset: number;
  onPrevWindow: () => void;
  onNextWindow: () => void;
}

export const EventsTimelineCard: FC<EventsTimelineCardProps> = ({
  events,
  currency,
  rangeStart,
  rangeEnd,
  heatmapActivities,
  accountTypeById,
  dailySpendByDate,
  selectedId,
  onSelect,
  windowOffset,
  onPrevWindow,
  onNextWindow,
}) => {
  const { t: tr } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { openEventDialog } = useEventDialog();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const node = containerRef.current;
    const update = () => setWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const computed = useEventsAggregate(events, heatmapActivities, accountTypeById, dailySpendByDate);

  const dailySeries = useMemo(
    () =>
      buildDailySeries(
        heatmapActivities,
        events,
        accountTypeById,
        dailySpendByDate,
        rangeStart,
        rangeEnd,
      ),
    [heatmapActivities, events, accountTypeById, dailySpendByDate, rangeStart, rangeEnd],
  );

  const periodDays = Math.max(1, inclusiveDays(rangeStart, rangeEnd));
  const W = Math.max(640, width || 1232);
  const padL = 14;
  const padR = 64;
  const innerW = W - padL - padR;
  const dayW = innerW / periodDays;

  const bandsTop = 48;
  const bandsH = 56;
  const LANE_STRIDE = bandsH + 6;

  // Month markers
  const months = useMemo(() => buildMonthMarkers(rangeStart, rangeEnd), [rangeStart, rangeEnd]);

  // Narrow-event label stacking — adjacent narrow bands stagger label rows.
  const WIDE_THRESHOLD = 50;
  const NARROW_LABEL_W = 110;

  // Wide-band lane assignment — overlapping wide bands stack vertically so
  // labels don't collide. Sorted by start x; each band claims the lowest lane
  // whose previous occupant ended before this one starts.
  const wideLaneByEventId = useMemo(() => {
    const result: Record<string, number> = {};
    const wide = events
      .map((e) => {
        const start = parseLocalDate(e.startDate);
        const end = parseLocalDate(e.endDate);
        const a = Math.max(0, Math.round((start.getTime() - rangeStart.getTime()) / 86_400_000));
        const b = Math.min(
          periodDays - 1,
          Math.round((end.getTime() - rangeStart.getTime()) / 86_400_000),
        );
        const x1 = padL + a * dayW;
        const w = Math.max((b - a + 1) * dayW, 6);
        return { id: e.eventId, x1, x2: x1 + w, wide: w > WIDE_THRESHOLD };
      })
      .filter((it) => it.wide)
      .sort((a, b) => a.x1 - b.x1);
    const laneRights: number[] = [];
    for (const item of wide) {
      let lane = 0;
      while (laneRights[lane] != null && laneRights[lane] > item.x1) lane++;
      laneRights[lane] = item.x2;
      result[item.id] = lane;
    }
    return result;
  }, [events, rangeStart, periodDays, dayW]);

  const wideLaneCount = Math.max(1, ...Object.values(wideLaneByEventId).map((l) => l + 1));
  const bandsAreaH = bandsH + (wideLaneCount - 1) * LANE_STRIDE;
  const chartTop = bandsTop + bandsAreaH + 18;
  const chartH = 96;
  const axisTop = chartTop + chartH;
  const totalH = axisTop + 30;

  // Memoize SVG geometry — rebuilds only when daily series or chart dims change,
  // not on every parent render (selectedId change, etc).
  const { linePath, areaPath, yNormal, todayX, showToday } = useMemo(() => {
    const maxDaily = Math.max(1, ...dailySeries);
    const scaleMax = Math.max(maxDaily * 1.1, computed.normalPace * 2.2);
    const yDaily = (v: number) => chartTop + chartH - (Math.min(v, scaleMax) / scaleMax) * chartH;
    const points = dailySeries.map((v, i) => [padL + (i + 0.5) * dayW, yDaily(v)] as const);
    const linePath = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
    const areaPath = `${linePath} L${padL + innerW},${chartTop + chartH} L${padL},${chartTop + chartH} Z`;
    const today = new Date();
    const todayIdx = Math.round((today.getTime() - rangeStart.getTime()) / 86_400_000);
    return {
      linePath,
      areaPath,
      yNormal: yDaily(computed.normalPace),
      todayX: padL + (todayIdx + 0.5) * dayW,
      showToday: todayIdx >= 0 && todayIdx <= periodDays - 1,
    };
  }, [
    dailySeries,
    computed.normalPace,
    chartTop,
    chartH,
    padL,
    dayW,
    innerW,
    rangeStart,
    periodDays,
  ]);

  const labelRowByEventId = useMemo(() => {
    const result: Record<string, number> = {};
    const rowEnds: number[] = [];
    const indexed = events.map((e) => {
      const start = parseLocalDate(e.startDate);
      const end = parseLocalDate(e.endDate);
      const a = Math.max(0, Math.round((start.getTime() - rangeStart.getTime()) / 86_400_000));
      const b = Math.min(
        periodDays - 1,
        Math.round((end.getTime() - rangeStart.getTime()) / 86_400_000),
      );
      return { e, a, b, x: padL + a * dayW };
    });
    indexed.sort((a, b) => a.x - b.x);
    for (const { e, a, b, x } of indexed) {
      const w = Math.max((b - a + 1) * dayW, 6);
      if (w > WIDE_THRESHOLD) continue;
      const labelStart = x + w / 2 - NARROW_LABEL_W / 2;
      const labelEnd = labelStart + NARROW_LABEL_W;
      let row = 0;
      while (rowEnds[row] != null && rowEnds[row] > labelStart) row++;
      rowEnds[row] = labelEnd;
      result[e.eventId] = row;
    }
    return result;
  }, [events, rangeStart, periodDays, dayW]);

  const selected = events.find((e) => e.eventId === selectedId) ?? events[events.length - 1];
  const biggest = useMemo(
    () => events.slice().sort((a, b) => b.totalSpending - a.totalSpending)[0],
    [events],
  );

  // Legend mirrors the actual event types present in the data — same color
  // source as the bands so the swatches always match what's drawn.
  const usedTypes = useMemo(() => {
    const map = new Map<string, { id: string; name: string; stroke: string; fill: string }>();
    for (const ev of events) {
      if (map.has(ev.eventTypeId)) continue;
      const c = getEventColors(ev);
      map.set(ev.eventTypeId, {
        id: ev.eventTypeId,
        name: ev.eventTypeName ?? tr("spending:eventsCard.title"),
        stroke: c.stroke,
        fill: c.fill,
      });
    }
    return Array.from(map.values());
  }, [events]);

  return (
    <div className={CARD_CLASS} ref={containerRef}>
      {/* HEADER */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-foreground text-base font-semibold tracking-tight">
            {tr("spending:eventsCard.title")}
          </div>
          <div className="text-muted-foreground/80 mt-0.5 text-[11px]">
            {tr("spending:timeline.headerSummary", {
              events: tr("spending:timeline.taggedEvents", { count: events.length }),
              days: computed.totalEventDays,
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {usedTypes.map((t) => (
            <span
              key={t.id}
              className="text-muted-foreground/80 inline-flex items-center gap-1.5 text-[10px] tracking-wider"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ background: t.fill, border: `1.5px solid ${t.stroke}` }}
              />
              {t.name.toUpperCase()}
            </span>
          ))}
          <div className="ml-1 inline-flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={tr("spending:timeline.previousPeriod")}
                  className="h-7 w-7 rounded-full"
                  onClick={onPrevWindow}
                >
                  <Icons.ChevronLeft className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tr("spending:timeline.previousPeriod")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={tr("spending:timeline.nextPeriod")}
                  className="h-7 w-7 rounded-full"
                  onClick={onNextWindow}
                  disabled={windowOffset === 0}
                >
                  <Icons.ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {windowOffset === 0
                  ? tr("spending:timeline.alreadyCurrent")
                  : tr("spending:timeline.nextPeriod")}
              </TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={tr("spending:events.createEvent")}
                className="h-7 w-7 rounded-full"
                onClick={() =>
                  openEventDialog({
                    prefill: { startDate: rangeStart, endDate: rangeEnd },
                    onCreated: (ev) => onSelect(ev.id),
                  })
                }
              >
                <Icons.Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tr("spending:events.createEvent")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* TIMELINE CHART */}
      <div className="relative w-full overflow-x-auto">
        <svg width={W} height={totalH} style={{ display: "block", overflow: "visible" }}>
          {/* Month gridlines + labels */}
          {months.map((m, i) => {
            const x = padL + m.idx * dayW;
            const showYear = m.label === "JAN" || i === 0;
            return (
              <g key={i}>
                <line
                  x1={x}
                  x2={x}
                  y1={20}
                  y2={chartTop + chartH}
                  stroke="currentColor"
                  className="text-foreground/10"
                  strokeDasharray="2 3"
                />
                <text
                  x={x + 6}
                  y={14}
                  className="fill-muted-foreground/80"
                  fontSize={10}
                  letterSpacing={0.5}
                >
                  {m.label}
                  {showYear ? ` ${m.year}` : ""}
                </text>
              </g>
            );
          })}

          {/* Normal-pace baseline */}
          {computed.normalPace > 0 && (
            <>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={yNormal}
                y2={yNormal}
                stroke="currentColor"
                className="text-muted-foreground/60"
                strokeDasharray="3 3"
              />
              <text
                x={padL + innerW + 4}
                y={yNormal + 3}
                fontSize={9}
                className="fill-muted-foreground"
              >
                {isBalanceHidden ? "••••" : formatCompactAmount(computed.normalPace, currency)}/d
              </text>
            </>
          )}

          {/* Daily area */}
          <path d={areaPath} fill="currentColor" className="text-foreground/5" />
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            className="text-muted-foreground/60"
          />

          {/* Highlight event regions on the daily chart */}
          {events.map((ev) => {
            const start = parseLocalDate(ev.startDate);
            const end = parseLocalDate(ev.endDate);
            const a = Math.max(
              0,
              Math.round((start.getTime() - rangeStart.getTime()) / 86_400_000),
            );
            const b = Math.min(
              periodDays - 1,
              Math.round((end.getTime() - rangeStart.getTime()) / 86_400_000),
            );
            if (b < 0 || a > periodDays - 1) return null;
            const x1 = padL + a * dayW;
            const x2 = padL + (b + 1) * dayW;
            const c = getEventColors(ev);
            const isSel = selectedId === ev.eventId;
            return (
              <rect
                key={"hl-" + ev.eventId}
                x={x1}
                y={chartTop - 2}
                width={x2 - x1}
                height={chartH + 4}
                fill={c.fill}
                opacity={isSel ? 0.55 : 0.28}
              />
            );
          })}

          {/* Re-stroke chart line on top of highlights */}
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            className="text-foreground/80"
          />

          {/* Event bands */}
          {events.map((ev) => {
            const start = parseLocalDate(ev.startDate);
            const end = parseLocalDate(ev.endDate);
            const a = Math.max(
              0,
              Math.round((start.getTime() - rangeStart.getTime()) / 86_400_000),
            );
            const b = Math.min(
              periodDays - 1,
              Math.round((end.getTime() - rangeStart.getTime()) / 86_400_000),
            );
            if (b < 0 || a > periodDays - 1) return null;
            const x1 = padL + a * dayW;
            const x2 = padL + (b + 1) * dayW;
            const w = Math.max(x2 - x1, 6);
            const isSel = selectedId === ev.eventId;
            const c = getEventColors(ev);
            const days = Math.max(1, inclusiveDays(start, end));
            const expected = computed.normalPace * days;
            const lift = ev.totalSpending - expected;
            const kindLabel = (ev.eventTypeName ?? "").toUpperCase();
            const labelRowIdx = labelRowByEventId[ev.eventId] ?? 0;
            const labelYOffset = -4 - labelRowIdx * 12;
            const isWide = w > WIDE_THRESHOLD;
            const bandY = isWide
              ? bandsTop + (wideLaneByEventId[ev.eventId] ?? 0) * LANE_STRIDE
              : bandsTop;

            return (
              <g
                key={ev.eventId}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(ev.eventId)}
              >
                <rect
                  x={x1}
                  y={bandY}
                  width={w}
                  height={bandsH - 4}
                  fill={c.fill}
                  stroke={c.stroke}
                  strokeWidth={isSel ? 2 : 1}
                  rx={4}
                  opacity={isSel ? 1 : 0.85}
                />
                <rect
                  x={x1}
                  y={bandY}
                  width={3}
                  height={bandsH - 4}
                  fill={c.stroke}
                  opacity={isSel ? 1 : 0.7}
                />

                {isWide ? (
                  <>
                    <text
                      x={x1 + 8}
                      y={bandY + 16}
                      fontSize={11}
                      className="fill-foreground"
                      fontWeight={isSel ? 700 : 600}
                    >
                      {ev.eventName}
                    </text>
                    <text
                      x={x1 + 8}
                      y={bandY + 32}
                      fontSize={9.5}
                      fontWeight={600}
                      className={lift >= 0 ? "fill-destructive" : "fill-success"}
                    >
                      {lift >= 0 ? "+" : "−"}
                      {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(lift), currency)}
                    </text>
                    <text x={x1 + 8} y={bandY + 46} fontSize={9} className="fill-muted-foreground">
                      {days}D · {kindLabel}
                    </text>
                  </>
                ) : (
                  <g>
                    {labelRowIdx > 0 && (
                      <line
                        x1={x1 + w / 2}
                        x2={x1 + w / 2}
                        y1={bandY}
                        y2={bandY + labelYOffset + 2}
                        stroke={c.stroke}
                        strokeWidth={1}
                        opacity={0.5}
                      />
                    )}
                    <text
                      x={x1 + w / 2}
                      y={bandY + labelYOffset}
                      fontSize={10}
                      fontWeight={isSel ? 700 : 500}
                      textAnchor="middle"
                      className={isSel ? "fill-foreground" : "fill-foreground/80"}
                    >
                      {ev.eventName}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Today marker */}
          {showToday && (
            <>
              <line
                x1={todayX}
                x2={todayX}
                y1={4}
                y2={chartTop + chartH}
                stroke="var(--event-today)"
                strokeWidth={1.5}
              />
              <circle cx={todayX} cy={4} r={3} fill="var(--event-today)" />
              <text x={todayX + 6} y={14} fontSize={9.5} fontWeight={600} fill="var(--event-today)">
                {tr("spending:timeline.today")}
              </text>
            </>
          )}

          {/* Bookend dates */}
          <text x={padL} y={axisTop + 14} fontSize={9.5} className="fill-muted-foreground">
            {formatBookendDate(rangeStart)}
          </text>
          <text
            x={padL + innerW}
            y={axisTop + 14}
            fontSize={9.5}
            textAnchor="end"
            className="fill-muted-foreground"
          >
            {formatBookendDate(rangeEnd)} ·{" "}
            {tr("spending:timeline.daysUpper", { count: periodDays })}
          </text>
          <text
            x={padL + innerW / 2}
            y={axisTop + 14}
            fontSize={9.5}
            textAnchor="middle"
            className="fill-muted-foreground/70"
          >
            {tr("spending:timeline.dailySpend")}
          </text>
        </svg>
      </div>

      {/* Summary strip */}
      <div className="border-border/40 mt-3 grid grid-cols-2 gap-x-0 gap-y-3 border-t pt-3 md:grid-cols-4">
        <SummaryCell label={tr("spending:timeline.acrossEvents", { count: events.length })}>
          <div className="text-foreground text-sm font-semibold tabular-nums tracking-tight">
            <PrivacyAmount value={computed.totalSpent} currency={currency} />
          </div>
          <div className="text-muted-foreground/80 mt-0.5 text-[10px]">
            {tr("spending:timeline.eventDaysOfPeriod", {
              days: computed.totalEventDays,
              pct: Math.round((computed.totalEventDays / periodDays) * 100),
            })}
          </div>
        </SummaryCell>
        <SummaryCell label={tr("spending:timeline.combinedLift")} divided>
          <div
            className={cn(
              "text-sm font-semibold tabular-nums tracking-tight",
              computed.lift >= 0 ? "text-destructive" : "text-success",
            )}
          >
            {computed.lift >= 0 ? "+" : "−"}
            <PrivacyAmount value={Math.abs(computed.lift)} currency={currency} />
          </div>
          <div className="text-muted-foreground/80 mt-0.5 text-[10px]">
            {tr("spending:timeline.onEventDays")}
          </div>
        </SummaryCell>
        {biggest && (
          <SummaryCell label={tr("spending:timeline.biggestEvent")} divided>
            <div className="text-foreground truncate text-sm font-semibold tracking-tight">
              {biggest.eventName}
            </div>
            <div className="text-muted-foreground/80 mt-0.5 text-[10px] tabular-nums">
              <PrivacyAmount value={biggest.totalSpending} currency={currency} />
            </div>
          </SummaryCell>
        )}
        {selected && (
          <SummaryCell label={tr("spending:timeline.selected")} divided>
            <div className="mt-0.5 inline-flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  background: getEventColors(selected).fill,
                  border: `1.5px solid ${getEventColors(selected).stroke}`,
                }}
              />
              <span className="text-foreground truncate text-sm font-semibold tracking-tight">
                {selected.eventName}
              </span>
            </div>
            <div className="text-muted-foreground/80 mt-0.5 text-[10px] tabular-nums">
              {formatSelectedRange(
                parseLocalDate(selected.startDate),
                parseLocalDate(selected.endDate),
              )}{" "}
              ·{" "}
              {inclusiveDays(parseLocalDate(selected.startDate), parseLocalDate(selected.endDate))}D
            </div>
          </SummaryCell>
        )}
      </div>
    </div>
  );
};

function SummaryCell({
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
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Build a per-day spend series across [rangeStart, rangeEnd]. */
function buildDailySeries(
  activities: Activity[],
  events: EventSpendingSummary[],
  accountTypeById: Map<string, string> | undefined,
  dailySpendByDate: Map<string, number> | undefined,
  rangeStart: Date,
  rangeEnd: Date,
): number[] {
  const periodDays = Math.max(1, inclusiveDays(rangeStart, rangeEnd));
  const series = new Array(periodDays).fill(0);
  const startMs = rangeStart.getTime();

  if (dailySpendByDate) {
    for (const [dateKey, amount] of dailySpendByDate) {
      if (amount <= 0) continue;
      const idx = Math.round((new Date(`${dateKey}T12:00:00`).getTime() - startMs) / 86_400_000);
      if (idx >= 0 && idx < periodDays) series[idx] += amount;
    }
  } else {
    for (const a of activities) {
      const amt = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
      if (amt <= 0) continue;
      const idx = Math.round((new Date(a.activityDate).getTime() - startMs) / 86_400_000);
      if (idx >= 0 && idx < periodDays) series[idx] += amt;
    }
  }

  // Overlay event-level dailySpending (covers periods outside the 12-week window).
  for (const ev of events) {
    for (const [dateKey, amount] of Object.entries(ev.dailySpending ?? {})) {
      const day = new Date(`${dateKey}T12:00:00`);
      const idx = Math.round((day.getTime() - startMs) / 86_400_000);
      if (idx >= 0 && idx < periodDays && amount > 0) series[idx] = amount;
    }
  }
  return series;
}

interface MonthMarker {
  idx: number;
  label: string;
  year: number;
}

function buildMonthMarkers(rangeStart: Date, rangeEnd: Date): MonthMarker[] {
  const out: MonthMarker[] = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1, 12, 0, 0, 0);
  while (cursor <= rangeEnd) {
    const idx = Math.round((cursor.getTime() - rangeStart.getTime()) / 86_400_000);
    out.push({ idx, label: MONTH_LABELS[cursor.getMonth()], year: cursor.getFullYear() });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

function formatBookendDate(d: Date): string {
  return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatSelectedRange(start: Date, end: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(start.getMonth() + 1)}/${pad(start.getDate())} – ${pad(end.getMonth() + 1)}/${pad(end.getDate())}`;
}
