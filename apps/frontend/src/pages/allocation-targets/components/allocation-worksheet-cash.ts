import {
  AMOUNT_EPSILON,
  formatDecimalInput,
  parseDecimalInput,
} from "./allocation-worksheet-utils";

/**
 * The tracked cash each selected account may spend (§6).
 *
 * The user sets it one of two ways: one total, spent as the same share of
 * what every account records, or an amount per account. Either way each
 * account spends only its own cash, and the total is the sum of the accounts.
 */
export interface CashToUse {
  /** What each selected account may spend, in the planning currency. */
  byAccount: Record<string, number>;
  total: number;
  /** What the selected accounts record together, as far as it is known. */
  recordedTotal: number;
  /** The share of each account's cash, while one share applies to every account. */
  share: number | null;
  /** Every selected account's recorded cash is known. */
  isKnown: boolean;
  /** The total asks for more than the selected accounts record. */
  isTotalAboveRecorded: boolean;
  isTotalInvalid: boolean;
  /** Accounts whose own amount asks for more than they record. */
  aboveRecordedAccountIds: string[];
  /** Accounts whose own amount is not a valid number. */
  invalidAccountIds: string[];
}

export interface CashToUseInput {
  accountIds: readonly string[];
  /** What each account records, as the core counts it. Absent while unknown. */
  recordedByAccount: Readonly<Record<string, number>>;
  /** The total, spent as one share of every account; `null` spends all of it. */
  trackedCash: string | null;
  /** Amounts per account; `null` while one share applies to every account. */
  cashByAccount: Readonly<Record<string, string>> | null;
  fractionDigits: number;
}

/**
 * Splits a total across accounts as one share of what each records, exact to
 * the currency's smallest unit. The units the share leaves over go to the
 * largest remainders, so the parts always add up to the total and no account
 * spends more than it records.
 */
export function splitByShare(
  total: number,
  accounts: readonly { accountId: string; recorded: number }[],
  fractionDigits: number,
): Record<string, number> {
  const unit = 10 ** fractionDigits;
  const recordedTotal = accounts.reduce((sum, account) => sum + Math.max(0, account.recorded), 0);
  const parts: Record<string, number> = {};
  if (recordedTotal <= 0 || total <= 0) {
    for (const account of accounts) parts[account.accountId] = 0;
    return parts;
  }
  const targetUnits = Math.round(Math.min(total, recordedTotal) * unit);
  const rows = accounts.map((account, index) => {
    const recorded = Math.max(0, account.recorded);
    const exact = (recorded / recordedTotal) * targetUnits;
    const units = Math.floor(exact + 1e-9);
    return {
      accountId: account.accountId,
      index,
      units,
      remainder: exact - units,
      cap: Math.floor(recorded * unit + 1e-9),
    };
  });
  let left = targetUnits - rows.reduce((sum, row) => sum + row.units, 0);
  const byRemainder = [...rows].sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  while (left > 0) {
    const next = byRemainder.find((row) => row.units < row.cap);
    if (!next) break;
    next.units += 1;
    next.remainder = -1;
    left -= 1;
    byRemainder.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  }
  for (const row of rows) parts[row.accountId] = row.units / unit;
  return parts;
}

export function cashToUse({
  accountIds,
  recordedByAccount,
  trackedCash,
  cashByAccount,
  fractionDigits,
}: CashToUseInput): CashToUse {
  const isKnown = accountIds.every((accountId) => recordedByAccount[accountId] !== undefined);
  const recorded = accountIds.map((accountId) => ({
    accountId,
    recorded: Math.max(0, recordedByAccount[accountId] ?? 0),
  }));
  const recordedTotal = recorded.reduce((sum, account) => sum + account.recorded, 0);
  const sum = (amounts: Record<string, number>) =>
    Object.values(amounts).reduce((total, amount) => total + amount, 0);

  if (cashByAccount === null) {
    const asked = trackedCash === null ? recordedTotal : parseDecimalInput(trackedCash);
    const isTotalInvalid = !Number.isFinite(asked) || asked < 0;
    const byAccount = splitByShare(isTotalInvalid ? 0 : asked, recorded, fractionDigits);
    const total = sum(byAccount);
    return {
      byAccount,
      total,
      recordedTotal,
      share: recordedTotal > 0 ? total / recordedTotal : null,
      isKnown,
      isTotalAboveRecorded: isKnown && !isTotalInvalid && asked > recordedTotal + AMOUNT_EPSILON,
      isTotalInvalid,
      aboveRecordedAccountIds: [],
      invalidAccountIds: [],
    };
  }

  const byAccount: Record<string, number> = {};
  const aboveRecordedAccountIds: string[] = [];
  const invalidAccountIds: string[] = [];
  for (const account of recorded) {
    const entered = cashByAccount[account.accountId];
    // An account the user has not set spends what it records, as it would
    // under one share of everything.
    const asked = entered === undefined ? account.recorded : parseDecimalInput(entered);
    if (!Number.isFinite(asked) || asked < 0) {
      invalidAccountIds.push(account.accountId);
      byAccount[account.accountId] = 0;
      continue;
    }
    const isAccountKnown = recordedByAccount[account.accountId] !== undefined;
    if (isAccountKnown && asked > account.recorded + AMOUNT_EPSILON) {
      aboveRecordedAccountIds.push(account.accountId);
    }
    byAccount[account.accountId] = isAccountKnown ? Math.min(asked, account.recorded) : 0;
  }
  return {
    byAccount,
    total: sum(byAccount),
    recordedTotal,
    share: null,
    isKnown,
    isTotalAboveRecorded: false,
    isTotalInvalid: false,
    aboveRecordedAccountIds,
    invalidAccountIds,
  };
}

/** The current amounts as entries the user can edit one account at a time. */
export function editableAmounts(
  byAccount: Readonly<Record<string, number>>,
  fractionDigits: number,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(byAccount).map(([accountId, amount]) => [
      accountId,
      formatDecimalInput(amount, fractionDigits),
    ]),
  );
}
