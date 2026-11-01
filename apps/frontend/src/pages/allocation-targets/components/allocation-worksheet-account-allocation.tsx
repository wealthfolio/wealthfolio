import { Button, Icons, useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, WorksheetAccountFunding } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  describePlacementProblem,
  displayUnits,
  stepByUnits,
  type PlacementProblem,
} from "./allocation-worksheet-amounts";
import { InfoTip } from "./allocation-worksheet-securities";
import { StepperField } from "./allocation-worksheet-stepper-field";
import {
  allocationProgress,
  AMOUNT_EPSILON,
  amountAccountCanTake,
  amountAtRest,
  decimalInputOrZero,
  floorToDigits,
  formatDecimalInput,
  placementAccountIds,
  type AccountFundingEstimate,
  type PositionAdjustment,
  type WorksheetPosition,
} from "./allocation-worksheet-utils";

interface AccountAllocationProps {
  position: WorksheetPosition;
  changeAmount: number;
  accounts: Account[];
  /** How each account is named where its name stands alone. */
  accountNames: ReadonlyMap<string, string>;
  adjustment: PositionAdjustment;
  currency: string;
  fundingByAccount: Map<string, WorksheetAccountFunding>;
  /** Resolved in the base currency, when the position records one. */
  unitPrice: number | undefined;
  wholeSharesOnly: boolean;
  /** The sole eligible account recording this security, which takes the change until the user splits it (§6). */
  impliedAccountId: string | undefined;
  /** What each account can still fund for this change; absent while cash is read. */
  fundingEstimates: ReadonlyMap<string, AccountFundingEstimate> | undefined;
  /** What each account deploys in this run, deposit included, behind its estimate. */
  deployedByAccount: Readonly<Record<string, number>> | undefined;
  /** What the worksheet's check says keeps this change out, if anything. */
  problem: PlacementProblem | undefined;
  onAmountChange: (accountId: string, value: string) => void;
  /**
   * Makes the change what the accounts hold, as an amount; absent where the
   * change is not entered as one.
   */
  onUsePlaced?: (amount: number) => void;
  /** Covers an account's shortfall with a deposit, when the user asks. */
  onAddDeposit: (accountId: string, amount: number) => void;
}

/**
 * Where a change sits (§6). A single eligible account takes the whole change;
 * with several, the user places it and nothing is assigned by default.
 */
