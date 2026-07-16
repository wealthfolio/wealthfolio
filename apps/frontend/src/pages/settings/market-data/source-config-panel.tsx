import { useMemo, useRef, useState } from "react";
import { type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";

import { cn } from "@/lib/utils";
import { TimezoneInput } from "@/pages/settings/general/timezone-input";

import type { FormValues, SourceKey } from "./custom-provider-form";
import { LATEST_TEMPLATES, HISTORICAL_TEMPLATES } from "./provider-templates";
import type { MappingField, SourceRuntime } from "./use-source-runtime";

interface SourceConfigPanelProps {
  form: UseFormReturn<FormValues>;
  prefix: SourceKey;
  runtime: SourceRuntime;
  onUrlChange?: (url: string) => void;
}

const PLACEHOLDERS = [
  "{SYMBOL}",
  "{ISIN}",
  "{MIC}",
  "{CURRENCY}",
  "{currency}",
  "{TODAY}",
  "{FROM}",
  "{TO}",
  "{DATE:%Y-%m-%d}",
];

const SOURCE_TYPES: {
  value: "json" | "html" | "html_table" | "csv";
  labelKey: string;
  descKey: string;
  icon: keyof typeof Icons;
}[] = [
  {
    value: "json",
    labelKey: "settings:market_data_page.source_type_json_label",
    descKey: "settings:market_data_page.source_type_json_desc",
    icon: "FileJson",
  },
  {
    value: "html",
    labelKey: "settings:market_data_page.source_type_html_label",
    descKey: "settings:market_data_page.source_type_html_desc",
    icon: "Globe",
  },
  {
    value: "html_table",
    labelKey: "settings:market_data_page.source_type_html_table_label",
    descKey: "settings:market_data_page.source_type_html_table_desc",
    icon: "FileSpreadsheet",
  },
  {
    value: "csv",
    labelKey: "settings:market_data_page.source_type_csv_label",
    descKey: "settings:market_data_page.source_type_csv_desc",
    icon: "FileText",
  },
];

function StepHeader({
  number,
  title,
  done,
  badge,
}: {
  number: number;
  title: string;
  done: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
          done ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <Icons.Check className="h-3.5 w-3.5" /> : number}
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {badge && <div className="ml-auto">{badge}</div>}
    </div>
  );
}

function PlaceholderChip({
  token,
  onInsert,
}: {
  token: string;
  onInsert: (token: string) => void;
}) {
  return (
    <button
      type="button"
      // Prevent the input from blurring on mousedown so the caret position
      // inside the URL input is still readable when the click fires.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onInsert(token)}
      className="border-border bg-muted/50 hover:border-foreground/30 hover:bg-accent rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
    >
      {token}
    </button>
  );
}

function mapChipLabel(
  field: MappingField,
  t: TFunction,
): { label: string; color: string; required: boolean } {
  switch (field) {
    case "pricePath":
      return {
        label: t("settings:market_data_page.field_price"),
        color: "bg-emerald-500",
        required: true,
      };
    case "datePath":
      return {
        label: t("settings:market_data_page.field_as_of"),
        color: "bg-sky-500",
        required: false,
      };
    case "currencyPath":
      return {
        label: t("settings:market_data_page.field_currency"),
        color: "bg-amber-500",
        required: false,
      };
    case "openPath":
      return {
        label: t("settings:market_data_page.field_open"),
        color: "bg-yellow-500",
        required: false,
      };
    case "highPath":
      return {
        label: t("settings:market_data_page.field_high"),
        color: "bg-orange-500",
        required: false,
      };
    case "lowPath":
      return {
        label: t("settings:market_data_page.field_low"),
        color: "bg-rose-500",
        required: false,
      };
    case "volumePath":
      return {
        label: t("settings:market_data_page.field_volume"),
        color: "bg-violet-500",
        required: false,
      };
  }
}

function MappingChip({
  field,
  value,
  armed,
  onClick,
}: {
  field: MappingField;
  value?: string;
  armed: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const { label, color, required } = mapChipLabel(field, t);
  const assigned = !!value;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-all",
        armed
          ? "bg-background border-foreground/30 ring-foreground/5 shadow-sm ring-1"
          : "bg-muted/30 hover:bg-muted/50 border-transparent",
      )}
    >
      <span className={cn("h-2 w-2 rounded-sm", color)} />
      <span className="font-medium">{label}</span>
      {required && !assigned && <span className="text-destructive">*</span>}
      <span className="text-muted-foreground font-mono">
        {assigned && value ? truncate(value, 18) : "—"}
      </span>
    </button>
  );
}

