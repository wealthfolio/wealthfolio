import { formatDateISO, parseLocalDate } from "@/lib/utils";

export const SPENDING_RANGE_FROM_PARAM = "spendingFrom";
export const SPENDING_RANGE_TO_PARAM = "spendingTo";

export interface SpendingDateRange {
  from: Date;
  to: Date;
}

function parseDateKey(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parseLocalDate(value);
  return Number.isNaN(date.getTime()) || formatDateISO(date) !== value ? null : date;
}

export function spendingRangeFromParams(params: URLSearchParams): SpendingDateRange | undefined {
  const from = parseDateKey(params.get(SPENDING_RANGE_FROM_PARAM));
  const to = parseDateKey(params.get(SPENDING_RANGE_TO_PARAM));
  if (!from || !to || from > to) return undefined;
  return { from, to };
}
