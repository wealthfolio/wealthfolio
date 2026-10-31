import { worksheetCategoryLabel } from "./allocation-worksheet-labels";
import {
  Card,
  Checkbox,
  Icons,
  Skeleton,
  useAmountFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { maskAccountNumber } from "@/lib/account-number";
import { AccountType } from "@/lib/constants";
import type { Account, AllocationTarget, DriftReport, WorksheetMode } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import type { CashToUse } from "./allocation-worksheet-cash";
import { InfoTip } from "./allocation-worksheet-securities";
import {
  amountAtRest,
  decimalInputOrZero,
  formatDecimalInput,
  symbolList,
} from "./allocation-worksheet-utils";

/**
 * An amount field as it reads at rest: the currency's precision, grouped by
 * thousands. Typing shows the digits as entered.
 */
function groupedAtRest(
  value: string,
  fractionDigits: number,
  decimalSeparator: string,
  groupSeparator: string,
): string {
  const atRest = amountAtRest(value, fractionDigits, decimalSeparator);
  const [whole, fraction] = atRest.split(decimalSeparator);
  if (!whole || !/^-?\d+$/.test(whole)) return atRest;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return fraction === undefined ? grouped : `${grouped}${decimalSeparator}${fraction}`;
}

const CASH_PRESETS = [0.25, 0.5, 0.75, 1] as const;
/** Past this many accounts, finding one by name beats scanning the list. */
const SEARCH_THRESHOLD = 6;

/**
 * The ledger's columns: the account and the cash it deploys. A deposit and a
 * partial amount are notes under that cash, so each figure is said once, and
 * a row is one line until it has something to note.
 */
const LEDGER_GRID = "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3";

/** The cash field's width: the column's edge whatever sits beside it. */
const AMOUNT_WIDTH = "w-[8.5rem] sm:w-40";

/** Select all and Clear: quiet text actions at the height of the cards' header controls. */
const LEDGER_ACTION =
  "text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-40";

/** A round mark, so the accounts read as a selection rather than a form. */
const ROUND_CHECKBOX = "size-5 rounded-full";

/** What a category's gap can reach with the securities as they are set (§4.1). */
export interface CategoryReach {
  /** Securities held in the category. */
  held: readonly string[];
  /** Those that may be increased. */
  increase: readonly string[];
  /** Those that may be reduced. */
  reduce: readonly string[];
}

export interface WorksheetSetupProps {
  profile: AllocationTarget;
  driftReport: DriftReport;
  currency: string;
  /** Accounts in the target's scope that can hold securities. */
  accounts: Account[];
  selectedAccountIds: readonly string[];
  onToggleAccount: (accountId: string) => void;
  onSelectAllAccounts: () => void;
  onClearAccounts: () => void;
  mode: WorksheetMode;
  onModeChange: (mode: WorksheetMode) => void;
  /** What each selected account records, once the core has read it. */
  recordedByAccount: Readonly<Record<string, number>>;
  cash: CashToUse;
  trackedCash: string | null;
  cashByAccount: Readonly<Record<string, string>> | null;
  onTotalChange: (value: string | null) => void;
  onAccountCashChange: (accountId: string, value: string) => void;
  onUseSameShare: () => void;
  /** Amounts set per account that the last total replaced, with the way back. */
  replacedCash: { onUndo: () => void } | null;
  externalCash: Readonly<Record<string, string>>;
  onExternalCashChange: (accountId: string, value: string) => void;
  /** What each category's gap can reach, by category id. */
  reach: ReadonlyMap<string, CategoryReach>;
  /** Accounts the target never reduces holdings in. */
  protectedAccountIds: ReadonlySet<string>;
  /** The securities card, under the gap it closes. */
  eligibleSecurities: ReactNode;
  /** What stops the calculation, in the order the user meets it. */
  blockingIssues: readonly string[];
  /** Calculate, recalculate or move on, with what the last attempt said. */
  actions: ReactNode;
}

/**
 * The ledger keeps the wider share; the side column is wide enough for the
 * securities, which now sit in it beside the accounts.
 */
const SETUP_COLUMNS =
  "grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]";

/**
 * Setup, as a ledger of accounts beside what it can do with them (§4, §6).
 *
 * Money lives in accounts, so the accounts are the page: each row says what
 * the account may deploy out of what it records, and the funding that comes
 * to with a deposit. Beside them sit the cash and whether to rebalance, the
 * gap to the target with what each category can reach, the securities the
 * calculation may increase or reduce, and the one action.
 */
export function WorksheetSetup(props: WorksheetSetupProps) {
  const { t } = useTranslation();
  const { currency } = props;

  return (
    <div className={SETUP_COLUMNS}>
      <div className="min-w-0">
        <AccountsLedger {...props} />
      </div>

      <aside aria-label={t("allocation:worksheet.summaryLabel")} className="min-w-0 space-y-4">
        <CashToDeploy {...props} />
        <GapToTarget
          taxonomyId={props.profile.taxonomyId}
          report={props.driftReport}
          accountCount={props.accounts.length}
          currency={currency}
          mode={props.mode}
          reach={props.reach}
        />
        {props.eligibleSecurities}
        {/* The step's own action, under what it acts on. */}
        <div className="space-y-3">
          {props.blockingIssues.length > 0 && (
            <div>
              <p className="text-xs font-medium">{t("allocation:worksheet.blockedTitle")}</p>
              <ul className="mt-1.5 space-y-1">
                {props.blockingIssues.map((issue) => (
                  <li
                    key={issue}
                    className="text-warning-subtle-foreground flex items-start gap-2 text-xs"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-current"
                    />
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {props.actions}
        </div>
      </aside>
    </div>
  );
}

interface AccountGroup {
  name: string | null;
  accounts: Account[];
}

/** Accounts by the group the user gave them, in the order they first appear; ungrouped ones last. */
function groupAccounts(accounts: readonly Account[]): AccountGroup[] {
  const groups = new Map<string | null, Account[]>();
  for (const account of accounts) {
    const name = account.group?.trim() || null;
    groups.set(name, [...(groups.get(name) ?? []), account]);
  }
  const named = [...groups.entries()].filter(([name]) => name !== null);
  const ungrouped = groups.get(null);
  return [
    ...named.map(([name, members]) => ({ name, accounts: members })),
    ...(ungrouped ? [{ name: null, accounts: ungrouped }] : []),
  ];
}

/**
 * The second line under an account's name. Two accounts can share a name, so
 * the currency is always there, and the end of the account number joins it
 * when name and currency are not enough. A crypto account says it takes only
 * crypto, so cash left in it after the calculation is no surprise, and an
 * account the target protects says its holdings are never reduced.
 */
function accountDetails(
  account: Account,
  accounts: readonly Account[],
  notes: { cryptoOnly: string; neverReduced: string | null },
): string {
  const twins = accounts.filter(
    (other) =>
      other.id !== account.id &&
      other.name.trim().toLowerCase() === account.name.trim().toLowerCase() &&
      other.currency === account.currency,
  );
  return [
    account.currency,
    twins.length > 0 ? maskAccountNumber(account.accountNumber) : null,
    account.accountType === AccountType.CRYPTOCURRENCY ? notes.cryptoOnly : null,
    notes.neverReduced,
  ]
    .filter(Boolean)
    .join(" · ");
}

function AccountsLedger({
  accounts,
  selectedAccountIds,
  onToggleAccount,
  onSelectAllAccounts,
  onClearAccounts,
  recordedByAccount,
  cash,
  cashByAccount,
  onAccountCashChange,
  externalCash,
  onExternalCashChange,
  protectedAccountIds,
  currency,
}: WorksheetSetupProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const matches = (account: Account) =>
    !normalized ||
    [account.name, account.group, account.currency, account.accountNumber]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalized));
  const selected = new Set(selectedAccountIds);
  const detailsOf = (account: Account) =>
    accountDetails(account, accounts, {
      cryptoOnly: t("allocation:worksheet.cryptoOnly"),
      neverReduced: protectedAccountIds.has(account.id)
        ? t("allocation:worksheet.accountNeverReduced")
        : null,
    });
  // The accounts in play stay together; one taken out moves below them.
  const groups = groupAccounts(accounts.filter((account) => selected.has(account.id)))
    .map((group) => ({ ...group, visible: group.accounts.filter(matches) }))
    .filter((group) => group.visible.length > 0);
  const leftOut = accounts.filter((account) => !selected.has(account.id) && matches(account));
  const showGroupNames = groupAccounts(accounts).some((group) => group.name !== null);
  const contributionOf = (accountId: string) =>
    Math.max(0, decimalInputOrZero(externalCash[accountId] ?? ""));
  const fundingOf = (accountId: string) =>
    (cash.byAccount[accountId] ?? 0) + contributionOf(accountId);

  return (
    <Card
      id="worksheet-accounts"
      role="region"
      aria-labelledby="worksheet-accounts-title"
      className="overflow-hidden"
    >
      {/* The title sits inside the card, as it does in the cards beside it, so
          their tops line up; the row keeps the height of their headers. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <h4 id="worksheet-accounts-title" className="text-sm font-semibold">
          {t("allocation:worksheet.accountsLabel")}
        </h4>
        <span className="text-muted-foreground text-xs">
          {t("allocation:worksheet.selectedAccountCount", {
            selected: selectedAccountIds.length,
            total: accounts.length,
          })}
        </span>
        {/* What the columns already show, a hover away rather than lines of text:
            the rule, and that every amount is in the planning currency, whatever
            the account's own currency on its row. */}
        <InfoTip
          text={`${t("allocation:worksheet.ledgerHint")} ${t("allocation:worksheet.amountsInCurrency", { currency })}`}
        />
        <div className="ms-auto flex h-6 items-center gap-3 text-xs">
          <button
            type="button"
            disabled={selectedAccountIds.length === accounts.length}
            onClick={onSelectAllAccounts}
            className={LEDGER_ACTION}
          >
            {t("allocation:worksheet.selectAllAccounts")}
          </button>
          <button
            type="button"
            disabled={selectedAccountIds.length === 0}
            onClick={onClearAccounts}
            className={LEDGER_ACTION}
          >
            {t("allocation:worksheet.clearAccounts")}
          </button>
        </div>
      </div>

      {/* The column headings. Past a handful of accounts, finding one takes the
          Account heading's place: it filters the column it heads. */}
      <div
        className={cn(
          LEDGER_GRID,
          "text-muted-foreground min-h-9 items-center border-y px-4 py-1.5 text-xs font-medium",
        )}
      >
        {accounts.length > SEARCH_THRESHOLD ? (
          // A control, so it starts at the card's edge like the group names.
          <div className="relative col-span-2 max-w-72">
            <Icons.Search
              aria-hidden="true"
              className="absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("allocation:worksheet.findAccount")}
              aria-label={t("allocation:worksheet.findAccount")}
              className="border-input bg-background text-foreground focus-visible:ring-ring h-7 w-full rounded-md border ps-7 pe-2 text-xs font-normal outline-none focus-visible:ring-1"
            />
          </div>
        ) : (
          <>
            <span />
            <span aria-hidden="true">{t("allocation:worksheet.account")}</span>
          </>
        )}
        <span aria-hidden="true" className="text-end">
          {t("allocation:worksheet.cashToDeploy")}
        </span>
      </div>

      {groups.length === 0 && leftOut.length === 0 && (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">
          {t("allocation:worksheet.noMatchingAccounts")}
        </p>
      )}

      {groups.map((group) => {
        const subtotal = group.accounts.reduce((sum, account) => sum + fundingOf(account.id), 0);
        const total = accounts.filter(
          (account) => (account.group?.trim() || null) === group.name,
        ).length;
        return (
          <div
            key={group.name ?? "__ungrouped__"}
            role="group"
            aria-label={group.name ?? undefined}
          >
            {showGroupNames && (
              <div className="bg-muted/30 flex items-baseline gap-2 px-4 py-1 text-xs">
                <span className="font-semibold">
                  {group.name ?? t("allocation:worksheet.otherAccounts")}
                </span>
                {/* Only worth saying once some of the group is left out. */}
                {group.accounts.length < total && (
                  <span className="text-muted-foreground">
                    {t("allocation:worksheet.selectedAccountCount", {
                      selected: group.accounts.length,
                      total,
                    })}
                  </span>
                )}
                {cash.isKnown && (
                  <span className="text-muted-foreground ms-auto font-mono tabular-nums">
                    {formatAmount(subtotal, currency)}
                  </span>
                )}
              </div>
            )}
            {group.visible.map((account) => (
              <LedgerRow
                key={account.id}
                account={account}
                details={detailsOf(account)}
                onToggle={() => onToggleAccount(account.id)}
                recorded={recordedByAccount[account.id]}
                use={cash.byAccount[account.id]}
                enteredUse={cashByAccount?.[account.id]}
                isAboveRecorded={cash.aboveRecordedAccountIds.includes(account.id)}
                onUseChange={(value) => onAccountCashChange(account.id, value)}
                contribution={externalCash[account.id] ?? ""}
                onContributionChange={(value) => onExternalCashChange(account.id, value)}
                currency={currency}
              />
            ))}
          </div>
        );
      })}

      {/* Out of the worksheet, out of the way: below the accounts in play. */}
      {leftOut.length > 0 && (
        <div role="group" aria-label={t("allocation:worksheet.leftOut", { count: leftOut.length })}>
          <div className="text-muted-foreground flex items-center justify-between gap-2 border-t px-4 py-2 text-xs">
            <span>{t("allocation:worksheet.leftOut", { count: leftOut.length })}</span>
            <button
              type="button"
              onClick={onSelectAllAccounts}
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              {t("allocation:worksheet.addAllBack")}
            </button>
          </div>
          {leftOut.map((account) => {
            const checkboxId = `worksheet-account-${account.id}`;
            return (
              <div
                key={account.id}
                data-worksheet-account={account.id}
                className="flex items-center gap-3 border-t px-4 py-1.5"
              >
                <Checkbox
                  id={checkboxId}
                  checked={false}
                  onCheckedChange={() => onToggleAccount(account.id)}
                  className="size-5 rounded-full"
                />
                <label
                  htmlFor={checkboxId}
                  className="text-muted-foreground min-w-0 flex-1 cursor-pointer truncate text-sm"
                >
                  {account.name}
                  <span className="ms-2 text-xs">{detailsOf(account)}</span>
                </label>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

interface LedgerRowProps {
  account: Account;
  details: string;
  onToggle: () => void;
  /** Undefined while the core has not read it. */
  recorded: number | undefined;
  use: number | undefined;
  /** What the user typed for this account, when they set it themselves. */
  enteredUse: string | undefined;
  isAboveRecorded: boolean;
  onUseChange: (value: string) => void;
  contribution: string;
  onContributionChange: (value: string) => void;
  currency: string;
}

/**
 * An account in the worksheet and the cash it deploys, in a shape that does not
 * change with what is set: the name over its details on the left, the recorded
 * cash among them; on the right, one line with any deposit beside the amount.
 * Adding a deposit shows on hover or focus, so idle rows stay quiet.
 */
function LedgerRow({
  account,
  details,
  onToggle,
  recorded,
  use,
  enteredUse,
  isAboveRecorded,
  onUseChange,
  contribution,
  onContributionChange,
  currency,
}: LedgerRowProps) {
  const { t } = useTranslation();
  const { formatAmount, currencyFractionDigits } = useAmountFormatting();
  const fractionDigits = currencyFractionDigits(currency);
  const checkboxId = `worksheet-account-${account.id}`;
  const isKnown = recorded !== undefined;
  const [isEditingDeposit, setIsEditingDeposit] = useState(false);
  const [isReturningFocus, setIsReturningFocus] = useState(false);
  const deposit = Math.max(0, decimalInputOrZero(contribution));
  const detailsLine = [
    details,
    recorded !== undefined && recorded > 0
      ? t("allocation:worksheet.accountRecorded", { amount: formatAmount(recorded, currency) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-worksheet-account={account.id}
      className={cn(LEDGER_GRID, "group items-center px-4 py-2")}
    >
      <Checkbox id={checkboxId} checked onCheckedChange={onToggle} className={ROUND_CHECKBOX} />
      <label htmlFor={checkboxId} className="min-w-0 cursor-pointer">
        <span className="block truncate text-sm font-medium">{account.name}</span>
        <span className="text-muted-foreground block truncate text-xs">{detailsLine}</span>
        {isAboveRecorded && recorded !== undefined && (
          <span className="text-warning-subtle-foreground block text-xs">
            {t("allocation:worksheet.exceedsObservedCashIssue", {
              amount: formatAmount(recorded, currency),
            })}
          </span>
        )}
      </label>

      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* A deposit is the user's own figure, open before the recorded cash is read. */}
        <DepositControl
          account={account}
          value={contribution}
          amount={deposit}
          onChange={onContributionChange}
          isEditing={isEditingDeposit}
          onEditingChange={setIsEditingDeposit}
          isReturningFocus={isReturningFocus}
          onFocusReturned={() => setIsReturningFocus(false)}
          onRemoved={() => setIsReturningFocus(true)}
          currency={currency}
          fractionDigits={fractionDigits}
        />
        <div className={cn(AMOUNT_WIDTH, "shrink-0 text-end")}>
          {!isKnown ? (
            <div className="flex h-8 items-center justify-end">
              <Skeleton className="h-4 w-16" />
            </div>
          ) : recorded === 0 ? (
            <span className="text-muted-foreground flex h-8 items-center justify-end text-xs">
              {t("allocation:worksheet.noCashRecorded")}
            </span>
          ) : (
            <AmountField
              label={t("allocation:worksheet.cashToDeployFor", { account: account.name })}
              value={enteredUse ?? formatDecimalInput(use ?? 0, fractionDigits)}
              fractionDigits={fractionDigits}
              isWarning={isAboveRecorded}
              onChange={onUseChange}
              onBlur={() => {
                // Asking for more than the account records is met with what it
                // records; the rest belongs in a deposit.
                if (isAboveRecorded && recorded !== undefined) {
                  onUseChange(formatDecimalInput(recorded, fractionDigits));
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Cash not recorded yet, for this account, on the line of its cash: a quiet
 * Deposit until one is entered, a short field while it is, then the amount,
 * which opens again to change it.
 */
function DepositControl({
  account,
  value,
  amount,
  onChange,
  isEditing,
  onEditingChange,
  isReturningFocus,
  onFocusReturned,
  onRemoved,
  currency,
  fractionDigits,
}: {
  account: Account;
  value: string;
  amount: number;
  onChange: (value: string) => void;
  isEditing: boolean;
  onEditingChange: (isEditing: boolean) => void;
  /** The deposit was just removed, so the cursor goes back to Deposit. */
  isReturningFocus: boolean;
  onFocusReturned: () => void;
  onRemoved: () => void;
  currency: string;
  fractionDigits: number;
}) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();

  if (isEditing) {
    return (
      <span
        className="flex shrink-0 items-center gap-0.5"
        // Closes once focus leaves the field and its remove button together,
        // so tabbing from one to the other keeps both.
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onEditingChange(false);
        }}
      >
        <span className="has-[input:focus-visible]:ring-ring bg-background flex h-7 w-28 items-center gap-1 rounded-md border border-dashed px-1.5 has-[input:focus-visible]:ring-1">
          <span aria-hidden="true" className="text-muted-foreground text-2xs">
            +
          </span>
          <AmountField
            label={t("allocation:worksheet.externalCashForAccount", { account: account.name })}
            value={value}
            fractionDigits={fractionDigits}
            onChange={onChange}
            focusOnOpen
            isCompact
          />
        </span>
        <button
          type="button"
          // WebKit does not focus a clicked button, so the field would close
          // before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            onEditingChange(false);
            onRemoved();
          }}
          aria-label={t("allocation:worksheet.depositRemove", { account: account.name })}
          className="text-muted-foreground hover:text-foreground flex h-7 w-5 items-center justify-center"
        >
          <Icons.Close className="h-3 w-3" />
        </button>
      </span>
    );
  }
  if (amount > 0) {
    return (
      <button
        type="button"
        onClick={() => onEditingChange(true)}
        className="text-muted-foreground hover:text-foreground text-2xs shrink-0 underline decoration-dotted underline-offset-2"
      >
        {t("allocation:worksheet.depositIncluded", { amount: formatAmount(amount, currency) })}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      ref={
        isReturningFocus
          ? (element) => {
              element?.focus();
              onFocusReturned();
            }
          : undefined
      }
      aria-label={t("allocation:worksheet.addContributionFor", { account: account.name })}
      // Shown with its row on hover or focus where there is hover; always on touch.
      className="text-muted-foreground hover:text-foreground text-2xs inline-flex shrink-0 items-center transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
    >
      <Icons.Plus aria-hidden="true" className="h-3 w-3 sm:me-0.5" />
      <span className="hidden sm:inline">{t("allocation:worksheet.depositAdd")}</span>
    </button>
  );
}

interface AmountFieldProps {
  label: string;
  value: string;
  fractionDigits: number;
  onChange: (value: string) => void;
  onBlur?: () => void;
  isWarning?: boolean;
  focusOnOpen?: boolean;
  /** Inside a compact frame of its own, as the deposit is. */
  isCompact?: boolean;
}

/** An amount at the currency's precision at rest, and as typed while it has focus. */
function AmountField({
  label,
  value,
  fractionDigits,
  onChange,
  onBlur,
  isWarning,
  focusOnOpen,
  isCompact,
}: AmountFieldProps) {
  const { decimalSeparator, groupSeparator } = useNumberFormatting();
  const [isTyping, setIsTyping] = useState(false);
  // Opened by the user's own click, so the cursor follows it, once: a new
  // callback each render would pull focus back on every keystroke and blur.
  const focusOnMount = useCallback(
    (element: HTMLInputElement | null) => {
      if (focusOnOpen) element?.focus();
    },
    [focusOnOpen],
  );
  return (
    <input
      ref={focusOnMount}
      aria-label={label}
      value={
        isTyping ? value : groupedAtRest(value, fractionDigits, decimalSeparator, groupSeparator)
      }
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => setIsTyping(true)}
      onBlur={() => {
        setIsTyping(false);
        onBlur?.();
      }}
      inputMode="decimal"
      placeholder="0"
      className={cn(
        "text-end font-mono tabular-nums outline-none",
        isCompact
          ? "text-2xs h-full w-full min-w-0 bg-transparent"
          : // A soft field that reads as a figure at rest; its edge shows on hover and focus.
            "bg-muted/50 hover:border-input focus-visible:border-input focus-visible:bg-background focus-visible:ring-ring h-8 w-full rounded-md border border-transparent px-2 text-sm transition-colors focus-visible:ring-1",
        isWarning && "border-warning bg-warning-subtle",
      )}
    />
  );
}

/**
 * What the calculation will try to close, straight from the drift report, and
 * what each category can reach with the securities as they are set. Each
 * category reads as a bar on one 0–100% scale: where it is now, its target
 * and the range around it, so the far-off ones stand out before any figure
 * is read. A category already in range steps back.
 */
function GapToTarget({
  taxonomyId,
  report,
  accountCount,
  currency,
  mode,
  reach,
}: {
  taxonomyId: string;
  report: DriftReport;
  accountCount: number;
  currency: string;
  mode: WorksheetMode;
  reach: ReadonlyMap<string, CategoryReach>;
}) {
  const { t } = useTranslation();
  const rows = report.rows.filter((row) => !row.isCash && Math.abs(row.valueDelta) >= 0.5);
  if (rows.length === 0) return null;
  // What to add first, then what to reduce, the largest gap first in each.
  const ordered = [
    ...rows
      .filter((row) => row.valueDelta < 0)
      .sort((left, right) => left.valueDelta - right.valueDelta),
    ...rows
      .filter((row) => row.valueDelta > 0)
      .sort((left, right) => right.valueDelta - left.valueDelta),
  ];
  const more = (count: number) => t("allocation:worksheet.gapMore", { count });
  // The allocation page's colours, so a category reads the same everywhere.
  const colors = buildAllocationTargetColorMap(report.rows);

  const noteFor = (row: DriftReport["rows"][number]): GapNote | null => {
    // Without the holdings behind the report there is nothing to say per category.
    const category = reach.get(row.categoryId);
    if (!category) return null;
    const isBelow = row.valueDelta < 0;
    if (category.held.length === 0) {
      return {
        text: t("allocation:worksheet.gapNothingHeld"),
        detail: t(
          isBelow
            ? "allocation:worksheet.gapNothingHeldBelowDetail"
            : "allocation:worksheet.gapNothingHeldAboveDetail",
        ),
        isWarning: isBelow,
      };
    }
    if (isBelow) {
      return category.increase.length === 0
        ? {
            text: t("allocation:worksheet.gapNothingToIncrease"),
            detail: t("allocation:worksheet.gapNothingToIncreaseDetail"),
            isWarning: true,
          }
        : {
            text: t("allocation:worksheet.gapIncreases", {
              securities: symbolList(category.increase, more),
            }),
            detail: t("allocation:worksheet.gapIncreasesDetail", {
              securities: category.increase.join(", "),
            }),
            isWarning: false,
          };
    }
    if (mode !== "rebalance") {
      return {
        text: t("allocation:worksheet.gapNotReduced"),
        detail: t("allocation:worksheet.gapNotReducedDetail"),
        isWarning: false,
      };
    }
    return category.reduce.length === 0
      ? {
          text: t("allocation:worksheet.gapNothingToReduce"),
          detail: t("allocation:worksheet.gapNothingToReduceDetail"),
          isWarning: true,
        }
      : {
          text: t("allocation:worksheet.gapReduces", {
            securities: symbolList(category.reduce, more),
          }),
          detail: t("allocation:worksheet.gapReducesDetail", {
            securities: category.reduce.join(", "),
          }),
          isWarning: false,
        };
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{t("allocation:worksheet.gapTitle")}</h4>
        {report.outOfBandCount > 0 && (
          <span className="text-muted-foreground text-xs">
            {t("allocation:worksheet.outsideRangeCount", { count: report.outOfBandCount })}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-xs" data-gap-scope>
        {t("allocation:worksheet.setupScope", { count: accountCount })}
      </p>
      <ul className="mt-3 space-y-3">
        {ordered.map((row) => (
          <GapRow
            taxonomyId={taxonomyId}
            key={row.categoryId}
            row={row}
            color={allocationTargetColorForRow(row, colors)}
            currency={currency}
            note={noteFor(row)}
          />
        ))}
      </ul>
      <div
        aria-hidden="true"
        className="text-muted-foreground text-2xs mt-4 flex gap-4 border-t pt-2.5"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-muted-foreground/60 h-2 w-3.5 rounded-full" />
          {t("allocation:worksheet.gapLegendNow")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-foreground h-3 w-[2.5px] rounded-sm" />
          {t("allocation:worksheet.gapLegendTarget")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-muted-foreground/20 h-2 w-3.5 rounded-full" />
          {t("allocation:worksheet.gapLegendRange")}
        </span>
      </div>
    </Card>
  );
}

interface GapNote {
  text: string;
  detail: string;
  isWarning: boolean;
}

/** A share of the portfolio as a position on the bar's 0–100% scale. */
const barPercent = (bps: number) => Math.min(100, Math.max(0, bps / 100));

function GapRow({
  taxonomyId,
  row,
  color,
  currency,
  note,
}: {
  taxonomyId: string;
  row: DriftReport["rows"][number];
  color: string;
  currency: string;
  note: GapNote | null;
}) {
  const { t } = useTranslation();
  const { formatRoundedAmount } = useAmountFormatting();
  const { formatPercent } = useNumberFormatting();
  const isInRange = row.status === "in_band";
  const bandFrom = barPercent(row.targetBps - row.effectiveBandBps);
  const bandTo = barPercent(row.targetBps + row.effectiveBandBps);

  return (
    <li data-gap-category={row.categoryId} className={cn("text-xs", isInRange && "opacity-60")}>
      <span className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 self-center rounded-sm"
          style={{ background: color }}
        />
        <span className="min-w-0 truncate">
          {worksheetCategoryLabel(t, taxonomyId, row.categoryId, row.categoryName)}
        </span>
        <span className="text-muted-foreground text-2xs shrink-0 font-mono tabular-nums">
          {formatPercent(row.currentBps / 10_000, { digits: 1 })} →{" "}
          {formatPercent(row.targetBps / 10_000, { digits: 1 })}
        </span>
        {/* Signed the way it moves: + to add, − to reduce. */}
        <span className="ms-auto shrink-0 font-mono tabular-nums">
          {row.valueDelta < 0 ? "+" : "−"}
          {formatRoundedAmount(Math.abs(row.valueDelta), currency)}
        </span>
      </span>
      {/* Drawn as the allocation page draws it: where it is, and a mark at the target. */}
      <span
        aria-hidden="true"
        className="bg-muted relative ms-[1.125rem] mt-2 block h-2 rounded-full"
      >
        {bandTo > bandFrom && (
          <span
            className="bg-muted-foreground/20 absolute inset-y-0 rounded-full"
            style={{ insetInlineStart: `${bandFrom}%`, width: `${bandTo - bandFrom}%` }}
          />
        )}
        <span
          className="absolute inset-y-0 start-0 rounded-full opacity-60"
          style={{ width: `${barPercent(row.currentBps)}%`, background: color }}
        />
        <span
          className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
          style={{ insetInlineStart: `calc(${barPercent(row.targetBps)}% - 1px)` }}
        />
      </span>
      {note && (
        <span
          className={cn(
            "text-2xs mt-1.5 flex items-center gap-1 ps-[1.125rem]",
            note.isWarning ? "text-warning-subtle-foreground" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate">{note.text}</span>
          <InfoTip text={note.detail} />
        </span>
      )}
    </li>
  );
}

/**
 * How much tracked cash the selected accounts may spend, as one total, and
 * whether reductions cover what it does not. Setting an account's own amount
 * in the ledger moves the total with it (§6).
 */
function CashToDeploy({
  profile,
  mode,
  onModeChange,
  selectedAccountIds,
  cash,
  trackedCash,
  cashByAccount,
  onTotalChange,
  onUseSameShare,
  replacedCash,
  externalCash,
  currency,
}: WorksheetSetupProps) {
  const { t } = useTranslation();
  const { formatAmount, currencyFractionDigits } = useAmountFormatting();
  const { decimalSeparator, groupSeparator } = useNumberFormatting();
  const fractionDigits = currencyFractionDigits(currency);
  const [isTyping, setIsTyping] = useState(false);
  const count = selectedAccountIds.length;
  const isReading = count > 0 && !cash.isKnown;
  const contributionOf = (accountId: string) =>
    Math.max(0, decimalInputOrZero(externalCash[accountId] ?? ""));
  const contributions = selectedAccountIds.reduce(
    (sum, accountId) => sum + contributionOf(accountId),
    0,
  );
  // An account with nothing to deploy and nothing arriving funds nothing.
  const fundingAccounts = selectedAccountIds.filter(
    (accountId) => (cash.byAccount[accountId] ?? 0) + contributionOf(accountId) > 0,
  ).length;
  const isCustom = cashByAccount !== null;
  // While one share applies the field shows what was typed; set per account,
  // it shows their sum, and typing in it goes back to one share.
  const totalValue =
    !isCustom && trackedCash !== null
      ? trackedCash
      : cash.isKnown
        ? formatDecimalInput(cash.total, fractionDigits)
        : "";
  const share = cash.share;
  const isPresetShare =
    share !== null && CASH_PRESETS.some((fraction) => Math.abs(share - fraction) < 0.0005);
  const linkClass = "text-foreground font-medium underline underline-offset-2";
  const isRebalance = mode === "rebalance";

  const status = cash.isTotalAboveRecorded ? (
    <span className="text-warning-subtle-foreground">
      {t("allocation:worksheet.cashAboveRecorded", {
        amount: formatAmount(cash.recordedTotal, currency),
      })}
    </span>
  ) : replacedCash ? (
    <span role="status">
      {t("allocation:worksheet.cashReplaced")}{" "}
      <button type="button" onClick={replacedCash.onUndo} className={linkClass}>
        {t("allocation:worksheet.undo")}
      </button>
    </span>
  ) : isCustom ? (
    <span>
      {t("allocation:worksheet.cashSetPerAccount")}{" "}
      <button type="button" onClick={onUseSameShare} className={linkClass}>
        {t("allocation:worksheet.useSameShare")}
      </button>
    </span>
  ) : cash.isKnown && share !== null && count > 0 && !isPresetShare ? (
    // A preset already says which share applies; a typed total says it here.
    t("allocation:worksheet.cashShare", { percent: formatDecimalInput(share * 100, 1) })
  ) : contributions > 0 ? (
    t("allocation:worksheet.cashPlusContribution", {
      amount: formatAmount(contributions, currency),
    })
  ) : cash.isKnown && count > 0 ? (
    t("allocation:worksheet.fundingFromAccounts", { count: fundingAccounts })
  ) : null;

  return (
    <Card id="worksheet-cash" className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="worksheet-cash-total" className="text-sm font-semibold">
          {t("allocation:worksheet.cashToDeploy")}
        </label>
        <div className="bg-muted/60 flex rounded-full p-0.5">
          {CASH_PRESETS.map((fraction) => {
            const active =
              !isCustom && cash.isKnown && share !== null && Math.abs(share - fraction) < 0.0005;
            return (
              <button
                key={fraction}
                type="button"
                aria-pressed={active}
                disabled={!cash.isKnown || cash.recordedTotal <= 0}
                onClick={() =>
                  onTotalChange(
                    fraction === 1
                      ? null
                      : formatDecimalInput(cash.recordedTotal * fraction, fractionDigits),
                  )
                }
                className={cn(
                  "rounded-full px-2.5 py-0.5 font-mono text-xs transition-colors disabled:opacity-40",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {fraction === 1 ? t("allocation:worksheet.allCash") : `${fraction * 100}%`}
              </button>
            );
          })}
        </div>
      </div>
      <div className="relative mt-2 flex items-baseline gap-2">
        <span className="text-muted-foreground text-sm">{currency}</span>
        <input
          id="worksheet-cash-total"
          value={
            isTyping
              ? totalValue
              : groupedAtRest(totalValue, fractionDigits, decimalSeparator, groupSeparator)
          }
          onChange={(event) => onTotalChange(event.target.value)}
          onFocus={() => setIsTyping(true)}
          onBlur={() => {
            setIsTyping(false);
            if (cash.isTotalAboveRecorded) onTotalChange(null);
          }}
          disabled={count === 0 || isReading}
          inputMode="decimal"
          placeholder={cash.isKnown ? "0" : ""}
          className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm bg-transparent font-mono text-xl font-semibold tabular-nums outline-none focus-visible:ring-1 disabled:opacity-50"
        />
        {isReading && (
          <Skeleton
            aria-hidden="true"
            className="absolute start-10 top-1/2 h-5 w-32 -translate-y-1/2"
          />
        )}
      </div>
      <p className="text-muted-foreground mt-1 min-h-4 text-xs">{status}</p>

      {/* Whether reductions cover what the cash does not: one choice, under the cash it follows. */}
      <div className="mt-3 flex items-start gap-3 border-t pt-3">
        <Checkbox
          id="worksheet-rebalance"
          checked={isRebalance}
          disabled={!profile.allowSells}
          onCheckedChange={(checked) =>
            onModeChange(checked === true ? "rebalance" : "invest_cash")
          }
          aria-describedby="worksheet-rebalance-hint"
          className="mt-0.5 size-5 rounded-full"
        />
        <div className="min-w-0 text-sm">
          <label
            htmlFor="worksheet-rebalance"
            className={cn(
              "block font-medium",
              profile.allowSells ? "cursor-pointer" : "text-muted-foreground cursor-not-allowed",
            )}
          >
            {t("allocation:worksheet.modeRebalance")}
          </label>
          <p
            id="worksheet-rebalance-hint"
            className="text-muted-foreground text-xs leading-relaxed"
          >
            {!profile.allowSells
              ? t("allocation:mode.enableSellsTip")
              : isRebalance
                ? t("allocation:worksheet.rebalanceOnHint")
                : t("allocation:worksheet.rebalanceOffHint")}
          </p>
        </div>
      </div>
    </Card>
  );
}
