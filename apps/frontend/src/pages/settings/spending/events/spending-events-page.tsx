import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EmptyPlaceholder,
  Icons,
  Skeleton,
} from "@wealthfolio/ui";

import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { useEventDialog } from "@/features/spending/components/event-dialog-provider";
import {
  useEventTypeMutations,
  useEventTypes,
  useSpendingEventMutations,
  useSpendingEvents,
} from "@/features/spending/hooks/use-spending-events";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import type { EventType, SpendingEvent } from "@/features/spending/types/event";

import { SettingsHeader } from "../../settings-header";
import { SpendingBackLink } from "../components/spending-back-link";

export default function SpendingEventsPage() {
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const {
    data: events = [],
    isLoading: eventsLoading,
    isError: eventsErrored,
  } = useSpendingEvents();
  const { data: eventTypes = [], isLoading: typesLoading, isError: typesErrored } = useEventTypes();
  const { remove: removeEventType } = useEventTypeMutations();
  const { remove: removeEvent } = useSpendingEventMutations();
  const { openEventDialog, openEventTypeDialog } = useEventDialog();

  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  const isLoading = eventsLoading || typesLoading;

  const eventsByType = useMemo(() => {
    const map: Record<string, SpendingEvent[]> = {};
    for (const e of events) {
      if (!map[e.eventTypeId]) map[e.eventTypeId] = [];
      map[e.eventTypeId].push(e);
    }
    return map;
  }, [events]);

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/settings/spending" replace />;
  }

  const toggleExpanded = (typeId: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  };

  const handleAddEventType = () => {
    openEventTypeDialog();
  };

  const handleEditEventType = (eventType: EventType) => {
    openEventTypeDialog({ eventType });
  };

  const handleAddEvent = (eventType?: EventType) => {
    openEventDialog({
      prefill: { eventTypeId: eventType?.id },
    });
  };

  const handleEditEvent = (event: SpendingEvent) => {
    openEventDialog({ event });
  };

  return (
    <div className="space-y-6">
      <SpendingBackLink />
      <SettingsHeader
        heading="Spending Events"
        text="Manage event types and events used to tag cash transactions."
        backTo="/settings/spending"
        actionsInline
      >
        <Button
          size="sm"
          className="sm:hidden"
          onClick={handleAddEventType}
          aria-label="Add event type"
        >
          <Icons.Plus className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" className="hidden sm:inline-flex" onClick={handleAddEventType}>
          <Icons.Plus className="mr-2 h-3.5 w-3.5" />
          Add event type
        </Button>
      </SettingsHeader>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : eventsErrored || typesErrored ? (
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="AlertTriangle" />
          <EmptyPlaceholder.Title>Events could not load</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Try again before editing event types or tagged events.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      ) : eventTypes.length > 0 ? (
        <div className="divide-border divide-y rounded-md border">
          {eventTypes.map((type) => {
            const typeEvents = eventsByType[type.id] ?? [];
            const hasEvents = typeEvents.length > 0;
            const isExpanded = expandedTypes.has(type.id);
            return (
              <div key={type.id}>
                <EventTypeRow
                  type={type}
                  typeEvents={typeEvents}
                  hasEvents={hasEvents}
                  isExpanded={isExpanded}
                  onToggleExpanded={() => toggleExpanded(type.id)}
                  onAddEvent={() => handleAddEvent(type)}
                  onEditEventType={() => handleEditEventType(type)}
                  onDeleteEventType={() => removeEventType.mutate(type.id)}
                />
                {hasEvents && isExpanded && (
                  <div className="space-y-0">
                    {typeEvents.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        color={type.color ?? null}
                        onEdit={() => handleEditEvent(event)}
                        onDelete={() => removeEvent.mutate(event.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyPlaceholder>
          <EmptyPlaceholder.Icon name="Calendar" />
          <EmptyPlaceholder.Title>No event types</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            You don&apos;t have any event types yet. Create an event type to start tagging
            transactions by trip, project, or any other grouping.
          </EmptyPlaceholder.Description>
          <Button onClick={handleAddEventType}>
            <Icons.Plus className="mr-2 h-4 w-4" />
            Add event type
          </Button>
        </EmptyPlaceholder>
      )}
    </div>
  );
}

function EventTypeRow({
  type,
  typeEvents,
  hasEvents,
  isExpanded,
  onToggleExpanded,
  onAddEvent,
  onEditEventType,
  onDeleteEventType,
}: {
  type: EventType;
  typeEvents: SpendingEvent[];
  hasEvents: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAddEvent: () => void;
  onEditEventType: () => void;
  onDeleteEventType: () => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const paletteGroups: ActionPaletteGroup[] = [
    {
      items: [
        { icon: Icons.Plus, label: "Add event", onClick: onAddEvent },
        { icon: Icons.Pencil, label: "Edit", onClick: onEditEventType },
      ],
    },
    {
      items: [
        {
          icon: Icons.Trash,
          label: "Delete",
          variant: "destructive" as const,
          onClick: () => setConfirmDeleteOpen(true),
        },
      ],
    },
  ];

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {hasEvents ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            onClick={onToggleExpanded}
          >
            {isExpanded ? (
              <Icons.ChevronDown className="h-4 w-4" />
            ) : (
              <Icons.ChevronRight className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <div className="w-6 shrink-0" />
        )}
        {type.color && (
          <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: type.color }} />
        )}
        <span className="min-w-0 truncate text-sm font-medium">{type.name}</span>
        {hasEvents && (
          <span className="text-muted-foreground shrink-0 text-xs">({typeEvents.length})</span>
        )}
      </div>

      {/* Desktop: inline actions */}
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <Button variant="ghost" size="sm" onClick={onAddEvent} title="Add event">
          <Icons.Plus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onEditEventType} title="Edit event type">
          <Icons.Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmDeleteOpen(true)}
          title="Delete event type"
        >
          <Icons.Trash className="h-4 w-4" />
        </Button>
      </div>

      {/* Mobile: ActionPalette kebab */}
      <ActionPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        title={type.name}
        groups={paletteGroups}
        align="end"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0 p-0 sm:hidden"
            aria-label="Event type actions"
          >
            <Icons.DotsThreeVertical className="h-4 w-4" />
          </Button>
        }
      />

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete event type</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{type.name}&quot;?
              {hasEvents && (
                <span className="text-destructive mt-2 block font-medium">
                  This will also delete all {typeEvents.length} event(s) under this type.
                </span>
              )}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeleteEventType}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EventRow({
  event,
  color,
  onEdit,
  onDelete,
}: {
  event: SpendingEvent;
  color: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const paletteGroups: ActionPaletteGroup[] = [
    {
      items: [{ icon: Icons.Pencil, label: "Edit", onClick: onEdit }],
    },
    {
      items: [
        {
          icon: Icons.Trash,
          label: "Delete",
          variant: "destructive" as const,
          onClick: () => setConfirmDeleteOpen(true),
        },
      ],
    },
  ];

  return (
    <div className="ml-6 border-l pl-4">
      <div className="flex items-center justify-between gap-2 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="w-6 shrink-0" />
          {color && (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <span className="block truncate text-sm">{event.name}</span>
            <div className="text-muted-foreground flex items-center gap-2 truncate text-xs">
              <span>
                {event.startDate} – {event.endDate}
              </span>
            </div>
          </div>
        </div>

        {/* Desktop: inline actions */}
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <Button variant="ghost" size="sm" onClick={onEdit} title="Edit event">
            <Icons.Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDeleteOpen(true)}
            title="Delete event"
          >
            <Icons.Trash className="h-4 w-4" />
          </Button>
        </div>

        {/* Mobile: ActionPalette kebab */}
        <ActionPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          title={event.name}
          groups={paletteGroups}
          align="end"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0 p-0 sm:hidden"
              aria-label="Event actions"
            >
              <Icons.DotsThreeVertical className="h-4 w-4" />
            </Button>
          }
        />

        <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete event</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{event.name}&quot;? This action cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
