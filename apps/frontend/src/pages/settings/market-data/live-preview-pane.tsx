import { useMemo, useState } from "react";
import { type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";

import type { DetectedHtmlTable } from "@/lib/types/custom-provider";
import { cn } from "@/lib/utils";

import { RawResponseViewer } from "./response-preview";
import type { FormValues, SourceKey } from "./custom-provider-form";
import type { MappingField, SourceRuntime } from "./use-source-runtime";

interface LivePreviewPaneProps {
  form: UseFormReturn<FormValues>;
  prefix: SourceKey;
  runtime: SourceRuntime;
}

const MAPPING_META: {
  field: MappingField;
  labelKey: string;
  color: string;
  required: boolean;
}[] = [
  {
    field: "pricePath",
    labelKey: "settings:market_data_page.field_price",
    color: "bg-emerald-500",
    required: true,
  },
  {
    field: "datePath",
    labelKey: "settings:market_data_page.field_as_of",
    color: "bg-sky-500",
    required: false,
  },
  {
    field: "currencyPath",
    labelKey: "settings:market_data_page.field_currency",
    color: "bg-amber-500",
    required: false,
  },
  {
    field: "openPath",
    labelKey: "settings:market_data_page.field_open",
    color: "bg-yellow-500",
    required: false,
  },
  {
    field: "highPath",
    labelKey: "settings:market_data_page.field_high",
    color: "bg-orange-500",
    required: false,
  },
  {
    field: "lowPath",
    labelKey: "settings:market_data_page.field_low",
    color: "bg-rose-500",
    required: false,
  },
  {
    field: "volumePath",
    labelKey: "settings:market_data_page.field_volume",
    color: "bg-violet-500",
    required: false,
  },
];

/** Inline chips replacing placeholders in the preview URL. */
function PreviewUrl({ template, values }: { template: string; values: Record<string, string> }) {
  const { t } = useTranslation();
  const segments = useMemo(() => {
    if (!template) return [];
    const re = /\{([A-Za-z:%\-_]+)\}/g;
    const out: { kind: "text" | "chip"; text: string; value?: string }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) {
      if (m.index > last) out.push({ kind: "text", text: template.slice(last, m.index) });
      const key = m[1];
      const value = values[key] || values[key.toUpperCase()];
      out.push({ kind: "chip", text: key, value });
      last = m.index + m[0].length;
    }
    if (last < template.length) out.push({ kind: "text", text: template.slice(last) });
    return out;
  }, [template, values]);

  if (!template) {
    return (
      <span className="text-muted-foreground/60 font-mono text-xs italic">
        {t("settings:market_data_page.enter_url_to_preview")}
      </span>
    );
  }

  return (
    <span className="break-all font-mono text-xs">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span
            key={i}
            className={cn(
              "mx-0.5 inline-flex items-center rounded border px-1 py-0.5 font-mono text-[11px]",
              seg.value
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-muted-foreground/40 bg-muted text-muted-foreground border-dashed",
            )}
          >
            {seg.value || `{${seg.text}}`}
          </span>
        ),
      )}
    </span>
  );
}

function StatusPill({
  isFetching,
  status,
  error,
}: {
  isFetching: boolean;
  status: { code: number; ok: boolean } | null;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (isFetching) {
    return (
      <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs">
        <Icons.Spinner className="h-3 w-3 animate-spin" />
        {t("settings:market_data_page.fetching")}
      </span>
    );
  }
  if (error || status?.ok === false) {
    return (
      <span className="text-destructive border-destructive/40 bg-destructive/10 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs">
        <span className="bg-destructive h-1.5 w-1.5 rounded-full" />
        {t("settings:market_data_page.status_error")}
      </span>
    );
  }
  if (status?.ok) {
    return (
      <span className="text-success border-success/40 bg-success/10 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs">
        <span className="bg-success h-1.5 w-1.5 rounded-full" />
        {t("settings:market_data_page.status_ok", { code: status.code })}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs">
      <span className="bg-muted-foreground/40 h-1.5 w-1.5 rounded-full" />
      {t("settings:market_data_page.status_idle")}
    </span>
  );
}

function EmptyResponseState() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center">
      <Icons.Target className="text-muted-foreground/40 h-6 w-6" />
      <div className="space-y-1">
        <p className="text-muted-foreground text-sm">
          {t("settings:market_data_page.empty_response_before")}
          <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
            {t("settings:market_data_page.fetch")}
          </span>
          {t("settings:market_data_page.empty_response_after")}
        </p>
        <p className="text-muted-foreground/70 text-xs">
          {t("settings:market_data_page.empty_response_line2")}
        </p>
      </div>
    </div>
  );
}

