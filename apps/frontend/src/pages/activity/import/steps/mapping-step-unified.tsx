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
import { isFieldMapped } from "../utils/draft-utils";
import { validateTickerSymbol, findMappedActivityType } from "../utils/validation-utils";
import {
  createDefaultActivityMapping,
  createDefaultParseConfig,
  isDefaultActivityTemplateId,
  prependDefaultActivityTemplate,
} from "../utils/default-activity-template";
import { mergeDetectedParseConfig } from "../utils/import-flow-utils";

import { isCashSymbol, needsImportAssetResolutionForRow } from "@/lib/activity-utils";
import { IMPORT_REQUIRED_FIELDS, ImportFormat } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, CsvRowData, ImportTemplateData } from "@/lib/types";
import { ImportType } from "@/lib/types";

export function MappingStepUnified() {
  const { state, dispatch } = useImportContext();
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
  const baselineParseConfig = useMemo(
    () => createDefaultParseConfig(selectedAccount?.currency),
    [selectedAccount?.currency],
  );

  const { data: allTemplates = [] } = useQuery<ImportTemplateData[], Error>({
    queryKey: [QueryKeys.IMPORT_TEMPLATES],
    queryFn: listImportTemplates,
  });
  const templates = useMemo(
    () =>
      prependDefaultActivityTemplate(allTemplates.filter((t) => t.kind === ImportType.ACTIVITY)),
    [allTemplates],
  );
  const effectiveSelectedTemplateId = state.selectedTemplateId ?? templates[0]?.id ?? null;

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
    defaultMapping: mapping || createDefaultActivityMapping(accountId || ""),
  });

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
  const requiredFieldsMapped = IMPORT_REQUIRED_FIELDS.every((field) =>
    isFieldMapped(localMapping.fieldMappings[field], headers),
  );

  // Count how many fields are mapped
  const mappedFieldsCount = Object.entries(localMapping.fieldMappings).filter(([_, headerName]) =>
    isFieldMapped(headerName, headers),
  ).length;
  const totalFields = Object.values(ImportFormat).length;

  // Symbols validation — skip rows where symbol is not required
  const { distinctSymbols, invalidSymbols } = useMemo(() => {
    const needed = new Set<string>();
    const invalid = new Set<string>();

    data.forEach((row) => {
      const symbol = getMappedValue(row, ImportFormat.SYMBOL)?.trim();
      if (!symbol) return;

      const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE)?.trim();
      const csvSubtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
      const quantity = getMappedValue(row, ImportFormat.QUANTITY)?.trim();
      const unitPrice = getMappedValue(row, ImportFormat.UNIT_PRICE)?.trim();
      const appType = csvType
        ? findMappedActivityType(csvType, localMapping.activityMappings || {})
        : null;

      if (
        appType &&
        (!needsImportAssetResolutionForRow({
          activityType: appType,
          subtype: csvSubtype,
          symbol,
          quantity,
          unitPrice,
        }) ||
          isCashSymbol(symbol))
      ) {
        return;
      }

      needed.add(symbol);
      if (!validateTickerSymbol(symbol)) invalid.add(symbol);
    });

    return {
      distinctSymbols: Array.from(needed),
      invalidSymbols: Array.from(invalid),
    };
  }, [data, getMappedValue, localMapping.activityMappings]);

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
        appType: findMappedActivityType(type, localMapping.activityMappings || {}),
      })),
      totalRows: total,
    };
  }, [data, getMappedValue, localMapping.activityMappings]);

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
        ? "Using selected account"
        : "Select a default account or map an account column";
    }

    if (missingAccountRowsCount > 0) {
      return `${missingAccountRowsCount} row${missingAccountRowsCount === 1 ? "" : "s"} missing account`;
    }

    if (localMapping.fieldMappings[ImportFormat.ACCOUNT] && localMapping.accountMappings?.[""]) {
      return "Blank account rows assigned";
    }

    if (distinctAccountIds.length > 0) {
      return `${distinctAccountIds.length - accountsToMapCount} of ${distinctAccountIds.length} mapped`;
    }

    return accountId ? "Using selected account for all rows" : "No unmapped account IDs";
  }, [
    accountId,
    accountsToMapCount,
    distinctAccountIds.length,
    localMapping.accountMappings,
    localMapping.fieldMappings,
    missingAccountRowsCount,
  ]);

  const symbolsToMapCount = useMemo(() => {
    const unresolved = new Set<string>();
    data.forEach((row) => {
      const symbol = getMappedValue(row, ImportFormat.SYMBOL)?.trim();
      if (!symbol) return;

      const csvType = getMappedValue(row, ImportFormat.ACTIVITY_TYPE)?.trim();
      const csvSubtype = getMappedValue(row, ImportFormat.SUBTYPE)?.trim();
      const quantity = getMappedValue(row, ImportFormat.QUANTITY)?.trim();
      const unitPrice = getMappedValue(row, ImportFormat.UNIT_PRICE)?.trim();
      const appType = csvType
        ? findMappedActivityType(csvType, localMapping.activityMappings || {})
        : null;

      if (
        appType &&
        (!needsImportAssetResolutionForRow({
          activityType: appType,
          subtype: csvSubtype,
          symbol,
          quantity,
          unitPrice,
        }) ||
          isCashSymbol(symbol))
      ) {
        return;
      }
      if (validateTickerSymbol(symbol) || localMapping.symbolMappings?.[symbol]) return;
      unresolved.add(symbol);
    });
    return unresolved.size;
  }, [data, getMappedValue, localMapping.symbolMappings, localMapping.activityMappings]);

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
        error instanceof Error ? error.message : "Failed to save the import template.",
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
        error instanceof Error ? error.message : "Failed to delete the import template.",
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
          setTemplateError("The selected template is no longer available.");
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

        updateMapping({
          accountId: accountId || "",
          name: isDefaultActivityTemplateId(template.id) ? "" : template.name,
          fieldMappings: computeFieldMappings(nextHeaders, template.fieldMappings),
          activityMappings: template.activityMappings,
          symbolMappings: template.symbolMappings,
          accountMappings: template.accountMappings || {},
          symbolMappingMeta: template.symbolMappingMeta || {},
          parseConfig: nextParseConfig,
        });
        dispatch(setSelectedTemplate(template.id, template.scope));
      } catch (error) {
        setTemplateError(
          error instanceof Error ? error.message : "Failed to apply the import template.",
        );
      }
    },
    [
      accountId,
      baselineParseConfig,
      dispatch,
      headers,
      state.file,
      state.parseConfig,
      templates,
      updateMapping,
    ],
  );

  const buildTemplatePayload = useCallback(
    (id: string): ImportTemplateData => ({
      id,
      name: templateName.trim(),
      scope: "USER",
      kind: ImportType.ACTIVITY,
      fieldMappings: localMapping.fieldMappings,
      activityMappings: localMapping.activityMappings,
      symbolMappings: localMapping.symbolMappings,
      accountMappings: localMapping.accountMappings,
      symbolMappingMeta: localMapping.symbolMappingMeta ?? {},
      parseConfig: state.parseConfig,
    }),
    [localMapping, state.parseConfig, templateName],
  );

  const handleSaveTemplate = useCallback(() => {
    const name = templateName.trim();
    if (!name) {
      setTemplateError("Template name is required.");
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
  ]);

  const handleSaveAsNewTemplate = useCallback(() => {
    const name = templateName.trim();
    if (!name) {
      setTemplateError("Template name is required.");
      return;
    }

    saveTemplateMutation.mutate(buildTemplatePayload(crypto.randomUUID()));
  }, [buildTemplatePayload, saveTemplateMutation, templateName]);

  const handleDeleteTemplate = useCallback(() => {
    if (!state.selectedTemplateId || state.selectedTemplateScope !== "USER") {
      return;
    }
    if (!window.confirm(`Delete template "${templateName || localMapping.name}"?`)) {
      return;
    }
    deleteTemplateMutation.mutate(state.selectedTemplateId);
  }, [
    deleteTemplateMutation,
    localMapping.name,
    state.selectedTemplateId,
    state.selectedTemplateScope,
    templateName,
  ]);

  if (!data || data.length === 0) {
    return (
      <ImportAlert
        variant="destructive"
        title="No CSV data available"
        description="Please go back and upload a valid file."
        icon={Icons.AlertCircle}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="bg-muted/20 mb-4 rounded-lg border p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-1.5">
            <Label>Template</Label>
            <TemplatePicker
              templates={templates}
              selectedTemplateId={effectiveSelectedTemplateId}
              onSelect={(id) => void applyTemplate(id)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="import-template-name">Template Name</Label>
            <Input
              id="import-template-name"
              value={templateName}
              onChange={(event) => {
                setTemplateName(event.target.value);
                setTemplateError(null);
                updateMapping({ name: event.target.value });
              }}
              placeholder="e.g. Interactive Brokers - Trades"
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Button
              onClick={handleSaveTemplate}
              disabled={saveTemplateMutation.isPending || templateName.trim() === ""}
            >
              {saveTemplateMutation.isPending
                ? "Saving..."
                : state.selectedTemplateId &&
                    !isDefaultActivityTemplateId(state.selectedTemplateId) &&
                    state.selectedTemplateScope === "USER"
                  ? "Update Template"
                  : "Save Template"}
            </Button>
            {state.selectedTemplateId && state.selectedTemplateScope === "USER" && (
              <>
                <Button
                  variant="outline"
                  onClick={handleSaveAsNewTemplate}
                  disabled={saveTemplateMutation.isPending || templateName.trim() === ""}
                >
                  Save as New
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleDeleteTemplate}
                  disabled={deleteTemplateMutation.isPending}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>

        {templateError && (
          <ImportAlert
            variant="destructive"
            size="sm"
            title="Template Error"
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
          title="Fields"
          description={`${mappedFieldsCount} of ${totalFields} mapped`}
          icon={Icons.ListChecks}
          className="mb-0"
          rightIcon={requiredFieldsMapped ? Icons.CheckCircle : Icons.AlertCircle}
        />

        <ImportAlert
          variant={activitiesToMapCount === 0 ? "success" : "destructive"}
          size="sm"
          title="Activities"
          description={`${distinctActivityTypes.length - activitiesToMapCount} of ${distinctActivityTypes.length} mapped`}
          icon={Icons.Activity}
          className="mb-0"
          rightIcon={activitiesToMapCount === 0 ? Icons.CheckCircle : Icons.AlertCircle}
        />

        <ImportAlert
          variant={symbolsToMapCount === 0 ? "success" : "destructive"}
          size="sm"
          title="Symbols"
          description={`${distinctSymbols.length - symbolsToMapCount} of ${distinctSymbols.length} mapped`}
          icon={Icons.Tag}
          className="mb-0"
          rightIcon={symbolsToMapCount === 0 ? Icons.CheckCircle : Icons.AlertCircle}
        />

        <ImportAlert
          variant={accountsReady ? "success" : "destructive"}
          size="sm"
          title="Accounts"
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
            title="Account assignment required"
            description={
              missingAccountRowsCount > 0
                ? `Map every CSV row to an account. ${missingAccountRowsCount} row${missingAccountRowsCount === 1 ? " is" : "s are"} still blank, so choose a default account in Upload or fill the account column.`
                : "Choose a default account in Upload or map the CSV account column before continuing."
            }
          />
        )}

      {/* Mapping Editor with Preview Toggle */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Tabs defaultValue="preview" className="flex flex-1 flex-col">
          <div className="py-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground hidden px-3 text-sm md:block">
                <span className="font-medium">{totalRows} </span>total row
                {totalRows !== 1 ? "s" : ""}
              </div>
              <TabsList className="bg-secondary flex space-x-1 rounded-full p-1">
                <TabsTrigger
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary data-[state=active]:hover:bg-primary/90 h-8 rounded-full px-2 text-sm"
                  value="preview"
                >
                  Activity Preview
                </TabsTrigger>
                <TabsTrigger
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary data-[state=active]:hover:bg-primary/90 h-8 rounded-full px-2 text-sm"
                  value="raw"
                >
                  File Preview
                </TabsTrigger>
              </TabsList>
            </div>
          </div>

          <CardContent className="flex-1 overflow-y-auto p-0">
            <TabsContent value="preview" className="m-0 flex flex-col border-0 p-0">
              <MappingTable
                mapping={localMapping}
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
