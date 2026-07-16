import {
  parseCsv,
  listImportTemplates,
  getAccountImportMapping,
  linkAccountTemplate,
} from "@/adapters";
import { AccountSelector } from "@/components/account-selector";
import { AccountSelectorMobile } from "@/components/account-selector-mobile";
import { useAccounts } from "@/hooks/use-accounts";
import { usePlatform } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, ImportTemplateData } from "@/lib/types";
import { ImportType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { TemplatePicker } from "../components/template-picker";
import { SearchableSelect } from "@wealthfolio/ui";
import { DATE_FORMAT_OPTIONS, isPresetFormat } from "../utils/date-format-options";
import { computeFieldMappings } from "../hooks/use-import-mapping";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CSVFileViewer, type CSVLine } from "../components/csv-file-viewer";
import { FileDropzone } from "../components/file-dropzone";
import { HelpTooltip } from "../components/help-tooltip";
import {
  setAccountId,
  setFile,
  setMapping,
  setParseConfig,
  setParsedData,
  setSelectedTemplate,
  setSuppressLinkedTemplate,
} from "../context/import-actions";
import { useImportContext, type ParseConfig } from "../context/import-context";
import {
  createDefaultParseConfig,
  createDefaultActivityTemplate,
  createEmptyHoldingsMapping,
  isDefaultActivityTemplateId,
  prependDefaultActivityTemplate,
} from "../utils/default-activity-template";
import {
  getActivityImportProfile,
  isTransactionImportProfile,
  mergeActivityMappingsForImportProfile,
  sanitizeImportMappingForProfile,
} from "../utils/activity-import-profile";

// ─────────────────────────────────────────────────────────────────────────────
// CSV Preview Component
// ─────────────────────────────────────────────────────────────────────────────

interface CsvPreviewTableProps {
  headers: string[];
  rows: string[][];
  maxRows?: number;
}

