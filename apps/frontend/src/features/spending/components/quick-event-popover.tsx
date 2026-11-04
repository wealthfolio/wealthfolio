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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetScreen,
  SheetScreenTrigger,
  SheetTitle,
  SheetTrigger,
  useDateFormatting,
  useInSheetNavigation,
} from "@wealthfolio/ui";

import { useIsMobileViewport } from "@/hooks/use-platform";
import { cn } from "@/lib/utils";

import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useEventDialog } from "./event-dialog-provider";

export interface QuickEventPopoverProps {
  trigger: React.ReactElement;
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
  /** The screen's title on phones; the field's own label, so the two match. */
  title?: string;
}

export function QuickEventPopover({
  trigger,
  selectedEventId,
  onSelect,
  onClear,
  align = "start",
  activityId,
  defaultDate,
  title: titleProp,
}: QuickEventPopoverProps) {
  const { t: tr } = useTranslation();
  const dateFormatting = useDateFormatting();
  // A start date in the region's short form; the year only when it is not this one.
  const formatEventDate = (startDate: string) =>
    dateFormatting.formatCalendarDate(startDate, {
      month: "short",
      day: "numeric",
      ...(startDate.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: "numeric" }),
    });
  const isMobile = useIsMobileViewport();
  const inSheetNavigation = useInSheetNavigation();
  const fillsSheet = isMobile || inSheetNavigation;
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

  const commandContent = (
    <Command
      className={cn(
        fillsSheet &&
          "h-auto min-h-0 flex-auto rounded-none bg-transparent [&_[data-slot=command-input-wrapper]]:shrink-0",
      )}
    >
      {loadErrored && (
        <div className="text-2xs border-warning-subtle-border bg-warning-subtle text-warning-subtle-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5">
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
      <CommandList className={cn(fillsSheet && "max-h-none min-h-0 flex-auto")}>
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
                    <span className="text-muted-foreground shrink-0 text-xs in-[[data-sheet-screen]]:text-sm">
                      {formatEventDate(ev.startDate)}
                    </span>
                    {isSelected && (
                      <Icons.Check
                        data-slot="command-item-check"
                        className="text-muted-foreground h-3.5 w-3.5"
                      />
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
              className="text-muted-foreground flex items-center gap-2"
            >
              <Icons.X className="h-3.5 w-3.5" />
              {tr("spending:events.clearEvent")}
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );

  const title = titleProp ?? tr("spending:cashForm.tagAnEvent");

  // Opens like the category picker: a screen of a phone form's sheet, a bottom
  // sheet elsewhere on phones, and a popover on larger screens.
  if (inSheetNavigation) {
    return (
      <>
        <SheetScreenTrigger render={trigger} open={open} onOpenChange={setOpen} />
        <SheetScreen open={open} onOpenChange={setOpen} title={title}>
          {commandContent}
        </SheetScreen>
      </>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={trigger} />
        <SheetContent
          side="bottom"
          className="mx-1 flex flex-col gap-0 overflow-hidden rounded-t-4xl p-0 [--overlay-max-height:85dvh]"
        >
          <SheetHeader className="shrink-0 border-b px-4 py-4 pe-16 text-start">
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          {commandContent}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-70 p-0" align={align}>
        {commandContent}
      </PopoverContent>
    </Popover>
  );
}
