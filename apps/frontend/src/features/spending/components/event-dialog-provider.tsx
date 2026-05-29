import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { EventFormDialog } from "./event-form-dialog";
import { EventTypeFormDialog } from "./event-type-form-dialog";
import type { EventType, SpendingEvent } from "../types/event";

export interface EventDialogPrefill {
  name?: string;
  description?: string;
  eventTypeId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface OpenEventDialogOptions {
  event?: SpendingEvent;
  prefill?: EventDialogPrefill;
  /** If set, the newly created event is tagged onto this activity automatically. */
  activityId?: string;
  /** Called after a successful create with the persisted event. */
  onCreated?: (event: SpendingEvent) => void;
  /** Called after a successful update. */
  onUpdated?: (event: SpendingEvent) => void;
}

export interface OpenEventTypeDialogOptions {
  eventType?: EventType;
  prefill?: { name?: string; color?: string };
  onCreated?: (eventType: EventType) => void;
}

interface EventDialogContextValue {
  openEventDialog: (opts?: OpenEventDialogOptions) => void;
  openEventTypeDialog: (opts?: OpenEventTypeDialogOptions) => void;
}

const EventDialogContext = createContext<EventDialogContextValue | null>(null);

export function useEventDialog(): EventDialogContextValue {
  const ctx = useContext(EventDialogContext);
  if (!ctx) throw new Error("useEventDialog must be used inside <EventDialogProvider>");
  return ctx;
}

interface EventState extends OpenEventDialogOptions {
  open: boolean;
}

interface EventTypeState extends OpenEventTypeDialogOptions {
  open: boolean;
}

export function EventDialogProvider({ children }: { children: ReactNode }) {
  const [eventState, setEventState] = useState<EventState>({ open: false });
  const [eventTypeState, setEventTypeState] = useState<EventTypeState>({ open: false });

  const openEventDialog = useCallback((opts: OpenEventDialogOptions = {}) => {
    setEventState({ open: true, ...opts });
  }, []);

  const openEventTypeDialog = useCallback((opts: OpenEventTypeDialogOptions = {}) => {
    setEventTypeState({ open: true, ...opts });
  }, []);

  const value = useMemo<EventDialogContextValue>(
    () => ({ openEventDialog, openEventTypeDialog }),
    [openEventDialog, openEventTypeDialog],
  );

  return (
    <EventDialogContext.Provider value={value}>
      {children}
      {eventState.open && (
        <EventFormDialog
          open
          onOpenChange={(open) => setEventState((s) => ({ ...s, open }))}
          event={eventState.event}
          prefill={eventState.prefill}
          activityId={eventState.activityId}
          onCreated={eventState.onCreated}
          onUpdated={eventState.onUpdated}
        />
      )}
      {eventTypeState.open && (
        <EventTypeFormDialog
          open
          onOpenChange={(open) => setEventTypeState((s) => ({ ...s, open }))}
          eventType={eventTypeState.eventType}
          prefill={eventTypeState.prefill}
          onCreated={eventTypeState.onCreated}
        />
      )}
    </EventDialogContext.Provider>
  );
}
