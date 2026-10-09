import { Button, Icons, useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Asset, WorksheetAccountFunding } from "@/lib/types";
import { cn } from "@/lib/utils";

import { AccountAllocation } from "./allocation-worksheet-account-allocation";
import { StepperField } from "./allocation-worksheet-stepper-field";
import {
  activeTarget,
  partialShareBps,
  partitionAmountsRows,
  rowEmphasis,
  rowStaysOpen,
  stepByUnits,
  unitsFor,
  type HighlightTarget,
  type RowStatus,
} from "./allocation-worksheet-amounts";
import { useHighlight, useHighlightActions } from "./allocation-worksheet-highlight";
import {
  AMOUNT_EPSILON,
  amountAtRest,
  decimalInputOrZero,
  formatDecimalInput,
  formatSignedAmount,
  UNCLASSIFIED_CATEGORY_ID,
  type PositionAdjustment,
  type WorksheetEditMode,
  type WorksheetPosition,
} from "./allocation-worksheet-utils";

/** One security's line in the Amounts panel, as the worksheet resolves it. */
export interface AmountsRowModel {
  position: WorksheetPosition;
  adjustment: PositionAdjustment | undefined;
  displayInput: string;
  /** The entered change, or zero while it cannot be read. */
  changeAmount: number;
  /** A change is entered, including one that cannot be read yet. */
  isChanged: boolean;
  projectedValue: number;
  /** The weight after the change, against the planning total. */
  projectedPct: number;
  /** The price one unit resolves at: the preview's when it has one, else the recorded one. */
  unitPrice: number | undefined;
  status: RowStatus | null;
  asset: Asset | undefined;
  isExpanded: boolean;
  /** Where the change may be placed, while there is one. */
  placement:
    | { accounts: Account[]; impliedAccountId: string | undefined; unitPrice: number | undefined }
    | undefined;
}

export interface AmountsRowActions {
  onInputChange: (position: WorksheetPosition, value: string) => void;
  onReduceToZero: (position: WorksheetPosition) => void;
  onRemove: (assetId: string) => void;
  onToggleExpanded: (assetId: string) => void;
  onAccountAmountChange: (assetId: string, accountId: string, value: string) => void;
  onPriceAction: (assetId: string, asset: Asset | undefined) => void;
}

interface AmountsListProps {
  rows: readonly AmountsRowModel[];
  /** Rows the worksheet or the preview has something to say about. */
  flaggedAssetIds: ReadonlySet<string>;
  /** Classes the calculation left an amount unresolved in. */
  unresolvedCategoryIds: ReadonlySet<string>;
  /** The colour each class has in Portfolio impact. */
  classColors: ReadonlyMap<string, string>;
  accountNames: ReadonlyMap<string, string>;
  editMode: WorksheetEditMode;
  currency: string;
  allowSells: boolean;
  wholeSharesOnly: boolean;
  fundingByAccount: Map<string, WorksheetAccountFunding>;
  isPriceSyncing: boolean;
  actions: AmountsRowActions;
}

/**
 * The grid shared by the header and every row: Position · Weight · Adjustment ·
 * Status. On a phone the weight sits beside the position and the field and
 * status take the full width below.
 */
const AMOUNTS_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_13.5rem_10rem] sm:items-start";

/**
 * The list of securities, opened short: rows with nothing to decide collapse
 * behind one counted line. The list is never filtered or reordered, and a row
 * touched during this visit stays out of the group until the list is left.
 */
