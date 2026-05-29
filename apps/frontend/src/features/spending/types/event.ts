export interface EventType {
  id: string;
  /** Stable slug for seeded types (Travel, Wedding, ...). User-created types
   *  have this `null`. UIs can use it as an i18n lookup key. */
  key?: string | null;
  name: string;
  color?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewEventType {
  id?: string | null;
  name: string;
  color?: string | null;
}

export interface SpendingEvent {
  id: string;
  name: string;
  description?: string | null;
  eventTypeId: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewSpendingEvent {
  id?: string | null;
  name: string;
  description?: string | null;
  eventTypeId: string;
  startDate: string;
  endDate: string;
}

export interface UpdateSpendingEvent {
  name?: string;
  description?: string | null;
  eventTypeId?: string;
  startDate?: string;
  endDate?: string;
}

/** Event joined with its EventType.name for UI display. */
export interface EventWithTypeName extends SpendingEvent {
  eventTypeName: string;
}

export interface EventCategorySpending {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  amount: number;
  transactionCount: number;
}

export interface EventSpendingSummary {
  eventId: string;
  eventName: string;
  eventTypeId: string;
  eventTypeName: string;
  eventTypeColor: string | null;
  startDate: string;
  endDate: string;
  totalSpending: number;
  transactionCount: number;
  currency: string;
  byCategory: Record<string, EventCategorySpending>;
  dailySpending: Record<string, number>;
}

export interface EventSummariesRequest {
  startDate?: string | null;
  endDate?: string | null;
  currency?: string | null;
}
