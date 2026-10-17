import { memo, type Ref } from "react";
import { useTranslation } from "react-i18next";

import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatDateTime } from "@/lib/utils";
import { AmountDisplay, TableCell, TableRow, useDateFormatting } from "@wealthfolio/ui";

import type { ActivityDayGroup } from "./activity-day-groups";

interface DayHeaderProps {
  group: ActivityDayGroup<unknown>;
  /** Any of the day's rows: the heading writes out the date they display. */
  date: string | Date;
  /** Leaves the count out: the trailing day may still be missing rows. */
  isPartial: boolean;
}

/** The day's date in full, formatted the way its rows format theirs. */
function useDayLabel(date: string | Date): string {
  const dateFormatting = useDateFormatting();
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;
  return formatDateTime(date, dateFormatting, appTimezone, { weekday: "long" }).date;
}

function DayCount({ group, isPartial }: Omit<DayHeaderProps, "date">) {
  const { t } = useTranslation();
  // "1 activity" restates the single row below it, so the count only appears
  // once it tells the reader something.
  if (isPartial || group.items.length < 2) return null;
  return (
    <span className="text-muted-foreground whitespace-nowrap text-xs">
      {t("activity:table.day_count", { count: group.items.length })}
    </span>
  );
}

/**
 * The account's cash at the end of the day. Unlike a day total it needs its
 * label: a bare figure in the header would read as the sum of the rows.
 */
function DayCash({ group }: Pick<DayHeaderProps, "group">) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  if (!group.cashBalance) return null;
  return (
    <span className="text-muted-foreground inline-flex items-baseline gap-1.5 whitespace-nowrap text-xs tabular-nums">
      {t("activity:table.day_end_cash")}
      <AmountDisplay
        value={group.cashBalance.amount}
        currency={group.cashBalance.currency}
        isHidden={isBalanceHidden}
        className="text-foreground"
      />
    </span>
  );
}

/** Columns the date and count always keep in a header that also shows cash. */
const MIN_HEADING_COLUMNS = 2;

interface ActivityDayHeaderRowProps extends DayHeaderProps {
  columnCount: number;
  /**
   * Visible index of the column the day's cash lines up with (the row
   * totals), or -1 to put it at the end of the row.
   */
  cashColumnIndex: number;
  /** Virtualizer wiring: it measures the header through the ref. */
  ref?: Ref<HTMLTableRowElement>;
  "data-index"?: number;
}

function ActivityDayHeaderRowImpl({
  ref,
  "data-index": dataIndex,
  group,
  date,
  isPartial,
  columnCount,
  cashColumnIndex,
}: ActivityDayHeaderRowProps) {
  const label = useDayLabel(date);
  const heading = (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium">{label}</span>
      <DayCount group={group} isPartial={isPartial} />
    </div>
  );
  // The cash spans the Total column and up to three before it, so its label
  // fits without widening the Total column, while the heading keeps at least
  // the first two columns: the two cells cannot overlap whichever columns are
  // hidden.
  const cashStart = Math.max(MIN_HEADING_COLUMNS, cashColumnIndex - 3);
  const alignsCash = group.cashBalance != null && cashColumnIndex >= MIN_HEADING_COLUMNS;

  return (
    <TableRow ref={ref} data-index={dataIndex} className="bg-muted/40 hover:bg-muted/40">
      {alignsCash ? (
        <>
          <TableCell colSpan={cashStart} className="px-3 py-1.5">
            {heading}
          </TableCell>
          {/* `pr-4` as on the row totals, so the right edges line up. */}
          <TableCell colSpan={cashColumnIndex - cashStart + 1} className="px-3 py-1.5 text-right">
            <div className="pr-4">
              <DayCash group={group} />
            </div>
          </TableCell>
          {columnCount - cashColumnIndex - 1 > 0 && (
            <TableCell colSpan={columnCount - cashColumnIndex - 1} className="px-3 py-1.5" />
          )}
        </>
      ) : (
        <TableCell colSpan={columnCount} className="px-3 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            {heading}
            <DayCash group={group} />
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

/** A day's header row inside the activity table. */
export const ActivityDayHeaderRow = memo(ActivityDayHeaderRowImpl);

function ActivityDayHeadingImpl({ group, date, isPartial }: DayHeaderProps) {
  const label = useDayLabel(date);
  return (
    // The heading separates days; on the card list it stays muted so it never
    // reads as loudly as the cards it separates.
    // On a narrow screen the cash moves under the date rather than squeezing it.
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 pt-2">
      <span className="text-muted-foreground whitespace-nowrap text-xs font-medium">{label}</span>
      <DayCount group={group} isPartial={isPartial} />
      <span className="ml-auto">
        <DayCash group={group} />
      </span>
    </div>
  );
}

/** The same day header for the card list, which is a stack rather than a table. */
export const ActivityDayHeading = memo(ActivityDayHeadingImpl);
