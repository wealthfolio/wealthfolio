import {
  CalendarDate,
  CalendarDateTime,
  createCalendar,
  getLocalTimeZone,
  GregorianCalendar,
  parseDate,
  parseDateTime,
  parseTime,
  Time,
  toCalendar,
  toZoned,
  type CalendarIdentifier,
} from "@internationalized/date";
import { NumberParser } from "@internationalized/number";
import { DECIMAL_PRECISION, DISPLAY_DECIMAL_PRECISION } from "./constants";
import { getQuoteUnitCurrency, quoteCurrencies } from "./currencies";

/** Max fraction digits for a standard per-unit price (prices >= 0.01). */
const STANDARD_PRICE_DECIMAL_PRECISION = 4;

export const FORMATTING_REGIONS = [
  "system",
  "CA",
  "US",
  "GB",
  "FR",
  "DE",
  "ES",
  "MX",
  "BR",
  "PT",
  "CN",
  "JP",
  "KR",
  "IT",
] as const;

export type FormattingRegionSetting = (typeof FORMATTING_REGIONS)[number];

const FORMATTING_REGION_LOCALES: Record<Exclude<FormattingRegionSetting, "system">, string> = {
  CA: "en-CA",
  US: "en-US",
  GB: "en-GB",
  FR: "fr-FR",
  DE: "de-DE",
  ES: "es-ES",
  MX: "es-MX",
  BR: "pt-BR",
  PT: "pt-PT",
  CN: "zh-CN",
  JP: "ja-JP",
  KR: "ko-KR",
  IT: "it-IT",
};

export interface PercentFormatOptions {
  digits?: number;
  signDisplay?: "auto" | "always" | "exceptZero" | "never";
}

export type NumberDisplayOptions = Pick<
  Intl.NumberFormatOptions,
  | "style"
  | "notation"
  | "currency"
  | "currencyDisplay"
  | "minimumFractionDigits"
  | "maximumFractionDigits"
  | "minimumSignificantDigits"
  | "maximumSignificantDigits"
  | "signDisplay"
  | "useGrouping"
>;

export type DateDisplayOptions = Pick<
  Intl.DateTimeFormatOptions,
  | "dateStyle"
  | "timeStyle"
  | "year"
  | "month"
  | "day"
  | "weekday"
  | "hour"
  | "minute"
  | "second"
  | "hour12"
  | "hourCycle"
  | "timeZoneName"
  | "timeZone"
  | "calendar"
>;

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export type CalendarDateValue = string | CalendarDate | CalendarDateParts;

export interface CalendarDateTimeParts extends CalendarDateParts {
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
}

export interface TimeParts {
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
}

export type CalendarDateTimeValue = string | CalendarDateTime | CalendarDateTimeParts;
export type TimeValue = string | Time | TimeParts;

export function calendarDateFromLocalDate(value: Date): CalendarDateParts {
  return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
}

export function calendarDateTimeFromLocalDate(value: Date): CalendarDateTimeParts {
  return {
    ...calendarDateFromLocalDate(value),
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
    millisecond: value.getMilliseconds(),
  };
}

export function timeFromLocalDate(value: Date): TimeParts {
  return {
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
    millisecond: value.getMilliseconds(),
  };
}

export function parseDateTimeInTimezone(value: string, timezone?: string): Date | undefined {
  const normalized = value.trim().replace(" ", "T");
  if (!normalized) return undefined;

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    const instant = new Date(normalized);
    return Number.isFinite(instant.getTime()) ? instant : undefined;
  }

  try {
    return toZoned(parseDateTime(normalized), timezone || getLocalTimeZone()).toDate();
  } catch {
    return undefined;
  }
}

