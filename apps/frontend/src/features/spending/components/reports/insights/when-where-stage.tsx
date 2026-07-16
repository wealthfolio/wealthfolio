/**
 * "When & where" stage of the insights page. Composes the heatmap, the events
 * timeline (desktop) / calendar (phone), and the rich event detail panel.
 *
 * All math lives in hooks (`useEventChartData`, `useEventsAggregate`,
 * `useBaselinePace`, `useMonthCalendar`). This file is orchestration only.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Icons } from "@wealthfolio/ui";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { Activity, TaxonomyCategory } from "@/lib/types";

import { useEventDialog } from "../../event-dialog-provider";
import type { EventSpendingSummary } from "../../../types/event";
import { EventDetailPanel } from "./event-detail-panel";
import { EventsCalendarCard } from "./events-calendar-card";
import { EventsTimelineCard } from "./events-timeline-card";
import { CARD_CLASS } from "./insights-shared";
import { WhenYouSpendCard } from "./when-you-spend-card";

export interface WhenWhereStageProps {
  /** Last 12 weeks of cash activities (for the heatmap). */
  heatmapActivities: Activity[];
  accountTypeById?: Map<string, string>;
  dailySpendByDate?: Map<string, number>;
  events: EventSpendingSummary[];
  /** True when the events query failed. Used to render an error state instead of
   * the "Create event" empty CTA, which would otherwise mask the failure. */
  eventsErrored?: boolean;
  onRetryEvents?: () => void;
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  timezone?: string | null;
  /** Period start/end for the events strip. */
  rangeStart: Date;
  rangeEnd: Date;
  /** 0 = current window, 1+ = N windows back. */
  windowOffset: number;
  onPrevWindow: () => void;
  onNextWindow: () => void;
  /** Fired when a heatmap cell is clicked. Weekday is Mon=0..Sun=6, hours are [start, end). */
  onHeatmapCellClick?: (weekday: number, startHour: number, endHour: number) => void;
}

export function WhenWhereStage({
  heatmapActivities,
  accountTypeById,
  dailySpendByDate,
  events,
  eventsErrored = false,
  onRetryEvents,
  taxonomyCategories,
  currency,
  timezone,
  rangeStart,
  rangeEnd,
  windowOffset,
  onPrevWindow,
  onNextWindow,
  onHeatmapCellClick,
}: WhenWhereStageProps) {
  // Derived: user's pick wins if it's still in the list; otherwise fall back to
  // the first event. Avoids the prop-mirror useEffect pattern.
  const [override, setOverride] = useState<string | null>(null);
  const selectedId =
    override && events.some((e) => e.eventId === override)
      ? override
      : (events[0]?.eventId ?? null);
  const selected = useMemo(
    () => events.find((e) => e.eventId === selectedId) ?? null,
    [events, selectedId],
  );

  // Phone-only calendar view. Viewport-based — < 768px (Tailwind md). This
  // excludes iPad (768 portrait / 1024 landscape both fail the `<` check) and
  // triggers correctly for a narrowed desktop browser during development.
  const useCalendar = useIsMobileViewport();

  return (
    <div className="flex flex-col gap-6">
      <WhenYouSpendCard
        activities={heatmapActivities}
        accountTypeById={accountTypeById}
        dailySpendByDate={dailySpendByDate}
        currency={currency}
        timezone={timezone}
        onCellClick={onHeatmapCellClick}
      />
      <div className="flex flex-col gap-4">
        {/* Error: backend query failed — surface explicitly. Without this branch,
            the empty CTA below would mask the failure. */}
        {eventsErrored ? (
          <EventsErrorCard onRetry={onRetryEvents} />
        ) : events.length === 0 && windowOffset === 0 ? (
          /* Empty + offset=0 (current period, no events ever tagged here): show the
              "tag your first event" CTA. Empty + offset>0 (paginated to a quiet
              historical window): render the timeline card empty so the < > arrows
              stay reachable. */
          <EmptyEventsCard rangeStart={rangeStart} rangeEnd={rangeEnd} />
        ) : (
          <>
            {useCalendar ? (
              <EventsCalendarCard
                events={events}
                currency={currency}
                selectedId={selectedId}
                onSelect={setOverride}
              />
            ) : (
              <EventsTimelineCard
                events={events}
                currency={currency}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                heatmapActivities={heatmapActivities}
                accountTypeById={accountTypeById}
                dailySpendByDate={dailySpendByDate}
                selectedId={selectedId}
                onSelect={setOverride}
                windowOffset={windowOffset}
                onPrevWindow={onPrevWindow}
                onNextWindow={onNextWindow}
              />
            )}
            {selected && (
              <EventDetailPanel
                event={selected}
                events={events}
                taxonomyCategories={taxonomyCategories}
                currency={currency}
                heatmapActivities={heatmapActivities}
                accountTypeById={accountTypeById}
                dailySpendByDate={dailySpendByDate}
                onSelect={setOverride}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EventsErrorCard({ onRetry }: { onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={CARD_CLASS}>
      <p className="text-foreground text-base font-semibold leading-snug">
        {t("spending:whenWhere.errorTitle")}
      </p>
      <p className="text-muted-foreground/80 mt-2 text-sm">{t("spending:whenWhere.errorBody")}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          {t("common:retry")}
        </Button>
      ) : null}
    </div>
  );
}

function EmptyEventsCard({ rangeStart, rangeEnd }: { rangeStart: Date; rangeEnd: Date }) {
  const { t } = useTranslation();
  const { openEventDialog } = useEventDialog();
  return (
    <div className={CARD_CLASS}>
      <p className="text-foreground text-base font-semibold leading-snug">
        {t("spending:whenWhere.emptyTitle")}
      </p>
      <p className="text-muted-foreground/80 mt-2 text-sm">{t("spending:whenWhere.emptyBody")}</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() =>
          openEventDialog({
            prefill: { startDate: rangeStart, endDate: rangeEnd },
          })
        }
      >
        {t("spending:events.createEvent")}
        <Icons.ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
