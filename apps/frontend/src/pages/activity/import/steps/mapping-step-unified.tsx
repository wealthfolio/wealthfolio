import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAccounts,
  deleteImportTemplate,
  listImportTemplates,
  parseCsv,
  saveImportTemplate,
} from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CSVFileViewer } from "../components/csv-file-viewer";
import { ImportAlert } from "../components/import-alert";
import { MappingTable } from "../components/mapping-table";
import {
  setMapping,
  setParseConfig,
  setParsedData,
  setSelectedTemplate,
  setSuppressLinkedTemplate,
  useImportContext,
} from "../context";
import { TemplatePicker } from "../components/template-picker";
import { computeFieldMappings, useImportMapping } from "../hooks/use-import-mapping";
import { ACTIVITY_SKIP, isFieldMapped } from "../utils/draft-utils";
import { validateTickerSymbol, findMappedActivityType } from "../utils/validation-utils";
import {
  createDefaultActivityMapping,
  createDefaultParseConfig,
  isDefaultActivityTemplateId,
  prependDefaultActivityTemplate,
} from "../utils/default-activity-template";
import { mergeDetectedParseConfig } from "../utils/import-flow-utils";
import {
  activityTypeAllowedForImportProfile,
  getActivityImportProfileForImportContext,
  getActivityTypeLabelForImportProfile,
  isTransactionImportProfile,
  mergeActivityMappingsForImportProfile,
  sanitizeImportMappingForProfile,
} from "../utils/activity-import-profile";

import { isCashSymbol, needsImportAssetResolution } from "@/lib/activity-utils";
import { ImportFormat, type ActivityType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, CsvRowData, ImportTemplateData } from "@/lib/types";
import { ImportType } from "@/lib/types";