export interface FormattingApi {
  locale: string;
  timezone?: string;
  decimalSeparator: string;
  groupSeparator: string;
  formatAmount: (
    value: number | string | null | undefined,
    currency: string,
    displayCurrency?: boolean,
  ) => string;
  formatCompactAmount: (
    value: number | string | null | undefined,
    currency: string,
    displayCurrency?: boolean,
  ) => string;
  formatPrice: (
    value: number | string | null | undefined,
    currency: string,
    displayCurrency?: boolean,
  ) => string;
  formatRoundedAmount: (value: number | string | null | undefined, currency: string) => string;
  formatCurrencySymbol: (currency: string) => string;
  currencyFractionDigits: (currency: string) => number;
  formatPercent: (value: number | null | undefined, options?: PercentFormatOptions) => string;
  formatQuantity: (value: number | string | null | undefined) => string;
  formatDecimal: (value: number | string, options?: NumberDisplayOptions) => string;
  formatDate: (value: Date | string | number, options?: DateDisplayOptions) => string;
  formatCalendarDate: (value: CalendarDateValue, options?: DateDisplayOptions) => string;
  formatCalendarDateRange: (
    start: CalendarDateValue,
    end: CalendarDateValue,
    options?: DateDisplayOptions,
  ) => string;
  formatCalendarDateTime: (value: CalendarDateTimeValue, options?: DateDisplayOptions) => string;
  formatTimeOfDay: (value: TimeValue, options?: DateDisplayOptions) => string;
  formatTime: (value: Date | string | number, options?: DateDisplayOptions) => string;
  formatDateTime: (value: Date | string | number, options?: DateDisplayOptions) => string;
  parseNumber: (value: string) => number | undefined;
  parseDate: (value: string) => Date | undefined;
}

export type AmountFormatting = Pick<
  FormattingApi,
  | "formatAmount"
  | "formatCompactAmount"
  | "formatPrice"
  | "formatRoundedAmount"
  | "formatCurrencySymbol"
  | "currencyFractionDigits"
>;

export type NumberFormatting = Pick<
  FormattingApi,
  | "decimalSeparator"
  | "groupSeparator"
  | "formatPercent"
  | "formatQuantity"
  | "formatDecimal"
  | "parseNumber"
>;

export type DateFormatting = Pick<
  FormattingApi,
  | "formatDate"
  | "formatCalendarDate"
  | "formatCalendarDateRange"
  | "formatCalendarDateTime"
  | "formatTimeOfDay"
  | "formatTime"
  | "formatDateTime"
  | "parseDate"
>;

export function resolveFormattingLocale(
  setting: string | null | undefined,
  /** @deprecated UI language no longer affects formatting. */
  _uiLocale?: string | null,
): string {
  if (!setting) {
    throw new Error("A formatting locale is required");
  }
  if (setting === "system") {
    const systemLocale =
      typeof navigator !== "undefined" ? navigator.languages?.[0] || navigator.language : undefined;
    if (!systemLocale) {
      throw new Error("The system formatting locale is unavailable; provide an explicit locale");
    }
    try {
      return Intl.getCanonicalLocales(systemLocale)[0]!;
    } catch {
      throw new Error(`Invalid formatting locale: ${systemLocale}`);
    }
  }
  try {
    const region = setting.toUpperCase() as Exclude<FormattingRegionSetting, "system">;
    if (/^[A-Z]{2}$/.test(setting)) {
      const locale = FORMATTING_REGION_LOCALES[region];
      if (!locale) throw new Error(`Unsupported formatting region: ${setting}`);
      return locale;
    }
    return Intl.getCanonicalLocales(setting)[0]!;
  } catch {
    throw new Error(`Invalid formatting locale: ${setting}`);
  }
}

interface PreparedFormatters {
  decimal: Pick<Intl.NumberFormat, "format">;
  amount: Pick<Intl.NumberFormat, "format">;
  quantity: Pick<Intl.NumberFormat, "format">;
  date: { format(value: Date): string };
  calendarDate: { format(value: Date): string };
  calendarDateTime: { format(value: Date): string };
  timeOfDay: { format(value: Date): string };
  time: { format(value: Date): string };
  dateTime: { format(value: Date): string };
}

type PreparedAmountFormatters = Pick<PreparedFormatters, "decimal" | "amount">;
type PreparedNumberFormatters = Pick<PreparedFormatters, "decimal" | "quantity">;
type PreparedDateFormatters = Pick<
  PreparedFormatters,
  "date" | "calendarDate" | "calendarDateTime" | "timeOfDay" | "time" | "dateTime"
>;

function separators(locale: string) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? ",",
  };
}

const currencyAffixMatchers = new Map<string, { prefix: RegExp; suffix: RegExp }>();

function normalizeCurrencyAffix(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u061c\u200e\u200f]/gu, "")
    .trim();
}

