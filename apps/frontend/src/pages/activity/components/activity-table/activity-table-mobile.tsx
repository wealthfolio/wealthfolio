import { useCallback } from "react";

import { TickerAvatar } from "@/components/ticker-avatar";
import {
  calculateActivityValue,
  formatSplitRatio,
  isAssetBackedIncomeActivity,
  isCashActivity,
  isCashTransfer,
  isFeeActivity,
  isIncomeActivity,
  isSecuritiesTransfer,
  isSplitActivity,
  localizeActivityTypeName,
} from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { formatOptionSubtitle, parseOccSymbol } from "@/lib/occ-symbol";
import { useSettingsContext } from "@/lib/settings-provider";
import { ActivityDetails } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import {
  AmountDisplay,
  Button,
  EmptyPlaceholder,
  Icons,
  PriceDisplay,
  Separator,
  useNumberFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Card } from "@wealthfolio/ui/components/ui/card";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { InfiniteScrollTrigger } from "@/components/infinite-scroll-trigger";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useVirtualScrollContainer } from "@/hooks/use-virtual-scroll-container";
import { ActivityOperations } from "../activity-operations";
import { ActivityTypeBadge } from "../activity-type-badge";

/**
 * Starting heights for virtualized cards. The detailed card grows with the
 * fields an activity carries, so this is only a starting point — each card
 * reports its real height once measured.
 */
const COMPACT_CARD_HEIGHT = 88;
const DETAILED_CARD_HEIGHT = 300;
/** `space-y-2`, moved into the virtualizer's layout maths. */
const CARD_GAP = 8;
/** Cards kept mounted past the viewport edge, so a fast flick stays painted. */
const OVERSCAN = 5;

interface ActivityTableMobileProps {
  activities: ActivityDetails[];
  isLoading?: boolean;
  isCompactView: boolean;
  handleEdit: (activity?: ActivityDetails) => void;
  handleDelete: (activity: ActivityDetails) => void;
  onDuplicate: (activity: ActivityDetails) => Promise<void>;
  onLinkTransfer?: (activity: ActivityDetails) => void;
  onUnlinkTransfer?: (activity: ActivityDetails) => void;
  filtersActive?: boolean;
  onAdd?: () => void;
  onClearFilters?: () => void;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
  isFetching?: boolean;
  isFetchingNextPage?: boolean;
  hasLoadMoreError?: boolean;
}

