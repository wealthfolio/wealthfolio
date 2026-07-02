import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import * as z from "zod";

import { useI18n } from "@/i18n/i18n-provider";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  DatePickerInput,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PrivacyAmount,
  Textarea,
} from "@wealthfolio/ui";

import type { Activity } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { formatDateISO, parseLocalDate } from "@/lib/utils";

import { useCashActivities, useSetActivityEvent } from "../hooks/use-cash-activities";
import {
  useEventTypeMutations,
  useEventTypes,
  useSpendingEventMutations,
} from "../hooks/use-spending-events";
import type { EventDialogPrefill } from "./event-dialog-provider";
import type { NewSpendingEvent, SpendingEvent } from "../types/event";

function createEventSchema(isChinese: boolean) {
  return z
    .object({
      name: z.string().min(1, isChinese ? "请输入名称" : "Name is required"),
      description: z.string().optional(),
      eventTypeId: z.string().min(1, isChinese ? "请选择事件类型" : "Event type is required"),
      startDate: z.date({
        required_error: isChinese ? "请选择开始日期" : "Start date is required",
      }),
      endDate: z.date({
        required_error: isChinese ? "请选择结束日期" : "End date is required",
      }),
    })
    .refine((data) => data.startDate <= data.endDate, {
      message: isChinese
        ? "开始日期必须早于或等于结束日期"
        : "Start date must be before or equal to end date",
      path: ["endDate"],
    });
}

type EventFormValues = z.infer<ReturnType<typeof createEventSchema>>;

const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
];

interface Props {
  event?: SpendingEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: EventDialogPrefill;
  /** If provided, the saved event will be tagged onto this activity on success. */
  activityId?: string;
  onCreated?: (event: SpendingEvent) => void;
  onUpdated?: (event: SpendingEvent) => void;
}

