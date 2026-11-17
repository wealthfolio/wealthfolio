import type { IncompleteHoldingsAccount } from "@/lib/types";

/** Pending reason of an account with no calculated holdings to show yet. */
export const CALCULATION_REQUIRED = "CALCULATION_REQUIRED";

/**
 * Accounts whose holdings the response left out: unavailable, or never
 * calculated yet. An account only waiting for a running calculation is still
 * returned with its last calculated holdings, which the portfolio update's
 * completion refreshes.
 */
export function withheldHoldingsAccounts(
  accounts: IncompleteHoldingsAccount[] = [],
): IncompleteHoldingsAccount[] {
  return accounts.filter(
    (account) => account.status === "unavailable" || account.reasonCode === CALCULATION_REQUIRED,
  );
}

/** Every requested account's holdings are in the response. */
export function isHoldingsScopeReady(accounts: IncompleteHoldingsAccount[] = []): boolean {
  return withheldHoldingsAccounts(accounts).length === 0;
}
