import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryKeys } from "@/lib/query-keys";

import { invalidateSpendingCaches } from "../lib/invalidation";
import {
  createEvent,
  createEventType,
  deleteEvent,
  deleteEventType,
  getEventSpendingSummaries,
  listEventTypes,
  listEvents,
  updateEvent,
  updateEventType,
} from "../adapters/events";
import type {
  EventSpendingSummary,
  EventType,
  NewEventType,
  NewSpendingEvent,
  SpendingEvent,
  UpdateSpendingEvent,
} from "../types/event";

// Event types and the full events list rarely change — keep them around so
// multi-page navigation doesn't refetch unnecessarily.
const STALE_TIME = 60_000;

export function useEventTypes() {
  return useQuery<EventType[], Error>({
    queryKey: [QueryKeys.SPENDING_EVENT_TYPES],
    queryFn: listEventTypes,
    staleTime: STALE_TIME,
  });
}

export function useSpendingEvents() {
  return useQuery<SpendingEvent[], Error>({
    queryKey: [QueryKeys.SPENDING_EVENTS],
    queryFn: listEvents,
    staleTime: STALE_TIME,
  });
}

export function useEventSpendingSummaries(request: { startDate: string; endDate: string }) {
  return useQuery<EventSpendingSummary[], Error>({
    queryKey: [QueryKeys.SPENDING_EVENTS, "summaries", request],
    queryFn: () => getEventSpendingSummaries(request),
  });
}

export function useEventTypeMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QueryKeys.SPENDING_EVENT_TYPES] });
    invalidateSpendingCaches(qc);
  };

  const create = useMutation({
    mutationFn: (t: NewEventType) => createEventType(t),
    onSuccess: () => {
      invalidate();
      toast.success("Event type created.");
    },
    onError: () => toast.error("Failed to create event type."),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; color?: string | null } }) =>
      updateEventType(id, patch),
    onSuccess: () => {
      invalidate();
      toast.success("Event type updated.");
    },
    onError: () => toast.error("Failed to update event type."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteEventType(id),
    onSuccess: () => {
      invalidate();
      toast.success("Event type deleted.");
    },
    onError: () => toast.error("Failed to delete event type."),
  });
  return { create, update, remove };
}

export function useSpendingEventMutations() {
  const qc = useQueryClient();
  const invalidate = () => invalidateSpendingCaches(qc);

  const create = useMutation({
    mutationFn: (e: NewSpendingEvent) => createEvent(e),
    onSuccess: () => {
      invalidate();
      toast.success("Event created.");
    },
    onError: () => toast.error("Failed to create event."),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSpendingEvent }) =>
      updateEvent(id, patch),
    onSuccess: () => {
      invalidate();
      toast.success("Event updated.");
    },
    onError: () => toast.error("Failed to update event."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: () => {
      invalidate();
      toast.success("Event deleted.");
    },
    onError: () => toast.error("Failed to delete event."),
  });
  return { create, update, remove };
}
