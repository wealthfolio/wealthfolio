import { useMemo, useState, type FC } from "react";
import { useTranslation } from "react-i18next";

import { Button, Icons } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn, formatAmount } from "@/lib/utils";

import { useEventDialog } from "../../event-dialog-provider";
import { useMonthCalendar } from "../../../hooks/use-month-calendar";
import type { EventSpendingSummary } from "../../../types/event";
import { getEventColors } from "./event-colors";

const CARD_CLASS = "border-border/60 bg-card/40 rounded-2xl border p-4 backdrop-blur-xl";
const LABEL_CLASS = "text-muted-foreground/70 text-[10px] font-normal uppercase tracking-[0.12em]";

const DAY_NAME_KEYS = [
  "spending:calendar.dayMon",
  "spending:calendar.dayTue",
  "spending:calendar.dayWed",
  "spending:calendar.dayThu",
  "spending:calendar.dayFri",
  "spending:calendar.daySat",
  "spending:calendar.daySun",
];

interface Props {
  events: EventSpendingSummary[];
  currency: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export const EventsCalendarCard: FC<Props> = ({ events, currency, selectedId, onSelect }) => {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { openEventDialog } = useEventDialog();
  const today = useMemo(() => stripTime(new Date()), []);
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(today));

  const { monthLabel, monthStart, monthEnd, weeks, monthEvents } = useMonthCalendar(events, cursor);

  return (
    <div className={CARD_CLASS}>
      {/* Header */}
      <div className="mb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-foreground text-base font-semibold tracking-tight">
            {t("spending:eventsCard.title")}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={t("spending:calendar.previousMonth")}
              className="h-7 w-7"
              onClick={() => setCursor(addMonths(cursor, -1))}
            >
              <Icons.ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("spending:calendar.nextMonth")}
              className="h-7 w-7"
              onClick={() => setCursor(addMonths(cursor, 1))}
            >
              <Icons.ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("spending:events.createEvent")}
              className="ml-1 h-7 w-7 rounded-full"
              onClick={() =>
                openEventDialog({
                  prefill: { startDate: monthStart, endDate: monthEnd },
                  onCreated: (ev) => onSelect(ev.id),
                })
              }
            >
              <Icons.Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="text-muted-foreground/80 mt-1 text-[11px]">
          {t("spending:calendar.monthSummary", {
            count: monthEvents.length,
            month: monthLabel,
          })}
        </div>
      </div>

      {/* Day-of-week header */}
      <div className={cn("grid grid-cols-7 text-center", LABEL_CLASS)}>
        {DAY_NAME_KEYS.map((key) => (
          <div key={key} className="pb-1">
            {t(key)}
          </div>
        ))}
      </div>

      {/* Weeks */}
      <div className="space-y-1">
        {weeks.map((week, wi) => (
          <div
            key={wi}
            className="grid auto-rows-min grid-cols-7 gap-y-0.5"
            style={{ gridAutoRows: "min-content" }}
          >
            {/* Day numbers in row 1 */}
            {week.days.map((day, di) => {
              const isToday = sameDay(day, today);
              const inMonth = day.getMonth() === cursor.getMonth();
              return (
                <div
                  key={`d-${di}`}
                  className={cn(
                    "flex h-7 items-center justify-center text-[11px] tabular-nums",
                    !inMonth && "text-muted-foreground/40",
                    inMonth && "text-foreground/80",
                    isToday && "font-semibold",
                  )}
                  style={{ gridColumn: di + 1, gridRow: 1 }}
                >
                  <span
                    className={cn(
                      isToday &&
                        "ring-foreground/70 inline-flex h-5 w-5 items-center justify-center rounded-full ring-1",
                    )}
                  >
                    {day.getDate()}
                  </span>
                </div>
              );
            })}
            {/* Event bars on rows 2+ */}
            {week.bars.map((bar) => {
              const c = getEventColors(bar.event);
              const isSel = selectedId === bar.event.eventId;
              return (
                <button
                  type="button"
                  key={`bar-${bar.event.eventId}`}
                  onClick={() => onSelect(bar.event.eventId)}
                  title={`${bar.event.eventName} · ${
                    isBalanceHidden ? "••••" : formatAmount(bar.event.totalSpending, currency)
                  }`}
                  className={cn(
                    "min-h-[16px] truncate rounded-sm px-1 text-left text-[10px] leading-[16px]",
                    isSel ? "font-semibold" : "hover:brightness-95",
                  )}
                  style={{
                    gridColumn: `${bar.startCol + 1} / ${bar.endCol + 2}`,
                    gridRow: bar.lane + 2,
                    background: c.fill,
                    border: isSel ? `2px solid var(--foreground)` : `1px solid ${c.stroke}`,
                    color: c.stroke,
                  }}
                >
                  {bar.showName ? bar.event.eventName : " "}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Component-local date helpers (today highlight + month nav) ─────────

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
