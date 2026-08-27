export interface CustomProviderSource {
  id: string;
  providerId: string;
  kind: "latest" | "historical";
  format: "json" | "html" | "html_table" | "csv";
  url: string;
  pricePath: string;
  datePath?: string;
  dateFormat?: string;
  currencyPath?: string;
  factor?: number;
  invert?: boolean;
  locale?: string;
  headers?: string;
  /** HTTP method: "GET" or "POST" */
  method?: "GET" | "POST";
  /** Request body for POST requests (JSON string) */
  body?: string;
  openPath?: string;
  highPath?: string;
  lowPath?: string;
  volumePath?: string;
  defaultPrice?: number;
  dateTimezone?: string;
}

export interface CustomProviderWithSources {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  sources: CustomProviderSource[];
}

export interface NewCustomProvider {
  code: string;
  name: string;
  description?: string;
  priority?: number;
  sources: NewCustomProviderSource[];
}

export interface UpdateCustomProvider {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  sources?: NewCustomProviderSource[];
}

export interface NewCustomProviderSource {
  kind: "latest" | "historical";
  format: "json" | "html" | "html_table" | "csv";
  url: string;
  pricePath: string;
  datePath?: string;
  dateFormat?: string;
  currencyPath?: string;
  factor?: number;
  invert?: boolean;
  locale?: string;
  headers?: string;
  /** HTTP method: "GET" or "POST" */
  method?: "GET" | "POST";
  /** Request body for POST requests (JSON string) */
  body?: string;
  openPath?: string;
  highPath?: string;
  lowPath?: string;
  volumePath?: string;
  defaultPrice?: number;
  dateTimezone?: string;
}

export interface TestSourceRequest {
  format: "json" | "html" | "html_table" | "csv";
  url: string;
  pricePath: string;
  datePath?: string;
  dateFormat?: string;
  currencyPath?: string;
  factor?: number;
  invert?: boolean;
  locale?: string;
  headers?: string;
  /** HTTP method: "GET" or "POST" */
  method?: "GET" | "POST";
  /** Request body for POST requests (JSON string) */
  body?: string;
  symbol: string;
  isin?: string;
  mic?: string;
  currency?: string;
  from?: string;
  to?: string;
  openPath?: string;
  highPath?: string;
  lowPath?: string;
  volumePath?: string;
  defaultPrice?: number;
  dateTimezone?: string;
}

export interface DetectedHtmlElement {
  selector: string;
  value: number;
  text: string;
  label: string;
  htmlContext: string;
}

export interface DetectedColumn {
  index: number;
  header: string;
  role?: string;
}

export interface DetectedHtmlTable {
  index: number;
  columns: DetectedColumn[];
  rowCount: number;
  sampleRows: string[][];
}

export interface TestSourceResult {
  success: boolean;
  // Rust `Option<T>::None` serializes to JSON `null` (no `skip_serializing_if`
  // attribute). Typing these as `T | null` makes TS flag unsafe direct access.
  statusCode?: number | null;
  price?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  currency?: string | null;
  date?: string | null;
  error?: string | null;
  rawResponse?: string | null;
  detectedElements?: DetectedHtmlElement[] | null;
  detectedTables?: DetectedHtmlTable[] | null;
}
