import {
  Card,
  Checkbox,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useAmountFormatting,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { TickerAvatar } from "@/components/ticker-avatar";
import type { Asset, Holding } from "@/lib/types";
import { cn } from "@/lib/utils";

import { symbolList } from "./allocation-worksheet-utils";
import {
  getEligibleHoldings,
  type EligibleHolding,
  type TargetCategories,
} from "./eligible-holdings";

/** The Increase and Reduce columns: wide enough for their headings in every locale. */
const SWITCH_COLUMN = "flex w-20 shrink-0 justify-center";

/** Unheld securities offered for one query; the list stays a glance, not a catalogue. */
const ADDABLE_LIMIT = 5;

/**
 * A hover or focus away: the rest of what a short line means. A screen reader
 * hears it as the button's name, so it never depends on the tooltip opening.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={text}
              className="text-muted-foreground hover:text-foreground inline-flex shrink-0 align-middle"
            />
          }
        >
          <Icons.Info className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs leading-relaxed">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface SecuritiesCardProps {
  holdings: Holding[];
  categories: TargetCategories | undefined;
  /** Securities left out of increases (§4.1). */
  increaseExcluded: ReadonlySet<string>;
  /** Securities left out of reductions (§4.1). */
  reduceExcluded: ReadonlySet<string>;
  /** Securities the target's rules never increase in the selected accounts. */
  increaseProtected: ReadonlySet<string>;
  /** Securities the target's rules never reduce in the selected accounts. */
  reduceProtected: ReadonlySet<string>;
  onToggleIncrease: (assetId: string) => void;
  onToggleReduce: (assetId: string) => void;
  onSetIncrease: (assetIds: readonly string[], included: boolean) => void;
  onSetReduce: (assetIds: readonly string[], included: boolean) => void;
  isRebalance: boolean;
  /** Every tracked security, so one the accounts do not hold can be added. */
  assets: readonly Asset[];
  addedAssetIds: readonly string[];
  onAdd: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  /** The target's limits on the amounts, said once with the securities they shape. */
  limits: readonly string[];
  currency: string;
}

/** One line of the folded card: something that applies to this run. */
interface SummaryLine {
  key: string;
  text: string;
  detail?: string;
  isLocked?: boolean;
}

interface SecurityGroup {
  key: string;
  name: string;
  color?: string;
  isBelowTarget: boolean | null;
  holdings: EligibleHolding[];
}

const symbolOf = (asset: Asset) =>
  asset.displayCode ?? asset.instrumentSymbol ?? asset.name ?? asset.id;

/**
 * What the calculation may increase or reduce, security by security (§4.1).
 *
 * Folded, it says what applies to this run: what the target protects, what
 * is left out this time, what was added. Change opens the list, grouped by
 * the target's categories, each row with a switch per direction its
 * categories use: a category below its target is never reduced, one above is
 * never increased. A rule on the target shows as a lock, never as a switch it
 * would ignore.
 */