export const ActivityTableMobile = ({
  activities,
  isLoading = false,
  isCompactView,
  handleEdit,
  handleDelete,
  onDuplicate,
  onLinkTransfer,
  onUnlinkTransfer,
  filtersActive = false,
  onAdd,
  onClearFilters,
  onLoadMore,
  hasNextPage = false,
  isFetching,
  isFetchingNextPage = false,
  hasLoadMoreError = false,
}: ActivityTableMobileProps) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  // The list scrolls inside its own box, so it sits at the top of it and the
  // margin resolves to zero; the hook still supplies the element itself.
  const { listRef, scrollElement, scrollMargin } = useVirtualScrollContainer();

  /**
   * Measured heights are cached under this key, and the detailed card is
   * several times the height of the compact one — so the view has to be part
   * of the identity, or a card would be laid out at the height it had under
   * the other view. Changing the key also remounts the row, which is what
   * makes it re-measure: `measureElement` is a stable callback ref, so React
   * never re-runs it for a row that merely re-rendered.
   */
  const getItemKey = useCallback(
    (index: number) =>
      `${isCompactView ? "compact" : "detailed"}:${activities[index]?.id ?? index}`,
    [activities, isCompactView],
  );

  const virtualizer = useVirtualizer({
    count: activities.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => (isCompactView ? COMPACT_CARD_HEIGHT : DETAILED_CARD_HEIGHT),
    getItemKey,
    overscan: OVERSCAN,
    scrollMargin,
    // `space-y-2`, which positioned cards no longer inherit.
    gap: CARD_GAP,
  });

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t("activity:table.loading")}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <EmptyPlaceholder>
        <EmptyPlaceholder.Icon name="Activity" />
        <EmptyPlaceholder.Title>{t("activity:table.no_activities")}</EmptyPlaceholder.Title>
        <EmptyPlaceholder.Description>
          {filtersActive
            ? t("activity:table.no_activities_filtered")
            : t("activity:table.no_activities_desc")}
        </EmptyPlaceholder.Description>
        {filtersActive ? (
          onClearFilters ? (
            <Button variant="outline" onClick={onClearFilters}>
              {t("activity:table.clear_filters")}
            </Button>
          ) : null
        ) : onAdd ? (
          <Button onClick={onAdd}>
            <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("activity:add_activity")}
          </Button>
        ) : null}
      </EmptyPlaceholder>
    );
  }

  /**
   * One card. Extracted from the list body so the virtualizer can render it
   * inside the positioned wrapper it needs for each row.
   */
  const renderCard = (activity: ActivityDetails) => {
    const symbol = activity.assetSymbol;
    const activityType = activity.activityType;
    const isTransferActivity =
      activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
    const isAssetBackedIncome = isAssetBackedIncomeActivity(activityType, symbol, activity.assetId);
    const isCash = isTransferActivity
      ? isCashTransfer(activityType, symbol, activity.assetId)
      : isCashActivity(activityType) && !isAssetBackedIncome;
    const hasAsset = Boolean(activity.assetId?.trim());
    const isOptionActivity = activity.instrumentType === "OPTION";
    const parsedOption = isOptionActivity ? parseOccSymbol(symbol) : null;
    const displaySymbol = isCash
      ? t("activity:table.cash")
      : parsedOption
        ? parsedOption.underlying
        : symbol;
    const avatarSymbol = isCash ? "$CASH" : symbol;
    const optionSubtitle = parsedOption
      ? formatOptionSubtitle(parsedOption, { ...numberFormatting, ...dateFormatting })
      : null;
    const formattedDate = formatDateTime(activity.date, dateFormatting, appTimezone);
    const displayValue = calculateActivityValue(activity);
    const displayGross = isIncomeActivity(activity.activityType)
      ? displayValue + Number(activity.tax ?? 0)
      : displayValue;

    // Compact View
    if (isCompactView) {
      const activityTypeLabel = localizeActivityTypeName(t, activity.activityType);
      return (
        <Card key={activity.id} className="p-3">
          <div className="flex items-center gap-3">
            {(() => {
              const inner = (
                <>
                  <TickerAvatar
                    symbol={avatarSymbol}
                    exchangeMic={activity.exchangeMic}
                    instrumentType={activity.instrumentType}
                    assetId={activity.assetId}
                    className="h-10 w-10 flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate font-semibold">{displaySymbol}</p>
                      {activity.activityType !== "SPLIT" && (
                        <AmountDisplay
                          value={displayGross}
                          currency={activity.currency}
                          isHidden={isBalanceHidden}
                          className="shrink-0 text-sm font-semibold"
                        />
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {optionSubtitle
                        ? `${activityTypeLabel} · ${optionSubtitle}`
                        : activityTypeLabel}
                    </p>
                    <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                      <span>{formattedDate.date}</span>
                      {!isCash &&
                        !(isIncomeActivity(activity.activityType) && !isAssetBackedIncome) &&
                        !isSplitActivity(activity.activityType) &&
                        !isFeeActivity(activity.activityType) &&
                        activity.quantity && (
                          <>
                            <span>•</span>
                            <span>
                              {isBalanceHidden ? "••••" : activity.quantity}{" "}
                              {isOptionActivity
                                ? t("activity:date_list.contracts")
                                : t("activity:date_list.shares")}
                            </span>
                          </>
                        )}
                    </div>
                  </div>
                </>
              );
              return isCash || !hasAsset ? (
                <div className="flex min-w-0 flex-1 items-center gap-3">{inner}</div>
              ) : (
                <Link
                  to={`/holdings/${encodeURIComponent(activity.assetId)}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  {inner}
                </Link>
              );
            })()}
            <ActivityOperations
              activity={activity}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={onDuplicate}
              onLinkTransfer={onLinkTransfer}
              onUnlinkTransfer={onUnlinkTransfer}
              touch
            />
          </div>
        </Card>
      );
    }

    // Detailed View
    return (
      <Card key={activity.id} className="p-3">
        <div className="space-y-2">
          {/* Header: Symbol and Date */}
          <div className="flex items-start justify-between">
            {(() => {
              const inner = (
                <>
                  <TickerAvatar
                    symbol={avatarSymbol}
                    exchangeMic={activity.exchangeMic}
                    instrumentType={activity.instrumentType}
                    assetId={activity.assetId}
                    className="h-10 w-10"
                  />
                  <div>
                    <p className="font-semibold">{displaySymbol}</p>
                    <p className="text-muted-foreground text-xs">
                      {isCash ? activity.currency : (optionSubtitle ?? activity.assetName)}
                    </p>
                  </div>
                </>
              );
              return isCash || !hasAsset ? (
                <div className="flex items-center gap-2">{inner}</div>
              ) : (
                <Link
                  to={`/holdings/${encodeURIComponent(activity.assetId)}`}
                  className="flex items-center gap-2"
                >
                  {inner}
                </Link>
              );
            })()}
            <ActivityOperations
              activity={activity}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onDuplicate={onDuplicate}
              onLinkTransfer={onLinkTransfer}
              onUnlinkTransfer={onUnlinkTransfer}
              touch
            />
          </div>

          <Separator />

          {/* Activity Details Grid */}
          <div className="space-y-1.5 text-sm">
            {/* Date and Type */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("activity:table_date")}</span>
              <div className="text-right">
                <p>{formattedDate.date}</p>
                <p className="text-muted-foreground text-xs">{formattedDate.time}</p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("activity:table_type")}</span>
              <ActivityTypeBadge
                type={activity.activityType}
                subtype={activity.subtype}
                className="text-xs font-normal"
              />
            </div>

            {/* Quantity (if applicable) */}
            {!isCash &&
              !(isIncomeActivity(activity.activityType) && !isAssetBackedIncome) &&
              !isSplitActivity(activity.activityType) &&
              !isFeeActivity(activity.activityType) &&
              activity.quantity && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {isOptionActivity ? t("activity:detail.contracts") : t("activity:field_shares")}
                  </span>
                  <span className="font-medium">
                    {isBalanceHidden ? "••••" : activity.quantity}
                  </span>
                </div>
              )}

            {/* Price/Amount */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {activity.activityType === "SPLIT"
                  ? t("activity:table.ratio")
                  : isIncomeActivity(activity.activityType)
                    ? t("activity:form.label_amount")
                    : (isCashActivity(activity.activityType) &&
                          !isAssetBackedIncome &&
                          !isSecuritiesTransfer(activity.activityType, symbol, activity.assetId)) ||
                        isCashTransfer(activity.activityType, symbol, activity.assetId)
                      ? t("activity:form.label_amount")
                      : isOptionActivity
                        ? t("activity:table.premium")
                        : t("activity:field_price")}
              </span>
              <span className="font-medium">
                {activity.activityType === "FEE" ? (
                  "-"
                ) : activity.activityType === "SPLIT" ? (
                  formatSplitRatio(Number(activity.amount))
                ) : isIncomeActivity(activity.activityType) ? (
                  <AmountDisplay
                    value={Number(activity.amount) + Number(activity.tax ?? 0)}
                    currency={activity.currency}
                    isHidden={isBalanceHidden}
                  />
                ) : (isCashActivity(activity.activityType) &&
                    !isAssetBackedIncome &&
                    !isSecuritiesTransfer(activity.activityType, symbol, activity.assetId)) ||
                  isCashTransfer(activity.activityType, symbol, activity.assetId) ? (
                  <AmountDisplay
                    value={Number(activity.amount)}
                    currency={activity.currency}
                    isHidden={isBalanceHidden}
                  />
                ) : (
                  <PriceDisplay
                    value={Number(activity.unitPrice)}
                    currency={activity.currency}
                    isHidden={isBalanceHidden}
                  />
                )}
              </span>
            </div>

            {/* Fee (if applicable) */}
            {Number(activity.fee) > 0 && activity.activityType !== "SPLIT" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("activity:table_fee")}</span>
                <AmountDisplay
                  value={Number(activity.fee)}
                  currency={activity.currency}
                  isHidden={isBalanceHidden}
                  className="font-medium"
                />
              </div>
            )}
            {Number(activity.tax) > 0 && activity.activityType !== "SPLIT" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("activity:table.tax")}</span>
                <AmountDisplay
                  value={Number(activity.tax)}
                  currency={activity.currency}
                  isHidden={isBalanceHidden}
                  className="font-medium"
                />
              </div>
            )}

            {/* Total Value */}
            {activity.activityType !== "SPLIT" && (
              <div className="flex items-center justify-between border-t pt-1.5">
                <span className="text-muted-foreground font-medium">
                  {t("activity:table.total_value")}
                </span>
                <AmountDisplay
                  value={displayValue}
                  currency={activity.currency}
                  isHidden={isBalanceHidden}
                  className="font-semibold"
                />
              </div>
            )}

            {/* Account */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("activity:table_account")}</span>
              <div className="text-right">
                <p>{activity.accountName}</p>
                <p className="text-muted-foreground text-xs">{activity.accountCurrency}</p>
              </div>
            </div>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div
      data-virtual-scroll-parent
      className="min-h-0 flex-1 overflow-auto"
      /* `overflow-anchor: none` keeps the browser from choosing a card in here
         as its scroll anchor: cards are recycled as you scroll, and
         re-anchoring to one that just changed height fights the virtualizer. */
      style={{ overflowAnchor: "none" }}
    >
      <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const activity = activities[virtualItem.index];
          if (!activity) return null;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
            >
              {renderCard(activity)}
            </div>
          );
        })}
      </div>
      {onLoadMore && (
        <InfiniteScrollTrigger
          onLoadMore={onLoadMore}
          hasNextPage={hasNextPage}
          isFetching={isFetching ?? isFetchingNextPage}
          isFetchingNextPage={isFetchingNextPage}
          hasLoadMoreError={hasLoadMoreError}
        />
      )}
    </div>
  );
};

export default ActivityTableMobile;
