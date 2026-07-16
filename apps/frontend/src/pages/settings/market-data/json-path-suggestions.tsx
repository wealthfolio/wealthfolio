/** Utilities for extracting numeric values from JSON and HTML responses. */

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface PathEntry {
  path: string;
  value: number;
  /** Original source-string form if this entry came from a stringified number
   *  (e.g. "105.90"). Preserves trailing zeros so downstream text lookups match. */
  raw?: string;
}

const DOT_NOTATION_KEY = /^(?!length\(\)$)[A-Za-z0-9_#/\\-]+$/;

/** Append an object key using syntax accepted by the backend JSONPath parser. */
export function appendJsonPathKey(path: string, key: string): string {
  return DOT_NOTATION_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Recursively collect all numeric leaf paths from a parsed JSON value.
 *  For arrays, generates both `[0]` (specific) and `[*]` (all elements) paths.
 *  The `[*]` variant is shown first for arrays with homogeneous structure. */
export function walkJson(value: unknown, path = "$"): PathEntry[] {
  if (typeof value === "number" && isFinite(value)) {
    return [{ path, value }];
  }
  if (typeof value === "string") {
    const n = parseFloat(value);
    if (!isNaN(n) && isFinite(n)) return [{ path, value: n, raw: value }];
    return [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // Generate [*] paths from first element (for "select all" pattern)
    const wildcardEntries = walkJson(value[0], `${path}[*]`);
    // Generate [0] paths from first element (for "select specific" pattern)
    const specificEntries = walkJson(value[0], `${path}[0]`);
    // Show wildcard first, then specific
    return [...wildcardEntries, ...specificEntries];
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => walkJson(v, appendJsonPathKey(path, k)));
  }
  return [];
}

/** Make a JSONPath human-readable: "$.bitcoin.usd" → "bitcoin.usd" */
export function friendlyPath(path: string): string {
  return path.replace(/^\$\.?/, "") || "$";
}

export function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (n !== Math.floor(n)) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(n);
}