function getCurrencyAffixMatchers(locale: string): { prefix: RegExp; suffix: RegExp } {
  const cached = currencyAffixMatchers.get(locale);
  if (cached) return cached;

  const affixes = new Set<string>();
  for (const currency of quoteCurrencies) {
    affixes.add(currency.value);
    const quoteUnit = getQuoteUnitCurrency(currency.value);
    if (quoteUnit) {
      affixes.add(quoteUnit.symbol);
      continue;
    }

    const symbol = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.value,
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value;
    if (symbol) affixes.add(symbol);
  }

  const alternatives = Array.from(affixes, normalizeCurrencyAffix)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((affix) => affix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const affix = `(?:${alternatives})`;
  const matchers = {
    prefix: new RegExp(`^([+\\-−]?)\\s*${affix}\\s*`, "u"),
    suffix: new RegExp(`\\s*${affix}\\s*$`, "u"),
  };
  currencyAffixMatchers.set(locale, matchers);
  return matchers;
}

function stripFinancialAffixes(value: string, locale: string): string | null {
  const affixMatchers = getCurrencyAffixMatchers(locale);
  let result = value.replace(affixMatchers.prefix, "$1").replace(affixMatchers.suffix, "").trim();
  // A pasted machine-formatted value may carry a currency symbol from a
  // different locale (for example "$1,234.56" in a French locale).
  result = result
    .replace(/^([+\-−]?)\s*\p{Sc}\s*/u, "$1")
    .replace(/\s*\p{Sc}\s*$/u, "")
    .trim();
  if (/\p{L}|\p{Sc}/u.test(result)) return null;
  result = result.replace(/^−/, "-");
  return result;
}

function hasValidGrouping(value: string, locale: string, parsed: number): boolean {
  const formatter = new Intl.NumberFormat(locale);
  const parts = formatter.formatToParts(12345.6);
  const decimal = parts.find((part) => part.type === "decimal")?.value;
  const group = parts.find((part) => part.type === "group")?.value;
  if (!group) return true;

  const normalized = /\s/u.test(group) ? value.replace(/[\s\u00a0\u202f]/gu, group) : value;
  const [integer = "", ...fractions] = decimal ? normalized.split(decimal) : [normalized];
  if (fractions.length > 1 || fractions.some((fraction) => fraction.includes(group))) return false;
  if (!integer.includes(group)) return true;

  const actualGroups = integer.replace(/^[+-]/, "").split(group);
  if (actualGroups.some((part) => part.length === 0)) return false;
  const expectedGroups = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  })
    .formatToParts(Math.trunc(Math.abs(parsed)))
    .filter((part) => part.type === "integer")
    .map((part) => Array.from(part.value).length);
  return (
    actualGroups.length === expectedGroups.length &&
    actualGroups.every((part, index) => Array.from(part).length === expectedGroups[index])
  );
}

const INVARIANT_NUMBER_PATTERN =
  /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parsePreparedNumber(
  value: string,
  locale: string,
  parser: NumberParser,
): number | undefined {
  const localized = parser.parse(value);
  if (Number.isFinite(localized) && hasValidGrouping(value, locale, localized)) {
    return localized;
  }
  if (!INVARIANT_NUMBER_PATTERN.test(value)) return undefined;

  const invariant = Number(value.replaceAll(",", ""));
  return Number.isFinite(invariant) ? invariant : undefined;
}

