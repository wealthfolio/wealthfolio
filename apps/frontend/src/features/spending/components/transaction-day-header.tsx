import { memo, type Ref } from "react";
import { useTranslation } from "react-i18next";

import { Checkbox, PrivacyAmount, TableCell, TableRow, useDateFormatting } from "@wealthfolio/ui";

import type { TransactionDayGroup } from "../lib/transactions-helpers";

/** The day's date, formatted in the app timezone the rows were bucketed by. */
function useDayLabel(group: TransactionDayGroup, appTimezone?: string): string {
  const { formatDate } = useDateFormatting();
  return formatDate(group.date, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(appTimezone ? { timeZone: appTimezone } : {}),
  });
}

/**
 * The day's net. Scaffolding, not data: it stays quiet so it never competes
 * with the row amounts under it, and needs no visible label — a number in the
 * amount column of a day header can only be the day's total.
 *
 * The word is carried by visually-hidden text rather than an `aria-label`,
 * which a bare span silently drops: its implicit role is `generic`, and that
 * role prohibits naming, so the total would be announced as a lone number
 * indistinguishable from a row amount.
 */
function DayNet({ group }: { group: TransactionDayGroup }) {
  const { t } = useTranslation();
  if (!group.net) return null;
  return (
    <span className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
      <span className="sr-only">{t("spending:txTab.net")}</span>
      {group.net.amount < 0 ? "-" : "+"}
      <PrivacyAmount value={Math.abs(group.net.amount)} currency={group.net.currency} />
    </span>
  );
}

interface TransactionDayHeaderProps {
  group: TransactionDayGroup;
  appTimezone?: string;
  /** True when every row in the day is selected, "indeterminate" when only some are. */
  selectionState: boolean | "indeterminate";
  onToggleDay: (group: TransactionDayGroup) => void;
  /**
   * Suppresses the count and net. Set for the trailing group while more pages
   * are pending, since that day is still missing rows.
   */
  isPartial: boolean;
  /** Columns between the checkbox and the amount, which the date label spans. */
  labelColSpan?: number;
  /**
   * Virtualizer wiring: it measures the rendered header through the ref and
   * identifies it by `data-index`. Both are unset when the list renders
   * unvirtualized.
   */
  ref?: Ref<HTMLElement>;
  "data-index"?: number;
}

function TransactionDayHeaderImpl({
  ref,
  "data-index": dataIndex,
  group,
  appTimezone,
  selectionState,
  onToggleDay,
  isPartial,
  labelColSpan = 3,
}: TransactionDayHeaderProps) {
  const { t } = useTranslation();
  const label = useDayLabel(group, appTimezone);

  return (
    <TableRow
      ref={ref as Ref<HTMLTableRowElement>}
      data-index={dataIndex}
      className="bg-muted/40 hover:bg-muted/40"
    >
      <TableCell className="relative px-3 py-1.5">
        <Checkbox
          checked={selectionState}
          onCheckedChange={() => onToggleDay(group)}
          aria-label={
            selectionState === true
              ? t("spending:txTab.deselectDay", { date: label })
              : t("spending:txTab.selectDay", { date: label })
          }
        />
      </TableCell>
      <TableCell colSpan={labelColSpan} className="px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium">{label}</span>
          {/* "1 transaction" restates the single row below it, so the count
              only appears once it is telling the reader something. */}
          {!isPartial && group.rows.length > 1 && (
            <span className="text-muted-foreground text-xs">
              {t("spending:txTab.dayCount", { count: group.rows.length })}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="w-28 px-3 py-1.5 text-right">
        {!isPartial && <DayNet group={group} />}
      </TableCell>
      <TableCell className="px-3 py-1.5" />
    </TableRow>
  );
}

export const TransactionDayHeader = memo(TransactionDayHeaderImpl);

function TransactionDayHeadingImpl({ group, appTimezone, isPartial }: TransactionDayHeaderProps) {
  const { t } = useTranslation();
  const label = useDayLabel(group, appTimezone);

  return (
    // No per-day checkbox here: it sat left of the cards' own checkboxes rather
    // than in line with them, and selecting a whole day is already covered by
    // the list's select-all control.
    <div className="flex items-baseline gap-2 px-1 pt-2">
      {/* The heading separates days; it should not read as loudly as the rows
          it separates, so on the card list it stays muted throughout. */}
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {!isPartial && group.rows.length > 1 && (
        <span className="text-muted-foreground text-xs">
          {t("spending:txTab.dayCount", { count: group.rows.length })}
        </span>
      )}
      <span className="ml-auto">{!isPartial && <DayNet group={group} />}</span>
    </div>
  );
}

/**
 * The same day header for the mobile card list, which is a plain stack rather
 * than a table and so cannot host the row version.
 */
export const TransactionDayHeading = memo(TransactionDayHeadingImpl);
