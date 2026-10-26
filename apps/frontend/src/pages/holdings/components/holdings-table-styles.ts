// Shared by the Holdings page's tables (Investments, and Assets and Liabilities), so
// their rows read the same.

/** Rows a step tighter than the shared table's p-4 cells; goes on the table's wrapper. */
export const HOLDINGS_TABLE_DENSITY = "[&_td]:py-2.5";

/**
 * Gain and loss percents as the dashboard's holding rows draw them: a badge in regular
 * weight (the badge variant defaults to light), a fixed minimum width so a column lines up.
 */
export const PERCENT_BADGE = "mt-0.5 min-w-15 justify-center text-xs font-normal";

/** The row's actions button: shown on row hover or focus and while open; always on screens without hover. */
export const ROW_ACTIONS_TRIGGER =
  "in-[tr:hover]:opacity-100 in-[tr:focus-within]:opacity-100 aria-expanded:opacity-100 opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
