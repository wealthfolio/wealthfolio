import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";

import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useEventDialog } from "./event-dialog-provider";

export interface QuickEventPopoverProps {
  trigger: React.ReactNode;
  selectedEventId?: string | null;
  onSelect: (eventId: string) => void;
  onClear?: () => void;
  align?: "start" | "center" | "end";
  /**
   * When provided, "Create event" from the popover opens the create dialog with
   * this activity pre-tagged. The new event is also automatically linked to the
   * activity on save.
   */
  activityId?: string;
  /** Pre-fills the start date of new events created from this popover. */
  defaultDate?: Date;
}

export function QuickEventPopover({
  trigger,
  selectedEventId,
  onSelect,
  onClear,
  align = "start",
  activityId,
  defaultDate,
}: QuickEventPopoverProps) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { openEventDialog } = useEventDialog();
  const { data: events = [], isError: eventsErrored, refetch: refetchEvents } = useSpendingEvents();
  const { data: eventTypes = [], isError: typesErrored, refetch: refetchTypes } = useEventTypes();
  const loadErrored = eventsErrored || typesErrored;
  const retryLoad = () => {
    if (eventsErrored) void refetchEvents();
    if (typesErrored) void refetchTypes();
  };

  const handleCreate = () => {
    const seedName = search.trim();
    setOpen(false);
    openEventDialog({
      prefill: {
        name: seedName || undefined,
        startDate: defaultDate ?? new Date(),
        endDate: defaultDate ?? new Date(),
      },
      activityId,
      onCreated: (ev) => onSelect(ev.id),
    });
    setSearch("");
  };

  const typeById = new Map(eventTypes.map((t) => [t.id, t]));

  // Group events by their event type for a tidy list
  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const arr = groups.get(e.eventTypeId) ?? [];
    arr.push(e);
    groups.set(e.eventTypeId, arr);
  }

  const handleSelect = (id: string) => {
    onSelect(id);
    setOpen(false);
  };
  const handleClear = () => {
    onClear?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align={align}>
        <Command>
          {loadErrored && (
            <div className="flex items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <span>{tr("spending:events.loadError")}</span>
              <button type="button" onClick={retryLoad} className="text-foreground hover:underline">
                {tr("common:retry")}
              </button>
            </div>
          )}
          <CommandInput
            placeholder={tr("spending:events.searchEvents")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {events.length === 0 ? (
              <CommandEmpty>
                <div className="text-muted-foreground p-3 text-center text-xs">
                  {loadErrored
                    ? tr("spending:events.noEventsAvailable")
                    : tr("spending:events.noEventsYet")}
                </div>
              </CommandEmpty>
            ) : (
              <CommandEmpty>{tr("spending:events.noEventsFound")}</CommandEmpty>
            )}
            {Array.from(groups.entries()).map(([typeId, items]) => {
              const t = typeById.get(typeId);
              return (
                <CommandGroup key={typeId} heading={t?.name ?? tr("spending:events.otherType")}>
                  {items.map((ev) => {
                    const isSelected = selectedEventId === ev.id;
                    return (
                      <CommandItem
                        key={ev.id}
                        value={`${t?.name ?? ""} ${ev.name}`}
                        onSelect={() => handleSelect(ev.id)}
                        className="flex items-center gap-2"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: t?.color ?? "var(--muted-foreground)" }}
                        />
                        <span className="min-w-0 flex-1 truncate">{ev.name}</span>
                        <span className="text-muted-foreground/70 shrink-0 text-[10px]">
                          {ev.startDate.slice(5)}
                        </span>
                        {isSelected && (
                          <Icons.Check className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__create_event__"
                onSelect={handleCreate}
                className="text-primary flex items-center gap-2"
              >
                <Icons.Plus className="h-3.5 w-3.5" />
                {search.trim()
                  ? tr("spending:events.createEventNamed", { name: search.trim() })
                  : tr("spending:events.createEvent")}
              </CommandItem>
              {selectedEventId && onClear && (
                <CommandItem
                  value="clear-event"
                  onSelect={handleClear}
                  className="text-destructive hover:bg-destructive/10"
                >
                  <Icons.X className="mr-2 h-3.5 w-3.5" />
                  {tr("spending:events.clearEvent")}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
