import type { useAmountFormatting } from "@wealthfolio/ui";

import type {
  AllocationRule,
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
 * fact. An increase may go to any account in scope: already holding the
 * security is not a reason to favour one account over another.
 */
export function eligibleAccountIdsForChange(
  changeAmount: number,
  heldAccountIds: readonly string[],
  accountIds: readonly string[],
): string[] {
  if (changeAmount >= 0) return [...accountIds];
  const held = new Set(heldAccountIds);
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
  externalContribution: Readonly<Record<string, number>>;
  /** Omitted means every recorded security; an empty list is a different, valid selection. */
  eligibleAssetIds?: readonly string[];
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
  const colorMap = buildAllocationTargetColorMap(visibleRows);
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
