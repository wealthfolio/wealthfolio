/**
 * Date format options for CSV import configuration.
 *
 * Each option maps a user-facing format value to its date-fns parse pattern.
 * The value is stored in the import mapping config; the pattern is used at parse time.
 */

export interface DateFormatOption {
  /** Stored config value */
  value: string;
  /** Display label (format + example) */
  label: string;
  /** date-fns pattern for parsing, null means special handling (auto / ISO) */
  dateFnsPattern: string | null;
}

export const DATE_FORMAT_OPTIONS: DateFormatOption[] = [
  // Auto
  { value: "auto", label: "Auto-detect", dateFnsPattern: null },

  // ── Date only ──────────────────────────────────────────────────────────────
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD — 2024-05-01", dateFnsPattern: "yyyy-MM-dd" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY — 01/05/2024", dateFnsPattern: "dd/MM/yyyy" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY — 05/01/2024", dateFnsPattern: "MM/dd/yyyy" },
  { value: "DD.MM.YYYY", label: "DD.MM.YYYY — 01.05.2024", dateFnsPattern: "dd.MM.yyyy" },
  { value: "DD-MM-YYYY", label: "DD-MM-YYYY — 01-05-2024", dateFnsPattern: "dd-MM-yyyy" },
  { value: "MM-DD-YYYY", label: "MM-DD-YYYY — 05-01-2024", dateFnsPattern: "MM-dd-yyyy" },

  // ── Date & Time ────────────────────────────────────────────────────────────
  {
    value: "YYYY-MM-DD HH:mm",
    label: "YYYY-MM-DD HH:mm — 2024-05-01 14:30",
    dateFnsPattern: "yyyy-MM-dd HH:mm",
  },
  {
    value: "YYYY-MM-DD HH:mm:ss",
    label: "YYYY-MM-DD HH:mm:ss — 2024-05-01 14:30:00",
    dateFnsPattern: "yyyy-MM-dd HH:mm:ss",
  },
  {
    value: "DD/MM/YYYY HH:mm",
    label: "DD/MM/YYYY HH:mm — 01/05/2024 14:30",
    dateFnsPattern: "dd/MM/yyyy HH:mm",
  },
  {
    value: "DD/MM/YYYY HH:mm:ss",
    label: "DD/MM/YYYY HH:mm:ss — 01/05/2024 14:30:00",
    dateFnsPattern: "dd/MM/yyyy HH:mm:ss",
  },
  {
    value: "MM/DD/YYYY HH:mm",
    label: "MM/DD/YYYY HH:mm — 05/01/2024 14:30",
    dateFnsPattern: "MM/dd/yyyy HH:mm",
  },
  {
    value: "MM/DD/YYYY HH:mm:ss",
    label: "MM/DD/YYYY HH:mm:ss — 05/01/2024 14:30:00",
    dateFnsPattern: "MM/dd/yyyy HH:mm:ss",
  },
  {
    value: "DD.MM.YYYY HH:mm",
    label: "DD.MM.YYYY HH:mm — 01.05.2024 14:30",
    dateFnsPattern: "dd.MM.yyyy HH:mm",
  },
  {
    value: "DD-MM-YYYY HH:mm",
    label: "DD-MM-YYYY HH:mm — 01-05-2024 14:30",
    dateFnsPattern: "dd-MM-yyyy HH:mm",
  },
  {
    value: "MM-DD-YYYY HH:mm",
    label: "MM-DD-YYYY HH:mm — 05-01-2024 14:30",
    dateFnsPattern: "MM-dd-yyyy HH:mm",
  },

  // ── Date & Time (12-hour AM/PM) ──────────────────────────────────────────────
  {
    value: "YYYY-MM-DD hh:mm:ss A",
    label: "YYYY-MM-DD hh:mm:ss AM/PM — 2024-05-01 12:00:00 AM",
    dateFnsPattern: "yyyy-MM-dd hh:mm:ss a",
  },
  {
    value: "YYYY-MM-DD hh:mm A",
    label: "YYYY-MM-DD hh:mm AM/PM — 2024-05-01 12:00 AM",
    dateFnsPattern: "yyyy-MM-dd hh:mm a",
  },
  {
    value: "MM/DD/YYYY hh:mm:ss A",
    label: "MM/DD/YYYY hh:mm:ss AM/PM — 05/01/2024 12:00:00 AM",
    dateFnsPattern: "MM/dd/yyyy hh:mm:ss a",
  },
  {
    value: "DD/MM/YYYY hh:mm:ss A",
    label: "DD/MM/YYYY hh:mm:ss AM/PM — 01/05/2024 12:00:00 AM",
    dateFnsPattern: "dd/MM/yyyy hh:mm:ss a",
  },

  // ── ISO 8601 ───────────────────────────────────────────────────────────────
  { value: "ISO8601", label: "ISO 8601 — 2024-05-01T14:30:00Z", dateFnsPattern: null },

  // ── Date only (two-digit year) ─────────────────────────────────────────────
  { value: "DD/MM/YY", label: "DD/MM/YY — 01/05/24", dateFnsPattern: "dd/MM/yy" },
  { value: "MM/DD/YY", label: "MM/DD/YY — 05/01/24", dateFnsPattern: "MM/dd/yy" },
  { value: "DD.MM.YY", label: "DD.MM.YY — 01.05.24", dateFnsPattern: "dd.MM.yy" },
  { value: "MM.DD.YY", label: "MM.DD.YY — 05.01.24", dateFnsPattern: "MM.dd.yy" },
  { value: "DD-MM-YY", label: "DD-MM-YY — 01-05-24", dateFnsPattern: "dd-MM-yy" },
  { value: "MM-DD-YY", label: "MM-DD-YY — 05-01-24", dateFnsPattern: "MM-dd-yy" },
];

/** Lookup map: config value → date-fns pattern */
const FORMAT_LOOKUP = new Map<string, string | null>(
  DATE_FORMAT_OPTIONS.map((o) => [o.value, o.dateFnsPattern]),
);

/**
 * Resolve a dateFormat config value to a date-fns parse pattern.
 *
 * - Known preset → its pattern (or null for auto/ISO)
 * - Unknown string → treated as a custom date-fns pattern typed by the user
 */
export function getDateFnsPattern(formatValue: string): string | null {
  if (!formatValue || formatValue === "auto") return null;
  if (FORMAT_LOOKUP.has(formatValue)) return FORMAT_LOOKUP.get(formatValue) ?? null;
  // Treat unknown values as custom date-fns patterns
  return formatValue;
}

/** Check whether a config value is a known preset (vs custom) */
export function isPresetFormat(formatValue: string): boolean {
  return FORMAT_LOOKUP.has(formatValue);
}