function normalizeInvariantNumberString(value: string): string {
  const normalized = value.replaceAll(",", "").replace(/^\+/, "").replace("E", "e");
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

function localizedNumberToInvariant(value: string, locale: string): string | undefined {
  const { decimal, group } = separators(locale);
  let normalized = normalizeLocalizedDigits(value, locale);
  if (/\s/u.test(group)) {
    normalized = normalized.replace(/[\s\u00a0\u202f]/gu, group);
  }
  normalized = normalized.replaceAll(group, "");
  if (decimal !== ".") normalized = normalized.replace(decimal, ".");
  normalized = normalizeInvariantNumberString(normalized);
  return INVARIANT_NUMBER_PATTERN.test(normalized) ? normalized : undefined;
}

function parsePreparedDecimalString(
  value: string,
  locale: string,
  parser: NumberParser,
): string | undefined {
  const localized = parser.parse(value);
  if (Number.isFinite(localized) && hasValidGrouping(value, locale, localized)) {
    return localizedNumberToInvariant(value, locale);
  }
  if (!INVARIANT_NUMBER_PATTERN.test(value)) return undefined;
  return normalizeInvariantNumberString(value);
}

export function parseLocalizedNumber(value: string, locale: string): number | undefined {
  const resolvedLocale = locale && locale !== "system" ? locale : resolveFormattingLocale(locale);
  const text = stripFinancialAffixes(
    value
      .normalize("NFKC")
      .trim()
      .replace(/[\u061c\u200e\u200f]/gu, ""),
    resolvedLocale,
  );
  if (!text) return undefined;
  const parser = new NumberParser(resolvedLocale, { style: "decimal" });
  return parsePreparedNumber(text, resolvedLocale, parser);
}

export function parseLocalizedDecimalString(value: string, locale: string): string | undefined {
  const resolvedLocale = locale && locale !== "system" ? locale : resolveFormattingLocale(locale);
  const text = stripFinancialAffixes(
    value
      .normalize("NFKC")
      .trim()
      .replace(/[\u061c\u200e\u200f]/gu, ""),
    resolvedLocale,
  );
  if (!text) return undefined;
  const parser = new NumberParser(resolvedLocale, { style: "decimal" });
  return parsePreparedDecimalString(text, resolvedLocale, parser);
}

const localizedMonths = new Map<string, Map<string, number>>();
const localizedNumberParsers = new Map<string, NumberParser>();

function normalizeLocalizedDigits(value: string, locale: string): string {
  let parser = localizedNumberParsers.get(locale);
  if (!parser) {
    parser = new NumberParser(locale, { style: "decimal" });
    localizedNumberParsers.set(locale, parser);
  }
  return Array.from(value, (character) => {
    const parsed = parser.parse(character);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? String(parsed) : character;
  }).join("");
}

function dateFromLocalizedFields(
  year: number,
  month: number,
  day: number,
  locale: string,
): Date | undefined {
  try {
    const calendarName = new Intl.DateTimeFormat(locale).resolvedOptions()
      .calendar as CalendarIdentifier;
    const calendar = createCalendar(calendarName);
    const localized = new CalendarDate(calendar, year, month, day);
    if (localized.year !== year || localized.month !== month || localized.day !== day) {
      return undefined;
    }
    const gregorian = toCalendar(localized, new GregorianCalendar());
    const result = new Date(gregorian.year, gregorian.month - 1, gregorian.day);
    return result.getFullYear() === gregorian.year &&
      result.getMonth() === gregorian.month - 1 &&
      result.getDate() === gregorian.day
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedDateTokens(value: string, locale: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase(locale)
    .replace(/[\p{P}\p{Z}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function monthTokens(locale: string): Map<string, number> {
  const cached = localizedMonths.get(locale);
  if (cached) return cached;

  const tokens = new Map<string, number>();
  const formatters = [
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }),
    new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }),
  ];
  const numericFormatter = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    timeZone: "UTC",
  });
  const start = Date.UTC(2020, 0, 1);
  const end = Date.UTC(2024, 0, 1);
  for (let timestamp = start; timestamp < end; timestamp += 7 * 24 * 60 * 60 * 1000) {
    const date = new Date(timestamp);
    const numericMonth = numericFormatter
      .formatToParts(date)
      .find((part) => part.type === "month")?.value;
    const month = Number(/\d+/u.exec(normalizeLocalizedDigits(numericMonth ?? "", locale))?.[0]);
    if (!Number.isInteger(month) || month < 1) continue;
    for (const formatter of formatters) {
      // Keep adjacent locale literals such as Japanese `月`. The bare `month`
      // part is only `7` in ja-JP, which would otherwise make an unrelated day
      // token such as the `3` in "Jul 3, 2026" look like March.
      const name = formatter.format(date);
      if (!name) continue;
      for (const token of normalizedDateTokens(name, locale)) tokens.set(token, month);
    }
  }
  localizedMonths.set(locale, tokens);
  return tokens;
}

function parseNamedMonthDate(value: string, locale: string): Date | undefined {
  const tokens = normalizedDateTokens(value, locale);
  const months = monthTokens(locale);
  const month = tokens
    .map((token) => months.get(token))
    .find((candidate) => candidate !== undefined);
  if (!month) return undefined;

  const numbers = normalizeLocalizedDigits(value, locale).match(/\d+/g)?.map(Number);
  if (numbers?.length !== 2) return undefined;
  const year = numbers.find((candidate) => candidate >= 100);
  const day = numbers.find((candidate) => candidate !== year && candidate >= 1 && candidate <= 31);
  if (!year || !day) return undefined;

  return dateFromLocalizedFields(year, month, day, locale);
}