export function EventFormDialog({
  event,
  open,
  onOpenChange,
  prefill,
  activityId,
  onCreated,
  onUpdated,
}: Props) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { data: eventTypes = [], isError: eventTypesErrored } = useEventTypes();
  const { create, update } = useSpendingEventMutations();
  const { create: createType } = useEventTypeMutations();
  const setEventOnActivity = useSetActivityEvent();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isEditing = !!event;

  // Inline "create event type" expand state.
  const [showCreateType, setShowCreateType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeColor, setNewTypeColor] = useState(PRESET_COLORS[0]);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [isCreatingType, setIsCreatingType] = useState(false);

  // Type picker popover state.
  const [typePopoverOpen, setTypePopoverOpen] = useState(false);

  const form = useForm<EventFormValues>({
    resolver: zodResolver(createEventSchema(isChinese)) as never,
    defaultValues: {
      name: "",
      description: "",
      eventTypeId: "",
      startDate: new Date(),
      endDate: new Date(),
    },
  });

  useEffect(() => {
    if (!open) return;
    setShowCreateType(false);
    setNewTypeName("");
    setNewTypeColor(PRESET_COLORS[0]);
    setTypeError(null);
    if (event) {
      form.reset({
        name: event.name,
        description: event.description ?? "",
        eventTypeId: event.eventTypeId,
        startDate: parseLocalDate(event.startDate),
        endDate: parseLocalDate(event.endDate),
      });
    } else {
      form.reset({
        name: prefill?.name ?? "",
        description: prefill?.description ?? "",
        eventTypeId: prefill?.eventTypeId ?? "",
        startDate: prefill?.startDate ?? new Date(),
        endDate: prefill?.endDate ?? prefill?.startDate ?? new Date(),
      });
    }
  }, [open, event, form, prefill]);

  const selectedTypeId = form.watch("eventTypeId");
  const selectedType = useMemo(
    () => eventTypes.find((t) => t.id === selectedTypeId) ?? null,
    [eventTypes, selectedTypeId],
  );

  // Suggested-transactions step: only shown when creating a brand-new event
  // (no `activityId` single-tag context, not editing). Activities in the
  // chosen date range are fetched and listed with checkboxes — selected ones
  // get tagged with the new event on submit.
  const watchedStart = form.watch("startDate");
  const watchedEnd = form.watch("endDate");
  const showSuggestions = !isEditing && !activityId;

  const candidateFilter = useMemo(() => {
    if (!showSuggestions || !watchedStart || !watchedEnd) return undefined;
    if (watchedStart > watchedEnd) return undefined;
    const start = new Date(watchedStart);
    start.setHours(0, 0, 0, 0);
    const end = new Date(watchedEnd);
    end.setHours(23, 59, 59, 999);
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }, [showSuggestions, watchedStart, watchedEnd]);

  const { data: candidates = [], isFetching: isFetchingCandidates } =
    useCashActivities(candidateFilter);

  // Selection state keyed by the active date range — on range change the key
  // shifts and overrides reset naturally without a useEffect.
  const rangeKey = candidateFilter ? `${candidateFilter.startDate}|${candidateFilter.endDate}` : "";
  const [overrides, setOverrides] = useState<{ key: string; map: Record<string, boolean> }>({
    key: "",
    map: {},
  });
  const activeOverrides = overrides.key === rangeKey ? overrides.map : {};

  const isCandidateSelected = (c: Activity): boolean =>
    Object.prototype.hasOwnProperty.call(activeOverrides, c.id)
      ? activeOverrides[c.id]
      : !c.eventId; // default ON for untagged, OFF for already-tagged

  const setCandidateSelected = (id: string, value: boolean) => {
    setOverrides((prev) => {
      const base = prev.key === rangeKey ? prev.map : {};
      return { key: rangeKey, map: { ...base, [id]: value } };
    });
  };

  const setAllCandidates = (value: boolean) => {
    setOverrides({
      key: rangeKey,
      map: Object.fromEntries(candidates.map((c) => [c.id, value])),
    });
  };

  const selectedCandidateIds = useMemo(
    () => candidates.filter(isCandidateSelected).map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, activeOverrides],
  );
  // Selected candidates that are currently tagged to another event. Tagging
  // them to the new event will silently replace the prior eventId on the
  // activity row — surface the count so the user is aware before submit.
  const replacedTagCount = useMemo(
    () => candidates.filter((c) => isCandidateSelected(c) && !!c.eventId).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, activeOverrides],
  );

  const handleCreateType = async () => {
    const name = newTypeName.trim();
    if (!name) {
      setTypeError(isChinese ? "请输入名称" : "Name is required");
      return;
    }
    setIsCreatingType(true);
    setTypeError(null);
    try {
      const created = await createType.mutateAsync({ name, color: newTypeColor });
      form.setValue("eventTypeId", created.id, { shouldValidate: true });
      setShowCreateType(false);
      setNewTypeName("");
      setNewTypeColor(PRESET_COLORS[0]);
    } catch {
      setTypeError(isChinese ? "创建事件类型失败。" : "Failed to create event type.");
    } finally {
      setIsCreatingType(false);
    }
  };

  const handleSubmit = async (values: EventFormValues) => {
    setIsSubmitting(true);
    try {
      const startDateStr = formatDateISO(values.startDate);
      const endDateStr = formatDateISO(values.endDate);

      if (isEditing && event) {
        const updated = await update.mutateAsync({
          id: event.id,
          patch: {
            name: values.name,
            description: values.description || null,
            eventTypeId: values.eventTypeId,
            startDate: startDateStr,
            endDate: endDateStr,
          },
        });
        onUpdated?.(updated);
      } else {
        const newEvent: NewSpendingEvent = {
          name: values.name,
          description: values.description || null,
          eventTypeId: values.eventTypeId,
          startDate: startDateStr,
          endDate: endDateStr,
        };
        const created = await create.mutateAsync(newEvent);
        // The event is persisted; tagging is a best-effort follow-up. A failed
        // tag must not strand the dialog open or discard the created event —
        // each tag mutation already surfaces its own error toast, so we settle
        // all of them and finalize regardless.
        if (activityId) {
          await setEventOnActivity
            .mutateAsync({ activityId, eventId: created.id })
            .catch(() => undefined);
        } else if (selectedCandidateIds.length > 0) {
          // Bulk-tag the suggested transactions in parallel. No bulk endpoint
          // exists today; the N round-trips are acceptable since the user has
          // already opted into the set explicitly.
          await Promise.allSettled(
            selectedCandidateIds.map((id) =>
              setEventOnActivity.mutateAsync({ activityId: id, eventId: created.id }),
            ),
          );
        }
        // The dashboard event card reads both the event list and cash activity tags.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: [QueryKeys.SPENDING_EVENTS] }),
          queryClient.invalidateQueries({ queryKey: [QueryKeys.SPENDING_TRANSACTIONS] }),
        ]);
        onCreated?.(created);
      }
      form.reset();
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? isChinese
                ? "编辑事件"
                : "Edit Event"
              : isChinese
                ? "新建事件"
                : "Create Event"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? isChinese
                ? "更新事件详情。"
                : "Update the event details."
              : isChinese
                ? "新建事件，用于追踪和归类现金账户交易。"
                : "Create a new event to track and categorize cash account transactions."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isChinese ? "名称" : "Name"}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={isChinese ? "例如：2024 暑假旅行" : "e.g., Summer Vacation 2024"}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{isChinese ? "说明（可选）" : "Description (Optional)"}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={
                        isChinese ? "添加关于这个事件的详情..." : "Add details about this event..."
                      }
                      className="resize-none"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="eventTypeId"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>{isChinese ? "事件类型" : "Event Type"}</FormLabel>
                  {!showCreateType ? (
                    <>
                      <Popover open={typePopoverOpen} onOpenChange={setTypePopoverOpen}>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <button
                              type="button"
                              aria-label={
                                selectedType
                                  ? isChinese
                                    ? `更改事件类型（${selectedType.name}）`
                                    : `Change event type (${selectedType.name})`
                                  : isChinese
                                    ? "选择事件类型"
                                    : "Select event type"
                              }
                              className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
                            >
                              {selectedType ? (
                                <span className="flex min-w-0 items-center gap-2">
                                  {selectedType.color && (
                                    <span
                                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: selectedType.color }}
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="truncate">{selectedType.name}</span>
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {isChinese ? "选择事件类型" : "Select event type"}
                                </span>
                              )}
                              <Icons.ChevronDown
                                className="ml-2 h-4 w-4 shrink-0 opacity-50"
                                aria-hidden="true"
                              />
                            </button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-[--radix-popover-trigger-width] p-0"
                          align="start"
                        >
                          <Command>
                            <CommandInput
                              placeholder={isChinese ? "搜索事件类型..." : "Search event types..."}
                            />
                            <CommandList>
                              <CommandEmpty>
                                {isChinese ? "未找到事件类型。" : "No event types found."}
                              </CommandEmpty>
                              {eventTypes.length > 0 && (
                                <CommandGroup>
                                  {eventTypes.map((t) => {
                                    const isSelected = field.value === t.id;
                                    return (
                                      <CommandItem
                                        key={t.id}
                                        value={t.name}
                                        onSelect={() => {
                                          field.onChange(t.id);
                                          setTypePopoverOpen(false);
                                        }}
                                        className="flex items-center gap-2"
                                      >
                                        {t.color && (
                                          <span
                                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                                            style={{ backgroundColor: t.color }}
                                            aria-hidden="true"
                                          />
                                        )}
                                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                                        {isSelected && (
                                          <Icons.Check className="text-muted-foreground h-3.5 w-3.5" />
                                        )}
                                      </CommandItem>
                                    );
                                  })}
                                </CommandGroup>
                              )}
                              <CommandSeparator />
                              <CommandGroup>
                                <CommandItem
                                  value="__create_new_type__"
                                  onSelect={() => {
                                    setTypePopoverOpen(false);
                                    setShowCreateType(true);
                                  }}
                                  className="text-primary flex items-center gap-2"
                                >
                                  <Icons.Plus className="h-3.5 w-3.5" />
                                  {isChinese ? "新建类型" : "Create new type"}
                                </CommandItem>
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {eventTypesErrored && (
                        <p className="text-destructive text-xs">
                          {isChinese ? "无法加载事件类型。" : "Event types could not load."}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="border-input bg-muted/20 space-y-3 rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-foreground text-xs font-semibold">
                          {isChinese ? "新事件类型" : "New event type"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setShowCreateType(false);
                            setNewTypeName("");
                            setTypeError(null);
                          }}
                          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                        >
                          {isChinese ? "取消" : "Cancel"}
                        </button>
                      </div>
                      <Input
                        autoFocus
                        placeholder={
                          isChinese ? "例如：旅行、婚礼、搬家" : "e.g., Travel, Wedding, Move"
                        }
                        value={newTypeName}
                        onChange={(e) => {
                          setNewTypeName(e.target.value);
                          if (typeError) setTypeError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleCreateType();
                          }
                        }}
                      />
                      <div className="flex flex-wrap gap-2">
                        {PRESET_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={isChinese ? `选择颜色 ${color}` : `Pick color ${color}`}
                            className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                              newTypeColor === color
                                ? "border-foreground ring-2 ring-offset-1"
                                : "border-transparent"
                            }`}
                            style={{ backgroundColor: color }}
                            onClick={() => setNewTypeColor(color)}
                          />
                        ))}
                      </div>
                      {typeError && <p className="text-destructive text-xs">{typeError}</p>}
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleCreateType}
                          disabled={isCreatingType || !newTypeName.trim()}
                        >
                          {isCreatingType
                            ? isChinese
                              ? "创建中..."
                              : "Creating..."
                            : isChinese
                              ? "创建类型"
                              : "Create type"}
                        </Button>
                      </div>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{isChinese ? "事件开始日期" : "Event Start Date"}</FormLabel>
                    <DatePickerInput
                      onChange={(date: Date | undefined) => field.onChange(date)}
                      value={field.value}
                      disabled={field.disabled}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{isChinese ? "事件结束日期" : "Event End Date"}</FormLabel>
                    <DatePickerInput
                      onChange={(date: Date | undefined) => field.onChange(date)}
                      value={field.value}
                      disabled={field.disabled}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {showSuggestions && candidateFilter && (
              <SuggestedTransactions
                language={language}
                candidates={candidates}
                isFetching={isFetchingCandidates}
                isSelected={isCandidateSelected}
                onToggle={setCandidateSelected}
                onSelectAll={() => setAllCandidates(true)}
                onClearAll={() => setAllCandidates(false)}
                selectedCount={selectedCandidateIds.length}
              />
            )}

            {replacedTagCount > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span className="font-semibold">{replacedTagCount}</span>{" "}
                {isChinese
                  ? "笔交易已标记到其他事件。创建此事件会替换这些标记。"
                  : `${replacedTagCount === 1 ? "transaction is" : "transactions are"} already tagged to another event. Creating this event will replace those tags.`}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                {isChinese ? "取消" : "Cancel"}
              </Button>
              <Button type="submit" disabled={isSubmitting || showCreateType}>
                {isSubmitting
                  ? isEditing
                    ? isChinese
                      ? "更新中..."
                      : "Updating..."
                    : isChinese
                      ? "创建中..."
                      : "Creating..."
                  : isEditing
                    ? isChinese
                      ? "更新事件"
                      : "Update Event"
                    : isChinese
                      ? "创建事件"
                      : "Create Event"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface SuggestedTransactionsProps {
  language: string;
  candidates: Activity[];
  isFetching: boolean;
  isSelected: (c: Activity) => boolean;
  onToggle: (id: string, value: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  selectedCount: number;
}

function SuggestedTransactions({
  language,
  candidates,
  isFetching,
  isSelected,
  onToggle,
  onSelectAll,
  onClearAll,
  selectedCount,
}: SuggestedTransactionsProps) {
  const isChinese = language === "zh-CN";

  if (isFetching && candidates.length === 0) {
    return (
      <div className="border-input bg-muted/10 rounded-md border p-3">
        <p className="text-muted-foreground text-xs">
          {isChinese ? "正在查找日期范围内的交易..." : "Looking for transactions in range..."}
        </p>
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="border-input bg-muted/10 rounded-md border p-3">
        <p className="text-foreground text-xs font-semibold">
          {isChinese ? "标记交易" : "Tag transactions"}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {isChinese
            ? "这个日期范围内没有找到交易。你可以稍后在活动列表中标记。"
            : "No transactions found in this date range. You can tag them later from the activity list."}
        </p>
      </div>
    );
  }

  return (
    <div className="border-input rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <p className="text-foreground text-xs font-semibold">
            {isChinese ? "标记此范围内的交易" : "Tag transactions in this range"}
          </p>
          <p className="text-muted-foreground text-[11px]">
            {isChinese
              ? `已选择 ${selectedCount} / ${candidates.length} 笔`
              : `${selectedCount} of ${candidates.length} selected`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            {isChinese ? "全选" : "Select all"}
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            {isChinese ? "清除" : "Clear"}
          </button>
        </div>
      </div>
      <ul className="max-h-52 divide-y overflow-y-auto">
        {candidates.map((c) => {
          const checked = isSelected(c);
          const amt = c.amount ? Number(c.amount) : 0;
          const date = new Date(c.activityDate);
          const dateLabel = isNaN(date.getTime())
            ? c.activityDate.slice(0, 10)
            : date.toLocaleDateString(isChinese ? "zh-CN" : undefined, {
                month: "short",
                day: "numeric",
              });
          return (
            <li key={c.id}>
              <label className="hover:bg-muted/30 flex cursor-pointer items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  className="border-input h-3.5 w-3.5 shrink-0 rounded"
                  checked={checked}
                  onChange={(e) => onToggle(c.id, e.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-xs">
                      {c.notes || c.activityType}
                    </span>
                    {c.eventId && checked && (
                      <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/15 px-1 py-px text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        {isChinese ? "将替换标记" : "will replace tag"}
                      </span>
                    )}
                    {c.eventId && !checked && (
                      <span className="text-muted-foreground/80 border-muted-foreground/30 shrink-0 rounded border px-1 py-px text-[9px] uppercase tracking-wide">
                        {isChinese ? "已标记" : "already tagged"}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-[10px]">{dateLabel}</p>
                </div>
                <span className="text-foreground shrink-0 text-xs font-medium tabular-nums">
                  <PrivacyAmount value={Math.abs(amt)} currency={c.currency || "USD"} />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