export function AmountsList({
  rows,
  flaggedAssetIds,
  unresolvedCategoryIds,
  actions,
  ...shared
}: AmountsListProps) {
  const { t } = useTranslation();
  const changedAssetIds = new Set(
    rows.filter((row) => row.isChanged).map((row) => row.position.assetId),
  );
  const addedAssetIds = new Set(
    rows.filter((row) => row.position.isAdded).map((row) => row.position.assetId),
  );
  const [touchedAssetIds, setTouchedAssetIds] = useState<ReadonlySet<string>>(() => new Set());
  // With nothing to decide yet, before a calculation or any typing, the whole
  // list is the work: it opens rather than hiding every row behind one line.
  const [showCollapsed, setShowCollapsed] = useState(
    () =>
      !rows.some((row) =>
        rowStaysOpen(row.position, {
          changedAssetIds,
          flaggedAssetIds,
          unresolvedCategoryIds,
          touchedAssetIds: new Set(),
          addedAssetIds,
        }),
      ),
  );
  const { reset } = useHighlightActions();
  // Leaving the list ends pointing and selection, so nothing stays lit in the rail.
  useEffect(() => reset, [reset]);

  const touch = (assetId: string) =>
    setTouchedAssetIds((current) =>
      current.has(assetId) ? current : new Set(current).add(assetId),
    );
  const rowActions: AmountsRowActions = {
    ...actions,
    onInputChange: (position, value) => {
      touch(position.assetId);
      actions.onInputChange(position, value);
    },
    onReduceToZero: (position) => {
      touch(position.assetId);
      actions.onReduceToZero(position);
    },
    onAccountAmountChange: (assetId, accountId, value) => {
      touch(assetId);
      actions.onAccountAmountChange(assetId, accountId, value);
    },
  };

  const rowByAsset = new Map(rows.map((row) => [row.position.assetId, row]));
  const { open, collapsed, collapsedValue } = partitionAmountsRows(
    rows.map((row) => row.position),
    {
      changedAssetIds,
      flaggedAssetIds,
      unresolvedCategoryIds,
      touchedAssetIds,
      addedAssetIds,
    },
  );
  const renderRow = (position: WorksheetPosition) => (
    <AmountRow
      key={position.assetId}
      model={rowByAsset.get(position.assetId)!}
      actions={rowActions}
      {...shared}
    />
  );

  // One keyed list rather than three blocks: a row typed into from the open
  // group moves among its siblings instead of remounting, so it keeps focus.
  const items: ReactNode[] = open.map(renderRow);
  if (collapsed.length > 0) {
    items.push(
      <CollapsedLine
        key="collapsed-rows"
        rows={collapsed}
        value={collapsedValue}
        currency={shared.currency}
        isOpen={showCollapsed}
        onToggle={() => setShowCollapsed((current) => !current)}
      />,
    );
    if (showCollapsed) items.push(...collapsed.map(renderRow));
  }
  return (
    <div>
      <div
        className={cn(
          AMOUNTS_GRID,
          "text-muted-foreground bg-muted/15 hidden border-b px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] sm:grid sm:items-center",
        )}
      >
        <span>{t("allocation:worksheet.position")}</span>
        <span>{t("allocation:worksheet.weight")}</span>
        <span>
          {shared.editMode === "amount"
            ? t("allocation:worksheet.changeAmount")
            : t("allocation:worksheet.afterPercentage")}
        </span>
        <span>{t("allocation:worksheet.status")}</span>
      </div>
      <div className="divide-y">{items}</div>
    </div>
  );
}

interface CollapsedLineProps {
  rows: readonly WorksheetPosition[];
  value: number;
  currency: string;
  isOpen: boolean;
  onToggle: () => void;
}

