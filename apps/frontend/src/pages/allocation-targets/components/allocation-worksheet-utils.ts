import type { useAmountFormatting } from "@wealthfolio/ui";

import { maskAccountNumber } from "@/lib/account-number";
import type {
  Account,
  AllocationRule,
  AllocationTargetConstraint,
  AllocationWorksheetResult,
  CalculatedAdjustments,
  DriftReport,
  UnresolvedReason,
  WorksheetMode,
} from "@/lib/types";

import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";

export const AMOUNT_EPSILON = 0.01;

/** The drift report's category for value no asset class covers. */
export const UNCLASSIFIED_CATEGORY_ID = "__UNKNOWN__";

export const UNRESOLVED_REASON_KEYS: Record<UnresolvedReason, string> = {
  no_recorded_security: "allocation:worksheet.unresolvedNoRecordedSecurity",
  no_eligible_security: "allocation:worksheet.unresolvedNoEligibleSecurity",
  no_usable_price: "allocation:worksheet.unresolvedNoUsablePrice",
};

export type WorksheetEditMode = "amount" | "after_percentage";

export interface PositionAccountHolding {
  accountId: string;
  value: number;
  quantity: number;
}

export interface PositionCategoryExposure {
  categoryId: string;
  categoryName: string;
  weightBps: number;
}

export interface WorksheetPosition {
  assetId: string;
  symbol: string;
  name: string;
  value: number;
  quantity: number;
  currentPct: number;
  categoryIds: string[];
  categoryNames: string[];
  categoryExposures: PositionCategoryExposure[];
  accountHoldings: PositionAccountHolding[];
  isAdded: boolean;
}

type FormatAmount = ReturnType<typeof useAmountFormatting>["formatAmount"];

export function formatSignedAmount(
  value: number,
  currency: string,
  formatAmount: FormatAmount,
): string {
  if (!Number.isFinite(value) || Math.abs(value) < AMOUNT_EPSILON) return "—";
  return `${value > 0 ? "+" : "−"}${formatAmount(Math.abs(value), currency)}`;
}

export interface PositionAdjustment {
  inputMode: WorksheetEditMode;
  inputValue: string;
  /** Amount placed in each account, as entered. */
  accountAmounts: Record<string, string>;
  /**
   * Which way the change went when `accountAmounts` were placed: 1 for an
   * increase, -1 for a reduction. Typing a new total passes through an empty
   * field or a bare sign, so the previous keystroke cannot say.
   */
  placedDirection?: 1 | -1;
  /** What was placed while the change went the other way, until it turns back. */
  setAsideAccountAmounts?: Record<string, string>;
  /**
   * Whether the change was placed whole in one account at the last total that
   * could be read, so a cleared total retyped still follows it there, and a
   * partial placement still does not.
   */
  placedWhole?: boolean;
}

export type PositionAdjustments = Record<string, PositionAdjustment>;

export interface AllocationProgress {
  remaining: number;
  overallocated: number;
  isFullyAllocated: boolean;
}

const DECIMAL_INPUT_PATTERN = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

export function parseDecimalInput(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (!DECIMAL_INPUT_PATTERN.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(",", "."));
}