export function parseLocalizedDate(value: string, locale: string): Date | undefined {
  const resolvedLocale = locale && locale !== "system" ? locale : resolveFormattingLocale(locale);
  const text = normalizeLocalizedDigits(
    value
      .normalize("NFKC")
      .trim()
      .replace(/[\u061c\u200e\u200f]/gu, ""),
    resolvedLocale,
  );
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(text)
  ) {
    const result = new Date(text);
    return Number.isFinite(result.getTime()) ? result : undefined;
  }
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDate) {
    const [, yearText, monthText, dayText] = isoDate;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const result = new Date(year, month - 1, day);
    return result.getFullYear() === year &&
      result.getMonth() === month - 1 &&
      result.getDate() === day
      ? result
      : undefined;
  }
  const yearFirstDate = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(text);
  const calendar = new Intl.DateTimeFormat(resolvedLocale).resolvedOptions().calendar;
  if (yearFirstDate && calendar === "gregory") {
    const [, yearText, , monthText, dayText] = yearFirstDate;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const result = new Date(year, month - 1, day);
    return result.getFullYear() === year &&
      result.getMonth() === month - 1 &&
      result.getDate() === day
      ? result
      : undefined;
  }
  const numbers = text.match(/\d+/g)?.map(Number);
  if (numbers?.length !== 3) {
    const localized = parseNamedMonthDate(text, resolvedLocale);
    if (localized) return localized;
    const result = new Date(text);
    return Number.isFinite(result.getTime()) ? result : undefined;
  }
  const order = new Intl.DateTimeFormat(resolvedLocale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(new Date(2006, 10, 22))
    .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
    .map((part) => part.type as "year" | "month" | "day");
  const fields = Object.fromEntries(order.map((key, index) => [key, numbers[index]])) as Record<
    string,
    number
  >;
  return dateFromLocalizedFields(fields.year, fields.month, fields.day, resolvedLocale);
}

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toCalendarDate(value: CalendarDateValue): CalendarDate | null {
  try {
    if (typeof value === "string") {
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDate(value) : null;
    }
    if (value instanceof CalendarDate) return value;
    const date = new CalendarDate(value.year, value.month, value.day);
    return date.year === value.year && date.month === value.month && date.day === value.day
      ? date
      : null;
  } catch {
    return null;
  }
}

function toCalendarDateTime(value: CalendarDateTimeValue): CalendarDateTime | null {
  try {
    if (typeof value === "string") return parseDateTime(value);
    if (value instanceof CalendarDateTime) return value;
    return new CalendarDateTime(
      value.year,
      value.month,
      value.day,
      value.hour,
      value.minute,
      value.second ?? 0,
      value.millisecond ?? 0,
    );
  } catch {
    return null;
  }
}

function toTime(value: TimeValue): Time | null {
  try {
    if (typeof value === "string") return parseTime(value);
    if (value instanceof Time) return value;
    return new Time(value.hour, value.minute, value.second ?? 0, value.millisecond ?? 0);
  } catch {
    return null;
  }
}

