/** The account ids a limit counts, from its comma-separated `accountIds`. */
export function parseAccountIds(accountIds: string | null | undefined): string[] {
  return (accountIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
