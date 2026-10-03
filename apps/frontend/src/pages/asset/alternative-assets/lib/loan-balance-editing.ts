import type { Quote } from "@/lib/types";

export function hasBalanceDateConflict(quotes: Quote[], original: Quote, date: string) {
  return (
    date !== original.timestamp.slice(0, 10) &&
    quotes.some((quote) => quote.id !== original.id && quote.timestamp.slice(0, 10) === date)
  );
}