const ROLE_COLOR: Record<string, string> = {
  close: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  date: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  high: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  low: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  volume: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  open: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const COLUMN_ROLE_TO_FIELD: Partial<Record<string, MappingField>> = {
  close: "pricePath",
  date: "datePath",
  open: "openPath",
  high: "highPath",
  low: "lowPath",
  volume: "volumePath",
};

function HtmlTableResponse({
  tables,
  runtime,
}: {
  tables: DetectedHtmlTable[];
  runtime: SourceRuntime;
}) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const table = tables[activeIndex] ?? tables[0];
  if (!table) return null;

  const handleHeaderClick = (colIndex: number, role?: string) => {
    const tableIdx = table.index;
    const cellPath = `${tableIdx}:${colIndex}`;
    if (runtime.armedField) {
      runtime.handlePathSelect(cellPath, runtime.armedField);
      return;
    }
    const field = role ? COLUMN_ROLE_TO_FIELD[role] : undefined;
    runtime.handlePathSelect(cellPath, field ?? "pricePath");
  };

  // When switching tables, rewrite the table-index prefix of any existing
  // mappings so they target the new table (keeping the same column).
  const handleSwitchTable = (newIndex: number) => {
    const prev = tables[activeIndex];
    const next = tables[newIndex];
    if (!prev || !next || prev.index === next.index) {
      setActiveIndex(newIndex);
      return;
    }
    runtime.remapTableIndex(prev.index, next.index);
    setActiveIndex(newIndex);
  };

  return (
    <div className="space-y-3">
      {/* Table selector — shown always when html_table, as a legend + switcher */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground mr-1 text-[11px] font-medium uppercase tracking-wide">
          {t("settings:market_data_page.table")}
        </span>
        {tables.map((tbl, i) => (
          <button
            key={tbl.index}
            type="button"
            onClick={() => handleSwitchTable(i)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs transition-colors",
              i === activeIndex
                ? "bg-background border-foreground/30 shadow-sm"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50 border-transparent",
            )}
            title={t("settings:market_data_page.table_cols_rows_title", {
              cols: tbl.columns.length,
              rows: tbl.rowCount,
            })}
          >
            {i + 1}
          </button>
        ))}
        <span className="text-muted-foreground ml-auto text-xs">
          {runtime.armedField
            ? t("settings:market_data_page.table_click_column_to_map_field", {
                count: table.rowCount,
                field: labelForField(runtime.armedField, t),
              })
            : t("settings:market_data_page.table_click_column_to_map", {
                count: table.rowCount,
              })}
        </span>
      </div>

      <div className="bg-background max-h-[420px] overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0">
            <tr>
              {table.columns.map((col) => (
                <th key={col.index} className="px-3 py-2 text-left">
                  <button
                    type="button"
                    onClick={() => handleHeaderClick(col.index, col.role)}
                    className="hover:text-foreground group flex flex-col items-start gap-1 text-left"
                  >
                    <span className="text-foreground text-xs font-medium">
                      {col.header ||
                        t("settings:market_data_page.column_index", { index: col.index })}
                    </span>
                    {col.role && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          ROLE_COLOR[col.role] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {col.role}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.sampleRows.slice(0, 8).map((row, ri) => (
              <tr key={ri} className="border-t">
                {row.map((cell, ci) => (
                  <td key={ci} className="text-muted-foreground px-3 py-1.5 font-mono text-[11px]">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CsvResponse({ raw, runtime }: { raw: string; runtime: SourceRuntime }) {
  const { t } = useTranslation();
  const { headers, rows } = useMemo(() => parseCsv(raw), [raw]);
  if (headers.length === 0) {
    return (
      <pre className="bg-background max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs">
        {raw.slice(0, 3000)}
      </pre>
    );
  }

  const handleHeaderClick = (name: string) => {
    const field = runtime.armedField ?? inferCsvFieldFromHeader(name);
    runtime.handlePathSelect(name, field);
  };

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {runtime.armedField
          ? t("settings:market_data_page.csv_rows_detected_field", {
              count: rows.length,
              field: labelForField(runtime.armedField, t),
            })
          : t("settings:market_data_page.csv_rows_detected", { count: rows.length })}
      </p>
      <div className="bg-background max-h-[420px] overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 sticky top-0">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-3 py-2 text-left">
                  <button
                    type="button"
                    onClick={() => handleHeaderClick(h)}
                    className="text-foreground hover:text-primary text-xs font-medium"
                  >
                    {h}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, ri) => (
              <tr key={ri} className="border-t">
                {headers.map((h) => (
                  <td key={h} className="text-muted-foreground px-3 py-1.5 font-mono text-[11px]">
                    {row[h]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function parseCsv(raw: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const delim = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const split = (line: string) => line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]);
  const rows = lines.slice(1, 30).map((l) => {
    const cells = split(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    return obj;
  });
  return { headers, rows };
}

function inferCsvFieldFromHeader(h: string): MappingField {
  const k = h.toLowerCase();
  if (k.includes("date") || k.includes("time")) return "datePath";
  if (k.includes("open")) return "openPath";
  if (k.includes("high")) return "highPath";
  if (k.includes("low")) return "lowPath";
  if (k.includes("volume") || k.includes("vol")) return "volumePath";
  if (k.includes("currency") || k === "ccy") return "currencyPath";
  return "pricePath";
}

function labelForField(f: MappingField, t: TFunction): string {
  const meta = MAPPING_META.find((m) => m.field === f);
  return meta ? t(meta.labelKey) : f;
}

function HtmlElementsResponse({ runtime }: { runtime: SourceRuntime }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const max = 10;
  const list = showAll ? runtime.detectedElements : runtime.detectedElements.slice(0, max);
  const hasMore = runtime.detectedElements.length > max;

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {runtime.armedField
          ? t("settings:market_data_page.elements_detected_field", {
              count: runtime.detectedElements.length,
              field: labelForField(runtime.armedField, t),
            })
          : t("settings:market_data_page.elements_detected", {
              count: runtime.detectedElements.length,
            })}
      </p>
      <div className="max-h-[420px] space-y-2 overflow-y-auto">
        {list.map((el) => (
          <button
            key={el.selector}
            type="button"
            onClick={() => runtime.handlePathSelect(el.selector, runtime.armedField ?? "pricePath")}
            className="bg-background hover:bg-muted/30 group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <code className="bg-muted/60 inline-block max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[11px]">
                {el.selector}
              </code>
              {el.label && <p className="text-muted-foreground text-[11px]">{el.label}</p>}
              {el.htmlContext && (
                <pre className="bg-muted/40 text-muted-foreground/80 mt-1.5 overflow-x-auto rounded p-2 font-mono text-[10px] leading-relaxed">
                  {el.htmlContext}
                </pre>
              )}
            </div>
            <span className="shrink-0 pt-0.5 font-mono text-base font-semibold tabular-nums">
              {formatNumber(el.value)}
            </span>
          </button>
        ))}
      </div>
      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          {t("settings:market_data_page.show_more_elements", {
            count: runtime.detectedElements.length - max,
          })}
        </button>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n !== Math.floor(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return String(n);
}

function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (disabled || !text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silently ignore
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      title={
        copied ? t("settings:market_data_page.copied") : t("settings:market_data_page.copy_url")
      }
      className="text-muted-foreground hover:text-foreground hover:bg-muted/50 absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    >
      {copied ? (
        <Icons.Check className="text-success h-3.5 w-3.5" />
      ) : (
        <Icons.Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function ExtractedRow({
  color,
  label,
  display,
}: {
  color: string;
  label: string;
  display: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className={cn("h-2 w-2 shrink-0 rounded-sm", color)} />
      <span className="text-muted-foreground w-16 shrink-0 text-xs font-medium uppercase tracking-wide">
        {label}
      </span>
      <span className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">
        {display ?? (
          <span className="text-muted-foreground/60 italic">
            {t("settings:market_data_page.not_returned")}
          </span>
        )}
      </span>
      {display && <Icons.CheckCircle className="text-success h-3.5 w-3.5 shrink-0" />}
    </div>
  );
}

function TestField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        {label}
      </Label>
      {children}
    </div>
  );
}

function FieldMappingRow({
  field,
  label,
  color,
  required,
  value,
  armed,
  onArm,
}: {
  field: MappingField;
  label: string;
  color: string;
  required: boolean;
  value: string | undefined;
  armed: boolean;
  onArm: () => void;
}) {
  const { t } = useTranslation();
  const assigned = !!value;
  return (
    <button
      type="button"
      onClick={onArm}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
        armed
          ? "bg-background border-foreground/30 ring-foreground/5 shadow-sm ring-1"
          : "bg-background hover:bg-muted/30",
      )}
      data-field={field}
    >
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", color)} />
      <span className="shrink-0 text-sm font-medium">{label}</span>
      <span
        className={cn(
          "ml-1 h-1.5 w-1.5 shrink-0 rounded-full",
          assigned ? "bg-success" : armed ? "bg-primary" : "bg-muted-foreground/30",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-xs",
          assigned ? "text-foreground" : "text-muted-foreground/70 italic",
        )}
      >
        {assigned ? value : t("settings:market_data_page.unassigned_click_to_pick")}
      </span>
      {required ? (
        <span
          className={cn(
            "shrink-0 text-[10px] font-medium uppercase tracking-wide",
            assigned ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {t("settings:market_data_page.required")}
        </span>
      ) : (
        <span className="text-muted-foreground shrink-0 text-[10px] font-medium uppercase tracking-wide">
          {t("settings:market_data_page.optional")}
        </span>
      )}
    </button>
  );
}

export function LivePreviewPane({ form, prefix, runtime }: LivePreviewPaneProps) {
  const { t } = useTranslation();
  const [moreFieldsOpen, setMoreFieldsOpen] = useState(false);
  const format = form.watch(`${prefix}.format`) ?? "json";
  const pricePath = form.watch(`${prefix}.pricePath`);
  const datePath = form.watch(`${prefix}.datePath`);
  const currencyPath = form.watch(`${prefix}.currencyPath`);
  const openPath = form.watch(`${prefix}.openPath`);
  const highPath = form.watch(`${prefix}.highPath`);
  const lowPath = form.watch(`${prefix}.lowPath`);
  const volumePath = form.watch(`${prefix}.volumePath`);

  const values: Record<MappingField, string | undefined> = {
    pricePath,
    datePath,
    currencyPath,
    openPath,
    highPath,
    lowPath,
    volumePath,
  };

  const { inputs, setInputs, extraPlaceholders, isHistorical } = runtime;
  const previewCurrency = inputs.currency.trim() || "USD";

  const previewValues: Record<string, string> = {
    SYMBOL: inputs.symbol,
    ISIN: inputs.isin,
    MIC: inputs.mic,
    CURRENCY: previewCurrency.toUpperCase(),
    currency: previewCurrency.toLowerCase(),
    TODAY: new Date().toISOString().slice(0, 10),
    FROM: inputs.from,
    TO: inputs.to,
  };

  const missingRange = isHistorical && (!inputs.from || !inputs.to);
  const fetchDisabled =
    runtime.isFetching || !inputs.symbol || missingRange || !runtime.urlTemplate;

  const formatLabel = format.toUpperCase().replace("_", " ");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">
            {t("settings:market_data_page.live_request_response")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings:market_data_page.live_reflects_instantly")}
          </p>
        </div>
        <StatusPill
          isFetching={runtime.isFetching}
          status={runtime.status}
          error={runtime.fetchError}
        />
      </div>

      {/* Request URL preview */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {t("settings:market_data_page.request_url_preview")}
          </Label>
          <span className="text-muted-foreground text-[11px]">
            {isHistorical
              ? t("settings:market_data_page.get_historical")
              : t("settings:market_data_page.get_latest")}
          </span>
        </div>
        <div className="bg-background relative min-h-[40px] rounded-lg border px-3 py-2 pr-10">
          <PreviewUrl template={runtime.urlTemplate} values={previewValues} />
          <CopyButton text={runtime.expandedUrl} disabled={!runtime.urlTemplate} />
        </div>
      </section>

      {/* Test inputs */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <TestField
            label={t("settings:market_data_page.test_symbol")}
            className="min-w-[140px] flex-1"
          >
            <Input
              placeholder={t("settings:market_data_page.test_symbol_placeholder")}
              value={inputs.symbol}
              onChange={(e) => setInputs({ symbol: e.target.value })}
            />
          </TestField>
          {extraPlaceholders.isin && (
            <TestField label={t("settings:market_data_page.field_isin")} className="w-28">
              <Input
                placeholder="US0378331005"
                value={inputs.isin}
                onChange={(e) => setInputs({ isin: e.target.value })}
              />
            </TestField>
          )}
          {extraPlaceholders.mic && (
            <TestField label={t("settings:market_data_page.field_mic")} className="w-24">
              <Input
                placeholder="XLON"
                value={inputs.mic}
                onChange={(e) => setInputs({ mic: e.target.value })}
              />
            </TestField>
          )}
          {extraPlaceholders.currency && (
            <TestField label={t("common:currency")} className="w-20">
              <Input
                placeholder="USD"
                value={inputs.currency}
                onChange={(e) => setInputs({ currency: e.target.value })}
              />
            </TestField>
          )}
          {isHistorical && (
            <>
              <TestField label={t("settings:market_data_page.from")} className="w-36">
                <Input
                  type="date"
                  value={inputs.from}
                  onChange={(e) => setInputs({ from: e.target.value })}
                />
              </TestField>
              <TestField label={t("settings:market_data_page.to")} className="w-36">
                <Input
                  type="date"
                  value={inputs.to}
                  onChange={(e) => setInputs({ to: e.target.value })}
                />
              </TestField>
            </>
          )}
          <Button
            type="button"
            onClick={runtime.handleFetch}
            disabled={fetchDisabled}
            size="sm"
            className="h-input-height shrink-0"
          >
            {runtime.isFetching ? (
              <Icons.Spinner className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Icons.PlayCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("settings:market_data_page.fetch")}
          </Button>
        </div>
      </section>

      {/* Response */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {t("settings:market_data_page.response")} · {formatLabel}
          </Label>
          {runtime.detectedTables[0] && (
            <span className="text-muted-foreground text-[11px]">
              {t("settings:market_data_page.table_rows_cols", {
                rows: runtime.detectedTables[0].rowCount,
                cols: runtime.detectedTables[0].columns.length,
              })}
            </span>
          )}
        </div>

        {runtime.fetchError && !runtime.isFetching ? (
          <div className="border-destructive/30 bg-destructive/5 rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <Icons.XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="text-destructive text-sm">{runtime.fetchError}</p>
                {/403|forbidden|denied/i.test(runtime.fetchError) && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t("settings:market_data_page.fetch_error_headers_hint")}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : !runtime.hasFetched && !runtime.testResult ? (
          <EmptyResponseState />
        ) : format === "html_table" && runtime.detectedTables.length > 0 ? (
          <HtmlTableResponse tables={runtime.detectedTables} runtime={runtime} />
        ) : format === "html" && runtime.detectedElements.length > 0 ? (
          <HtmlElementsResponse runtime={runtime} />
        ) : format === "csv" && runtime.rawResponse ? (
          <CsvResponse raw={runtime.rawResponse} runtime={runtime} />
        ) : format === "json" && runtime.rawResponse ? (
          <div className="bg-background max-h-[420px] overflow-auto rounded-lg border">
            <RawResponseViewer
              rawResponse={runtime.rawResponse}
              format="json"
              onPathClick={(p) => runtime.handlePathSelect(p, runtime.armedField ?? "pricePath")}
            />
          </div>
        ) : runtime.rawResponse ? (
          <div className="bg-background max-h-[420px] overflow-auto rounded-lg border">
            <RawResponseViewer rawResponse={runtime.rawResponse} format="html" />
          </div>
        ) : (
          <EmptyResponseState />
        )}
      </section>

      {/* Extraction preview — verifies the current mapping against the response */}
      {runtime.testResult && (
        <section className="space-y-2">
          <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {t("settings:market_data_page.extracted")}
          </Label>
          {runtime.testResult.success ? (
            <div className="border-success/30 bg-success/5 divide-success/20 divide-y rounded-lg border">
              <ExtractedRow
                color="bg-emerald-500"
                label={t("settings:market_data_page.field_price")}
                display={
                  runtime.testResult.price != null ? (
                    <span className="tabular-nums">
                      {runtime.testResult.price.toLocaleString()}
                      {runtime.testResult.currency && (
                        <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                          {runtime.testResult.currency}
                        </span>
                      )}
                    </span>
                  ) : null
                }
              />
              {values.datePath && (
                <ExtractedRow
                  color="bg-sky-500"
                  label={t("settings:market_data_page.field_as_of")}
                  display={
                    runtime.testResult.date ? (
                      <span className="font-mono text-xs">{runtime.testResult.date}</span>
                    ) : null
                  }
                />
              )}
              {values.openPath && (
                <ExtractedRow
                  color="bg-yellow-500"
                  label={t("settings:market_data_page.field_open")}
                  display={
                    runtime.testResult.open != null ? (
                      <span className="tabular-nums">
                        {runtime.testResult.open.toLocaleString()}
                      </span>
                    ) : null
                  }
                />
              )}
              {values.highPath && (
                <ExtractedRow
                  color="bg-orange-500"
                  label={t("settings:market_data_page.field_high")}
                  display={
                    runtime.testResult.high != null ? (
                      <span className="tabular-nums">
                        {runtime.testResult.high.toLocaleString()}
                      </span>
                    ) : null
                  }
                />
              )}
              {values.lowPath && (
                <ExtractedRow
                  color="bg-rose-500"
                  label={t("settings:market_data_page.field_low")}
                  display={
                    runtime.testResult.low != null ? (
                      <span className="tabular-nums">
                        {runtime.testResult.low.toLocaleString()}
                      </span>
                    ) : null
                  }
                />
              )}
              {values.volumePath && (
                <ExtractedRow
                  color="bg-violet-500"
                  label={t("settings:market_data_page.field_volume")}
                  display={
                    runtime.testResult.volume != null ? (
                      <span className="tabular-nums">
                        {runtime.testResult.volume.toLocaleString()}
                      </span>
                    ) : null
                  }
                />
              )}
              {values.currencyPath && (
                <ExtractedRow
                  color="bg-amber-500"
                  label={t("common:currency")}
                  display={
                    runtime.testResult.currency ? (
                      <span className="font-mono text-xs">{runtime.testResult.currency}</span>
                    ) : null
                  }
                />
              )}
            </div>
          ) : (
            <div className="border-destructive/30 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <Icons.XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                {runtime.testResult.error ?? t("settings:market_data_page.extraction_failed")}
              </p>
            </div>
          )}
        </section>
      )}

      {/* Field mapping */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {isHistorical
              ? t("settings:market_data_page.field_mapping_historical")
              : t("settings:market_data_page.field_mapping_latest")}
          </Label>
          <span className="text-muted-foreground text-[11px]">
            {t("settings:market_data_page.field_mapping_hint")}
          </span>
        </div>

        <div className="space-y-1.5">
          {MAPPING_META.slice(0, 2).map((m) => (
            <FieldMappingRow
              key={m.field}
              field={m.field}
              label={t(m.labelKey)}
              color={m.color}
              required={m.required}
              value={values[m.field]}
              armed={runtime.armedField === m.field}
              onArm={() => runtime.setArmedField(runtime.armedField === m.field ? null : m.field)}
            />
          ))}
        </div>

        <Collapsible open={moreFieldsOpen} onOpenChange={setMoreFieldsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-xs"
            >
              <Icons.ChevronRight
                className={cn("h-3 w-3 transition-transform", moreFieldsOpen && "rotate-90")}
              />
              {t("settings:market_data_page.more_mapping_fields")}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5">
            {MAPPING_META.slice(2).map((m) => {
              if (
                (m.field === "openPath" ||
                  m.field === "highPath" ||
                  m.field === "lowPath" ||
                  m.field === "volumePath") &&
                format !== "json" &&
                format !== "csv" &&
                format !== "html_table"
              ) {
                return null;
              }
              return (
                <FieldMappingRow
                  key={m.field}
                  field={m.field}
                  label={t(m.labelKey)}
                  color={m.color}
                  required={m.required}
                  value={values[m.field]}
                  armed={runtime.armedField === m.field}
                  onArm={() =>
                    runtime.setArmedField(runtime.armedField === m.field ? null : m.field)
                  }
                />
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  );
}