function pathPlaceholder(
  format: "json" | "html" | "html_table" | "csv",
  kind: "price" | "date",
): string {
  if (kind === "price") {
    if (format === "json") return "$.data.price";
    if (format === "csv") return "Close";
    if (format === "html_table") return "0:3";
    return ".price";
  }
  if (format === "json") return "$.data.date";
  if (format === "csv") return "Date";
  if (format === "html_table") return "0:0";
  return ".date";
}

function MappingInputRow({
  form,
  prefix,
  field,
  armed,
  onArm,
  placeholder,
}: {
  form: UseFormReturn<FormValues>;
  prefix: SourceKey;
  field: "pricePath" | "datePath";
  armed: boolean;
  onArm: () => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const { label, color, required } = mapChipLabel(field, t);
  return (
    <FormField
      control={form.control}
      name={`${prefix}.${field}`}
      render={({ field: f }) => (
        <FormItem
          className={cn(
            "flex items-center gap-2.5 rounded-lg border p-2 transition-all",
            armed
              ? "bg-background border-foreground/30 ring-foreground/5 shadow-sm ring-1"
              : "bg-muted/30 border-transparent",
          )}
        >
          <button
            type="button"
            onClick={onArm}
            className="flex shrink-0 items-center gap-1.5"
            title={
              armed
                ? t("settings:market_data_page.arm_hint_unarm")
                : t("settings:market_data_page.arm_hint_arm")
            }
          >
            <span className={cn("h-2.5 w-2.5 rounded-sm", color)} />
            <span className="text-sm font-medium">{label}</span>
            {required && <span className="text-destructive -ml-1 text-xs">*</span>}
          </button>
          <FormControl>
            <Input
              placeholder={placeholder}
              className="bg-background flex-1 font-mono text-xs"
              {...f}
              onFocus={() => {
                if (!armed) onArm();
              }}
            />
          </FormControl>
          <FormMessage className="shrink-0" />
        </FormItem>
      )}
    />
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function SourceConfigPanel({ form, prefix, runtime, onUrlChange }: SourceConfigPanelProps) {
  const { t } = useTranslation();
  const [headersOpen, setHeadersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const format = form.watch(`${prefix}.format`) ?? "json";
  const urlValue = form.watch(`${prefix}.url`) ?? "";
  const pricePath = form.watch(`${prefix}.pricePath`);
  const currencyPath = form.watch(`${prefix}.currencyPath`);
  const openPath = form.watch(`${prefix}.openPath`);
  const highPath = form.watch(`${prefix}.highPath`);
  const lowPath = form.watch(`${prefix}.lowPath`);
  const volumePath = form.watch(`${prefix}.volumePath`);

  const timezones = useMemo(() => {
    const supportedValuesOf = (
      Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf;
    const raw = typeof supportedValuesOf === "function" ? supportedValuesOf("timeZone") : [];
    const merged = raw.includes("UTC") ? raw : ["UTC", ...raw];
    return Array.from(new Set(merged)).sort((a, b) => a.localeCompare(b));
  }, []);

  const isHistorical = runtime.isHistorical;
  const templates = (isHistorical ? HISTORICAL_TEMPLATES : LATEST_TEMPLATES).filter(
    (t) => t.format === format,
  );

  const endpointConfigured = !!urlValue && runtime.hasFetched;
  const mappingDone = !!pricePath;

  const mapHint =
    format === "csv" || format === "html"
      ? t("settings:market_data_page.map_hint_auto")
      : format === "html_table"
        ? t("settings:market_data_page.map_hint_click_column")
        : t("settings:market_data_page.map_hint_click_value");

  const mapHelper =
    format === "html"
      ? t("settings:market_data_page.map_helper_html")
      : format === "csv"
        ? t("settings:market_data_page.map_helper_csv")
        : format === "html_table"
          ? t("settings:market_data_page.map_helper_html_table")
          : t("settings:market_data_page.map_helper_json");

  const insertPlaceholder = (token: string) => {
    const input = urlInputRef.current;
    const current = form.getValues(`${prefix}.url`) ?? "";
    // If the URL input is focused, splice the token at the caret / selection;
    // otherwise fall back to appending at the end.
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);

    form.setValue(`${prefix}.url`, next, { shouldValidate: true });
    onUrlChange?.(next);

    // Restore focus + place caret right after the inserted token once React
    // has re-rendered with the new value.
    requestAnimationFrame(() => {
      const el = urlInputRef.current;
      if (!el) return;
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="space-y-3">
      {/* ── Step 1 — Configure endpoint ── */}
      <div className="bg-background rounded-xl border p-4">
        <StepHeader
          number={1}
          title={
            isHistorical
              ? t("settings:market_data_page.configure_historical_endpoint")
              : t("settings:market_data_page.configure_latest_endpoint")
          }
          done={endpointConfigured}
          badge={
            <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
              {t("settings:market_data_page.required")}
            </span>
          }
        />

        <div className="space-y-4">
          {/* Source type */}
          <FormField
            control={form.control}
            name={`${prefix}.format`}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                  {t("settings:market_data_page.source_type")}
                </FormLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SOURCE_TYPES.map((opt) => {
                    const Icon = Icons[opt.icon];
                    const selected = field.value === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          field.onChange(opt.value);
                          runtime.resetFetchState();
                        }}
                        className={cn(
                          "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
                          selected
                            ? "bg-background border-foreground/30 ring-foreground/5 shadow-sm ring-1"
                            : "bg-muted/30 hover:bg-muted/50 border-transparent",
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          {Icon && <Icon className="text-muted-foreground h-3.5 w-3.5" />}
                          <span className="text-sm font-medium">{t(opt.labelKey)}</span>
                        </span>
                        <span className="text-muted-foreground text-[11px]">{t(opt.descKey)}</span>
                      </button>
                    );
                  })}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Quick start templates */}
          {templates.length > 0 && (
            <div>
              <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                {t("settings:market_data_page.quick_start")}
              </Label>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {templates.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => runtime.applyTemplate(t)}
                    className="bg-muted/30 hover:bg-muted/50 flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-xs transition-colors"
                  >
                    <Icons.Globe className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground"> · {t.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* URL template + placeholders */}
          <FormField
            control={form.control}
            name={`${prefix}.url`}
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                    {t("settings:market_data_page.url_template")}
                  </FormLabel>
                  <span className="text-muted-foreground text-[11px]">
                    {t("settings:market_data_page.url_template_hint")}
                  </span>
                </div>
                <FormControl>
                  <Input
                    placeholder={
                      format === "json"
                        ? "https://api.example.com/v1/price/{SYMBOL}"
                        : "https://www.example.com/quote/{SYMBOL}"
                    }
                    {...field}
                    ref={(el) => {
                      urlInputRef.current = el;
                      if (typeof field.ref === "function") field.ref(el);
                    }}
                    onChange={(e) => {
                      field.onChange(e);
                      onUrlChange?.(e.target.value);
                    }}
                  />
                </FormControl>
                <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="mr-1">{t("settings:market_data_page.placeholders")}</span>
                  {PLACEHOLDERS.map((p) => (
                    <PlaceholderChip key={p} token={p} onInsert={insertPlaceholder} />
                  ))}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Format-specific inline field (html → CSS selector) */}
          {format === "html" && (
            <FormField
              control={form.control}
              name={`${prefix}.pricePath`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                    {t("settings:market_data_page.css_selector")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("settings:market_data_page.css_selector_placeholder")}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-muted-foreground text-[11px]">
                    {t("settings:market_data_page.css_selector_help")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* Headers & auth */}
          <Collapsible open={headersOpen} onOpenChange={setHeadersOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
              >
                <Icons.ChevronRight
                  className={cn("h-3 w-3 transition-transform", headersOpen && "rotate-90")}
                />
                {t("settings:market_data_page.headers_auth")}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <FormField
                control={form.control}
                name={`${prefix}.headers`}
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder='{"Authorization": "Bearer token"}'
                        {...field}
                      />
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t("settings:market_data_page.headers_secret_help")}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      {/* ── Step 2 — Map response fields ── */}
      <div className="bg-background rounded-xl border p-4">
        <StepHeader
          number={2}
          title={t("settings:market_data_page.map_response_fields")}
          done={mappingDone}
          badge={
            <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
              {mapHint}
            </span>
          }
        />

        <p className="text-muted-foreground mb-3 text-xs">{mapHelper}</p>

        <div className="space-y-2">
          <MappingInputRow
            form={form}
            prefix={prefix}
            field="pricePath"
            armed={runtime.armedField === "pricePath"}
            onArm={() =>
              runtime.setArmedField(runtime.armedField === "pricePath" ? null : "pricePath")
            }
            placeholder={pathPlaceholder(format, "price")}
          />
          <MappingInputRow
            form={form}
            prefix={prefix}
            field="datePath"
            armed={runtime.armedField === "datePath"}
            onArm={() =>
              runtime.setArmedField(runtime.armedField === "datePath" ? null : "datePath")
            }
            placeholder={pathPlaceholder(format, "date")}
          />
        </div>

        {/* More mapping fields (collapsible) */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            >
              <Icons.ChevronRight
                className={cn("h-3 w-3 transition-transform", advancedOpen && "rotate-90")}
              />
              {t("settings:market_data_page.more_mappings")}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {/* Additional mapping chips */}
            <div className="flex flex-wrap gap-2">
              <MappingChip
                field="currencyPath"
                value={currencyPath}
                armed={runtime.armedField === "currencyPath"}
                onClick={() =>
                  runtime.setArmedField(
                    runtime.armedField === "currencyPath" ? null : "currencyPath",
                  )
                }
              />
              {(format === "json" || format === "csv" || format === "html_table") && (
                <>
                  <MappingChip
                    field="openPath"
                    value={openPath}
                    armed={runtime.armedField === "openPath"}
                    onClick={() =>
                      runtime.setArmedField(runtime.armedField === "openPath" ? null : "openPath")
                    }
                  />
                  <MappingChip
                    field="highPath"
                    value={highPath}
                    armed={runtime.armedField === "highPath"}
                    onClick={() =>
                      runtime.setArmedField(runtime.armedField === "highPath" ? null : "highPath")
                    }
                  />
                  <MappingChip
                    field="lowPath"
                    value={lowPath}
                    armed={runtime.armedField === "lowPath"}
                    onClick={() =>
                      runtime.setArmedField(runtime.armedField === "lowPath" ? null : "lowPath")
                    }
                  />
                  <MappingChip
                    field="volumePath"
                    value={volumePath}
                    armed={runtime.armedField === "volumePath"}
                    onClick={() =>
                      runtime.setArmedField(
                        runtime.armedField === "volumePath" ? null : "volumePath",
                      )
                    }
                  />
                </>
              )}
            </div>

            <FormField
              control={form.control}
              name={`${prefix}.dateFormat`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">
                    {t("settings:market_data_page.date_format")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("settings:market_data_page.date_format_placeholder")}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {(format === "json" || format === "csv") && (
              <div className="grid gap-3 sm:grid-cols-4">
                <FormField
                  control={form.control}
                  name={`${prefix}.openPath`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t("settings:market_data_page.field_open")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={format === "csv" ? "Open" : "$.open"}
                          className="font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`${prefix}.highPath`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t("settings:market_data_page.field_high")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={format === "csv" ? "High" : "$.high"}
                          className="font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`${prefix}.lowPath`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t("settings:market_data_page.field_low")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={format === "csv" ? "Low" : "$.low"}
                          className="font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`${prefix}.volumePath`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        {t("settings:market_data_page.field_volume")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={format === "csv" ? "Volume" : "$.volume"}
                          className="font-mono text-xs"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <FormField
              control={form.control}
              name={`${prefix}.currencyPath`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">
                    {t("settings:market_data_page.currency_path")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("settings:market_data_page.currency_path_placeholder")}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name={`${prefix}.factor`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t("settings:market_data_page.factor")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="any"
                        placeholder="0.01"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`${prefix}.locale`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t("settings:market_data_page.locale")}
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="en-US" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`${prefix}.invert`}
                render={({ field }) => (
                  <FormItem className="flex flex-col justify-end">
                    <div className="flex items-center gap-2 pb-1">
                      <Switch
                        checked={field.value ?? false}
                        onCheckedChange={field.onChange}
                        id={`${prefix}-invert`}
                      />
                      <Label htmlFor={`${prefix}-invert`} className="text-xs">
                        {t("settings:market_data_page.invert")}
                      </Label>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name={`${prefix}.defaultPrice`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t("settings:market_data_page.default_price")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="any"
                        placeholder={t("settings:market_data_page.default_price_placeholder")}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value === "" ? undefined : Number(e.target.value))
                        }
                      />
                    </FormControl>
                    <p className="text-muted-foreground text-[11px]">
                      {t("settings:market_data_page.default_price_help")}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`${prefix}.dateTimezone`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">
                      {t("settings:market_data_page.date_timezone")}
                    </FormLabel>
                    <FormControl>
                      <TimezoneInput
                        value={field.value || ""}
                        onChange={field.onChange}
                        timezones={timezones}
                        placeholder="Europe/Berlin"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
