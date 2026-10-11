import { checkQuotesImport, importManualQuotes } from "@/adapters";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { QueryKeys } from "@/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type {
  QuoteImport,
  QuoteImportActions,
  QuoteImportPreview,
  QuoteImportState,
} from "../lib/types/quote-import";

function prepareQuotesForImport(quotes: QuoteImport[]): QuoteImport[] {
  return quotes.map((quote) => ({
    ...quote,
    validationStatus: "valid" as QuoteImport["validationStatus"],
    errorMessage: undefined,
  }));
}

function normalizeQuoteImport(quote: QuoteImport): QuoteImport {
  const rawStatus = (quote as unknown as { validationStatus: unknown }).validationStatus;
  let validationStatus: QuoteImport["validationStatus"] = "valid";
  let errorMessage = quote.errorMessage;

  if (typeof rawStatus === "string") {
    if (rawStatus === "valid" || rawStatus === "warning" || rawStatus === "error") {
      validationStatus = rawStatus;
    }
  } else if (rawStatus && typeof rawStatus === "object") {
    const warning = (rawStatus as { warning?: unknown }).warning;
    const error = (rawStatus as { error?: unknown }).error;

    if (typeof warning === "string") {
      validationStatus = "warning";
      errorMessage = warning;
    } else if (typeof error === "string") {
      validationStatus = "error";
      errorMessage = error;
    }
  }

  return {
    ...quote,
    validationStatus,
    errorMessage,
  };
}

// Tauri commands reject with the backend's message as a plain string.
function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof err.message === "string" &&
    err.message.trim()
  ) {
    return err.message;
  }
  return fallback;
}

export function useQuoteImport(): QuoteImportState & QuoteImportActions {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<QuoteImportPreview | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Store validated quotes with matched asset IDs (from backend validation)
  const validatedQuotesRef = useRef<QuoteImport[]>([]);

  const validateFile = useCallback(async () => {
    if (!file) {
      setError("No file selected");
      return false;
    }

    if (isValidating) {
      return false;
    }

    setIsValidating(true);
    setError(null);
    validatedQuotesRef.current = [];

    try {
      // Send file to backend for parsing and validation in one call
      const validatedQuotes = await checkQuotesImport(file, true);

      // Normalize validation status from backend (may come as object or string)
      const quotes = validatedQuotes.map(normalizeQuoteImport);

      // Store validated quotes for import
      validatedQuotesRef.current = quotes;

      const validQuotes = quotes.filter((q) => q.validationStatus === "valid");
      const warningQuotes = quotes.filter((q) => q.validationStatus === "warning");
      const invalidQuotes = quotes.filter((q) => q.validationStatus === "error");

      setPreview({
        totalRows: quotes.length,
        validRows: validQuotes.length + warningQuotes.length,
        invalidRows: invalidQuotes.length,
        sampleQuotes: quotes.slice(0, 10),
        detectedColumns: {},
        duplicateCount: 0,
      });

      return true;
    } catch (err) {
      setError(errorMessage(err, "Failed to validate CSV"));
      return false;
    } finally {
      setIsValidating(false);
    }
  }, [file, isValidating]);

  const importQuotes = useCallback(async () => {
    if (!file) {
      setError("No file selected");
      return false;
    }

    // Use validated quotes from validation step
    const allQuotes = validatedQuotesRef.current;
    if (allQuotes.length === 0) {
      setError("No quotes to import. Please validate the file first.");
      return false;
    }

    // Filter to only valid quotes (those with matched assets)
    const validQuotes = allQuotes.filter((q) => q.validationStatus === "valid");
    if (validQuotes.length === 0) {
      setError("No valid quotes to import. All quotes have validation errors.");
      return false;
    }

    setIsImporting(true);
    setImportProgress(0);
    setError(null);

    try {
      setImportProgress(25);

      // Simulate progress during import since Tauri command doesn't provide updates
      const progressInterval = setInterval(() => {
        setImportProgress((prev) => {
          const newProgress = prev + Math.random() * 10;
          return Math.min(newProgress, 90);
        });
      }, 200);

      const importResult = await importManualQuotes(prepareQuotesForImport(validQuotes));
      const normalizedResult = importResult.map(normalizeQuoteImport);
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LATEST_QUOTES] });
      invalidatePerformanceCaches(queryClient);

      clearInterval(progressInterval);

      setImportProgress(100);

      // Update preview with import results
      setPreview((prev) =>
        prev
          ? {
              ...prev,
              sampleQuotes: normalizedResult,
            }
          : null,
      );

      return true;
    } catch (err) {
      setError(errorMessage(err, "Failed to import quotes"));
      return false;
    } finally {
      setIsImporting(false);
      setImportProgress(0);
    }
  }, [file, queryClient]);

  const reset = useCallback(() => {
    setFile(null);
    setPreview(null);
    setIsValidating(false);
    setIsImporting(false);
    setImportProgress(0);
    setError(null);
    validatedQuotesRef.current = [];
  }, []);

  return {
    // State
    file,
    preview,
    isValidating,
    isImporting,
    importProgress,
    error,

    // Actions
    setFile,
    validateFile,
    importQuotes,
    reset,
  };
}