function numeric(value: number | string | null | undefined) {
  if (value == null || value === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

export function createAmountFormatting(
  locale: string,
  prepared?: PreparedAmountFormatters,
): AmountFormatting {
  const resolvedLocale = resolveFormattingLocale(locale);
  const decimalFormatter = prepared?.decimal ?? new Intl.NumberFormat(resolvedLocale);
  const amountFormatter =
    prepared?.amount ??
    new Intl.NumberFormat(resolvedLocale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const roundedDecimalFormatter = new Intl.NumberFormat(resolvedLocale, {
    maximumFractionDigits: 0,
  });
  const currencyFormatters = new Map<string, Intl.NumberFormat>();
  const roundedCurrencyFormatters = new Map<string, Intl.NumberFormat>();
  const currencySymbols = new Map<string, string>();
  const currencyFractionDigitsCache = new Map<string, number>();
  const amountDecimalFormatters = new Map<number, Pick<Intl.NumberFormat, "format">>([
    [2, amountFormatter],
  ]);
  const compactFormatters = new Map<string, Intl.NumberFormat>();
  const priceDecimalFormatters = new Map<number, Intl.NumberFormat>();
  const priceCurrencyFormatters = new Map<string, Intl.NumberFormat>();
  const getCurrencyFractionDigits = (currency: string) => {
    const normalizedCurrency = currency?.toUpperCase?.() || "USD";
    const cached = currencyFractionDigitsCache.get(normalizedCurrency);
    if (cached !== undefined) return cached;
    try {
      const digits =
        new Intl.NumberFormat(resolvedLocale, {
          style: "currency",
          currency: normalizedCurrency,
        }).resolvedOptions().maximumFractionDigits ?? 2;
      currencyFractionDigitsCache.set(normalizedCurrency, digits);
      return digits;
    } catch {
      return 2;
    }
  };
  const amountDecimalFormatter = (fractionDigits: number) => {
    let formatter = amountDecimalFormatters.get(fractionDigits);
    if (!formatter) {
      formatter = new Intl.NumberFormat(resolvedLocale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
      amountDecimalFormatters.set(fractionDigits, formatter);
    }
    return formatter;
  };
  const priceDecimalFormatter = (maximumFractionDigits: number) => {
    let formatter = priceDecimalFormatters.get(maximumFractionDigits);
    if (!formatter) {
      formatter = new Intl.NumberFormat(resolvedLocale, {
        minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
        maximumFractionDigits,
      });
      priceDecimalFormatters.set(maximumFractionDigits, formatter);
    }
    return formatter;
  };
  const compactDecimalFormatter = (maximumFractionDigits: number) => {
    const key = `decimal:${maximumFractionDigits}`;
    let formatter = compactFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(resolvedLocale, {
        notation: "compact",
        maximumFractionDigits,
      });
      compactFormatters.set(key, formatter);
    }
    return formatter;
  };

  const formatAmount: AmountFormatting["formatAmount"] = (
    value,
    currency,
    displayCurrency = true,
  ) => {
    const amount = numeric(value);
    if (amount == null) return "-";
    const quoteUnit = getQuoteUnitCurrency(currency);
    if (quoteUnit) {
      const displayed = Math.abs(amount) < 0.005 ? 0 : amount;
      const result = amountFormatter.format(displayed);
      return displayCurrency ? `${result}${quoteUnit.symbol}` : result;
    }
    const normalizedCurrency = currency?.toUpperCase?.() || "USD";
    const fractionDigits = getCurrencyFractionDigits(normalizedCurrency);
    const zeroThreshold = 0.5 * 10 ** -fractionDigits;
    const displayed = Math.abs(amount) < zeroThreshold ? 0 : amount;
    try {
      if (!displayCurrency) return amountDecimalFormatter(fractionDigits).format(displayed);
      let formatter = currencyFormatters.get(normalizedCurrency);
      if (!formatter) {
        formatter = new Intl.NumberFormat(resolvedLocale, {
          style: "currency",
          currency: normalizedCurrency,
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        });
        currencyFormatters.set(normalizedCurrency, formatter);
      }
      return formatter.format(displayed);
    } catch {
      const result = amountFormatter.format(displayed);
      return displayCurrency ? `${result} ${currency}` : result;
    }
  };

  return {
    formatAmount,
    formatRoundedAmount(value, currency) {
      const amount = numeric(value);
      if (amount == null) return "-";
      const quoteUnit = getQuoteUnitCurrency(currency);
      if (quoteUnit) return `${roundedDecimalFormatter.format(amount)}${quoteUnit.symbol}`;
      const normalizedCurrency = currency?.toUpperCase?.() || "USD";
      try {
        let formatter = roundedCurrencyFormatters.get(normalizedCurrency);
        if (!formatter) {
          formatter = new Intl.NumberFormat(resolvedLocale, {
            style: "currency",
            currency: normalizedCurrency,
            maximumFractionDigits: 0,
          });
          roundedCurrencyFormatters.set(normalizedCurrency, formatter);
        }
        return formatter.format(amount);
      } catch {
        return decimalFormatter.format(Math.round(amount));
      }
    },
    formatCurrencySymbol(currency) {
      const quoteUnit = getQuoteUnitCurrency(currency);
      if (quoteUnit) return quoteUnit.symbol;
      const normalizedCurrency = currency?.toUpperCase?.() || "USD";
      const cached = currencySymbols.get(normalizedCurrency);
      if (cached) return cached;
      try {
        const symbol =
          new Intl.NumberFormat(resolvedLocale, {
            style: "currency",
            currency: normalizedCurrency,
          })
            .formatToParts(0)
            .find((part) => part.type === "currency")?.value ?? normalizedCurrency;
        currencySymbols.set(normalizedCurrency, symbol);
        return symbol;
      } catch {
        return normalizedCurrency;
      }
    },
    currencyFractionDigits(currency) {
      return getCurrencyFractionDigits(currency);
    },
    formatCompactAmount(value, currency, displayCurrency = true) {
      const amount = numeric(value);
      if (amount == null) return "-";
      const max =
        Math.abs(amount) >= 1_000_000
          ? 2
          : Math.abs(amount) >= 100_000
            ? 0
            : Math.abs(amount) >= 1_000
              ? 1
              : 0;
      if (!displayCurrency) return compactDecimalFormatter(max).format(amount);
      const quoteUnit = getQuoteUnitCurrency(currency);
      if (quoteUnit) return `${compactDecimalFormatter(max).format(amount)}${quoteUnit.symbol}`;
      try {
        const normalizedCurrency = currency?.toUpperCase?.() || "USD";
        const key = `${normalizedCurrency}:${max}`;
        let formatter = compactFormatters.get(key);
        if (!formatter) {
          formatter = new Intl.NumberFormat(resolvedLocale, {
            style: "currency",
            currency: normalizedCurrency,
            notation: "compact",
            maximumFractionDigits: max,
          });
          compactFormatters.set(key, formatter);
        }
        return formatter.format(amount);
      } catch {
        return `${compactDecimalFormatter(max).format(amount)} ${currency}`;
      }
    },
    formatPrice(value, currency, displayCurrency = true) {
      const amount = numeric(value);
      if (amount == null) return "-";
      const displayed = Math.abs(amount) < 0.000000005 ? 0 : amount;
      const maximumFractionDigits =
        displayed !== 0 && Math.abs(displayed) < 0.01
          ? DECIMAL_PRECISION
          : STANDARD_PRICE_DECIMAL_PRECISION;
      const quoteUnit = getQuoteUnitCurrency(currency);
      if (quoteUnit) {
        const result = priceDecimalFormatter(maximumFractionDigits).format(displayed);
        return displayCurrency ? `${result}${quoteUnit.symbol}` : result;
      }
      if (!displayCurrency) return priceDecimalFormatter(maximumFractionDigits).format(displayed);
      try {
        const normalizedCurrency = currency?.toUpperCase?.() || "USD";
        const key = `${normalizedCurrency}:${maximumFractionDigits}`;
        let formatter = priceCurrencyFormatters.get(key);
        if (!formatter) {
          formatter = new Intl.NumberFormat(resolvedLocale, {
            style: "currency",
            currency: normalizedCurrency,
            minimumFractionDigits: DISPLAY_DECIMAL_PRECISION,
            maximumFractionDigits,
          });
          priceCurrencyFormatters.set(key, formatter);
        }
        return formatter.format(displayed);
      } catch {
        return priceDecimalFormatter(maximumFractionDigits).format(displayed);
      }
    },
  };
}

export function createNumberFormatting(
  locale: string,
  prepared?: PreparedNumberFormatters,
): NumberFormatting {
  const resolvedLocale = resolveFormattingLocale(locale);
  const { decimal, group } = separators(resolvedLocale);
  const decimalFormatter = prepared?.decimal ?? new Intl.NumberFormat(resolvedLocale);
  const quantityFormatter =
    prepared?.quantity ??
    new Intl.NumberFormat(resolvedLocale, {
      maximumFractionDigits: 8,
      useGrouping: true,
    });
  const percentFormatters = new Map<string, Intl.NumberFormat>();
  const decimalFormatters = new Map<string, Intl.NumberFormat>();
  const numberParser = new NumberParser(resolvedLocale, { style: "decimal" });
  const numberFormatter = (options: NumberDisplayOptions) => {
    const key = [
      options.style,
      options.notation,
      options.currency,
      options.currencyDisplay,
      options.minimumFractionDigits,
      options.maximumFractionDigits,
      options.minimumSignificantDigits,
      options.maximumSignificantDigits,
      options.signDisplay,
      options.useGrouping,
    ].join(":");
    let formatter = decimalFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(resolvedLocale, options);
      decimalFormatters.set(key, formatter);
    }
    return formatter;
  };

  return {
    decimalSeparator: decimal,
    groupSeparator: group,
    formatPercent(value, options = {}) {
      if (value == null) return "-";
      const digits = options.digits ?? 2;
      const signDisplay = options.signDisplay ?? "auto";
      const key = `${digits}:${signDisplay}`;
      let formatter = percentFormatters.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(resolvedLocale, {
          style: "percent",
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
          signDisplay,
        });
        percentFormatters.set(key, formatter);
      }
      return formatter.format(value);
    },
    formatQuantity(value) {
      const quantity = numeric(value);
      return quantity == null ? "-" : quantityFormatter.format(quantity);
    },
    formatDecimal(value, options) {
      return options
        ? numberFormatter(options).format(value as number)
        : decimalFormatter.format(value as number);
    },
    parseNumber(value) {
      const text = stripFinancialAffixes(
        value
          .normalize("NFKC")
          .trim()
          .replace(/[\u061c\u200e\u200f]/gu, ""),
        resolvedLocale,
      );
      if (!text) return undefined;
      return parsePreparedNumber(text, resolvedLocale, numberParser);
    },
  };
}

export function createDateFormatting(
  locale: string,
  timezone?: string,
  prepared?: PreparedDateFormatters,
): DateFormatting {
  const resolvedLocale = resolveFormattingLocale(locale);
  const defaultDateFormatter =
    prepared?.date ??
    new Intl.DateTimeFormat(resolvedLocale, {
      dateStyle: "medium",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  const defaultCalendarDateFormatter =
    prepared?.calendarDate ??
    new Intl.DateTimeFormat(resolvedLocale, {
      dateStyle: "medium",
      timeZone: "UTC",
    });
  const defaultCalendarDateTimeFormatter =
    prepared?.calendarDateTime ??
    new Intl.DateTimeFormat(resolvedLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });
  const defaultTimeOfDayFormatter =
    prepared?.timeOfDay ??
    new Intl.DateTimeFormat(resolvedLocale, { timeStyle: "short", timeZone: "UTC" });
  const defaultTimeFormatter =
    prepared?.time ??
    new Intl.DateTimeFormat(resolvedLocale, {
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  const defaultDateTimeFormatter =
    prepared?.dateTime ??
    new Intl.DateTimeFormat(resolvedLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  const dateFormatters = new Map<string, Intl.DateTimeFormat>();
  const dateFormatter = (options: DateDisplayOptions, applyTimezone: boolean) => {
    const effectiveTimezone = options.timeZone ?? (applyTimezone ? timezone : undefined);
    const key = [
      options.dateStyle,
      options.timeStyle,
      options.year,
      options.month,
      options.day,
      options.weekday,
      options.hour,
      options.minute,
      options.second,
      options.hour12,
      options.hourCycle,
      options.timeZoneName,
      options.timeZone,
      options.calendar,
      effectiveTimezone,
    ].join(":");
    let formatter = dateFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(resolvedLocale, {
        ...options,
        ...(effectiveTimezone ? { timeZone: effectiveTimezone } : {}),
      });
      dateFormatters.set(key, formatter);
    }
    return formatter;
  };

  return {
    formatDate(value, options = {}) {
      const parsed = toDate(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter(options, true).format(parsed)
          : defaultDateFormatter.format(parsed)
        : "-";
    },
    formatCalendarDate(value, options = {}) {
      const parsed = toCalendarDate(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter({ ...options, timeZone: "UTC" }, false).format(parsed.toDate("UTC"))
          : defaultCalendarDateFormatter.format(parsed.toDate("UTC"))
        : "-";
    },
    formatCalendarDateRange(start, end, options = {}) {
      const parsedStart = toCalendarDate(start);
      const parsedEnd = toCalendarDate(end);
      if (!parsedStart || !parsedEnd) return "-";
      const formatter = Object.keys(options).length
        ? dateFormatter({ ...options, timeZone: "UTC" }, false)
        : dateFormatter({ dateStyle: "medium", timeZone: "UTC" }, false);
      return formatter.formatRange(parsedStart.toDate("UTC"), parsedEnd.toDate("UTC"));
    },
    formatCalendarDateTime(value, options = {}) {
      const parsed = toCalendarDateTime(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter({ ...options, timeZone: "UTC" }, false).format(parsed.toDate("UTC"))
          : defaultCalendarDateTimeFormatter.format(parsed.toDate("UTC"))
        : "-";
    },
    formatTimeOfDay(value, options = {}) {
      const parsed = toTime(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter({ ...options, timeZone: "UTC" }, false).format(
              new Date(Date.UTC(1970, 0, 1, parsed.hour, parsed.minute, parsed.second)),
            )
          : defaultTimeOfDayFormatter.format(
              new Date(Date.UTC(1970, 0, 1, parsed.hour, parsed.minute, parsed.second)),
            )
        : "-";
    },
    formatTime(value, options = {}) {
      const parsed = toDate(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter(options, true).format(parsed)
          : defaultTimeFormatter.format(parsed)
        : "-";
    },
    formatDateTime(value, options = {}) {
      const parsed = toDate(value);
      return parsed
        ? Object.keys(options).length
          ? dateFormatter(options, true).format(parsed)
          : defaultDateTimeFormatter.format(parsed)
        : "-";
    },
    parseDate(value) {
      return parseLocalizedDate(value, resolvedLocale);
    },
  };
}

export function createFormatter(
  locale: string,
  timezone?: string,
  prepared?: PreparedFormatters,
): FormattingApi {
  const resolvedLocale = resolveFormattingLocale(locale);
  return {
    locale: resolvedLocale,
    timezone,
    ...createAmountFormatting(resolvedLocale, prepared),
    ...createNumberFormatting(resolvedLocale, prepared),
    ...createDateFormatting(resolvedLocale, timezone, prepared),
  };
}
