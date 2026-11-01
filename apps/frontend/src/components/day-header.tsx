import type { ReactNode, Ref } from "react";

import { TableRow } from "@wealthfolio/ui";

/** The band a day-grouped table draws above each day's rows. */
export function DayHeaderRow({
  ref,
  "data-index": dataIndex,
  children,
}: {
  /** Virtualizer wiring: it measures the header through the ref. */
  ref?: Ref<HTMLTableRowElement>;
  "data-index"?: number;
  children: ReactNode;
}) {
  return (
    <TableRow ref={ref} data-index={dataIndex} className="group/row bg-muted/40 hover:bg-muted/40">
      {children}
    </TableRow>
  );
}

/**
 * The day's date and, once it tells the reader something, how many rows it
 * holds: "1 activity" restates the single row below it, and a trailing day that
 * is still loading would undercount.
 */
export function DayHeading({
  label,
  count,
  isPartial,
  countLabel,
  muted = false,
}: {
  label: string;
  count: number;
  isPartial: boolean;
  countLabel: (count: number) => string;
  /** On a card list the heading stays muted, so it never reads as loudly as the cards. */
  muted?: boolean;
}) {
  return (
    <>
      <span
        className={
          muted
            ? "text-muted-foreground text-xs font-medium whitespace-nowrap"
            : "text-xs font-medium"
        }
      >
        {label}
      </span>
      {!isPartial && count > 1 && (
        <span className="text-muted-foreground text-xs whitespace-nowrap">{countLabel(count)}</span>
      )}
    </>
  );
}
