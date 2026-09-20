import type { Account } from "@/lib/types";

/**
 * Normalize an account identifier or label for comparison: case-insensitive,
 * trimmed, with runs of whitespace collapsed.
 */
function normalizeAccountKey(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Index accounts by the values a CSV is likely to carry: the account id, its
 * name, and the broker account number. A key claimed by more than one account
 * resolves to `null` so an ambiguous CSV value is never auto-assigned.
 */
function buildAccountIndex(accounts: readonly Account[]): Map<string, string | null> {
  const index = new Map<string, string | null>();

  const add = (rawKey: string | undefined, accountId: string) => {
    const key = rawKey ? normalizeAccountKey(rawKey) : "";
    if (!key) return;
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, accountId);
    } else if (existing !== accountId) {
      index.set(key, null);
    }
  };

  for (const account of accounts) {
    add(account.id, account.id);
    add(account.name, account.id);
    add(account.accountNumber, account.id);
  }

  return index;
}

/**
 * Collect the distinct, non-blank account values a CSV column holds. Fallback
 * column arrays resolve to the first non-blank value in the row, matching how
 * mapped values are read elsewhere in the wizard.
 */
export function collectCsvAccountValues(
  rows: readonly string[][],
  headers: readonly string[],
  fieldMapping: string | string[] | undefined,
): string[] {
  if (!fieldMapping) return [];

  const mappedHeaders = Array.isArray(fieldMapping) ? fieldMapping : [fieldMapping];
  const indices = mappedHeaders
    .map((header) => headers.indexOf(header))
    .filter((index) => index !== -1);
  if (indices.length === 0) return [];

  const values = new Set<string>();
  for (const row of rows) {
    for (const index of indices) {
      const value = row[index]?.trim();
      if (value) {
        values.add(value);
        break;
      }
    }
  }

  return Array.from(values);
}

/**
 * Resolve CSV account values against existing accounts, the way column headers
 * are auto-mapped to fields. Values already mapped keep their assignment, so a
 * user's choice always wins over an automatic match.
 */
export function autoMatchAccountMappings(
  csvAccountValues: readonly string[],
  accounts: readonly Account[],
  accountMappings: Record<string, string> = {},
): Record<string, string> {
  if (csvAccountValues.length === 0 || accounts.length === 0) return accountMappings;

  const index = buildAccountIndex(accounts);
  const matched: Record<string, string> = {};

  for (const rawValue of csvAccountValues) {
    const value = rawValue.trim();
    if (!value || accountMappings[value]) continue;

    const accountId = index.get(normalizeAccountKey(value));
    if (accountId) {
      matched[value] = accountId;
    }
  }

  if (Object.keys(matched).length === 0) return accountMappings;
  return { ...accountMappings, ...matched };
}
