import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type UseFormReturn } from "react-hook-form";

import { useTestCustomProviderSource } from "@/hooks/use-custom-providers";
import type {
  DetectedHtmlElement,
  DetectedHtmlTable,
  TestSourceResult,
} from "@/lib/types/custom-provider";

import type { FormValues, SourceKey } from "./custom-provider-form";
import type { ProviderTemplate } from "./provider-templates";
import { expandTemplatePlaceholders } from "./template-placeholders";

export type MappingField =
  | "pricePath"
  | "datePath"
  | "currencyPath"
  | "openPath"
  | "highPath"
  | "lowPath"
  | "volumePath";

export interface TestInputs {
  symbol: string;
  isin: string;
  mic: string;
  currency: string;
  from: string;
  to: string;
}

export interface FetchStatus {
  code: number;
  ok: boolean;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function yearStartDateString() {
  return `${new Date().getFullYear()}-01-01`;
}

const DEFAULT_TEST_CURRENCY = "USD";

function normalizedCurrencyInput(currency: string) {
  return currency.trim() || DEFAULT_TEST_CURRENCY;
}

function initialInputs(): TestInputs {
  return {
    symbol: "",
    isin: "",
    mic: "",
    currency: DEFAULT_TEST_CURRENCY,
    from: yearStartDateString(),
    to: todayDateString(),
  };
}

export interface SourceRuntime {
  isHistorical: boolean;
  isFetching: boolean;
  inputs: TestInputs;
  setInputs: (patch: Partial<TestInputs>) => void;
  rawResponse: string | null;
  detectedElements: DetectedHtmlElement[];
  detectedTables: DetectedHtmlTable[];
  fetchError: string | null;
  testResult: TestSourceResult | null;
  status: FetchStatus | null;
  armedField: MappingField | null;
  setArmedField: (f: MappingField | null) => void;
  handleFetch: () => void;
  handlePathSelect: (path: string, field?: MappingField) => void;
  handleColumnSelect: (
    pricePath: string,
    datePath?: string,
    highPath?: string,
    lowPath?: string,
    volumePath?: string,
  ) => void;
  /** Rewrite the "tableIdx:" prefix of every mapped path from `from` to `to`. */
  remapTableIndex: (from: number, to: number) => void;
  applyTemplate: (t: ProviderTemplate) => void;
  resetFetchState: () => void;
  extraPlaceholders: { isin: boolean; mic: boolean; currency: boolean };
  hasFetched: boolean;
  /** URL with placeholder values substituted (for preview). */
  expandedUrl: string;
  urlTemplate: string;
}

interface UseSourceRuntimeOptions {
  form: UseFormReturn<FormValues>;
  prefix: SourceKey;
  isHistorical: boolean;
  onUrlChange?: (url: string) => void;
  onAdvancedOpen?: () => void;
}

export function useSourceRuntime({
  form,
  prefix,
  isHistorical,
  onUrlChange,
  onAdvancedOpen,
}: UseSourceRuntimeOptions): SourceRuntime {
  const [inputsState, setInputsState] = useState<TestInputs>(initialInputs);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [detectedElements, setDetectedElements] = useState<DetectedHtmlElement[]>([]);
  const [detectedTables, setDetectedTables] = useState<DetectedHtmlTable[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestSourceResult | null>(null);
  const [status, setStatus] = useState<FetchStatus | null>(null);
  const [armedField, setArmedField] = useState<MappingField | null>(null);
  const { mutate: testSource, isPending: isFetching } = useTestCustomProviderSource();
  const verifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (verifyTimer.current) clearTimeout(verifyTimer.current);
    };
  }, []);

  const setInputs = useCallback((patch: Partial<TestInputs>) => {
    setInputsState((prev) => ({ ...prev, ...patch }));
  }, []);

  const urlTemplate = form.watch(`${prefix}.url`) ?? "";
  const bodyTemplate = form.watch(`${prefix}.body`) ?? "";
  const method = form.watch(`${prefix}.method`) ?? "GET";

  const extraPlaceholders = useMemo(() => {
    const templates = `${urlTemplate}\n${method === "POST" ? bodyTemplate : ""}`;
    return {
      isin: templates.includes("{ISIN}"),
      mic: templates.includes("{MIC}"),
      currency: templates.includes("{CURRENCY}") || templates.includes("{currency}"),
    };
  }, [urlTemplate, bodyTemplate, method]);

  const expandedUrl = useMemo(() => {
    return expandTemplatePlaceholders(urlTemplate, {
      SYMBOL: inputsState.symbol || "{SYMBOL}",
      ISIN: inputsState.isin,
      MIC: inputsState.mic,
      CURRENCY: normalizedCurrencyInput(inputsState.currency).toUpperCase(),
      currency: normalizedCurrencyInput(inputsState.currency).toLowerCase(),
      TODAY: todayDateString(),
      FROM: inputsState.from,
      TO: inputsState.to,
    });
  }, [urlTemplate, inputsState]);

  const resetFetchState = useCallback(() => {
    setRawResponse(null);
    setDetectedElements([]);
    setDetectedTables([]);
    setFetchError(null);
    setTestResult(null);
    setStatus(null);
  }, []);

  const handleFetch = useCallback(() => {
    const rawUrl = form.getValues(`${prefix}.url`);
    const symbol = inputsState.symbol;
    if (!rawUrl || !symbol) return;
    const format = form.getValues(`${prefix}.format`) ?? "json";
    const headers = form.getValues(`${prefix}.headers`);
    const pricePathCurrent = form.getValues(`${prefix}.pricePath`);
    const method = form.getValues(`${prefix}.method`) ?? "GET";
    const body = form.getValues(`${prefix}.body`);

    setTestResult(null);
    setFetchError(null);

    const dummyPath = format === "html" ? "body" : format === "html_table" ? "" : "$";

    testSource(
      {
        format,
        url: rawUrl,
        pricePath: dummyPath,
        symbol,
        currency: normalizedCurrencyInput(inputsState.currency),
        from: isHistorical ? inputsState.from : undefined,
        to: isHistorical ? inputsState.to : undefined,
        headers: headers || undefined,
        method,
        body: body || undefined,
        isin: inputsState.isin || undefined,
        mic: inputsState.mic || undefined,
      },
      {
        onSuccess: (result) => {
          const statusCode = result.statusCode ?? undefined;
          if (statusCode != null && (statusCode < 200 || statusCode >= 400)) {
            setRawResponse(null);
            setDetectedElements([]);
            setDetectedTables([]);
            setFetchError(result.error ?? "HTTP request failed.");
            setStatus({ code: statusCode, ok: false });
            if (result.error && /403|forbidden|denied/i.test(result.error)) {
              onAdvancedOpen?.();
            }
            return;
          }

          setStatus({ code: statusCode ?? 200, ok: true });
          setDetectedElements(result.detectedElements ?? []);
          setDetectedTables(result.detectedTables ?? []);

          if (result.detectedTables && result.detectedTables.length > 0) {
            setRawResponse(null);
          } else if (result.rawResponse) {
            setRawResponse(result.rawResponse);
            const trimmed = result.rawResponse.trimStart();
            const detected = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "html";
            if (!isHistorical && format !== "csv" && !pricePathCurrent) {
              form.setValue(`${prefix}.format`, detected);
            }
          } else if (result.detectedElements && result.detectedElements.length > 0) {
            setRawResponse(null);
          } else if (result.success) {
            setRawResponse(null);
            setTestResult(result);
          } else {
            setRawResponse(null);
            setFetchError(result.error ?? "Empty response from server.");
            setStatus({ code: 0, ok: false });
            if (result.error && /403|forbidden|denied/i.test(result.error)) {
              onAdvancedOpen?.();
            }
          }
        },
        onError: (err) => {
          setRawResponse(null);
          setDetectedElements([]);
          setDetectedTables([]);
          setFetchError(err.message);
          setStatus({ code: 0, ok: false });
          if (/403|forbidden|denied/i.test(err.message)) {
            onAdvancedOpen?.();
          }
        },
      },
    );
  }, [form, prefix, inputsState, testSource, isHistorical, onAdvancedOpen]);

  const scheduleVerify = useCallback(
    (path: string) => {
      if (verifyTimer.current) clearTimeout(verifyTimer.current);
      if (
        (!rawResponse && detectedElements.length === 0 && detectedTables.length === 0) ||
        !path ||
        path === "$" ||
        path === "body"
      )
        return;

      verifyTimer.current = setTimeout(() => {
        const rawUrl = form.getValues(`${prefix}.url`);
        const symbol = inputsState.symbol;
        if (!rawUrl || !symbol) return;
        const values = form.getValues(prefix);
        testSource(
          {
            format: values?.format ?? "json",
            url: rawUrl,
            pricePath: path,
            datePath: values?.datePath || undefined,
            dateFormat: values?.dateFormat || undefined,
            currencyPath: values?.currencyPath || undefined,
            factor: values?.factor ?? undefined,
            invert: values?.invert ?? undefined,
            locale: values?.locale || undefined,
            headers: values?.headers || undefined,
            method: values?.method ?? "GET",
            body: values?.body || undefined,
            isin: inputsState.isin || undefined,
            mic: inputsState.mic || undefined,
            openPath: values?.openPath || undefined,
            highPath: values?.highPath || undefined,
            lowPath: values?.lowPath || undefined,
            volumePath: values?.volumePath || undefined,
            symbol,
            currency: normalizedCurrencyInput(inputsState.currency),
            from: isHistorical ? inputsState.from : undefined,
            to: isHistorical ? inputsState.to : undefined,
          },
          {
            onSuccess: (result) => setTestResult(result),
            onError: (err) => setTestResult({ success: false, error: err.message }),
          },
        );
      }, 300);
    },
    [
      form,
      prefix,
      rawResponse,
      detectedElements,
      detectedTables,
      inputsState,
      testSource,
      isHistorical,
    ],
  );

  const handlePathSelect = useCallback(
    (path: string, field?: MappingField) => {
      const target: MappingField = field ?? armedField ?? "pricePath";
      form.setValue(`${prefix}.${target}`, path, { shouldValidate: true });
      // After mapping, if target was optional, keep armed at price (most common next click)
      if (target === "pricePath") {
        scheduleVerify(path);
      } else {
        // Verify using current pricePath
        const current = form.getValues(`${prefix}.pricePath`);
        if (current) scheduleVerify(current);
      }
    },
    [armedField, form, prefix, scheduleVerify],
  );

  const handleColumnSelect = useCallback(
    (
      pricePath: string,
      datePath?: string,
      highPath?: string,
      lowPath?: string,
      volumePath?: string,
    ) => {
      form.setValue(`${prefix}.pricePath`, pricePath, { shouldValidate: true });
      if (datePath) form.setValue(`${prefix}.datePath`, datePath);
      if (highPath) form.setValue(`${prefix}.highPath`, highPath);
      if (lowPath) form.setValue(`${prefix}.lowPath`, lowPath);
      if (volumePath) form.setValue(`${prefix}.volumePath`, volumePath);
      scheduleVerify(pricePath);
    },
    [form, prefix, scheduleVerify],
  );

  const remapTableIndex = useCallback(
    (fromIdx: number, toIdx: number) => {
      const fields: MappingField[] = [
        "pricePath",
        "datePath",
        "openPath",
        "highPath",
        "lowPath",
        "volumePath",
      ];
      const prefixStr = `${fromIdx}:`;
      for (const f of fields) {
        const current = form.getValues(`${prefix}.${f}`);
        if (typeof current === "string" && current.startsWith(prefixStr)) {
          const next = `${toIdx}:${current.slice(prefixStr.length)}`;
          form.setValue(`${prefix}.${f}`, next, { shouldValidate: true });
        }
      }
      const newPrice = form.getValues(`${prefix}.pricePath`);
      if (newPrice) scheduleVerify(newPrice);
    },
    [form, prefix, scheduleVerify],
  );

  const applyTemplate = useCallback(
    (t: ProviderTemplate) => {
      form.setValue(`${prefix}.format`, t.format);
      form.setValue(`${prefix}.url`, t.url);
      form.setValue(`${prefix}.pricePath`, t.pricePath);
      form.setValue(`${prefix}.datePath`, t.datePath ?? "");
      form.setValue(`${prefix}.dateFormat`, t.dateFormat ?? "");
      form.setValue(`${prefix}.openPath`, t.openPath ?? "");
      form.setValue(`${prefix}.highPath`, t.highPath ?? "");
      form.setValue(`${prefix}.lowPath`, t.lowPath ?? "");
      form.setValue(`${prefix}.volumePath`, t.volumePath ?? "");
      form.setValue(`${prefix}.headers`, t.headers ?? "");
      form.setValue(`${prefix}.method`, "GET");
      form.setValue(`${prefix}.body`, "");
      form.setValue(`${prefix}.currencyPath`, t.currencyPath ?? "");
      form.setValue(`${prefix}.locale`, "");
      form.setValue(`${prefix}.factor`, undefined);
      form.setValue(`${prefix}.invert`, false);
      form.setValue(`${prefix}.dateTimezone`, "");
      if (t.headers) onAdvancedOpen?.();
      setInputsState((prev) => ({ ...prev, symbol: t.testSymbol }));
      onUrlChange?.(t.url);
      resetFetchState();
    },
    [form, prefix, onAdvancedOpen, onUrlChange, resetFetchState],
  );

  const hasFetched =
    rawResponse !== null || detectedElements.length > 0 || detectedTables.length > 0;

  return {
    isHistorical,
    isFetching,
    inputs: inputsState,
    setInputs,
    rawResponse,
    detectedElements,
    detectedTables,
    fetchError,
    testResult,
    status,
    armedField,
    setArmedField,
    handleFetch,
    handlePathSelect,
    handleColumnSelect,
    remapTableIndex,
    applyTemplate,
    resetFetchState,
    extraPlaceholders,
    hasFetched,
    expandedUrl,
    urlTemplate,
  };
}