export function SecuritiesCard({
  holdings,
  categories,
  increaseExcluded,
  reduceExcluded,
  increaseProtected,
  reduceProtected,
  onToggleIncrease,
  onToggleReduce,
  onSetIncrease,
  onSetReduce,
  isRebalance,
  assets,
  addedAssetIds,
  onAdd,
  onRemove,
  limits,
  currency,
}: SecuritiesCardProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const held = useMemo(() => getEligibleHoldings(holdings), [holdings]);
  const normalized = query.trim().toLowerCase();
  const matches = (values: (string | null | undefined)[]) =>
    !normalized || values.some((value) => value?.toLowerCase().includes(normalized));

  const categoryOf = new Map(categories?.order.map((category) => [category.id, category]) ?? []);
  const directions = (assetId: string) =>
    (categories?.byAsset.get(assetId) ?? []).map((id) => categoryOf.get(id)?.isBelowTarget);

  const groups: SecurityGroup[] = categories
    ? [
        ...categories.order.map((category) => ({
          key: category.id,
          name: category.name,
          color: category.color,
          isBelowTarget: category.isBelowTarget,
          // A fund spans several categories; it is listed once, under its largest.
          holdings: held.filter(
            (holding) => categories.byAsset.get(holding.assetId)?.[0] === category.id,
          ),
        })),
        {
          key: "__outside__",
          name: t("allocation:eligibleHoldings.notInTarget"),
          isBelowTarget: null,
          holdings: held.filter(
            (holding) => !categoryOf.has(categories.byAsset.get(holding.assetId)?.[0] ?? ""),
          ),
        },
      ].filter((group) => group.holdings.length > 0)
    : [{ key: "__all__", name: "", isBelowTarget: null, holdings: held }];

  const heldIds = new Set(held.map((holding) => holding.assetId));
  const added = addedAssetIds.flatMap((assetId) => {
    const asset = assets.find((item) => item.id === assetId);
    return asset && !heldIds.has(assetId) ? [asset] : [];
  });
  const addables = normalized
    ? assets
        .filter(
          (asset) =>
            !heldIds.has(asset.id) &&
            !addedAssetIds.includes(asset.id) &&
            matches([symbolOf(asset), asset.name]),
        )
        .slice(0, ADDABLE_LIMIT)
    : [];

  const canIncrease = (assetId: string) =>
    !increaseExcluded.has(assetId) && !increaseProtected.has(assetId);
  const canReduce = (assetId: string) =>
    !reduceExcluded.has(assetId) && !reduceProtected.has(assetId);
  const increaseCount =
    held.filter((holding) => canIncrease(holding.assetId)).length + added.length;
  const reduceCount = held.filter((holding) => canReduce(holding.assetId)).length;

  // What applies to this run, said in a few words while the list is folded.
  // Two assets can share a symbol; each symbol is named once.
  const symbolsOf = (keep: (holding: EligibleHolding) => boolean) => [
    ...new Set(held.filter(keep).map((holding) => holding.symbol)),
  ];
  const more = (count: number) => t("allocation:worksheet.gapMore", { count });
  const protectedSymbols = symbolsOf(
    (holding) =>
      increaseProtected.has(holding.assetId) ||
      (isRebalance && reduceProtected.has(holding.assetId)),
  );
  const notIncreased = symbolsOf(
    (holding) => increaseExcluded.has(holding.assetId) && !increaseProtected.has(holding.assetId),
  );
  const notReduced = isRebalance
    ? symbolsOf(
        (holding) => reduceExcluded.has(holding.assetId) && !reduceProtected.has(holding.assetId),
      )
    : [];
  const summary: SummaryLine[] = [];
  if (protectedSymbols.length > 0) {
    summary.push({
      key: "protected",
      text: t("allocation:worksheet.securitiesProtected", {
        securities: symbolList(protectedSymbols, more),
      }),
      detail: t("allocation:worksheet.securitiesProtectedDetail"),
      isLocked: true,
    });
  }
  if (notIncreased.length > 0) {
    summary.push({
      key: "increase",
      text: t("allocation:worksheet.securitiesNotIncreased", {
        securities: symbolList(notIncreased, more),
      }),
    });
  }
  if (notReduced.length > 0) {
    summary.push({
      key: "reduce",
      text: t("allocation:worksheet.securitiesNotReduced", {
        securities: symbolList(notReduced, more),
      }),
    });
  }
  if (added.length > 0) {
    summary.push({
      key: "added",
      text: t("allocation:worksheet.securitiesAddedSummary", {
        securities: symbolList(added.map(symbolOf), more),
      }),
    });
  }

  return (
    <Card role="region" aria-labelledby="worksheet-securities-title">
      <div className="space-y-1 px-4 py-3">
        <div className="flex h-6 items-center justify-between gap-3">
          <h4 id="worksheet-securities-title" className="text-sm font-semibold">
            {t("allocation:worksheet.securitiesTitle")}
          </h4>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls="worksheet-securities-list"
            onClick={() => {
              setIsOpen(!isOpen);
              setQuery("");
            }}
            className={cn(
              "h-6 rounded-full border px-2.5 text-xs transition-colors",
              isOpen
                ? "bg-foreground text-background border-foreground"
                : "hover:border-foreground/40",
            )}
          >
            {t(
              isOpen
                ? "allocation:worksheet.securitiesDone"
                : "allocation:worksheet.securitiesChange",
            )}
          </button>
        </div>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="tabular-nums">
            {isRebalance
              ? t("allocation:worksheet.securitiesCount", {
                  increase: increaseCount,
                  reduce: reduceCount,
                })
              : t("allocation:worksheet.securitiesIncreaseCount", { increase: increaseCount })}
          </span>
          <InfoTip text={t("allocation:worksheet.securitiesRule")} />
        </p>
        {!isOpen && (
          <ul className="space-y-0.5 pt-1 text-xs">
            {summary.length === 0 ? (
              <li className="text-muted-foreground">
                {t("allocation:worksheet.securitiesNoExceptions")}
              </li>
            ) : (
              summary.map((line) => (
                <li key={line.key} className="flex items-center gap-1.5">
                  {line.isLocked && (
                    <Icons.Lock aria-hidden="true" className="text-muted-foreground h-3 w-3" />
                  )}
                  <span className="min-w-0 truncate">{line.text}</span>
                  {line.detail && <InfoTip text={line.detail} />}
                </li>
              ))
            )}
          </ul>
        )}
        {limits.length > 0 && <p className="text-muted-foreground text-xs">{limits.join(" · ")}</p>}
      </div>

      {isOpen && (
        <div id="worksheet-securities-list" className="border-t">
          <div className="relative px-4 pt-3">
            <Icons.Search
              aria-hidden="true"
              className="text-muted-foreground absolute start-6 top-[calc(50%+0.375rem)] h-3.5 w-3.5 -translate-y-1/2"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("allocation:worksheet.securitiesSearch")}
              aria-label={t("allocation:worksheet.securitiesSearch")}
              className="border-input bg-background focus-visible:ring-ring h-8 w-full rounded-md border ps-8 pe-2.5 text-sm outline-none focus-visible:ring-1"
            />
          </div>

          {addables.length > 0 && (
            <div className="mx-4 mt-2 rounded-lg border">
              <p className="text-muted-foreground text-2xs px-3 pt-2 font-medium tracking-wide uppercase">
                {t("allocation:worksheet.securitiesNotHeld")}
              </p>
              {addables.map((asset) => (
                <div
                  key={asset.id}
                  className="flex items-center gap-2.5 border-t px-3 py-2 first-of-type:border-t-0"
                >
                  <TickerAvatar
                    symbol={symbolOf(asset)}
                    exchangeMic={asset.instrumentExchangeMic}
                    instrumentType={asset.instrumentType}
                    assetId={asset.id}
                    className="size-6 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className="font-mono font-semibold">{symbolOf(asset)}</span>
                    {asset.name && <span className="text-muted-foreground"> {asset.name}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onAdd(asset.id);
                      setQuery("");
                    }}
                    aria-label={t("allocation:worksheet.securityAdd", { symbol: symbolOf(asset) })}
                    className="hover:border-foreground/40 shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                  >
                    <Icons.Plus className="me-1 inline h-3 w-3" />
                    {t("common:add")}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 max-h-[min(55vh,32.5rem)] overflow-y-auto">
            {/* Each switch is named once, over its column; Reduce only matters with Rebalance. */}
            <div
              aria-hidden="true"
              className="bg-card text-muted-foreground text-2xs sticky top-0 z-10 flex items-center border-y px-4 py-1.5 font-medium"
            >
              <span className="flex-1">{t("allocation:worksheet.security")}</span>
              <span className={SWITCH_COLUMN}>{t("allocation:worksheet.allowIncrease")}</span>
              {isRebalance && (
                <span className={SWITCH_COLUMN}>{t("allocation:worksheet.allowReduce")}</span>
              )}
            </div>
            {groups.map((group) => {
              const members = group.holdings.filter((holding) =>
                matches([holding.symbol, holding.name, holding.exchangeMic]),
              );
              if (members.length === 0) return null;
              const forIncrease = group.isBelowTarget === true;
              const forReduce = group.isBelowTarget === false;
              // The group's action leaves what the target protects alone.
              const ids = group.holdings
                .map((holding) => holding.assetId)
                .filter((id) => !(forIncrease ? increaseProtected : reduceProtected).has(id));
              const allOn = forIncrease
                ? ids.every((id) => !increaseExcluded.has(id))
                : ids.every((id) => !reduceExcluded.has(id));
              return (
                <div key={group.key} role="group" aria-label={group.name || undefined}>
                  {group.name && (
                    <div className="bg-muted/30 flex items-center gap-2 px-4 py-1.5 text-xs">
                      {group.color && (
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ background: group.color }}
                        />
                      )}
                      <span className="font-semibold">{group.name}</span>
                      {group.isBelowTarget !== null && (
                        <span className="text-muted-foreground">
                          {t(
                            group.isBelowTarget
                              ? "allocation:worksheet.categoryBelowTarget"
                              : "allocation:worksheet.categoryAboveTarget",
                          )}
                        </span>
                      )}
                      {ids.length > 0 && (forIncrease || (forReduce && isRebalance)) && (
                        <button
                          type="button"
                          onClick={() =>
                            forIncrease ? onSetIncrease(ids, !allOn) : onSetReduce(ids, !allOn)
                          }
                          className="text-muted-foreground hover:text-foreground ms-auto underline-offset-2 hover:underline"
                        >
                          {t(
                            allOn
                              ? "allocation:worksheet.turnAllOff"
                              : "allocation:worksheet.turnAllOn",
                          )}
                        </button>
                      )}
                    </div>
                  )}
                  {members.map((holding) => {
                    const directionsOf = directions(holding.assetId);
                    const increaseUsed = directionsOf.includes(true);
                    const reduceUsed = isRebalance && directionsOf.includes(false);
                    return (
                      <SecurityRow
                        key={holding.assetId}
                        holding={holding}
                        alsoIn={(categories?.byAsset.get(holding.assetId) ?? [])
                          .slice(1)
                          .flatMap((id) => categoryOf.get(id)?.name ?? [])}
                        currency={currency}
                        canIncrease={!increaseExcluded.has(holding.assetId)}
                        canReduce={!reduceExcluded.has(holding.assetId)}
                        isIncreaseProtected={increaseProtected.has(holding.assetId)}
                        isReduceProtected={reduceProtected.has(holding.assetId)}
                        increaseUsed={increaseUsed}
                        reduceUsed={reduceUsed}
                        showReduce={isRebalance}
                        onToggleIncrease={() => onToggleIncrease(holding.assetId)}
                        onToggleReduce={() => onToggleReduce(holding.assetId)}
                      />
                    );
                  })}
                </div>
              );
            })}

            {added.length > 0 && (
              <div role="group" aria-label={t("allocation:worksheet.securitiesAdded")}>
                <div className="bg-muted/30 px-4 py-1.5 text-xs font-semibold">
                  {t("allocation:worksheet.securitiesAdded")}
                </div>
                {added.map((asset) => (
                  <div key={asset.id} className="flex items-center gap-2.5 px-4 py-2">
                    <TickerAvatar
                      symbol={symbolOf(asset)}
                      exchangeMic={asset.instrumentExchangeMic}
                      instrumentType={asset.instrumentType}
                      assetId={asset.id}
                      className="size-7 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">
                        <span className="font-mono font-semibold">{symbolOf(asset)}</span>
                        {asset.name && <span className="text-muted-foreground"> {asset.name}</span>}
                      </span>
                      <span className="text-2xs text-info-subtle-foreground block">
                        {t("allocation:worksheet.securityNewHint")}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemove(asset.id)}
                      aria-label={t("allocation:worksheet.securityRemove", {
                        symbol: symbolOf(asset),
                      })}
                      className="text-muted-foreground hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    >
                      <Icons.Close className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {held.length > 0 &&
              groups.every(
                (group) =>
                  !group.holdings.some((holding) =>
                    matches([holding.symbol, holding.name, holding.exchangeMic]),
                  ),
              ) &&
              addables.length === 0 && (
                <p className="text-muted-foreground px-4 py-3 text-xs">
                  {t("allocation:eligibleHoldings.noMatches")}
                </p>
              )}
          </div>
        </div>
      )}
    </Card>
  );
}

function SecurityRow({
  holding,
  alsoIn,
  currency,
  canIncrease,
  canReduce,
  isIncreaseProtected,
  isReduceProtected,
  increaseUsed,
  reduceUsed,
  showReduce,
  onToggleIncrease,
  onToggleReduce,
}: {
  holding: EligibleHolding;
  /** The security's other categories, where it also counts. */
  alsoIn: readonly string[];
  currency: string;
  canIncrease: boolean;
  canReduce: boolean;
  isIncreaseProtected: boolean;
  isReduceProtected: boolean;
  increaseUsed: boolean;
  reduceUsed: boolean;
  showReduce: boolean;
  onToggleIncrease: () => void;
  onToggleReduce: () => void;
}) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  // Nothing the calculation may do with it, as things are set: it steps back.
  const isIdle =
    !(increaseUsed && canIncrease && !isIncreaseProtected) &&
    !(reduceUsed && canReduce && !isReduceProtected);
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <TickerAvatar
        symbol={holding.symbol}
        exchangeMic={holding.exchangeMic}
        instrumentType={holding.instrumentType}
        assetId={holding.assetId}
        className={cn("size-7 shrink-0", isIdle && "opacity-50")}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-xs", isIdle && "text-muted-foreground")}>
          <span className="font-mono font-semibold">{holding.symbol}</span>
          {holding.name && <span className="text-muted-foreground"> {holding.name}</span>}
        </span>
        <span
          className="text-muted-foreground text-2xs block truncate"
          title={alsoIn.length > 0 ? alsoIn.join(", ") : undefined}
        >
          <span className="font-mono tabular-nums">
            {t("allocation:worksheet.securityHeld", {
              amount: formatAmount(holding.value, currency),
            })}
          </span>
          {alsoIn.length > 0 &&
            ` · ${t("allocation:worksheet.securityAlsoIn", { categories: alsoIn.join(", ") })}`}
        </span>
      </span>
      <AllowCell
        label={t("allocation:worksheet.allowIncreaseFor", { symbol: holding.symbol })}
        isOn={canIncrease}
        isUsed={increaseUsed}
        protectedNote={
          isIncreaseProtected ? t("allocation:worksheet.securityIncreaseProtected") : null
        }
        unusedNote={t("allocation:worksheet.increaseUnused")}
        onToggle={onToggleIncrease}
      />
      {showReduce && (
        <AllowCell
          label={t("allocation:worksheet.allowReduceFor", { symbol: holding.symbol })}
          isOn={canReduce}
          isUsed={reduceUsed}
          protectedNote={
            isReduceProtected ? t("allocation:worksheet.securityReduceProtected") : null
          }
          unusedNote={t("allocation:worksheet.reduceUnused")}
          onToggle={onToggleReduce}
        />
      )}
    </div>
  );
}

/**
 * One switch under its column heading: a round check where the security's
 * categories use that direction, a dash where they never do, and a lock
 * where the target's rules decide instead.
 */
function AllowCell({
  label,
  isOn,
  isUsed,
  protectedNote,
  unusedNote,
  onToggle,
}: {
  label: string;
  isOn: boolean;
  isUsed: boolean;
  protectedNote: string | null;
  unusedNote: string;
  onToggle: () => void;
}) {
  return (
    <span className={SWITCH_COLUMN}>
      {isUsed && protectedNote ? (
        <span title={protectedNote} className="text-muted-foreground">
          <Icons.Lock aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{protectedNote}</span>
        </span>
      ) : isUsed ? (
        <Checkbox
          checked={isOn}
          onCheckedChange={onToggle}
          aria-label={label}
          className="size-5 rounded-full"
        />
      ) : (
        <span title={unusedNote} className="text-muted-foreground/50 text-xs">
          <span aria-hidden="true">–</span>
          <span className="sr-only">{unusedNote}</span>
        </span>
      )}
    </span>
  );
}
