/**
 * The end of an account number, for showing beside the account's name:
 * "··" and its last four characters, spaces ignored, so an IBAN typed in
 * groups still ends in its digits. Nothing when the account has no number.
 */
export function maskAccountNumber(accountNumber?: string | null): string | null {
  const compact = accountNumber?.replace(/\s+/g, "") ?? "";
  return compact ? `··${compact.slice(-4)}` : null;
}
