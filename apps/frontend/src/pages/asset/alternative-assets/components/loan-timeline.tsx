import { useState } from "react";
import { useTranslation } from "react-i18next";
import { parseISO, startOfYear, subYears } from "date-fns";
import {
  Area,
  AreaChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AmountDisplay,
  AnimatedToggleGroup,
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Icons,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { HistoryChartActiveDot } from "@/components/history-chart-marker";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import type { Quote } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import {
  balanceAt,
  confirmedLoanBalances,
  loanBalanceTimeline,
  loanMarkers,
  loanMilestones,
  loanPeriod,
  type LoanMarker,
} from "../lib/loan-presentation";
import { useLoanToday } from "../hooks/use-loan-calculation";

const LOAN_RANGES = ["YTD", "1Y", "5Y", "ALL"] as const;
type LoanRange = (typeof LOAN_RANGES)[number];

// Events drawn on the line: renewals get an icon badge, extra repayments a plain dot.
const MARKER_TYPES = ["renewal", "extra_repayment"] as const;
type MarkerType = (typeof MARKER_TYPES)[number];
type TimelineMarker = LoanMarker & { type: MarkerType };
const isMarkerType = (type: string): type is MarkerType =>
  (MARKER_TYPES as readonly string[]).includes(type);
const MARKER_STACK_OFFSET = 30;

interface LoanTimelineProps {
  calculation: LoanCalculation | null;
  quotes: Quote[];
  metadata: Record<string, unknown>;
  currency: string;
  balance: number;
  originalAmount: number | null;
  lastConfirmed?: string;
  mortgage?: boolean;
  onConfirmBalance: () => void;
  onEditEvent: (index: number) => void;
  onEditTerms: () => void;
  className?: string;
}

/** Balance card matching the asset and account history cards: headline, chart, range pills. */
export function LoanTimeline({
  calculation,
  quotes,
  metadata,
  currency,
  balance,
  originalAmount,
  lastConfirmed,
  mortgage = false,
  onConfirmBalance,
  onEditEvent,
  onEditTerms,
  className,
}: LoanTimelineProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const formatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();
  const today = useLoanToday();
  const [range, setRange] = useState<LoanRange>("ALL");
  const [focusedEvent, setFocusedEvent] = useState<string | null>(null);
  const milestones = loanMilestones(calculation, metadata, today);
  const dateLabel = (date: string) =>
    dateFormatting.formatCalendarDate(date, { day: "numeric", month: "short", year: "numeric" });

  const points = loanBalanceTimeline(calculation, quotes, today);
  const from =
    range === "ALL"
      ? undefined
      : formatDateISO(
          range === "YTD"
            ? startOfYear(parseISO(today))
            : subYears(parseISO(today), range === "1Y" ? 1 : 5),
        );
  const period = loanPeriod(points, from, today);
  const visible = range === "ALL" ? points : period.points;
  const paidDown =
    range === "ALL" && originalAmount
      ? { amount: originalAmount - balance, percent: (originalAmount - balance) / originalAmount }
      : { amount: period.reduction, percent: period.percent };
  const estimated = !!calculation && lastConfirmed !== today;

  const chart = visible.map((point) => ({
    ...point,
    timestamp: parseISO(point.date).getTime(),
    history: point.date <= today ? point.balance : null,
    forecast: point.date >= today ? point.balance : null,
  }));
  const values = visible.map((point) => point.balance);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = (high - low) * 0.1 || high * 0.01;
  const domain: [number, number] =
    range === "ALL" ? [0, high] : [Math.max(0, low - padding), high + padding];
  const confirmedDates = new Set(
    confirmedLoanBalances(quotes, today).map((quote) => quote.timestamp.slice(0, 10)),
  );
  const isVisible = (date?: string) =>
    !!date && visible.length > 0 && date >= visible[0].date && date <= visible.at(-1)!.date;
  const recorded = loanMarkers(metadata, quotes, today).filter((event): event is TimelineMarker =>
    isMarkerType(event.type),
  );
  const upcomingRenewal =
    milestones.upcomingRenewal &&
    !recorded.some((event) => event.type === "renewal" && event.date === milestones.maturity)
      ? [{ type: "renewal" as const, date: milestones.maturity!, eventIndex: undefined }]
      : [];
  // Events closer than ~3% of the visible span would overlap; stack them upward instead.
  const span =
    visible.length > 1
      ? parseISO(visible.at(-1)!.date).getTime() - parseISO(visible[0].date).getTime()
      : 0;
  let anchor = Number.NEGATIVE_INFINITY;
  let stack = 0;
  const markers = [...recorded, ...upcomingRenewal]
    .filter((event) => isVisible(event.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((event) => {
      const time = parseISO(event.date).getTime();
      stack = time - anchor < span * 0.03 ? stack + 1 : 0;
      if (stack === 0) anchor = time;
      return { ...event, offset: stack * MARKER_STACK_OFFSET };
    });
  const markerName = (event: TimelineMarker) =>
    t(
      event.type === "renewal" && event.date > today
        ? "asset:loanOverview.next_renewal"
        : `asset:loanOverview.event_${event.type}`,
    );
  const markerDetail = (event: TimelineMarker) =>
    event.type === "extra_repayment" && event.amount != null ? (
      <AmountDisplay value={event.amount} currency={currency} />
    ) : event.type === "renewal" && event.annualRate != null ? (
      <>
        {`${formatting.formatDecimal(event.annualRate, { maximumFractionDigits: 2 })}%`}
        {event.paymentAmount != null && (
          <>
            {" · "}
            <AmountDisplay value={event.paymentAmount} currency={currency} />
          </>
        )}
      </>
    ) : null;
  const renderTooltip = (date: string | undefined) => {
    const balanceOnDate = date ? balanceAt(points, date) : null;
    return date && balanceOnDate != null ? (
      <div
        role="tooltip"
        className="bg-popover pointer-events-none grid min-w-44 max-w-64 grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md"
      >
        <p className="text-muted-foreground text-xs">{dateLabel(date)}</p>
        <p className="text-xs font-semibold">
          <AmountDisplay value={balanceOnDate} currency={currency} />
        </p>
        <p className="text-muted-foreground text-xs">
          {t(
            confirmedDates.has(date)
              ? "asset:loanOverview.confirmed_balance"
              : date > today
                ? "asset:loanActions.status_projected"
                : "asset:loanOverview.projected",
          )}
        </p>
        {markers
          .filter((event) => event.date === date)
          .map((event) => (
            <div
              key={`${event.type}-${event.eventIndex ?? "upcoming"}`}
              className="flex items-center gap-1.5 border-t pt-1.5 text-xs"
            >
              <span className="text-success flex size-3.5 shrink-0 items-center justify-center">
                {event.type === "renewal" ? (
                  <Icons.LightningDuotone size={14} />
                ) : (
                  <span className="size-2 rounded-full bg-current" />
                )}
              </span>
              <span>{markerName(event)}</span>
              <span className="ml-auto pl-2 font-medium">{markerDetail(event)}</span>
            </div>
          ))}
      </div>
    ) : null;
  };
  const referenceLabel = (value: string, position: "insideTopLeft" | "insideTopRight") => ({
    value,
    position,
    fontSize: 11,
    fill: "var(--muted-foreground)",
  });
  const title = t(
    mortgage ? "asset:loanOverview.mortgage_timeline" : "asset:loanOverview.timeline",
  );

  return (
    <Card className={cn("flex flex-col", className)} role="region" aria-label={title}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-md">
          <HoverCard>
            <HoverCardTrigger asChild className="cursor-pointer">
              <div>
                <p className="flex items-center gap-2 pt-3 text-xl font-bold">
                  <AmountDisplay value={balance} currency={currency} isHidden={isBalanceHidden} />
                  {estimated && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      {t("asset:loanOverview.projected")}
                    </Badge>
                  )}
                </p>
                <p
                  className={cn(
                    "text-sm font-light",
                    paidDown.amount == null
                      ? "text-muted-foreground"
                      : paidDown.amount >= 0
                        ? "text-success"
                        : "text-destructive",
                  )}
                  data-testid="loan-period-change"
                >
                  {paidDown.amount == null ? (
                    `${t("asset:loanOverview.period_change")} ${t("asset:loanOverview.unavailable")}`
                  ) : (
                    <>
                      {t(
                        paidDown.amount >= 0
                          ? "asset:altContent.paid_down"
                          : "asset:altContent.increased",
                      )}
                      <AmountDisplay
                        value={Math.abs(paidDown.amount)}
                        currency={currency}
                        isHidden={isBalanceHidden}
                      />
                      {paidDown.percent != null &&
                        !isBalanceHidden &&
                        ` (${formatting.formatPercent(Math.abs(paidDown.percent), { digits: 1 })})`}{" "}
                      {t(`ui:interval.${range}`)}
                    </>
                  )}
                </p>
              </div>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-80 shadow-none">
              <div className="flex flex-col space-y-4">
                <div className="space-y-2">
                  <h4 className="flex items-center text-sm font-light">
                    <Icons.Calendar className="mr-2 h-4 w-4" />
                    {t("asset:loanOverview.last_confirmed")}
                    <Badge className="ml-1 font-medium" variant="secondary">
                      {lastConfirmed ? dateLabel(lastConfirmed) : "-"}
                    </Badge>
                  </h4>
                  {estimated && (
                    <p className="text-muted-foreground text-xs">
                      {t("asset:loanOverview.forecast_hint")}
                    </p>
                  )}
                </div>
                <Button
                  onClick={onConfirmBalance}
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                >
                  <Icons.Check className="mr-2 h-4 w-4" />
                  {t("asset:loanActions.confirm_balance")}
                </Button>
              </div>
            </HoverCardContent>
          </HoverCard>
        </CardTitle>
      </CardHeader>
      <CardContent className="relative flex-1 p-0">
        {focusedEvent && !isBalanceHidden && (
          <div className="pointer-events-none absolute right-3 top-2 z-10">
            {renderTooltip(focusedEvent)}
          </div>
        )}
        <div className="h-full min-h-[320px]" data-testid="loan-timeline-chart">
          {isBalanceHidden ? (
            <div className="text-muted-foreground flex h-full min-h-[320px] items-center justify-center">
              ••••
            </div>
          ) : chart.length ? (
            <ResponsiveContainer width="100%" height="100%" minHeight={320}>
              <AreaChart
                data={chart}
                margin={{ top: 24, right: 0, left: 0, bottom: 48 }}
                accessibilityLayer
              >
                <defs>
                  <linearGradient id="loanHistoryFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.2} />
                    <stop offset="70%" stopColor="var(--success)" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="loanForecastFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis hide type="number" dataKey="timestamp" domain={["dataMin", "dataMax"]} />
                <YAxis hide type="number" domain={domain} />
                <ChartTooltip
                  active={focusedEvent ? false : undefined}
                  cursor={{ stroke: "var(--border)", strokeWidth: 1, pointerEvents: "none" }}
                  content={({ active, label }) =>
                    active && !focusedEvent
                      ? renderTooltip(chart.find((point) => point.timestamp === label)?.date)
                      : null
                  }
                />
                <Area
                  type="linear"
                  dataKey="history"
                  stroke="var(--success)"
                  strokeWidth={1.5}
                  fill="url(#loanHistoryFill)"
                  fillOpacity={1}
                  activeDot={(props: { cx?: number; cy?: number }) => (
                    <HistoryChartActiveDot {...props} />
                  )}
                  isAnimationActive={false}
                />
                <Area
                  type="linear"
                  dataKey="forecast"
                  stroke="var(--success)"
                  strokeOpacity={0.6}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  fill="url(#loanForecastFill)"
                  fillOpacity={1}
                  activeDot={(props: { cx?: number; cy?: number }) => (
                    <HistoryChartActiveDot {...props} />
                  )}
                  isAnimationActive={false}
                />
                {range === "ALL" && calculation && isVisible(today) && (
                  <ReferenceLine
                    x={parseISO(today).getTime()}
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                    label={referenceLabel(t("asset:loanOverview.today"), "insideTopRight")}
                  />
                )}
                {isVisible(milestones.maturity) && (
                  <ReferenceLine
                    x={parseISO(milestones.maturity!).getTime()}
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                    label={referenceLabel(t("asset:loanOverview.renewal"), "insideTopLeft")}
                  />
                )}
                {range === "ALL" && isVisible(milestones.payoff) && (
                  <ReferenceLine
                    x={parseISO(milestones.payoff!).getTime()}
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                    label={referenceLabel(
                      t("asset:loanOverview.estimated_payoff"),
                      "insideTopRight",
                    )}
                  />
                )}
                {markers.map((event) => (
                  <ReferenceDot
                    key={`${event.type}-${event.date}-${event.eventIndex ?? "upcoming"}`}
                    x={parseISO(event.date).getTime()}
                    y={balanceAt(points, event.date) ?? 0}
                    shape={
                      <LoanEventMarker
                        type={event.type}
                        upcoming={event.date > today}
                        offset={event.offset}
                        label={`${markerName(event)}, ${dateLabel(event.date)}`}
                        onFocus={() => setFocusedEvent(event.date)}
                        onBlur={() =>
                          setFocusedEvent((current) => (current === event.date ? null : current))
                        }
                        onEdit={() => {
                          setFocusedEvent(null);
                          if (event.eventIndex != null) onEditEvent(event.eventIndex);
                          else onEditTerms();
                        }}
                      />
                    }
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-muted-foreground flex h-full min-h-[320px] items-center justify-center text-sm">
              {t("asset:altContent.no_valuation_data")}
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute bottom-2 left-0 right-0 flex justify-center">
          <AnimatedToggleGroup
            items={LOAN_RANGES.map((code) => ({
              value: code,
              label: t(`ui:interval.label.${code}`, code),
              title: t(`ui:interval.${code}`),
            }))}
            value={range}
            onValueChange={setRange}
            size="sm"
            variant="default"
            className="pointer-events-auto bg-transparent"
            aria-label={t("asset:loanOverview.history_period")}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface LoanEventMarkerProps {
  cx?: number;
  cy?: number;
  type: MarkerType;
  upcoming: boolean;
  offset: number;
  label: string;
  onFocus: () => void;
  onBlur: () => void;
  onEdit: () => void;
}
function LoanEventMarker({
  cx = 0,
  cy = 0,
  type,
  upcoming,
  offset,
  label,
  onFocus,
  onBlur,
  onEdit,
}: LoanEventMarkerProps) {
  const renewal = type === "renewal";
  const markerY = Math.max(16, cy - offset);
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={label}
      data-testid={
        type === "extra_repayment" ? "loan-extra-repayment-marker" : "loan-renewal-marker"
      }
      transform={`translate(${cx}, ${markerY})`}
      className="text-success group cursor-pointer outline-none"
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={onFocus}
      onMouseLeave={(event) => {
        if (document.activeElement !== event.currentTarget) onBlur();
      }}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onBlur();
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onEdit();
        }
      }}
    >
      {offset > 0 && (
        <line
          pointerEvents="none"
          y1={renewal ? 11 : 6}
          y2={cy - markerY}
          stroke="currentColor"
          strokeOpacity={0.4}
          strokeWidth={1}
        />
      )}
      {renewal ? (
        <>
          <circle r={15} fill="currentColor" opacity={upcoming ? 0.08 : 0.14} />
          <circle
            r={11}
            fill="var(--card)"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeDasharray={upcoming ? "3 2" : undefined}
            className="group-focus-visible:stroke-foreground"
          />
          <g transform="translate(-7, -7)" opacity={upcoming ? 0.7 : 1}>
            <Icons.LightningDuotone size={14} />
          </g>
        </>
      ) : (
        <>
          <circle r={12} fill="transparent" />
          <circle r={10} fill="currentColor" opacity={0.14} />
          <circle
            r={6}
            fill="currentColor"
            stroke="var(--background)"
            strokeWidth={1.5}
            className="group-focus-visible:stroke-foreground"
          />
        </>
      )}
    </g>
  );
}