export function decimalInputOrZero(value: string): number {
  const parsed = parseDecimalInput(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDecimalInput(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return "";
  const normalized = Math.abs(value) < Number.EPSILON ? 0 : value;
  return normalized
    .toFixed(maximumFractionDigits)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

/**
 * An amount field as it reads when nobody is typing in it: the currency's
 * precision in the user's decimal mark. A calculated amount carries the float
 * residue of its price (239.240005); the full value returns on focus, and what
 * is stored never changes.
 */
export function amountAtRest(
  value: string,
  fractionDigits: number,
  decimalSeparator: string,
): string {
  const parsed = parseDecimalInput(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return value;
  const fixed = parsed.toFixed(fractionDigits);
  return (Number(fixed) === 0 ? (0).toFixed(fractionDigits) : fixed).replace(".", decimalSeparator);
}

export function allocationProgress(
  requested: number,
  assigned: number,
  epsilon: number,
): AllocationProgress {
  const difference = requested - assigned;
  return {
    remaining: Math.max(0, difference),
    overallocated: Math.max(0, -difference),
    isFullyAllocated: Math.abs(difference) <= epsilon,
  };
}

/**
 * The basis every target weight is sized against.
 *
 * Mirrors `planning_total` in the core worksheet service, so a final percentage
 * typed here converts to the amount the preview projects back as that same
 * percentage. With a cash sleeve the tracked cash is already in the total, and
 * only the cash not yet recorded widens it.
 */
export function planningTotal(
  totalValue: number,
  trackedCashToUse: number,
  externalCash: number,
  hasCashSleeve: boolean,
): number {
  return hasCashSleeve ? totalValue + externalCash : totalValue + trackedCashToUse + externalCash;
}

/**
 * The accounts a change may be placed in (§6).
 *
 * A reduction is drawn from the accounts that hold the security, which is a
 * fact. An increase may go to any account in scope that can technically take
 * the security: already holding it is not a reason to favour one account over
 * another, and an account that holds it can always take more.
 */
export function eligibleAccountIdsForChange(
  changeAmount: number,
  heldAccountIds: readonly string[],
  accountIds: readonly string[],
  /** Whether an account that does not hold the security can take it. */
  canReceive: (accountId: string) => boolean = () => true,
): string[] {
  const held = new Set(heldAccountIds);
  if (changeAmount >= 0) {
    return accountIds.filter((accountId) => held.has(accountId) || canReceive(accountId));
  }
  return accountIds.filter((accountId) => held.has(accountId));
}

/**
 * The account an increase lands in without the user placing it (§6).
 *
 * Which accounts record the security is a fact, the same fact a reduction is
 * drawn from. When exactly one eligible account already holds it, the increase
 * states that fact rather than choosing between accounts. A second holder hands
 * the choice back to the user.
 */
export function soleHoldingAccountId(
  heldAccountIds: readonly string[],
  eligibleAccountIds: readonly string[],
): string | undefined {
  const eligible = new Set(eligibleAccountIds);
  const holders = [...new Set(heldAccountIds)].filter((accountId) => eligible.has(accountId));
  return holders.length === 1 ? holders[0] : undefined;
}

/**
 * Which accounts an account allocation lists straight away (§6).
 *
 * The accounts that hold the security are a fact and come first. Any other
 * account the change could go to waits behind "Place in another account",
 * unless it already carries an amount. A security no eligible account holds
 * lists every account: there is no fact to put first.
 */
export function placementAccountIds(
  eligibleAccountIds: readonly string[],
  heldAccountIds: readonly string[],
  enteredAccountIds: readonly string[],
): { shown: string[]; hidden: string[] } {
  const held = new Set(heldAccountIds);
  if (!eligibleAccountIds.some((accountId) => held.has(accountId))) {
    return { shown: [...eligibleAccountIds], hidden: [] };
  }
  const entered = new Set(enteredAccountIds);
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const accountId of eligibleAccountIds) {
    (held.has(accountId) || entered.has(accountId) ? shown : hidden).push(accountId);
  }
  return { shown, hidden };
}

/**
 * The worksheet the calculated adjustments prefill (§5): one signed amount per
 * security, and the accounts the calculation placed it in. An increase the
 * calculation left unallocated arrives without account amounts, so the user
 * places it.
 */
export function adjustmentsFromCalculated(calculated: CalculatedAdjustments): PositionAdjustments {
  const totals = new Map<string, number>();
  const placed = new Map<string, Map<string, number>>();
  for (const line of calculated.adjustments) {
    totals.set(line.assetId, (totals.get(line.assetId) ?? 0) + line.amount);
    if (!line.accountId) continue;
    const accounts = placed.get(line.assetId) ?? new Map<string, number>();
    accounts.set(line.accountId, (accounts.get(line.accountId) ?? 0) + Math.abs(line.amount));
    placed.set(line.assetId, accounts);
  }

  const adjustments: PositionAdjustments = {};
  for (const [assetId, total] of totals) {
    adjustments[assetId] = {
      inputMode: "amount",
      inputValue: formatDecimalInput(total, 6),
      accountAmounts: Object.fromEntries(
        [...(placed.get(assetId) ?? [])].map(([accountId, amount]) => [
          accountId,
          formatDecimalInput(amount, 6),
        ]),
      ),
    };
  }
  return adjustments;
}

/**
 * The securities whose amounts or account placements the user changed since
 * the calculation, or added. Compared as numbers: a value only reformatted is
 * not an edit.
 */
export function editedAssetIds(
  adjustments: PositionAdjustments,
  calculated: CalculatedAdjustments,
): Set<string> {
  const expected = adjustmentsFromCalculated(calculated);
  const same = (left: string | undefined, right: string | undefined) =>
    left !== undefined &&
    right !== undefined &&
    Math.abs(decimalInputOrZero(left) - decimalInputOrZero(right)) < AMOUNT_EPSILON;
  const isEdited = (assetId: string) => {
    const actual = adjustments[assetId];
    const wanted = expected[assetId];
    if (!actual || !wanted) return true;
    if (actual.inputMode !== wanted.inputMode || !same(actual.inputValue, wanted.inputValue)) {
      return true;
    }
    const accountIds = new Set([
      ...Object.keys(actual.accountAmounts),
      ...Object.keys(wanted.accountAmounts),
    ]);
    return [...accountIds].some(
      (accountId) => !same(actual.accountAmounts[accountId], wanted.accountAmounts[accountId]),
    );
  };
  return new Set(
    [...new Set([...Object.keys(adjustments), ...Object.keys(expected)])].filter(isEdited),
  );
}

/**
 * The worksheet still holds the calculated amounts, so recalculating would
 * replace nothing the user entered (§5).
 */
export function isAsCalculated(
  adjustments: PositionAdjustments,
  calculated: CalculatedAdjustments,
): boolean {
  return editedAssetIds(adjustments, calculated).size === 0;
}

/**
 * How far a change split across accounts may be from the change, either way,
 * and still be accepted: 1% of the change, never under two cents. A remainder
 * that small moves no category in a way that matters, so it is stated rather
 * than demanded. Rounding is apart from it: under a whole-unit policy, once
 * part of the change is placed, what is left short of one more unit buys
 * nothing, so it may stay unplaced too. A change with nothing placed is never
 * accepted.
 */
export function placementSlack(
  requested: number,
  allocated: number,
  wholeUnitPrice: number | undefined,
): { short: number; over: number } {
  const over = Math.max(0.02, requested * 0.01);
  if (allocated < AMOUNT_EPSILON) return { short: 0, over };
  return { short: wholeUnitPrice ? Math.max(over, wholeUnitPrice) : over, over };
}

/**
 * How far a unit price may move before the worksheet stops matching its
 * calculation. Prices move all day and are synced when the app opens; a
 * smaller move only changes the estimated quantities, which the preview
 * already shows.
 */
export const PRICE_MOVE_THRESHOLD = 0.01;

/**
 * Whether a unit price moved by more than PRICE_MOVE_THRESHOLD since a
 * calculation used it. Prices are not among the inputs §5 lists; this check is
 * an addition to it, proposed on the PR.
 */
export function unitPriceMoved(now: number, calculatedWith: number): boolean {
  return Math.abs(now - calculatedWith) > Math.abs(calculatedWith) * PRICE_MOVE_THRESHOLD;
}

/** Cash not yet recorded, keyed by the account it would arrive in. */
/** What one change places in each account: positive increases, negative reductions. */
export interface RowPlacementLedger {
  byAccount: ReadonlyMap<string, number>;
  /** The worksheet's check accepts this change's placement as entered. */
  isValid: boolean;
}

export interface AccountFundingEstimate {
  /** What the account can still fund, never below zero. */
  capacity: number;
  /** How far the other changes already exceed its funding. */
  deficit: number;
}

/**
 * What each account can still fund for one change, estimated from what the
 * page holds (§6): the cash it deploys and its contribution, plus what valid
 * reductions elsewhere raise in it, minus what other changes already place in
 * it, partly placed ones included. The change itself is left out. Each account
 * stands alone, so a shortfall in one is never offset by another. The preview
 * still decides: it resolves whole units and held quantities.
 */
export function estimatedFunding(
  fundingByAccount: Readonly<Record<string, number>>,
  ledgers: ReadonlyMap<string, RowPlacementLedger>,
  excludeAssetId: string,
  accountIds: readonly string[],
): Map<string, AccountFundingEstimate> {
  const estimates = new Map<string, AccountFundingEstimate>();
  for (const accountId of accountIds) {
    let balance = fundingByAccount[accountId] ?? 0;
    for (const [assetId, ledger] of ledgers) {
      if (assetId === excludeAssetId) continue;
      const amount = ledger.byAccount.get(accountId) ?? 0;
      // An increase reserves what it places even while its row is incomplete;
      // a reduction only adds what a valid placement raises.
      if (amount > 0 || ledger.isValid) balance -= amount;
    }
    estimates.set(accountId, {
      capacity: Math.max(0, balance),
      deficit: Math.max(0, -balance),
    });
  }
  return estimates;
}

/**
 * What one account can take of a change: what is left of it, capped by what
 * the account can fund or holds, in whole units under a whole-unit policy.
 * What is left is offered to the cent as the row shows it, so taking it
 * completes the row; the cap is cut down to the cent, so the offer is never
 * more than the account can fund. Nothing while the cap is not known:
 * offering the whole change could place it where it cannot be funded.
 */
export function amountAccountCanTake(
  remaining: number,
  cap: number | undefined,
  unitPrice: number | undefined,
  wholeSharesOnly: boolean,
  fractionDigits: number,
): number {
  if (cap === undefined) return 0;
  const scale = 10 ** fractionDigits;
  const capped = Math.min(
    Math.round(remaining * scale) / scale,
    floorToDigits(cap, fractionDigits),
  );
  // The unit price is derived from the recorded holding rather than the quote
  // the core resolves against, so the floor gets a tolerance and never drops a
  // unit over the last decimal. An amount that buys nothing is still offered:
  // the core reports such a line, and withholding it only forces the same
  // amount in by hand.
  const wholeUnits =
    wholeSharesOnly && unitPrice ? Math.floor(capped / unitPrice + 1e-9) * unitPrice : capped;
  if (wholeUnits <= AMOUNT_EPSILON) return floorToDigits(capped, fractionDigits);
  // Whole units are rounded up to the cent, as a unit step is: the preview
  // floors the quantity, so three units at 39.849998 offered as 119.54 would
  // come back as two. `capped` is in cents and holds the units, so rounding
  // up never passes it.
  return wholeSharesOnly && unitPrice
    ? Math.ceil(wholeUnits * scale - 1e-6) / scale
    : floorToDigits(wholeUnits, fractionDigits);
}

/**
 * An amount cut down to the currency's smallest unit, never rounded up past
 * what it was: how much an account can fund is stated, and offered, this way.
 */
export function floorToDigits(amount: number, fractionDigits: number): number {
  const scale = 10 ** fractionDigits;
  return Math.floor(amount * scale + 1e-6) / scale;
}

/**
 * Whether what an account has left is a shortfall, counted to the cent as the
 * core counts it: dividing by a price leaves residue far past the cent, and an
 * account spent to the cent is not short.
 */
export function isShortOfFunding(remaining: number): boolean {
  return Math.round(remaining * 100) < 0;
}

/**
 * Each account's name, told apart from another account of the same name by the
 * end of its number, or else by its currency. Setup shows both beside the
 * name; everywhere else the name stands alone and has to carry the difference.
 */
export function accountLabels(
  accounts: readonly Pick<Account, "id" | "name" | "currency" | "accountNumber">[],
): Map<string, string> {
  const key = (name: string) => name.trim().toLowerCase();
  const byName = new Map<string, number>();
  for (const account of accounts) {
    byName.set(key(account.name), (byName.get(key(account.name)) ?? 0) + 1);
  }
  return new Map(
    accounts.map((account) => {
      if ((byName.get(key(account.name)) ?? 0) < 2) return [account.id, account.name];
      const maskedNumber = maskAccountNumber(account.accountNumber);
      if (maskedNumber) return [account.id, `${account.name} ${maskedNumber}`];
      const sharesCurrency = accounts.some(
        (other) =>
          other.id !== account.id &&
          key(other.name) === key(account.name) &&
          other.currency === account.currency,
      );
      return [
        account.id,
        account.currency && !sharesCurrency
          ? `${account.name} (${account.currency})`
          : account.name,
      ];
    }),
  );
}

export function externalContributionFor(
  accountIds: readonly string[],
  entered: Readonly<Record<string, string>>,
): Record<string, number> {
  const contribution: Record<string, number> = {};
  for (const accountId of accountIds) {
    const amount = parseDecimalInput(entered[accountId] ?? "");
    if (Number.isFinite(amount) && amount > 0) contribution[accountId] = amount;
  }
  return contribution;
}

export interface WorksheetGenerationInputs {
  targetId: string;
  targetVersion: string;
  accountIds: readonly string[];
  mode: WorksheetMode;
  rule: AllocationRule;
  trackedCashToUse: number;
  /** What each account may spend, once the cash it records is known. */
  trackedCashByAccount?: Readonly<Record<string, number>>;
  externalContribution: Readonly<Record<string, number>>;
  /** Omitted means every recorded security; an empty list is a different, valid selection. */
  eligibleAssetIds?: readonly string[];
  /** The securities that may be sold; omitted means every recorded security. */
  sellableAssetIds?: readonly string[];
}

/**
 * A fingerprint of everything the calculation depends on (§5).
 *
 * When it no longer matches the one the adjustments were calculated from, the
 * worksheet is marked as out of date. Edits to the adjustments are deliberately
 * not part of it: an edited worksheet still matches its inputs.
 */
export function generationInputsKey(inputs: WorksheetGenerationInputs): string {
  return JSON.stringify([
    inputs.targetId,
    inputs.targetVersion,
    [...inputs.accountIds].sort(),
    inputs.mode,
    inputs.rule,
    inputs.trackedCashToUse,
    Object.entries(inputs.externalContribution)
      .filter(([, amount]) => amount > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
    inputs.eligibleAssetIds === undefined ? null : [...inputs.eligibleAssetIds].sort(),
    // Set once the cash each account records is known.
    ...(inputs.trackedCashByAccount
      ? [
          Object.entries(inputs.trackedCashByAccount).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ]
      : []),
    // Only when something is kept from the sales, so a worksheet calculated
    // before it existed still matches.
    ...(inputs.sellableAssetIds === undefined
      ? []
      : [{ sellable: [...inputs.sellableAssetIds].sort() }]),
  ]);
}

export interface ImpactClass {
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  projectedBps: number;
  targetBps: number;
  projectedDifferenceBps: number;
  effectiveBandBps: number;
  currentValue: number;
  projectedValue: number;
}

/**
 * Every class the worksheet can move, in the preview's figures once there is
 * one. The rows' class dots take their colours from the same list.
 */
export function impactClasses(
  report: DriftReport,
  result: AllocationWorksheetResult | null,
  defaultBandBps: number,
): ImpactClass[] {
  const driftByCategory = new Map(report.rows.map((row) => [row.categoryId, row]));
  const sourceRows =
    result?.categories ??
    report.rows.map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      currentBps: row.currentBps,
      projectedBps: row.currentBps,
      targetBps: row.targetBps,
      projectedDifferenceBps: row.driftBps,
      currentValue: row.currentValue,
      projectedValue: row.currentValue,
    }));
  const visibleRows = sourceRows.filter(
    (row) => row.currentBps > 0 || row.projectedBps > 0 || row.targetBps > 0,
  );
  // Colours come from the drift report's own list, as on the allocation page,
  // so a class keeps its colour whichever classes the rail leaves out.
  const colorMap = buildAllocationTargetColorMap([...report.rows, ...visibleRows]);
  return visibleRows.map((row, index) => ({
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    currentBps: row.currentBps,
    projectedBps: row.projectedBps,
    targetBps: row.targetBps,
    projectedDifferenceBps: row.projectedDifferenceBps,
    currentValue: row.currentValue,
    projectedValue: row.projectedValue,
    color: allocationTargetColorForRow(row, colorMap, index),
    effectiveBandBps: driftByCategory.get(row.categoryId)?.effectiveBandBps ?? defaultBandBps,
  }));
}

/** The target's blocking rules, as the calculation applies them (§4.1, #1177). */
export interface StandingRules {
  /** Whether a reduction of the security in this account is blocked. */
  blocksReduce: (assetId: string, accountId: string, categoryIds: readonly string[]) => boolean;
  /** Whether any increase of the security is blocked. */
  blocksIncrease: (assetId: string, categoryIds: readonly string[]) => boolean;
  /** Accounts whose holdings are never reduced. */
  protectedAccountIds: ReadonlySet<string>;
}

/**
 * Reads the target's constraints the way the core does: only `block` rules
 * bind, `trade` covers both directions, and a category rule matches the
 * classified categories a security counts towards, never Unknown. `avoid`
 * only warns in the preview, so it stays out.
 */
export function standingRules(constraints: readonly AllocationTargetConstraint[]): StandingRules {
  const blocks = constraints.filter((constraint) => constraint.effect === "block");
  const covers = (constraint: AllocationTargetConstraint, action: "buy" | "sell") =>
    constraint.action === "trade" || constraint.action === action;
  const matches = (
    constraint: AllocationTargetConstraint,
    assetId: string,
    accountId: string | null,
    categoryIds: readonly string[],
  ) => {
    switch (constraint.subjectType) {
      case "asset":
        return constraint.subjectId === assetId;
      case "account":
        return accountId !== null && constraint.subjectId === accountId;
      case "category":
        return (
          constraint.subjectId !== UNCLASSIFIED_CATEGORY_ID &&
          categoryIds.includes(constraint.subjectId)
        );
    }
  };
  return {
    blocksReduce: (assetId, accountId, categoryIds) =>
      blocks.some(
        (constraint) =>
          covers(constraint, "sell") && matches(constraint, assetId, accountId, categoryIds),
      ),
    blocksIncrease: (assetId, categoryIds) =>
      blocks.some(
        (constraint) =>
          covers(constraint, "buy") && matches(constraint, assetId, null, categoryIds),
      ),
    protectedAccountIds: new Set(
      blocks
        .filter((constraint) => constraint.subjectType === "account" && covers(constraint, "sell"))
        .map((constraint) => constraint.subjectId),
    ),
  };
}

/** Up to three symbols, then how many more. */
export function symbolList(symbols: readonly string[], more: (count: number) => string): string {
  const shown = symbols.slice(0, 3).join(", ");
  return symbols.length > 3 ? `${shown} ${more(symbols.length - 3)}` : shown;
}
