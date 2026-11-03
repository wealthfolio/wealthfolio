import i18n from "i18next";
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
    staleTime: STALE_TIME,
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
      toast.success(i18n.t("common:notifications.event_type_created"));
    },
    onError: () => toast.error(i18n.t("spending:eventForm.createTypeFailed")),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; color?: string | null } }) =>
      updateEventType(id, patch),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.event_type_updated"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_update_event_type")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteEventType(id),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.event_type_deleted"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_delete_event_type")),
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
      toast.success(i18n.t("common:notifications.event_created"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_create_event")),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSpendingEvent }) =>
      updateEvent(id, patch),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.event_updated"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_update_event")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.event_deleted"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_delete_event")),
  });
  return { create, update, remove };
}
