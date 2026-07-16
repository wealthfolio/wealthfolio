import type { Quote } from "@/lib/types";

export interface QuoteEntry {
  id: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  currency: string;
  isNew?: boolean;
}

/** Preserve source precision in edit state; formatting belongs at render time. */
export function toQuoteEntry(quote: Quote): QuoteEntry {
  return {
    id: quote.id,
    date: new Date(quote.timestamp),
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    volume: Math.round(quote.volume),
    currency: quote.currency,
    isNew: false,
  };
}
