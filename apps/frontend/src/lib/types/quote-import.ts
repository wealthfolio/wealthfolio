export interface QuoteImport {
  symbol: string;
  displaySymbol?: string;
  date: string; // ISO format YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number; // Required field
  volume?: number;
  currency: string;
  validationStatus: ImportValidationStatus;
  errorMessage?: string;
}

export interface QuoteImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  sampleQuotes: QuoteImport[];
  detectedColumns: Record<string, string>;
  duplicateCount: number;
}

export type ImportValidationStatus = "valid" | "warning" | "error";

export interface QuoteImportState {
  file: File | null;
  preview: QuoteImportPreview | null;
  isValidating: boolean;
  isImporting: boolean;
  importProgress: number;
  error: string | null;
}

export interface QuoteImportActions {
  setFile: (file: File | null) => void;
  validateFile: () => Promise<boolean>;
  importQuotes: () => Promise<boolean>;
  reset: () => void;
}