function CsvPreviewTable({ headers, rows, maxRows = 50 }: CsvPreviewTableProps) {
  const { t } = useTranslation();
  const displayRows = rows.slice(0, maxRows);
  const hasMoreRows = rows.length > maxRows;

  return (
    <>
      <table className="w-full">
        <thead className="bg-muted sticky top-0">
          <tr>
            <th className="text-muted-foreground bg-muted w-12 border-r px-2 py-1.5 text-right font-mono text-xs">
              #
            </th>
            {headers.map((header, idx) => (
              <th
                key={idx}
                className="border-r px-2 py-1.5 text-left font-mono text-xs font-semibold last:border-r-0"
              >
                {header || (
                  <span className="text-muted-foreground italic">
                    {t("activity:import.csvViewer.empty")}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {displayRows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className={cn(
                "border-t transition-colors",
                rowIdx % 2 === 0 ? "bg-background" : "bg-muted/30",
                "hover:bg-muted/50",
              )}
            >
              <td className="text-muted-foreground bg-muted/20 w-12 border-r px-2 py-1 text-right">
                {rowIdx + 1}
              </td>
              {row.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  className="max-w-[200px] truncate border-r px-2 py-1 last:border-r-0"
                  title={cell}
                >
                  {cell || <span className="text-muted-foreground italic">-</span>}
                </td>
              ))}
              {row.length < headers.length &&
                Array.from({ length: headers.length - row.length }).map((_, idx) => (
                  <td key={`empty-${idx}`} className="border-r px-2 py-1 last:border-r-0">
                    <span className="text-muted-foreground italic">-</span>
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMoreRows && (
        <div className="text-muted-foreground border-t px-3 py-2 text-center text-xs">
          {t("activity:import.upload.showingFirstRows", { max: maxRows, total: rows.length })}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Preview Tabs Component
// ─────────────────────────────────────────────────────────────────────────────

function CsvPreviewTabs({
  file,
  headers,
  rows,
}: {
  file: File;
  headers: string[];
  rows: string[][];
}) {
  const { t } = useTranslation();
  const [csvLines, setCsvLines] = useState<CSVLine[] | null>(null);

  const handleTabChange = useCallback(
    (value: string) => {
      if (value === "raw" && csvLines === null) {
        file.text().then((text) => {
          const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
          setCsvLines(lines.map((line, i) => ({ id: i, content: line, isValid: true })));
        });
      }
    },
    [file, csvLines],
  );

  return (
    <Tabs defaultValue="parsed" onValueChange={handleTabChange}>
      <Card>
        <CardHeader className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">
                {t("activity:import.upload.csvPreview")}
              </CardTitle>
              <span className="text-muted-foreground text-xs">
                {t("activity:import.upload.rows", { count: rows.length })}
              </span>
            </div>
            <TabsList className="bg-secondary flex space-x-1 rounded-full p-1">
              <TabsTrigger className="h-8 rounded-full px-2 text-sm" value="parsed">
                {t("activity:import.upload.parsed")}
              </TabsTrigger>
              <TabsTrigger className="h-8 rounded-full px-2 text-sm" value="raw">
                {t("activity:import.upload.rawFile")}
              </TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <TabsContent value="parsed" className="m-0 border-0 p-0">
            <div className="max-h-[300px] overflow-auto border-t">
              <CsvPreviewTable headers={headers} rows={rows} maxRows={50} />
            </div>
          </TabsContent>
          <TabsContent value="raw" className="m-0 border-0 p-0">
            <CSVFileViewer data={csvLines ?? []} className="w-full" maxHeight="50vh" />
          </TabsContent>
        </CardContent>
      </Card>
    </Tabs>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Date Format Picker (searchable select + custom input)
// ─────────────────────────────────────────────────────────────────────────────

const dateFormatSelectOptions = DATE_FORMAT_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
}));

function DateFormatPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (config: Partial<ParseConfig>) => void;
}) {
  const { t } = useTranslation();
  const DATE_FORMAT_SELECT_OPTIONS = useMemo(
    () => [
      ...dateFormatSelectOptions,
      { value: "__custom__", label: t("activity:import.parseSettings.custom") },
    ],
    [t],
  );
  const isCustom = value !== "__custom__" && !isPresetFormat(value) && value !== "";
  const [showCustom, setShowCustom] = useState(isCustom);
  const [customValue, setCustomValue] = useState(isCustom ? value : "");

  const selectValue = showCustom ? "__custom__" : value;

  return (
    <div className="space-y-1.5">
      <Label className="text-muted-foreground text-xs">
        {t("activity:import.parseSettings.dateFormat")}
      </Label>
      <SearchableSelect
        options={DATE_FORMAT_SELECT_OPTIONS}
        value={selectValue}
        onValueChange={(v) => {
          if (v === "__custom__") {
            setShowCustom(true);
            if (customValue) {
              onChange({ dateFormat: customValue });
            }
          } else {
            setShowCustom(false);
            onChange({ dateFormat: v });
          }
        }}
        placeholder={t("activity:import.parseSettings.selectDateFormat")}
        searchPlaceholder={t("activity:import.parseSettings.searchFormats")}
        emptyMessage={t("activity:import.parseSettings.noMatchingFormat")}
      />
      {showCustom && (
        <Input
          placeholder={t("activity:import.parseSettings.customDatePlaceholder")}
          value={customValue}
          onChange={(e) => {
            const v = e.target.value;
            setCustomValue(v);
            if (v.trim()) {
              onChange({ dateFormat: v.trim() });
            }
          }}
          className="h-8 font-mono text-xs"
        />
      )}
    </div>
  );
}

// Format config value for display
function formatConfigValue(t: TFunction, key: string, value: string | number | boolean): string {
  if (key === "delimiter") {
    const delimiterLabels: Record<string, string> = {
      auto: t("activity:import.parseSettings.valueAuto"),
      ",": t("activity:import.parseSettings.valueComma"),
      ";": t("activity:import.parseSettings.valueSemicolon"),
      "\t": t("activity:import.parseSettings.valueTab"),
    };
    return delimiterLabels[value as string] || String(value);
  }
  if (key === "dateFormat") {
    return value === "auto" ? t("activity:import.parseSettings.valueAuto") : String(value);
  }
  if (key === "decimalSeparator") {
    const decimalLabels: Record<string, string> = {
      auto: t("activity:import.parseSettings.valueAuto"),
      ".": t("activity:import.parseSettings.valuePeriod"),
      ",": t("activity:import.parseSettings.valueComma"),
    };
    return decimalLabels[value as string] || String(value);
  }
  return String(value);
}

// Build compact summary of parse settings
function buildConfigSummary(t: TFunction, config: ParseConfig): string {
  const parts: string[] = [];

  if (config.delimiter && config.delimiter !== "auto") {
    parts.push(
      t("activity:import.parseSettings.summaryDelimiter", {
        value: formatConfigValue(t, "delimiter", config.delimiter),
      }),
    );
  }
  if (config.dateFormat && config.dateFormat !== "auto") {
    parts.push(t("activity:import.parseSettings.summaryDate", { value: config.dateFormat }));
  }
  if (config.decimalSeparator && config.decimalSeparator !== "auto") {
    parts.push(
      t("activity:import.parseSettings.summaryDecimal", {
        value: formatConfigValue(t, "decimalSeparator", config.decimalSeparator),
      }),
    );
  }
  if (config.skipTopRows > 0) {
    parts.push(t("activity:import.parseSettings.summarySkipTop", { count: config.skipTopRows }));
  }
  if (config.skipBottomRows > 0) {
    parts.push(
      t("activity:import.parseSettings.summarySkipBottom", { count: config.skipBottomRows }),
    );
  }
  if (!config.hasHeaderRow) {
    parts.push(t("activity:import.parseSettings.summaryNoHeader"));
  }

  return parts.length > 0 ? parts.join(" · ") : t("activity:import.parseSettings.autoDetect");
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Selector Component (includes Parse Settings)
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateSelectorProps {
  templates: ImportTemplateData[];
  selectedTemplateId: string | null;
  onSelect: (templateId: string) => void;
  onClear?: () => void;
  config: ParseConfig;
  onConfigChange: (updates: Partial<ParseConfig>) => void;
  hasConfigErrors?: boolean;
}

function TemplateSelector({
  templates,
  selectedTemplateId,
  onSelect,
  onClear,
  config,
  onConfigChange,
  hasConfigErrors = false,
}: TemplateSelectorProps) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(hasConfigErrors);

  useEffect(() => {
    if (hasConfigErrors) setSettingsOpen(true);
  }, [hasConfigErrors]);

  const configSummary = buildConfigSummary(t, config);

  return (
    <div className="bg-muted/20 rounded-lg border">
      {/* Template picker row */}
      <div className="p-3">
        <TemplatePicker
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onSelect={onSelect}
          onClear={onClear}
        />
      </div>

      {/* Parse Settings — collapsible */}
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
        <CollapsibleTrigger asChild>
          <div
            className={cn(
              "hover:bg-muted/40 flex cursor-pointer items-center justify-between px-3 py-2 transition-colors",
              "border-t",
            )}
          >
            <div className="flex items-center gap-2">
              <Icons.Settings2 className="text-muted-foreground h-3.5 w-3.5" />
              <span className="text-muted-foreground text-xs font-medium">
                {t("activity:import.parseSettings.title")}
              </span>
              {hasConfigErrors && (
                <span className="bg-destructive/10 text-destructive rounded-full px-2 py-px text-[10px]">
                  {t("activity:import.parseSettings.adjustToFix")}
                </span>
              )}
              {!settingsOpen && !hasConfigErrors && (
                <span className="text-muted-foreground text-[11px]">{configSummary}</span>
              )}
            </div>
            <Icons.ChevronDown
              className={cn(
                "text-muted-foreground h-3.5 w-3.5 transition-transform duration-200",
                settingsOpen && "rotate-180",
              )}
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-3 pb-4 pt-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {/* Header row checkbox spans full width on mobile */}
              <div className="col-span-2 flex items-center gap-2 sm:col-span-3">
                <Checkbox
                  id="hasHeaderRow"
                  checked={config.hasHeaderRow}
                  onCheckedChange={(checked) => onConfigChange({ hasHeaderRow: checked === true })}
                />
                <Label htmlFor="hasHeaderRow" className="cursor-pointer text-sm">
                  {t("activity:import.parseSettings.firstRowHeader")}
                </Label>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skipTopRows" className="text-muted-foreground text-xs">
                  {t("activity:import.parseSettings.skipTopRows")}
                </Label>
                <Input
                  id="skipTopRows"
                  type="number"
                  min={0}
                  value={config.skipTopRows}
                  onChange={(e) =>
                    onConfigChange({ skipTopRows: Math.max(0, parseInt(e.target.value) || 0) })
                  }
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="skipBottomRows" className="text-muted-foreground text-xs">
                  {t("activity:import.parseSettings.skipBottomRows")}
                </Label>
                <Input
                  id="skipBottomRows"
                  type="number"
                  min={0}
                  value={config.skipBottomRows}
                  onChange={(e) =>
                    onConfigChange({ skipBottomRows: Math.max(0, parseInt(e.target.value) || 0) })
                  }
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="delimiter" className="text-muted-foreground text-xs">
                  {t("activity:import.parseSettings.delimiter")}
                </Label>
                <Select
                  value={config.delimiter}
                  onValueChange={(value) => onConfigChange({ delimiter: value })}
                >
                  <SelectTrigger id="delimiter" className="h-8 text-sm">
                    <SelectValue placeholder={t("activity:import.parseSettings.selectDelimiter")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t("activity:import.parseSettings.delimiterAuto")}
                    </SelectItem>
                    <SelectItem value=",">
                      {t("activity:import.parseSettings.delimiterComma")}
                    </SelectItem>
                    <SelectItem value=";">
                      {t("activity:import.parseSettings.delimiterSemicolon")}
                    </SelectItem>
                    <SelectItem value="\t">
                      {t("activity:import.parseSettings.delimiterTab")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DateFormatPicker value={config.dateFormat} onChange={onConfigChange} />

              <div className="space-y-1.5">
                <Label htmlFor="decimalSeparator" className="text-muted-foreground text-xs">
                  {t("activity:import.parseSettings.decimalSeparator")}
                </Label>
                <Select
                  value={config.decimalSeparator}
                  onValueChange={(value) => onConfigChange({ decimalSeparator: value })}
                >
                  <SelectTrigger id="decimalSeparator" className="h-8 text-sm">
                    <SelectValue placeholder={t("activity:import.parseSettings.selectSeparator")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t("activity:import.parseSettings.decimalAuto")}
                    </SelectItem>
                    <SelectItem value=".">
                      {t("activity:import.parseSettings.decimalPeriod")}
                    </SelectItem>
                    <SelectItem value=",">
                      {t("activity:import.parseSettings.decimalComma")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload Step Component
// ─────────────────────────────────────────────────────────────────────────────

export function UploadStep() {
  const { state, dispatch } = useImportContext();
  const { t } = useTranslation();
  const [parseError, setParseError] = useState<string | null>(null);
  const { accounts } = useAccounts();
  const { isMobile } = usePlatform();

  // Derive import type from the selected account's tracking mode
  const selectedAccount = useMemo(
    () => accounts?.find((a: Account) => a.id === state.accountId) ?? null,
    [accounts, state.accountId],
  );
  const importProfile = useMemo(() => getActivityImportProfile(selectedAccount), [selectedAccount]);
  const importType =
    selectedAccount?.trackingMode === "HOLDINGS" ? ImportType.HOLDINGS : ImportType.ACTIVITY;
  const baselineParseConfig = useMemo(
    () => createDefaultParseConfig(selectedAccount?.currency),
    [selectedAccount?.currency],
  );

  // Templates — filtered by the active import kind
  const { data: allTemplates = [] } = useQuery<ImportTemplateData[], Error>({
    queryKey: [QueryKeys.IMPORT_TEMPLATES],
    queryFn: listImportTemplates,
  });
  const templates = useMemo(
    () =>
      importType === ImportType.ACTIVITY
        ? prependDefaultActivityTemplate(
            allTemplates.filter((t) => t.kind === importType),
            importProfile,
          )
        : allTemplates.filter((t) => t.kind === importType),
    [allTemplates, importProfile, importType],
  );
  const effectiveSelectedTemplateId =
    importType === ImportType.ACTIVITY
      ? (state.selectedTemplateId ?? templates[0]?.id ?? null)
      : state.selectedTemplateId;

  const applyTemplate = useCallback(
    async (template: ImportTemplateData, options?: { selectTemplate?: boolean }) => {
      const selectTemplate = options?.selectTemplate ?? true;
      const nextParseConfig =
        importType === ImportType.ACTIVITY && isDefaultActivityTemplateId(template.id)
          ? baselineParseConfig
          : template.parseConfig
            ? { ...state.parseConfig, ...template.parseConfig }
            : state.parseConfig;

      dispatch(setParseConfig(nextParseConfig));

      // Re-parse with the template's config to get fresh headers, then compute mappings
      // so auto-detected columns (e.g., ISIN) are merged with the saved template mappings.
      let headers = state.headers;
      if (state.file) {
        try {
          const result = await parseCsv(state.file, nextParseConfig);
          setParseError(null);
          dispatch(setParsedData(result.headers, result.rows));
          dispatch(setParseConfig(result.detectedConfig));
          headers = result.headers;
        } catch (err) {
          setParseError(
            err instanceof Error ? err.message : t("activity:import.upload.failedToReparse"),
          );
        }
      }

      dispatch(
        setMapping(
          sanitizeImportMappingForProfile(
            {
              accountId: state.accountId || "",
              importType,
              name: isDefaultActivityTemplateId(template.id) ? "" : template.name,
              fieldMappings: computeFieldMappings(headers, template.fieldMappings, importProfile),
              activityMappings: isTransactionImportProfile(importProfile)
                ? mergeActivityMappingsForImportProfile(template.activityMappings, importProfile)
                : template.activityMappings,
              symbolMappings: template.symbolMappings,
              accountMappings: template.accountMappings || {},
              symbolMappingMeta: template.symbolMappingMeta || {},
              parseConfig: template.parseConfig,
            },
            importProfile,
          ),
        ),
      );
      if (selectTemplate) {
        dispatch(setSelectedTemplate(template.id, template.scope));
      }
    },
    [
      baselineParseConfig,
      dispatch,
      importProfile,
      importType,
      state.accountId,
      state.file,
      state.parseConfig,
      state.headers,
      t,
    ],
  );

  const handleTemplateSelect = useCallback(
    async (templateId: string) => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) return;
      dispatch(setSuppressLinkedTemplate(false));
      await applyTemplate(template);
      if (state.accountId && !isDefaultActivityTemplateId(template.id)) {
        linkAccountTemplate(state.accountId, templateId, importType).catch(() => {
          /* non-critical */
        });
      }
    },
    [applyTemplate, importType, state.accountId, templates],
  );

  const handleTemplateClear = useCallback(() => {
    dispatch(setSuppressLinkedTemplate(true));
    dispatch(setSelectedTemplate(null, null));

    if (importType === ImportType.ACTIVITY) {
      void applyTemplate(createDefaultActivityTemplate(importProfile), { selectTemplate: false });
      return;
    }

    dispatch(setParseConfig(baselineParseConfig));
    dispatch(setMapping(createEmptyHoldingsMapping(state.accountId || "")));
    if (state.file) {
      parseCsv(state.file, baselineParseConfig)
        .then((result) => {
          setParseError(null);
          dispatch(setParsedData(result.headers, result.rows));
          dispatch(setParseConfig(result.detectedConfig));
        })
        .catch((error) => {
          setParseError(
            error instanceof Error ? error.message : t("activity:import.upload.failedToParse"),
          );
        });
    }
  }, [
    applyTemplate,
    baselineParseConfig,
    dispatch,
    importProfile,
    importType,
    state.accountId,
    state.file,
    t,
  ]);

  // Auto-suggest linked template when account changes.
  // Two-phase approach: fetch the linked template ID, then apply once templates are loaded.
  const [pendingLinkedTemplateId, setPendingLinkedTemplateId] = useState<string | null>(null);
  const prevAccountIdRef = useRef(state.accountId);
  useEffect(() => {
    const accountChanged = prevAccountIdRef.current !== state.accountId;
    prevAccountIdRef.current = state.accountId;
    if (accountChanged) {
      setPendingLinkedTemplateId(null);
      // Clear the previous account's template so the new account's linked template can apply
      dispatch(setSelectedTemplate(null, null));
      dispatch(setSuppressLinkedTemplate(false));
      if (importType === ImportType.ACTIVITY) {
        void applyTemplate(createDefaultActivityTemplate(importProfile), { selectTemplate: false });
      } else {
        dispatch(setParseConfig(baselineParseConfig));
        dispatch(setMapping(createEmptyHoldingsMapping(state.accountId || "")));
        if (state.file) {
          parseCsv(state.file, baselineParseConfig)
            .then((result) => {
              setParseError(null);
              dispatch(setParsedData(result.headers, result.rows));
              dispatch(setParseConfig(result.detectedConfig));
            })
            .catch((error) => {
              setParseError(
                error instanceof Error ? error.message : t("activity:import.upload.failedToParse"),
              );
            });
        }
      }
    }
    // Skip if no account, or if a template is already selected and the account hasn't changed
    if (
      !state.accountId ||
      state.suppressLinkedTemplate ||
      (state.selectedTemplateId && !accountChanged)
    ) {
      return;
    }
    getAccountImportMapping(state.accountId, importType)
      .then((mapping) => {
        setPendingLinkedTemplateId(mapping?.templateId ?? null);
      })
      .catch(() => {
        /* no saved mapping — ignore */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyTemplate,
    baselineParseConfig,
    dispatch,
    importProfile,
    importType,
    state.accountId,
    state.file,
    state.selectedTemplateId,
    state.suppressLinkedTemplate,
  ]);

  // Apply the pending linked template once the template list is available
  const applyTemplateRef = useRef(applyTemplate);
  applyTemplateRef.current = applyTemplate;
  useEffect(() => {
    if (!pendingLinkedTemplateId || state.selectedTemplateId) return;
    const linked = templates.find((t) => t.id === pendingLinkedTemplateId);
    if (linked) {
      setPendingLinkedTemplateId(null);
      applyTemplateRef.current(linked).catch(() => {
        /* non-critical */
      });
    }
  }, [pendingLinkedTemplateId, templates, state.selectedTemplateId]);

  const fileRef = useRef(state.file);
  fileRef.current = state.file;
  const parseConfigRef = useRef(state.parseConfig);
  parseConfigRef.current = state.parseConfig;

  useEffect(() => {
    if (!selectedAccount || state.parseConfig.defaultCurrency === selectedAccount.currency) {
      return;
    }

    const updates: Partial<ParseConfig> = {
      defaultCurrency: selectedAccount.currency,
    };
    dispatch(setParseConfig(updates));

    if (fileRef.current) {
      const newConfig = { ...parseConfigRef.current, ...updates };
      parseCsv(fileRef.current, newConfig)
        .then((result) => {
          setParseError(null);
          dispatch(setParsedData(result.headers, result.rows));
        })
        .catch((error) => {
          setParseError(
            error instanceof Error ? error.message : t("activity:import.upload.failedToParse"),
          );
        });
    }
  }, [dispatch, selectedAccount, state.parseConfig.defaultCurrency, t]);

  const handleAccountSelect = useCallback(
    (account: Account) => {
      dispatch(setAccountId(account.id));
    },
    [dispatch],
  );

  const { mutate: parseFile, isPending } = useMutation({
    mutationFn: (file: File) => parseCsv(file, state.parseConfig),
    onSuccess: (result) => {
      setParseError(null);
      dispatch(setParsedData(result.headers, result.rows));
      dispatch(setParseConfig(result.detectedConfig));
    },
    onError: (error) => {
      setParseError(
        error instanceof Error ? error.message : t("activity:import.upload.failedToParse"),
      );
    },
  });

  const handleFileSelect = useCallback(
    (file: File | null) => {
      if (file) {
        dispatch(setFile(file));
        parseFile(file);
      } else {
        dispatch(setFile(null as unknown as File));
        dispatch(setParsedData([], []));
      }
    },
    [dispatch, parseFile],
  );

  const handleConfigChange = useCallback(
    (updates: Partial<ParseConfig>) => {
      dispatch(setParseConfig(updates));
      if (state.file) {
        const newConfig = { ...state.parseConfig, ...updates };
        parseCsv(state.file, newConfig)
          .then((result) => {
            setParseError(null);
            dispatch(setParsedData(result.headers, result.rows));
          })
          .catch((error) => {
            setParseError(
              error instanceof Error ? error.message : t("activity:import.upload.failedToParse"),
            );
          });
      }
    },
    [dispatch, state.file, state.parseConfig, t],
  );

  const hasParseErrors = parseError !== null;

  return (
    <div className="flex flex-col gap-4">
      {/* Primary actions: Account + File upload */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Account */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-mono text-[10px] tabular-nums">01</span>
            <h2 className="text-sm font-semibold">{t("activity:import.upload.selectAccount")}</h2>
            <HelpTooltip content={t("activity:import.upload.selectAccountHelp")} />
          </div>
          <div className="h-[116px]">
            {isMobile ? (
              <div
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-3 rounded-lg border p-4 transition-colors",
                  selectedAccount
                    ? "border-border bg-background"
                    : "border-border bg-background/50 hover:border-muted-foreground/50 hover:bg-background/80 border-dashed",
                )}
              >
                {selectedAccount ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Icons.Briefcase className="text-primary h-5 w-5" />
                      <div className="text-center">
                        <p className="text-sm font-medium">{selectedAccount.name}</p>
                        <p className="text-muted-foreground text-xs">{selectedAccount.currency}</p>
                      </div>
                    </div>
                    <AccountSelectorMobile
                      setSelectedAccount={handleAccountSelect}
                      includePortfolio={false}
                      iconOnly={false}
                    />
                  </>
                ) : (
                  <>
                    <Icons.Briefcase className="text-muted-foreground h-8 w-8" />
                    <p className="text-muted-foreground text-center text-sm">
                      {t("activity:import.upload.noAccountSelected")}
                    </p>
                    <AccountSelectorMobile
                      setSelectedAccount={handleAccountSelect}
                      includePortfolio={false}
                      iconOnly={false}
                    />
                  </>
                )}
              </div>
            ) : (
              <AccountSelector
                selectedAccount={selectedAccount}
                setSelectedAccount={handleAccountSelect}
              />
            )}
          </div>
        </div>

        {/* File upload */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground font-mono text-[10px] tabular-nums">02</span>
            <h2 className="text-sm font-semibold">{t("activity:import.upload.uploadCsv")}</h2>
            <HelpTooltip content={t("activity:import.upload.uploadCsvHelp")} />
          </div>
          <div className="h-[116px]">
            <FileDropzone
              file={state.file}
              onFileChange={handleFileSelect}
              isLoading={isPending}
              accept=".csv"
              isValid={!hasParseErrors}
              error={parseError}
            />
          </div>
        </div>
      </div>

      {/* Select Format */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">03</span>
          <h2 className="text-sm font-semibold">{t("activity:import.upload.selectFormat")}</h2>
          <span className="text-muted-foreground rounded border px-1.5 py-px text-[10px] leading-none">
            {t("activity:import.upload.optional")}
          </span>
        </div>
        <TemplateSelector
          templates={templates}
          selectedTemplateId={effectiveSelectedTemplateId}
          onSelect={handleTemplateSelect}
          onClear={
            isDefaultActivityTemplateId(effectiveSelectedTemplateId)
              ? undefined
              : handleTemplateClear
          }
          config={state.parseConfig}
          onConfigChange={handleConfigChange}
          hasConfigErrors={hasParseErrors}
        />
      </div>

      {/* CSV Preview */}
      {state.file && state.headers.length > 0 && (
        <CsvPreviewTabs file={state.file} headers={state.headers} rows={state.parsedRows} />
      )}
    </div>
  );
}