function CollapsedLine({ rows, value, currency, isOpen, onToggle }: CollapsedLineProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const activeCategoryId = useHighlight((state) => {
    const active = activeTarget(state);
    return active?.kind === "category" ? active.categoryId : null;
  });
  const touching = activeCategoryId
    ? rows.filter((row) =>
        row.categoryExposures.some(
          (exposure) => exposure.categoryId === activeCategoryId && exposure.weightBps > 0,
        ),
      )
    : [];
  const categoryName = touching[0]?.categoryExposures.find(
    (exposure) => exposure.categoryId === activeCategoryId,
  )?.categoryName;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      data-collapsed-rows
      className={cn(
        "flex w-full items-center justify-between gap-3 px-4 py-3 text-left sm:px-5",
        touching.length > 0 && "bg-muted/60",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5 text-xs">
        <Icons.ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", isOpen && "rotate-180")}
        />
        <span className="font-medium">
          {t("allocation:worksheet.collapsedRows", { count: rows.length })}
        </span>
        <span className="text-muted-foreground font-mono tabular-nums">
          {formatAmount(value, currency)}
        </span>
      </span>
      <span className={cn("shrink-0 text-xs", touching.length > 0 && "font-semibold")}>
        {touching.length > 0 && categoryName
          ? t("allocation:worksheet.collapsedTouching", {
              count: touching.length,
              category: categoryName,
            })
          : isOpen
            ? t("allocation:worksheet.hideRows")
            : t("allocation:worksheet.showRows")}
      </span>
    </button>
  );
}

interface AmountRowProps extends Omit<
  AmountsListProps,
  "rows" | "flaggedAssetIds" | "unresolvedCategoryIds"
> {
  model: AmountsRowModel;
}

function AmountRow({
  model,
  actions,
  classColors,
  accountNames,
  editMode,
  currency,
  allowSells,
  wholeSharesOnly,
  fundingByAccount,
  isPriceSyncing,
}: AmountRowProps) {
  const { t } = useTranslation();
  const { formatAmount, formatPrice, currencyFractionDigits } = useAmountFormatting();
  const { formatQuantity, decimalSeparator } = useNumberFormatting();
  const {
    position,
    adjustment,
    displayInput,
    changeAmount,
    isChanged,
    projectedValue,
    projectedPct,
    unitPrice,
    status,
    asset,
    isExpanded,
    placement,
  } = model;
  const emphasis = useHighlight((state) =>
    rowEmphasis(activeTarget(state), position.assetId, position.categoryExposures),
  );
  const shareBps = useHighlight((state) =>
    partialShareBps(activeTarget(state), position.categoryExposures),
  );
  const isSelected = useHighlight(
    (state) => state.selected?.kind === "row" && state.selected.assetId === position.assetId,
  );
  const { point, unpoint, select, toggleSelected } = useHighlightActions();
  const [isTyping, setIsTyping] = useState(false);
  const canPlace = placement !== undefined && placement.accounts.length > 1;
  const fractionDigits = currencyFractionDigits(currency);
  // A rare action, offered on the row being worked on rather than on every row.
  const isActive = emphasis === "active" || isSelected || isExpanded;
  const canReduceToZero = !position.isAdded && position.value > AMOUNT_EPSILON && allowSells;
  // One unit at a time, on the amount: amounts stay primary (§4.6.5).
  const canStep = editMode === "amount" && unitPrice !== undefined && unitPrice > 0;
  const downTo = canStep
    ? stepByUnits(changeAmount, unitPrice, -1, wholeSharesOnly, fractionDigits)
    : undefined;
  // Without reductions, a step cannot take the amount below zero.
  const stepDown = downTo !== undefined && (allowSells || downTo >= 0) ? downTo : undefined;
  const stepTo = (amount: number) =>
    actions.onInputChange(position, formatDecimalInput(amount, fractionDigits));
  const target: HighlightTarget = { kind: "row", assetId: position.assetId };
  // Said in words as well as colour: "US equity 60%, Bonds 40%".
  const classNames = position.categoryExposures.map((exposure) =>
    exposure.categoryId === UNCLASSIFIED_CATEGORY_ID
      ? t("allocation:worksheet.unclassified")
      : exposure.categoryName,
  );
  const classesText = position.categoryExposures
    .map((exposure, index) => `${classNames[index]} ${Math.round(exposure.weightBps / 100)}%`)
    .join(", ");
  const classesId = `worksheet-classes-${position.assetId}`;

  return (
    <div
      id={`worksheet-position-${position.assetId}`}
      data-amounts-row={position.assetId}
      data-emphasis={emphasis}
      aria-current={isSelected || undefined}
      onPointerEnter={(event) => event.pointerType !== "touch" && point(target)}
      onPointerLeave={(event) => event.pointerType !== "touch" && unpoint(target)}
      // Focus inside the row, in its amount field above all, behaves like pointing.
      onFocus={() => point(target)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) unpoint(target);
      }}
      onClick={(event) => {
        const clicked = event.target as HTMLElement;
        if (clicked.closest("input, button, a, [data-account-allocation]")) return;
        if (!canPlace) {
          toggleSelected(target);
          return;
        }
        // The whole row opens where the change goes; the open row is the
        // selected one, so its classes stay lit while it is placed.
        actions.onToggleExpanded(position.assetId);
        if (!isExpanded) select(target);
        else if (isSelected) toggleSelected(target);
      }}
      className={cn(
        "cursor-pointer px-4 py-3 transition-[opacity,background-color] sm:px-5",
        (emphasis === "active" || emphasis === "lit") && "bg-muted/60",
        emphasis === "dim" && "opacity-40",
        isSelected && "ring-foreground ring-[1.5px] ring-inset",
      )}
    >
      <div className={AMOUNTS_GRID}>
        {/* Symbol above name, so the name is not cut short beside the symbol. */}
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex w-5 shrink-0 flex-wrap gap-[3px] pt-[7px]" title={classesText}>
            {position.categoryExposures.map((exposure) =>
              exposure.categoryId === UNCLASSIFIED_CATEGORY_ID ? (
                <span
                  key={exposure.categoryId}
                  className="border-muted-foreground h-[7px] w-[7px] rounded-full border border-dashed"
                />
              ) : (
                <span
                  key={exposure.categoryId}
                  className="bg-muted-foreground h-[7px] w-[7px] rounded-full"
                  style={{ background: classColors.get(exposure.categoryId) }}
                />
              ),
            )}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-semibold leading-5">
                {position.symbol}
              </span>
              {shareBps !== null && (
                <span className="border-foreground shrink-0 rounded border px-1 font-mono text-[11px]">
                  {Math.round(shareBps / 100)}%
                </span>
              )}
            </div>
            <p className="text-muted-foreground truncate text-xs leading-4">{position.name}</p>
          </div>
          <span id={classesId} className="sr-only">
            {classesText}
          </span>
        </div>

        {/* The projected weight stands out, so the eye finds what changes without
            reading the arrow; no colour says which way. */}
        <span className="text-right font-mono text-xs tabular-nums sm:pt-2 sm:text-left">
          {isChanged ? (
            <>
              <span className="text-muted-foreground">{position.currentPct.toFixed(1)} → </span>
              <span className="font-semibold">{projectedPct.toFixed(1)}%</span>
            </>
          ) : (
            <span className="text-muted-foreground">{position.currentPct.toFixed(1)}%</span>
          )}
        </span>

        <div className="col-span-2 min-w-0 sm:col-span-1">
          <div className="flex items-center gap-1">
            <StepperField
              prefix={editMode === "amount" ? currency : undefined}
              suffix={editMode === "after_percentage" ? "%" : undefined}
              unitSteps={
                canStep
                  ? {
                      downLabel: t("allocation:worksheet.removeOneUnit", {
                        symbol: position.symbol,
                      }),
                      upLabel: t("allocation:worksheet.addOneUnit", { symbol: position.symbol }),
                      onDown: stepDown !== undefined ? () => stepTo(stepDown) : undefined,
                      onUp: () =>
                        stepTo(
                          stepByUnits(changeAmount, unitPrice, 1, wholeSharesOnly, fractionDigits),
                        ),
                    }
                  : undefined
              }
              aria-label={t("allocation:worksheet.positionInputLabel", {
                symbol: position.symbol,
              })}
              aria-describedby={classesId}
              value={
                editMode === "amount" && !isTyping
                  ? amountAtRest(displayInput, fractionDigits, decimalSeparator)
                  : displayInput
              }
              onFocus={() => setIsTyping(true)}
              onBlur={() => setIsTyping(false)}
              onChange={(event) => actions.onInputChange(position, event.target.value)}
              // A tap on the amount field selects the row too, so its classes
              // stay lit while typing.
              onPointerDown={(event) => event.pointerType === "touch" && select(target)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  toggleSelected(target);
                  return;
                }
                if (
                  editMode !== "after_percentage" ||
                  (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                ) {
                  return;
                }
                event.preventDefault();
                const current = decimalInputOrZero(displayInput);
                const step = event.shiftKey ? 1 : 0.5;
                const next = Math.min(
                  100,
                  Math.max(0, current + (event.key === "ArrowUp" ? step : -step)),
                );
                actions.onInputChange(position, formatDecimalInput(next, 4));
              }}
              inputMode="decimal"
              placeholder={editMode === "amount" ? "±0" : undefined}
            />
            {position.isAdded && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={t("allocation:worksheet.removePosition")}
                onClick={() => actions.onRemove(position.assetId)}
              >
                <Icons.X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {/* A final percentage is typed; the amount it comes to stays in view. */}
          {editMode === "after_percentage" && isChanged && (
            <p className="text-muted-foreground mt-0.5 text-right font-mono text-[10px] tabular-nums">
              ≈ {formatSignedAmount(changeAmount, currency, formatAmount)}
            </p>
          )}
          {/* The price, so an amount can be sized; the units it comes to, secondary. */}
          {editMode === "amount" && unitPrice !== undefined && (
            <p className="text-muted-foreground mt-0.5 text-right font-mono text-[10px] tabular-nums">
              {Math.abs(changeAmount) >= AMOUNT_EPSILON
                ? t("allocation:worksheet.unitsAtPrice", {
                    count: unitsFor(changeAmount, unitPrice, wholeSharesOnly),
                    // An estimate: two decimals say enough.
                    quantity: formatQuantity(
                      Math.round(unitsFor(changeAmount, unitPrice, wholeSharesOnly) * 100) / 100,
                    ),
                    price: formatPrice(unitPrice, currency),
                  })
                : t("allocation:worksheet.perUnit", { price: formatPrice(unitPrice, currency) })}
            </p>
          )}
        </div>

        <div className="col-span-2 flex min-w-0 items-start justify-between gap-1 text-xs sm:col-span-1 sm:pt-1.5">
          <div className="min-w-0 space-y-1">
            <RowStatusCell
              status={status}
              accountNames={accountNames}
              currency={currency}
              isExpanded={isExpanded}
              onToggleExpanded={() => actions.onToggleExpanded(position.assetId)}
              onPriceAction={() => actions.onPriceAction(position.assetId, asset)}
              priceActionLabel={
                asset?.quoteMode === "MARKET"
                  ? t("allocation:worksheet.refreshPrice")
                  : t("allocation:worksheet.addManualPrice")
              }
              isPriceSyncing={isPriceSyncing}
            />
            {/* Emptying a position in one go, in words so it cannot be read as a
                unit step, and only on the row being worked on. */}
            {canReduceToZero && isActive && (
              <button
                type="button"
                disabled={projectedValue <= AMOUNT_EPSILON}
                onClick={() => actions.onReduceToZero(position)}
                className="text-foreground block text-[11px] underline underline-offset-2 disabled:pointer-events-none disabled:opacity-40"
              >
                {t("allocation:worksheet.reduceToZero")}
              </button>
            )}
          </div>
          {/* Placing the change is always reachable, whatever the status says. */}
          {canPlace && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={t("allocation:worksheet.toggleAccountAllocation")}
              aria-expanded={isExpanded}
              onClick={() => actions.onToggleExpanded(position.assetId)}
            >
              <Icons.ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
          )}
        </div>
      </div>

      {adjustment && isExpanded && placement && (
        <AccountAllocation
          position={position}
          changeAmount={changeAmount}
          accounts={placement.accounts}
          adjustment={adjustment}
          currency={currency}
          fundingByAccount={fundingByAccount}
          unitPrice={placement.unitPrice}
          wholeSharesOnly={wholeSharesOnly}
          impliedAccountId={placement.impliedAccountId}
          onAmountChange={(accountId, value) =>
            actions.onAccountAmountChange(position.assetId, accountId, value)
          }
        />
      )}
    </div>
  );
}