export function AccountAllocation({
  position,
  changeAmount,
  accounts,
  accountNames,
  adjustment,
  currency,
  fundingByAccount,
  unitPrice,
  wholeSharesOnly,
  impliedAccountId,
  fundingEstimates,
  deployedByAccount,
  problem,
  onAmountChange,
  onUsePlaced,
  onAddDeposit,
}: AccountAllocationProps) {
  const { t } = useTranslation();
  const { formatAmount, currencyFractionDigits } = useAmountFormatting();
  const { formatQuantity, decimalSeparator } = useNumberFormatting();
  const fractionDigits = currencyFractionDigits(currency);
  const nameOf = (account: Account) => accountNames.get(account.id) ?? account.name;
  const [typingAccountId, setTypingAccountId] = useState<string | null>(null);
  const [typingValue, setTypingValue] = useState("");
  // At the currency's precision except while it is typed in, like the row's field.
  const atRest = (accountId: string, value: string) =>
    typingAccountId === accountId
      ? typingValue
      : amountAtRest(value, fractionDigits, decimalSeparator);
  // The same unit steps as the row: the account's amount moves, the units follow.
  const canStep = unitPrice !== undefined && unitPrice > 0;
  const stepAccount = (accountId: string, amount: number, step: 1 | -1) => {
    if (!unitPrice) return;
    const next = Math.max(0, stepByUnits(amount, unitPrice, step, wholeSharesOnly, fractionDigits));
    onAmountChange(accountId, formatDecimalInput(next, fractionDigits));
  };
  const [showOtherAccounts, setShowOtherAccounts] = useState(false);
  const requested = Math.abs(changeAmount);
  const hasEnteredAmount = accounts.some(
    (account) => (adjustment.accountAmounts[account.id] ?? "").trim() !== "",
  );
  const impliedHolder = hasEnteredAmount ? undefined : impliedAccountId;
  const amountFor = (accountId: string) =>
    impliedHolder === accountId
      ? requested
      : Math.max(0, decimalInputOrZero(adjustment.accountAmounts[accountId] ?? ""));
  const assigned =
    accounts.length === 1
      ? requested
      : accounts.reduce((sum, account) => sum + amountFor(account.id), 0);
  const { isFullyAllocated } = allocationProgress(requested, assigned, AMOUNT_EPSILON);
  const difference = requested - assigned;
  const isReduce = changeAmount < 0;
  const { shown, hidden } = placementAccountIds(
    accounts.map((account) => account.id),
    position.accountHoldings
      .filter((holding) => holding.quantity > 0)
      .map((holding) => holding.accountId),
    accounts
      .filter((account) => (adjustment.accountAmounts[account.id] ?? "").trim() !== "")
      .map((account) => account.id),
  );
  const listedAccounts = showOtherAccounts
    ? accounts
    : accounts.filter((account) => shown.includes(account.id));
  // The listed accounts' own funding, side by side: a fact about each, never
  // pooled across accounts and never a ranking of them (§6).
  const listedCapacity =
    !isReduce && accounts.length > 1 && fundingEstimates
      ? listedAccounts.reduce(
          (sum, account) =>
            sum + floorToDigits(fundingEstimates.get(account.id)?.capacity ?? 0, fractionDigits),
          0,
        )
      : undefined;
  const format = (amount: number) => formatAmount(amount, currency);
  // What the accounts not listed yet could add, so a change the listed ones
  // cannot fund says where the rest of the cash is rather than reading as a
  // dead end. The user still picks them.
  const otherCapacity =
    listedCapacity !== undefined && !showOtherAccounts
      ? accounts
          .filter((account) => !shown.includes(account.id))
          .reduce(
            (sum, account) =>
              sum + floorToDigits(fundingEstimates?.get(account.id)?.capacity ?? 0, fractionDigits),
            0,
          )
      : 0;
  const canUsePlaced =
    onUsePlaced !== undefined &&
    accounts.length > 1 &&
    assigned >= AMOUNT_EPSILON &&
    (problem?.reason === "over" || problem?.reason === "left");
  // The badge follows the worksheet's own check, so it never calls a change
  // blocked that the check accepts, or the reverse.
  const badge: { text: string; tone: "done" | "accepted" | "problem" | "over" } = problem
    ? {
        text:
          problem.reason === "left"
            ? t("allocation:worksheet.remainingToAllocate", { amount: format(problem.amount) })
            : problem.reason === "not_placed"
              ? t("allocation:worksheet.remainingToAllocate", { amount: format(requested) })
              : describePlacementProblem(problem, t, format),
        tone: problem.reason === "over" ? "over" : "problem",
      }
    : Math.abs(difference) < AMOUNT_EPSILON
      ? { text: t("allocation:worksheet.fullyAllocated"), tone: "done" }
      : {
          text:
            difference > 0
              ? t("allocation:worksheet.allocationAcceptedUnplaced", {
                  amount: format(difference),
                })
              : t("allocation:worksheet.allocationAcceptedOver", { amount: format(-difference) }),
          tone: "accepted",
        };
  // Which accounts record the security is a fact about the portfolio, so it is
  // stated whether or not the user has since placed the change by hand. Only
  // the first sentence — that the app placed it — depends on that.
  const holderName = accounts.find((account) => account.id === impliedAccountId)?.name;
  const hint = isReduce
    ? "allocation:worksheet.reductionAccountAllocationHint"
    : accounts.length === 1
      ? "allocation:worksheet.singleAccountAllocationHint"
      : impliedHolder
        ? "allocation:worksheet.soleHolderAllocationHint"
        : impliedAccountId
          ? "allocation:worksheet.soleHolderSplitHint"
          : "allocation:worksheet.increaseAccountAllocationHint";

  return (
    <div
      data-account-allocation
      className="border-border/60 bg-muted/20 mt-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-2xs font-mono font-medium tracking-[0.12em] uppercase">
            {t("allocation:worksheet.accountAllocation")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t(hint, { account: holderName })}</p>
          {listedCapacity !== undefined && listedCapacity < requested - 0.02 && (
            <p className="text-warning-subtle-foreground mt-1 text-xs">
              {t("allocation:worksheet.placementCanFundTotal", {
                amount: format(listedCapacity),
                requested: format(requested),
              })}
              {otherCapacity >= 0.01 && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => setShowOtherAccounts(true)}
                    className="text-foreground font-medium underline underline-offset-2"
                  >
                    {t("allocation:worksheet.placementOtherAccountsCanFund", {
                      amount: format(otherCapacity),
                    })}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {/* Colour means a problem here; a complete or accepted allocation is not one. */}
          <span
            className={cn(
              "text-2xs inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono",
              badge.tone === "done" && "text-foreground border",
              badge.tone === "accepted" && "text-muted-foreground border",
              badge.tone === "over" && "bg-destructive-subtle text-destructive-subtle-foreground",
              badge.tone === "problem" && "bg-warning-subtle text-warning-subtle-foreground",
            )}
          >
            {badge.tone === "done" && <Icons.Check className="h-3 w-3" />}
            {badge.text}
          </span>
          {/* When the accounts hold more or less than the change, the change can
            follow them in one step, rather than by redoing the arithmetic. The
            accounts stay as the user placed them; none is picked. */}
          {canUsePlaced && (
            <button
              type="button"
              onClick={() => onUsePlaced?.(assigned)}
              className="text-xs font-medium underline underline-offset-2"
            >
              {t("allocation:worksheet.useAsAdjustment", { amount: format(assigned) })}
            </button>
          )}
        </div>
      </div>

      {/* One set of columns for every account: the account, its amount, and the
          amount it can take. Amounts line up whether or not a row offers one. */}
      <div className="mt-3 divide-y sm:grid sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        {accounts.length === 0 && (
          <p className="text-muted-foreground py-3 text-xs leading-relaxed sm:col-span-full">
            {t("allocation:worksheet.noEligibleAccounts")}
          </p>
        )}
        {listedAccounts.map((account) => {
          const holding = position.accountHoldings.find((item) => item.accountId === account.id);
          const funding = fundingByAccount.get(account.id);
          const estimate = fundingEstimates?.get(account.id);
          const currentAmount = amountFor(account.id);
          const need = isReduce
            ? 0
            : funding
              ? Math.max(0, -funding.remaining)
              : estimate
                ? Math.max(0, currentAmount - (estimate.capacity - estimate.deficit))
                : 0;
          const rowRemaining = Math.max(0, requested - (assigned - currentAmount));
          // What this account can take of the change: what is left, capped by
          // what it can fund (an increase) or holds (a reduction). The user picks
          // the account; the amount is that account's own arithmetic (§6).
          // Funding not read yet offers nothing.
          const accountCap = isReduce ? (holding?.value ?? 0) : estimate?.capacity;
          const amountToUse = amountAccountCanTake(
            rowRemaining,
            accountCap,
            unitPrice,
            wholeSharesOnly,
            fractionDigits,
          );
          const currentUnits = unitPrice ? currentAmount / unitPrice : undefined;
          // Offered only while it would add to this account: it says the
          // amount, so nothing about it has to be guessed.
          const offersAmount =
            accounts.length > 1 &&
            !isFullyAllocated &&
            amountToUse > currentAmount + AMOUNT_EPSILON;
          return (
            <div
              key={account.id}
              className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:col-span-full sm:grid-cols-[minmax(0,1fr)_auto_8.5rem] sm:items-start sm:gap-y-0 sm:supports-[grid-template-columns:subgrid]:grid-cols-subgrid"
            >
              <div className="min-w-0 sm:pe-3">
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                  <span className="truncate">{nameOf(account)}</span>
                  {impliedHolder === account.id && (
                    <span className="text-muted-foreground text-2xs inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-normal">
                      <Icons.Check className="h-2.5 w-2.5" />
                      {t("allocation:worksheet.holdsThisSecurity")}
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground text-2xs mt-0.5">
                  {/* The security this account already holds, named so it never
                      reads as the account's cash. */}
                  {holding &&
                    t("allocation:worksheet.accountHoldingSummary", {
                      amount: formatAmount(holding.value, currency),
                      quantity: formatQuantity(holding.quantity),
                      symbol: position.symbol,
                    })}
                  {holding && !isReduce && " · "}
                  {/* An estimate from the page's own figures; the preview then
                      resolves whole units and says what it found. */}
                  {!isReduce &&
                    (estimate
                      ? t("allocation:worksheet.accountCanFund", {
                          amount: format(floorToDigits(estimate.capacity, fractionDigits)),
                        })
                      : t("allocation:worksheet.accountFundingPending"))}
                  {!isReduce && estimate && deployedByAccount?.[account.id] !== undefined && (
                    <>
                      {" "}
                      <InfoTip
                        text={t("allocation:worksheet.accountCanFundDetail", {
                          amount: format(deployedByAccount[account.id] ?? 0),
                        })}
                      />
                    </>
                  )}
                </p>
                {/* What the account lacks for what is placed in it: the preview's
                    figure once there is one, the page's own estimate before.
                    Covering it is one click away, never done for the user. */}
                {need >= 0.01 ? (
                  <p className="text-2xs text-warning-subtle-foreground mt-0.5 flex flex-wrap items-baseline gap-x-2 font-medium">
                    <span>{t("allocation:worksheet.fundingNeeded", { amount: format(need) })}</span>
                    <AddDepositButton
                      amount={need}
                      account={nameOf(account)}
                      currency={currency}
                      onAdd={(amount) => onAddDeposit(account.id, amount)}
                    />
                  </p>
                ) : (
                  !isReduce &&
                  estimate &&
                  estimate.deficit >= AMOUNT_EPSILON && (
                    <p className="text-2xs text-warning-subtle-foreground mt-0.5">
                      {t("allocation:worksheet.accountFundingDeficit", {
                        amount: format(estimate.deficit),
                      })}
                    </p>
                  )
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {accounts.length === 1 ? (
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {formatAmount(requested, currency)}
                  </span>
                ) : (
                  // The row's field and steps, at the row's width.
                  <StepperField
                    className="w-full flex-none sm:w-[13.5rem]"
                    prefix={currency}
                    unitSteps={
                      canStep
                        ? {
                            downLabel: t("allocation:worksheet.removeOneUnitIn", {
                              account: nameOf(account),
                            }),
                            upLabel: t("allocation:worksheet.addOneUnitIn", {
                              account: nameOf(account),
                            }),
                            onDown:
                              currentAmount > AMOUNT_EPSILON
                                ? () => stepAccount(account.id, currentAmount, -1)
                                : undefined,
                            onUp: () => stepAccount(account.id, currentAmount, 1),
                          }
                        : undefined
                    }
                    aria-label={t("allocation:worksheet.accountAmountLabel", {
                      account: nameOf(account),
                    })}
                    value={atRest(
                      account.id,
                      impliedHolder === account.id
                        ? formatDecimalInput(requested, 6)
                        : (adjustment.accountAmounts[account.id] ?? ""),
                    )}
                    onFocus={(event) => {
                      setTypingAccountId(account.id);
                      setTypingValue(event.currentTarget.value);
                    }}
                    onBlur={() => setTypingAccountId(null)}
                    onChange={(event) => {
                      setTypingValue(event.target.value);
                      onAmountChange(account.id, event.target.value);
                    }}
                    inputMode="decimal"
                    placeholder="0"
                  />
                )}
                {currentUnits !== undefined && currentAmount > AMOUNT_EPSILON && (
                  <span className="text-muted-foreground text-2xs font-mono tabular-nums">
                    {t("allocation:worksheet.accountUnitsSummary", {
                      quantity: formatQuantity(
                        wholeSharesOnly ? Math.floor(currentUnits) : displayUnits(currentUnits),
                      ),
                    })}
                  </span>
                )}
              </div>
              {offersAmount && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-2xs h-8 justify-self-end px-2 font-mono tabular-nums sm:ms-2 sm:h-9"
                  aria-label={t("allocation:worksheet.useAmountIn", {
                    amount: format(amountToUse),
                    account: nameOf(account),
                  })}
                  onClick={() =>
                    onAmountChange(account.id, formatDecimalInput(amountToUse, fractionDigits))
                  }
                >
                  {t("allocation:worksheet.useAmount", { amount: format(amountToUse) })}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {/* Any other account can still receive the change; it opens a new position there. */}
      {!showOtherAccounts && hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOtherAccounts(true)}
          className="text-foreground mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          <Icons.Plus className="h-3.5 w-3.5" />
          {t("allocation:worksheet.placeInAnotherAccount")}
        </button>
      )}
    </div>
  );
}

/** One click to cover an account's shortfall with a deposit it states. */
export function AddDepositButton({
  amount,
  account,
  currency,
  onAdd,
}: {
  amount: number;
  account: string;
  currency: string;
  onAdd: (amount: number) => void;
}) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  return (
    <button
      type="button"
      onClick={() => onAdd(amount)}
      aria-label={t("allocation:worksheet.addAsDepositTo", {
        amount: formatAmount(amount, currency),
        account,
      })}
      className="text-foreground font-medium underline underline-offset-2"
    >
      {t("allocation:worksheet.addAsDeposit", { amount: formatAmount(amount, currency) })}
    </button>
  );
}
