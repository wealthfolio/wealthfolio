import { ImportFormat } from "@/lib/constants";

export interface NumericColumnAnalysis {
  decimalSeparator: string;
  issue?: "ambiguous" | "conflicting";
}

const NUMERIC_FIELDS: string[] = [
  ImportFormat.QUANTITY,
  ImportFormat.UNIT_PRICE,
  ImportFormat.AMOUNT,
  ImportFormat.FEE,
  ImportFormat.TAX,
  ImportFormat.FX_RATE,
];

/** Some number formats write negatives with U+2212 instead of a hyphen. */
export function normalizeMinusSign(value: string): string {
  return value.trim().replace(/−/g, "-");
}

/**
 * Drops a currency label around a number: "US$1,500", "Rs. 1,500", "1,500 usd".
 * A dot after one or two letters ends an abbreviation ("Rs.100"); after a three-letter
 * code it can start the decimals ("USD.50").
 */
export function stripCurrencyLabel(value: string): string {
  return value
    .trim()
    .replace(
      /^([+-]?)\s*\p{Sc}*\s*(?:(?:\p{L}{1,2}\.?|\p{L}{3}(?:\.(?=\s|\d+[.,]\d))?)\s*)?\p{Sc}*\s*(?=[+-]?[\d.,])/u,
      "$1",
    )
    .replace(/([\d.,])\s*\p{Sc}*\s*\p{L}{1,3}\.?$/u, "$1");
}

/** Only well-formed numbers supply evidence; labels and malformed cells do not. */
function classifyNumericFormat(
  value: string | undefined,
  thousandsSeparator: string,
): "." | "," | "ambiguous" | undefined {
  if (!value) return undefined;
  let normalized = normalizeMinusSign(value);
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1);
  }
  // The label goes first: "kr. 100" needs its space to tell the label's dot from a decimal.
  normalized = stripCurrencyLabel(normalized).replace(/\p{Sc}|\s/gu, "");
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = stripCurrencyLabel(normalized.slice(1, -1));
  }
  const match = /^[+-]?([\d.,]+)(?:[eE][+-]?\d+)?$/.exec(normalized);
  if (!match) return undefined;
  const mantissa = match[1];
  const allowsPunctuationGrouping = thousandsSeparator === "auto";

  if (mantissa.includes(",") && mantissa.includes(".")) {
    if (!allowsPunctuationGrouping) return undefined;
    if (/^\d{1,3}(,\d{3})+\.\d+$/.test(mantissa)) return ".";
    if (/^\d{1,2}(,\d{2})+,\d{3}\.\d+$/.test(mantissa)) return ".";
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(mantissa)) return ",";
    return undefined;
  }
  if (allowsPunctuationGrouping && /^\d{1,3}(,\d{3}){2,}$/.test(mantissa)) return ".";
  // Lakh grouping: 1,23,456 and 1,00,00,000.
  if (allowsPunctuationGrouping && /^\d{1,2}(,\d{2})+,\d{3}$/.test(mantissa)) return ".";
  if (allowsPunctuationGrouping && /^\d{1,3}(\.\d{3}){2,}$/.test(mantissa)) return ",";

  const singleSeparator = /^(\d*)([.,])(\d*)$/.exec(mantissa);
  if (!singleSeparator || !/\d/.test(mantissa)) return undefined;
  if (
    allowsPunctuationGrouping &&
    singleSeparator[1] !== "0" &&
    /^\d{1,3}[.,]\d{3}$/.test(mantissa)
  )
    return "ambiguous";
  return singleSeparator[2] as "." | ",";
}

/** Resolve Auto once per column. Explicit settings always take precedence. */
export function analyzeNumericColumn(
  values: (string | undefined)[],
  decimalSeparator: string,
  thousandsSeparator: string,
): NumericColumnAnalysis {
  if (decimalSeparator !== "auto") return { decimalSeparator };
  if (thousandsSeparator === ",") return { decimalSeparator: "." };
  if (thousandsSeparator === ".") return { decimalSeparator: "," };

  const evidence = new Set<string>();
  let hasAmbiguousValue = false;
  for (const value of values) {
    const format = classifyNumericFormat(value, thousandsSeparator);
    if (format === "ambiguous") hasAmbiguousValue = true;
    else if (format) evidence.add(format);
  }
  if (evidence.size > 1) return { decimalSeparator: "auto", issue: "conflicting" };
  const [resolved] = evidence;
  if (resolved) return { decimalSeparator: resolved };
  return {
    decimalSeparator: "auto",
    ...(hasAmbiguousValue ? { issue: "ambiguous" as const } : {}),
  };
}

/** Keep the historical per-value choice when a column cannot be resolved. */
export function resolveNumericDecimalSeparator(
  value: string,
  decimalSeparator: string,
  thousandsSeparator: string,
): string {
  const analysis = analyzeNumericColumn([value], decimalSeparator, thousandsSeparator);
  if (analysis.decimalSeparator !== "auto") return analysis.decimalSeparator;
  return value.lastIndexOf(",") > value.lastIndexOf(".") ? "," : ".";
}

export function getMappedColumnValue(
  row: string[],
  headerIndex: Record<string, number>,
  mappedHeader: string | string[] | undefined,
): string | undefined {
  if (!mappedHeader) return undefined;
  if (Array.isArray(mappedHeader)) {
    for (const header of mappedHeader) {
      const value = row[headerIndex[header]]?.trim();
      if (value) return value;
    }
    return undefined;
  }
  return row[headerIndex[mappedHeader]];
}

export function analyzeMappedNumericColumns(
  headers: string[],
  rows: string[][],
  fieldMappings: Record<string, string | string[]>,
  decimalSeparator: string,
  thousandsSeparator: string,
): Record<string, NumericColumnAnalysis> {
  const headerIndex = Object.fromEntries(headers.map((header, index) => [header, index]));
  return Object.fromEntries(
    Object.entries(fieldMappings)
      .filter(([field]) => NUMERIC_FIELDS.includes(field))
      .map(([field, mappedHeader]) => [
        field,
        analyzeNumericColumn(
          rows.map((row) => getMappedColumnValue(row, headerIndex, mappedHeader)),
          decimalSeparator,
          thousandsSeparator,
        ),
      ]),
  );
}