interface RowStatusCellProps {
  status: RowStatus | null;
  accountNames: ReadonlyMap<string, string>;
  currency: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onPriceAction: () => void;
  priceActionLabel: string;
  isPriceSyncing: boolean;
}

function RowStatusCell({
  status,
  accountNames,
  currency,
  isExpanded,
  onToggleExpanded,
  onPriceAction,
  priceActionLabel,
  isPriceSyncing,
}: RowStatusCellProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  if (!status) return null;

  const warning = "text-amber-800 dark:text-amber-200";
  const linkClass = "max-w-full truncate text-left underline-offset-4 hover:underline";
  switch (status.kind) {
    case "needs_account":
      // The account allocation opens from here until Placement has its own panel.
      return (
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={onToggleExpanded}
          className={cn(linkClass, "font-medium", warning)}
        >
          {t("allocation:worksheet.needsAccount")}
        </button>
      );
    case "check_amount":
      return (
        <span className={cn("block truncate", warning)} title={status.message}>
          {t("allocation:worksheet.checkAmount")}
        </span>
      );
    case "price_required":
      return (
        <button
          type="button"
          title={priceActionLabel}
          disabled={isPriceSyncing}
          onClick={onPriceAction}
          className={cn(linkClass, "text-destructive")}
        >
          {t("allocation:worksheet.noQuoteShort")}
        </button>
      );
    case "warnings":
      return (
        <span className={cn("block truncate", warning)} title={status.messages.join("\n")}>
          {t("allocation:worksheet.lineWarningCount", { count: status.messages.length })}
        </span>
      );
    case "rounded":
      // Expected on almost every line under whole units, so not a problem colour,
      // and shown whole rather than cut short.
      return (
        <span className="text-muted-foreground block font-mono text-[11px] leading-snug">
          {t("allocation:worksheet.roundedTo", {
            amount: formatSignedAmount(status.amount, currency, formatAmount),
          })}
        </span>
      );
    case "stale_price":
      return (
        <span className={cn("block truncate", warning)}>
          {t("allocation:worksheet.priceFrom", { date: status.date })}
        </span>
      );
    case "not_eligible":
      return (
        <span className="text-muted-foreground block truncate">
          {t("allocation:worksheet.notEligible")}
        </span>
      );
    case "placed":
      return (
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={onToggleExpanded}
          className={cn(linkClass, "text-muted-foreground")}
        >
          {status.accountIds.length === 1
            ? (accountNames.get(status.accountIds[0]) ?? t("allocation:worksheet.unknownAccount"))
            : t("allocation:worksheet.accountCount", { count: status.accountIds.length })}
        </button>
      );
  }
}
