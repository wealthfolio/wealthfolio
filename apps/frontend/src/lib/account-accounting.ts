import { AccountType } from "@/lib/constants";

// An account's accounting settings live in its meta under `accounting`, read
// by core as the portfolio engine needs them (engine rules R7.2, R1.6).

export const CASH_TRACKED = "TRACKED";
export const CASH_NOT_TRACKED = "NOT_TRACKED";

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMetaObject(meta?: string | null): Record<string, unknown> | null {
  if (!meta) return null;
  try {
    return asObject(JSON.parse(meta));
  } catch {
    return null;
  }
}

export function getAccountingFromMeta(meta?: string | null): Record<string, unknown> {
  return asObject(parseMetaObject(meta)?.accounting) ?? {};
}

/**
 * Whether an account can stop tracking cash: a transactions account that holds
 * securities. Mirrors core's `can_leave_cash_untracked`, which owns the rule.
 */
export function supportsCashTracking(
  accountType: string | undefined,
  trackingMode: string | undefined,
): boolean {
  return (
    trackingMode === "TRANSACTIONS" &&
    (accountType === AccountType.SECURITIES || accountType === AccountType.CRYPTOCURRENCY)
  );
}

// The stored code as core reads it: exactly, so a code core refuses is not
// shown as either choice.
export function getCashTrackingFromMeta(meta?: string | null): string {
  const accounting = getAccountingFromMeta(meta);
  const code = accounting.cashTracking ?? accounting.cash_tracking;
  return typeof code === "string" ? code : CASH_TRACKED;
}

export function setCashTrackingInMeta(meta: string | null | undefined, code: string): string {
  // Meta that is not a JSON object cannot hold settings: start a new one.
  const parsed = parseMetaObject(meta) ?? {};
  // Keep the rest of the accounting settings; one spelling of the key.
  const accounting = { ...getAccountingFromMeta(meta) };
  delete accounting.cash_tracking;
  parsed.accounting = { ...accounting, cashTracking: code };
  return JSON.stringify(parsed);
}

/** Whether the account holds no cash of its own (engine rules R1.6). */
export function isCashNotTracked(account: {
  accountType?: string;
  trackingMode?: string;
  meta?: string | null;
}): boolean {
  return (
    supportsCashTracking(account.accountType, account.trackingMode) &&
    getCashTrackingFromMeta(account.meta) === CASH_NOT_TRACKED
  );
}