export function MappingStepUnified() {
  const { state, dispatch } = useImportContext();
  const { t } = useTranslation();
  const { headers, parsedRows, mapping, accountId } = state;
  const queryClient = useQueryClient();
  const [templateName, setTemplateName] = useState(mapping?.name ?? "");
  const [templateError, setTemplateError] = useState<string | null>(null);

  // Fetch accounts
  const { data: accounts = [] } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === accountId) ?? null,
    [accountId, accounts],
  );
  const initialImportProfile = useMemo(
    () =>
      getActivityImportProfileForImportContext({
        defaultAccountId: accountId,
        accounts,
      }),
    [accountId, accounts],
  );
  const baselineParseConfig = useMemo(
    () => createDefaultParseConfig(selectedAccount?.currency),
    [selectedAccount?.currency],
  );

  // Convert string[][] to CsvRowData[]
  const data: CsvRowData[] = useMemo(() => {
    return parsedRows.map((row, index) => {
      const rowData: CsvRowData = { lineNumber: String(index + 1) };
      headers.forEach((header, colIndex) => {
        rowData[header] = row[colIndex] || "";
      });
      return rowData;
    });
  }, [parsedRows, headers]);

  // Use the import mapping hook
  const {
    mapping: localMapping,
    updateMapping,
    handleColumnMapping,
    handleActivityTypeMapping,
    handleSymbolMapping,
    handleAccountIdMapping,
  } = useImportMapping({
    accountId,
    defaultMapping: mapping || createDefaultActivityMapping(accountId || "", initialImportProfile),
  });

  const importProfile = useMemo(
    () =>
      getActivityImportProfileForImportContext({
        defaultAccountId: accountId,
        accounts,
        headers,
        parsedRows,
        fieldMappings: localMapping.fieldMappings,
        accountMappings: localMapping.accountMappings,
      }),
    [
      accountId,
      accounts,
      headers,
      localMapping.accountMappings,
      localMapping.fieldMappings,
      parsedRows,
    ],
  );
  const getActivityTypeLabel = useCallback(
    (activityType: ActivityType) =>
      getActivityTypeLabelForImportProfile(activityType, importProfile, t),
    [importProfile, t],
  );

  const effectiveActivityMappings = useMemo(
    () =>
      isTransactionImportProfile(importProfile)
        ? mergeActivityMappingsForImportProfile(localMapping.activityMappings, importProfile)
        : localMapping.activityMappings,
    [importProfile, localMapping.activityMappings],
  );

  const displayMapping = useMemo(
    () =>
      effectiveActivityMappings === localMapping.activityMappings
        ? localMapping
        : { ...localMapping, activityMappings: effectiveActivityMappings },
    [effectiveActivityMappings, localMapping],
  );

  const { data: allTemplates = [] } = useQuery<ImportTemplateData[], Error>({
    queryKey: [QueryKeys.IMPORT_TEMPLATES],
    queryFn: listImportTemplates,
  });
  const templates = useMemo(
    () =>
      prependDefaultActivityTemplate(
        allTemplates.filter((t) => t.kind === ImportType.ACTIVITY),
        importProfile,
      ),
    [allTemplates, importProfile],
  );
  const effectiveSelectedTemplateId = state.selectedTemplateId ?? templates[0]?.id ?? null;

  // Sync localMapping to context whenever it changes (covers auto-detection, user edits, etc.)
  useEffect(() => {
    dispatch(setMapping(localMapping));
  }, [localMapping, dispatch]);

  useEffect(() => {
    setTemplateName(localMapping.name ?? "");
  }, [localMapping.name]);

  // Helper to get mapped value from row (supports fallback columns)
  const getMappedValue = useCallback(
    (row: CsvRowData, field: ImportFormat): string => {
      const mapping = localMapping.fieldMappings[field];
      if (!mapping) return "";
      if (Array.isArray(mapping)) {
        for (const h of mapping) {
          const val = row[h]?.trim();
          if (val) return val;
        }
        return "";
      }
      return row[mapping] || "";
    },
    [localMapping.fieldMappings],
  );

  // Check if all required fields are mapped
  const requiredFieldsMapped = importProfile.requiredMappingFields.every((field) =>
    isFieldMapped(localMapping.fieldMappings[field], headers),
  );

  // Count how many fields are mapped
  const visibleFieldSet = useMemo(
    () => new Set(importProfile.visibleMappingFields),
    [importProfile.visibleMappingFields],
  );
  const mappedFieldsCount = Object.entries(localMapping.fieldMappings).filter(
    ([field, headerName]) =>
      visibleFieldSet.has(field as ImportFormat) && isFieldMapped(headerName, headers),
  ).length;
  const totalFields = importProfile.visibleMappingFields.length;

  // Symbols validation — skip rows where symbol is not required
  const { distinctSymbols, invalidSymbols } = useMemo(() => {
    const needed = new Set<string>();
    const invalid = new Set<string>();

    if (!importProfile.assetResolutionEnabled) {
      return { distinctSymbols: [], invalidSymbols: [] };
    }

    data.forEach((row) => {
      const symbol = getMappedValue(row, ImportFormat.SYMBOL)?.trim();
      if (!symbol) return;

      const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE)?.trim();
      const csvSubtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
      const appType = csvType
        ? findMappedActivityType(csvType, effectiveActivityMappings || {})
        : null;

      if (appType && (!needsImportAssetResolution(appType, csvSubtype) || isCashSymbol(symbol))) {
        return;
      }

      needed.add(symbol);
      if (!validateTickerSymbol(symbol)) invalid.add(symbol);
    });

    return {
      distinctSymbols: Array.from(needed),
      invalidSymbols: Array.from(invalid),
    };
  }, [data, effectiveActivityMappings, getMappedValue, importProfile.assetResolutionEnabled]);

  // Account ID mappings
  const distinctAccountIds = useMemo(() => {
    if (!localMapping.fieldMappings[ImportFormat.ACCOUNT]) return [];
    return Array.from(
      new Set(
        data.map((row) => getMappedValue(row, ImportFormat.ACCOUNT)?.trim() || "").filter(Boolean),
      ),
    );
  }, [data, localMapping.fieldMappings, getMappedValue]);

  const validAccountIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);
  const invalidAccounts = useMemo(() => {
    return distinctAccountIds.filter(
      (account) => !validAccountIds.has(account) && !localMapping.accountMappings?.[account],
    );
  }, [distinctAccountIds, localMapping.accountMappings, validAccountIds]);

  const missingAccountRowsCount = useMemo(() => {
    if (
      !localMapping.fieldMappings[ImportFormat.ACCOUNT] ||
      accountId ||
      localMapping.accountMappings?.[""]
    ) {
      return 0;
    }

    return data.reduce((count, row) => {
      return getMappedValue(row, ImportFormat.ACCOUNT)?.trim() ? count : count + 1;
    }, 0);
  }, [accountId, data, getMappedValue, localMapping.accountMappings, localMapping.fieldMappings]);

  const missingAccountRows = useMemo(() => {
    if (
      !localMapping.fieldMappings[ImportFormat.ACCOUNT] ||
      accountId ||
      localMapping.accountMappings?.[""]
    ) {
      return [];
    }

    return data.filter((row) => !getMappedValue(row, ImportFormat.ACCOUNT)?.trim());
  }, [accountId, data, getMappedValue, localMapping.accountMappings, localMapping.fieldMappings]);

  // Activity type mappings
  const { distinctActivityTypes, totalRows } = useMemo(() => {
    const activityTypeMap = new Map<string, { row: CsvRowData; count: number }>();
    let total = 0;

    data.forEach((row) => {
      const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE);
      if (!csvType) return;

      const normalizedCsvType = csvType.trim();
      if (!activityTypeMap.has(normalizedCsvType)) {
        activityTypeMap.set(normalizedCsvType, { row, count: 1 });
      } else {
        const current = activityTypeMap.get(normalizedCsvType)!;
        activityTypeMap.set(normalizedCsvType, { ...current, count: current.count + 1 });
      }
      total++;
    });

    return {
      distinctActivityTypes: Array.from(activityTypeMap.entries()).map(([type, d]) => ({
        csvType: type,
        row: d.row,
        count: d.count,
        appType: (() => {
          const mapped = findMappedActivityType(type, effectiveActivityMappings || {}) as
            | string
            | null;
          return mapped === ACTIVITY_SKIP ||
            activityTypeAllowedForImportProfile(mapped, importProfile)
            ? mapped
            : null;
        })(),
      })),
      totalRows: total,
    };
  }, [data, effectiveActivityMappings, getMappedValue, importProfile]);

  // Count unmapped items
  const activitiesToMapCount = useMemo(() => {
    return distinctActivityTypes.filter((activity) => !activity.appType).length;
  }, [distinctActivityTypes]);

  const accountsToMapCount = useMemo(() => {
    if (!localMapping.fieldMappings[ImportFormat.ACCOUNT]) return 0;
    return invalidAccounts.length;
  }, [localMapping.fieldMappings, invalidAccounts]);

  const accountsReady = useMemo(() => {
    if (localMapping.fieldMappings[ImportFormat.ACCOUNT]) {
      return accountsToMapCount === 0 && missingAccountRowsCount === 0;
    }

    return Boolean(accountId);
  }, [accountId, accountsToMapCount, localMapping.fieldMappings, missingAccountRowsCount]);

  const accountsDescription = useMemo(() => {
    if (!localMapping.fieldMappings[ImportFormat.ACCOUNT]) {
      return accountId
        ? t("activity:import.mapping.usingSelectedAccount")
        : t("activity:import.mapping.selectDefaultOrColumn");
    }

    if (missingAccountRowsCount > 0) {
      return t("activity:import.mapping.missingAccountRows", { count: missingAccountRowsCount });
    }

    if (localMapping.fieldMappings[ImportFormat.ACCOUNT] && localMapping.accountMappings?.[""]) {
      return t("activity:import.mapping.blankAccountRowsAssigned");
    }

    if (distinctAccountIds.length > 0) {
      return t("activity:import.mapping.mappedCount", {
        mapped: distinctAccountIds.length - accountsToMapCount,
        total: distinctAccountIds.length,
      });
    }

    return accountId
      ? t("activity:import.mapping.usingSelectedForAll")
      : t("activity:import.mapping.noUnmappedAccountIds");
  }, [
    accountId,
    accountsToMapCount,
    distinctAccountIds.length,
    localMapping.accountMappings,
    localMapping.fieldMappings,
    missingAccountRowsCount,
    t,
  ]);

  const symbolsToMapCount = useMemo(() => {
    if (!importProfile.assetResolutionEnabled) return 0;

    const unresolved = new Set<string>();
    data.forEach((row) => {
      const symbol = getMappedValue(row, ImportFormat.SYMBOL)?.trim();
      if (!symbol) return;

      const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE)?.trim();
      const csvSubtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
      const appType = csvType
        ? findMappedActivityType(csvType, effectiveActivityMappings || {})
        : null;

      if (appType && (!needsImportAssetResolution(appType, csvSubtype) || isCashSymbol(symbol))) {
        return;
      }
      if (validateTickerSymbol(symbol) || localMapping.symbolMappings?.[symbol]) return;
      unresolved.add(symbol);
    });
    return unresolved.size;
  }, [
    data,
    getMappedValue,
    importProfile.assetResolutionEnabled,
    localMapping.symbolMappings,
    effectiveActivityMappings,
  ]);

  // Data to display in mapping table (prioritize rows needing mapping, exclude cash-only symbols)
  const nonCashSymbolSet = useMemo(() => new Set(distinctSymbols), [distinctSymbols]);

  const { distinctSymbolRows } = useMemo(() => {
    const symbolMap = new Map<string, { row: CsvRowData; count: number }>();

    data.forEach((row) => {
      const symbol = getMappedValue(row, ImportFormat.SYMBOL)?.trim();
      if (!symbol) return;

      // Skip symbols that only appear on cash activity rows
      if (!nonCashSymbolSet.has(symbol)) return;

      if (!symbolMap.has(symbol)) {
        symbolMap.set(symbol, { row, count: 1 });
      } else {
        const current = symbolMap.get(symbol)!;
        symbolMap.set(symbol, { ...current, count: current.count + 1 });
      }
    });

    return {
      distinctSymbolRows: Array.from(symbolMap.entries()).map(([symbol, d]) => ({
        symbol,
        row: d.row,
        count: d.count,
        isValid: !invalidSymbols.includes(symbol),
        mappedSymbol: localMapping.symbolMappings?.[symbol],
      })),
    };
  }, [data, getMappedValue, invalidSymbols, localMapping.symbolMappings, nonCashSymbolSet]);

  const { distinctAccountRows } = useMemo(() => {
    const accountMap = new Map<string, { row: CsvRowData; count: number }>();

    data.forEach((row) => {
      const account = getMappedValue(row, ImportFormat.ACCOUNT)?.trim() || "";
      if (!account) return;

      if (!accountMap.has(account)) {
        accountMap.set(account, { row, count: 1 });
      } else {
        const current = accountMap.get(account)!;
        accountMap.set(account, { ...current, count: current.count + 1 });
      }
    });

    return {
      distinctAccountRows: Array.from(accountMap.entries()).map(([account, d]) => ({
        accountId: account,
        row: d.row,
        count: d.count,
        isValid: !invalidAccounts.includes(account),
        mappedAccount: localMapping.accountMappings?.[account],
      })),
    };
  }, [data, getMappedValue, invalidAccounts, localMapping.accountMappings]);

  const dataToMap = useMemo(() => {
    const rowsNeedingMapping = new Set<CsvRowData>();
    const processedRows = new Map<string, CsvRowData>();

    distinctActivityTypes.forEach(({ row, appType }) => {
      const lineNumber = row.lineNumber;
      processedRows.set(lineNumber, row);
      if (!appType) {
        rowsNeedingMapping.add(row);
      }
    });

    distinctSymbolRows.forEach(({ row, isValid, mappedSymbol }) => {
      const lineNumber = row.lineNumber;
      processedRows.set(lineNumber, row);
      if (!isValid && !mappedSymbol) {
        rowsNeedingMapping.add(row);
      }
    });

    distinctAccountRows.forEach(({ row, isValid, mappedAccount }) => {
      const lineNumber = row.lineNumber;
      processedRows.set(lineNumber, row);
      if (!isValid && !mappedAccount) {
        rowsNeedingMapping.add(row);
      }
    });

    missingAccountRows.forEach((row) => {
      processedRows.set(row.lineNumber, row);
      rowsNeedingMapping.add(row);
    });

    return Array.from(processedRows.values()).sort((a, b) => {
      const aNeedsMapping = rowsNeedingMapping.has(a);
      const bNeedsMapping = rowsNeedingMapping.has(b);

      // Unmapped rows first
      if (aNeedsMapping !== bNeedsMapping) {
        return aNeedsMapping ? -1 : 1;
      }

      // Within unmapped: group by activity type
      if (aNeedsMapping && bNeedsMapping) {
        const aType = getMappedValue(a, ImportFormat.ACTIVITY_TYPE);
        const bType = getMappedValue(b, ImportFormat.ACTIVITY_TYPE);
        if (aType !== bType) return aType.localeCompare(bType);
      }

      return parseInt(a.lineNumber) - parseInt(b.lineNumber);
    });
  }, [distinctActivityTypes, distinctSymbolRows, distinctAccountRows, missingAccountRows]);

  // CSV data for raw file viewer
  const csvData = useMemo(() => {
    return [
      { id: 0, content: headers.join(","), isValid: true },
      ...data.map((rowData, index) => ({
        id: index + 1,
        content: headers.map((header) => rowData[header] || "").join(","),
        isValid: true,
      })),
    ];
  }, [data, headers]);

  const saveTemplateMutation = useMutation({
    mutationFn: saveImportTemplate,
    onSuccess: (savedTemplate) => {
      setTemplateError(null);
      dispatch(setSelectedTemplate(savedTemplate.id, savedTemplate.scope));
      updateMapping({
        name: savedTemplate.name,
        parseConfig: savedTemplate.parseConfig,
      });
      void queryClient.invalidateQueries({ queryKey: [QueryKeys.IMPORT_TEMPLATES] });
    },
    onError: (error) => {
      setTemplateError(
        error instanceof Error ? error.message : t("activity:import.template.failedToSave"),
      );
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: deleteImportTemplate,
    onSuccess: () => {
      setTemplateError(null);
      dispatch(setSelectedTemplate(null, null));
      setTemplateName(localMapping.name ?? "");
      void queryClient.invalidateQueries({ queryKey: [QueryKeys.IMPORT_TEMPLATES] });
    },
    onError: (error) => {
      setTemplateError(
        error instanceof Error ? error.message : t("activity:import.template.failedToDelete"),
      );
    },
  });

  const applyTemplate = useCallback(
    async (templateId: string) => {
      try {
        const isDefaultTemplate = isDefaultActivityTemplateId(templateId);
        if (templateId === "__custom__") {
          dispatch(setSelectedTemplate(null, null));
          setTemplateError(null);
          return;
        }

        const template = templates.find((item) => item.id === templateId);
        if (!template) {
          setTemplateError(t("activity:import.template.notAvailable"));
          return;
        }

        setTemplateError(null);

        let nextHeaders = headers;
        let nextParseConfig: typeof state.parseConfig = isDefaultTemplate
          ? baselineParseConfig
          : template.parseConfig
            ? ({ ...state.parseConfig, ...template.parseConfig } as typeof state.parseConfig)
            : state.parseConfig;

        dispatch(setParseConfig(nextParseConfig));
        dispatch(setSuppressLinkedTemplate(false));

        if (state.file) {
          const parsed = await parseCsv(state.file, nextParseConfig);
          nextHeaders = parsed.headers;
          nextParseConfig = mergeDetectedParseConfig(nextParseConfig, parsed.detectedConfig);
          dispatch(setParsedData(parsed.headers, parsed.rows));
          dispatch(setParseConfig(nextParseConfig));
        }

        updateMapping(
          sanitizeImportMappingForProfile(
            {
              accountId: accountId || "",
              name: isDefaultActivityTemplateId(template.id) ? "" : template.name,
              fieldMappings: computeFieldMappings(
                nextHeaders,
                template.fieldMappings,
                importProfile,
              ),
              activityMappings: isTransactionImportProfile(importProfile)
                ? mergeActivityMappingsForImportProfile(template.activityMappings, importProfile)
                : template.activityMappings,
              symbolMappings: template.symbolMappings,
              accountMappings: template.accountMappings || {},
              symbolMappingMeta: template.symbolMappingMeta || {},
              parseConfig: nextParseConfig,
            },
            importProfile,
          ),
        );
        dispatch(setSelectedTemplate(template.id, template.scope));
      } catch (error) {
        setTemplateError(
          error instanceof Error ? error.message : t("activity:import.template.failedToApply"),
        );
      }
    },
    [
      accountId,
      baselineParseConfig,
      dispatch,
      headers,
      importProfile,
      state.file,
      state.parseConfig,
      templates,
      updateMapping,
      t,
    ],
  );

  const buildTemplatePayload = useCallback(
    (id: string): ImportTemplateData => {
      const mappingToSave = isTransactionImportProfile(importProfile)
        ? { ...localMapping, activityMappings: effectiveActivityMappings }
        : localMapping;
      const sanitized = sanitizeImportMappingForProfile(mappingToSave, importProfile);
      return {
        id,
        name: templateName.trim(),
        scope: "USER",
        kind: ImportType.ACTIVITY,
        fieldMappings: sanitized.fieldMappings,
        activityMappings: sanitized.activityMappings,
        symbolMappings: sanitized.symbolMappings,
        accountMappings: localMapping.accountMappings,
        symbolMappingMeta: sanitized.symbolMappingMeta ?? {},
        parseConfig: state.parseConfig,
      };
    },
    [effectiveActivityMappings, importProfile, localMapping, state.parseConfig, templateName],
  );

  const handleSaveTemplate = useCallback(() => {
    const name = templateName.trim();
    if (!name) {
      setTemplateError(t("activity:import.template.nameRequired"));
      return;
    }

    const templateId =
      state.selectedTemplateId && state.selectedTemplateScope === "USER"
        ? state.selectedTemplateId
        : crypto.randomUUID();

    saveTemplateMutation.mutate(buildTemplatePayload(templateId));
  }, [
    buildTemplatePayload,
    saveTemplateMutation,
    state.selectedTemplateId,
    state.selectedTemplateScope,
    templateName,
    t,
  ]);

  const handleSaveAsNewTemplate = useCallback(() => {
    const name = templateName.trim();
    if (!name) {
      setTemplateError(t("activity:import.template.nameRequired"));
      return;
    }

    saveTemplateMutation.mutate(buildTemplatePayload(crypto.randomUUID()));
  }, [buildTemplatePayload, saveTemplateMutation, templateName, t]);

  const handleDeleteTemplate = useCallback(() => {
    if (!state.selectedTemplateId || state.selectedTemplateScope !== "USER") {
      return;
    }
    if (
      !window.confirm(
        t("activity:import.template.deleteConfirm", { name: templateName || localMapping.name }),
      )
    ) {
      return;
    }
    deleteTemplateMutation.mutate(state.selectedTemplateId);
  }, [
    deleteTemplateMutation,
    localMapping.name,
    state.selectedTemplateId,
    state.selectedTemplateScope,
    templateName,
    t,
  ]);

  if (!data || data.length === 0) {
    return (
      <ImportAlert
        variant="destructive"
        title={t("activity:import.mapping.noCsvTitle")}
        description={t("activity:import.mapping.noCsvDescription")}
        icon={Icons.AlertCircle}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="bg-muted/20 mb-4 rounded-lg border p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <Label>{t("activity:import.template.label")}</Label>
            <TemplatePicker
              templates={templates}
              selectedTemplateId={effectiveSelectedTemplateId}
              onSelect={(id) => void applyTemplate(id)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="import-template-name">{t("activity:import.template.name")}</Label>
            <Input
              id="import-template-name"
              value={templateName}
              onChange={(event) => {
                setTemplateName(event.target.value);
                setTemplateError(null);
                updateMapping({ name: event.target.value });
              }}
              placeholder={t("activity:import.template.namePlaceholder")}
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Button
              onClick={handleSaveTemplate}
              disabled={saveTemplateMutation.isPending || templateName.trim() === ""}
            >
              {saveTemplateMutation.isPending
                ? t("activity:import.template.saving")
                : state.selectedTemplateId &&
                    !isDefaultActivityTemplateId(state.selectedTemplateId) &&
                    state.selectedTemplateScope === "USER"
                  ? t("activity:import.template.update")
                  : t("activity:import.template.save")}
            </Button>
            {state.selectedTemplateId && state.selectedTemplateScope === "USER" && (
              <>
                <Button
                  variant="outline"
                  onClick={handleSaveAsNewTemplate}
                  disabled={saveTemplateMutation.isPending || templateName.trim() === ""}
                >
                  {t("activity:import.template.saveAsNew")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleDeleteTemplate}
                  disabled={deleteTemplateMutation.isPending}
                >
                  {t("activity:import.template.delete")}
                </Button>
              </>
            )}
          </div>
        </div>

        {templateError && (
          <ImportAlert
            variant="destructive"
            size="sm"
            title={t("activity:import.template.errorTitle")}
            description={templateError}
            className="mb-0 mt-3"
          />
        )}
      </div>

      {/* Summary Cards */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ImportAlert
          variant={requiredFieldsMapped ? "success" : "destructive"}
          size="sm"
          title={t("activity:import.mapping.fields")}
          description={t("activity:import.mapping.mappedCount", {
            mapped: mappedFieldsCount,
            total: totalFields,
          })}
          icon={Icons.ListChecks}
          className="mb-0"
          rightIcon={requiredFieldsMapped ? Icons.CheckCircle : Icons.AlertCircle}
        />

        <ImportAlert
          variant={activitiesToMapCount === 0 ? "success" : "destructive"}
          size="sm"
          title={t("activity:import.mapping.activities")}
          description={t("activity:import.mapping.mappedCount", {
            mapped: distinctActivityTypes.length - activitiesToMapCount,
            total: distinctActivityTypes.length,
          })}
          icon={Icons.Activity}
          className="mb-0"
          rightIcon={activitiesToMapCount === 0 ? Icons.CheckCircle : Icons.AlertCircle}
        />

        {importProfile.assetResolutionEnabled && (
          <ImportAlert
            variant={symbolsToMapCount === 0 ? "success" : "destructive"}
            size="sm"
            title={t("activity:import.mapping.symbols")}
            description={t("activity:import.mapping.mappedCount", {
              mapped: distinctSymbols.length - symbolsToMapCount,
              total: distinctSymbols.length,
            })}
            icon={Icons.Tag}
            className="mb-0"
            rightIcon={symbolsToMapCount === 0 ? Icons.CheckCircle : Icons.AlertCircle}
          />
        )}

        <ImportAlert
          variant={accountsReady ? "success" : "destructive"}
          size="sm"
          title={t("activity:import.mapping.accounts")}
          description={accountsDescription}
          icon={Icons.Wallet}
          className="mb-0"
          rightIcon={accountsReady ? Icons.CheckCircle : Icons.AlertCircle}
        />
      </div>

      {!accountsReady &&
        (missingAccountRowsCount > 0 || !localMapping.fieldMappings[ImportFormat.ACCOUNT]) && (
          <ImportAlert
            variant="destructive"
            size="sm"
            title={t("activity:import.mapping.accountAssignmentRequired")}
            description={
              missingAccountRowsCount > 0
                ? t("activity:import.mapping.accountAssignmentBlankRows", {
                    count: missingAccountRowsCount,
                  })
                : t("activity:import.mapping.accountAssignmentDefault")
            }
          />
        )}

      {/* Mapping Editor with Preview Toggle */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Tabs defaultValue="preview" className="flex flex-1 flex-col">
          <div className="py-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground hidden px-3 text-sm md:block">
                {t("activity:import.mapping.totalRows", { count: totalRows })}
              </div>
              <TabsList className="bg-secondary flex space-x-1 rounded-full p-1">
                <TabsTrigger
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary data-[state=active]:hover:bg-primary/90 h-8 rounded-full px-2 text-sm"
                  value="preview"
                >
                  {importProfile.kind === "transaction"
                    ? t("activity:import.mapping.transactionPreview")
                    : t("activity:import.mapping.activityPreview")}
                </TabsTrigger>
                <TabsTrigger
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary data-[state=active]:hover:bg-primary/90 h-8 rounded-full px-2 text-sm"
                  value="raw"
                >
                  {t("activity:import.mapping.filePreview")}
                </TabsTrigger>
              </TabsList>
            </div>
          </div>

          <CardContent className="flex-1 overflow-y-auto p-0">
            <TabsContent value="preview" className="m-0 flex flex-col border-0 p-0">
              <MappingTable
                mapping={displayMapping}
                headers={headers}
                data={dataToMap}
                accounts={accounts}
                handleColumnMapping={handleColumnMapping}
                handleActivityTypeMapping={handleActivityTypeMapping}
                handleSymbolMapping={handleSymbolMapping}
                handleAccountIdMapping={handleAccountIdMapping}
                getMappedValue={getMappedValue}
                invalidSymbols={invalidSymbols}
                invalidAccounts={invalidAccounts}
                visibleFields={importProfile.visibleMappingFields}
                requiredFields={importProfile.requiredMappingFields}
                allowedActivityTypes={importProfile.allowedActivityTypes}
                getActivityTypeLabel={getActivityTypeLabel}
                className="max-h-[50vh]"
              />
            </TabsContent>

            <TabsContent value="raw" className="m-0 flex-1 border-0 p-0">
              <CSVFileViewer data={csvData} className="w-full" maxHeight="50vh" />
            </TabsContent>
          </CardContent>
        </Tabs>
      </div>
    </div>
  );
}

export default MappingStepUnified;
