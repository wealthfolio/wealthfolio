import { invoke, logger } from "#platform";
import type {
  EventSpendingSummary,
  EventSummariesRequest,
  EventType,
  NewEventType,
  NewSpendingEvent,
  SpendingEvent,
  UpdateSpendingEvent,
} from "../types/event";

export const getEventSpendingSummaries = async (
  request?: EventSummariesRequest,
): Promise<EventSpendingSummary[]> => {
  try {
    return await invoke<EventSpendingSummary[]>("get_event_spending_summaries", { request });
  } catch (e) {
    logger.error("Error fetching event spending summaries.");
    throw e;
  }
};

export const listEventTypes = async (): Promise<EventType[]> => {
  try {
    return await invoke<EventType[]>("list_event_types");
  } catch (e) {
    logger.error("Error listing event types.");
    throw e;
  }
};

export const createEventType = async (newType: NewEventType): Promise<EventType> => {
  try {
    return await invoke<EventType>("create_event_type", { newType });
  } catch (e) {
    logger.error("Error creating event type.");
    throw e;
  }
};

export const updateEventType = async (
  id: string,
  patch: { name?: string; color?: string | null },
): Promise<EventType> => {
  try {
    return await invoke<EventType>("update_event_type", { id, patch });
  } catch (e) {
    logger.error("Error updating event type.");
    throw e;
  }
};

export const deleteEventType = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_event_type", { id });
  } catch (e) {
    logger.error("Error deleting event type.");
    throw e;
  }
};

export const listEvents = async (): Promise<SpendingEvent[]> => {
  try {
    return await invoke<SpendingEvent[]>("list_events");
  } catch (e) {
    logger.error("Error listing events.");
    throw e;
  }
};

export const createEvent = async (event: NewSpendingEvent): Promise<SpendingEvent> => {
  try {
    return await invoke<SpendingEvent>("create_event", { event });
  } catch (e) {
    logger.error("Error creating event.");
    throw e;
  }
};

export const updateEvent = async (
  id: string,
  patch: UpdateSpendingEvent,
): Promise<SpendingEvent> => {
  try {
    return await invoke<SpendingEvent>("update_event", { id, patch });
  } catch (e) {
    logger.error("Error updating event.");
    throw e;
  }
};

export const deleteEvent = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_event", { id });
  } catch (e) {
    logger.error("Error deleting event.");
    throw e;
  }
};
