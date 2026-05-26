import { TickerAvatar } from "@/components/ticker-avatar";
import { Card } from "@wealthfolio/ui/components/ui/card";
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
} from "@/lib/activity-utils";
import { ActivityType, ActivityTypeNames } from "@/lib/constants";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { useSettingsContext } from "@/lib/settings-provider";
import { ActivityDetails } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { Button, EmptyPlaceholder, formatAmount, Icons, Separator } from "@wealthfolio/ui";
import { Link } from "react-router-dom";
import { ActivityOperations } from "../activity-operations";
import { ActivityTypeBadge } from "../activity-type-badge";

interface ActivityTableMobileProps {
  activities: ActivityDetails[];
  isCompactView: boolean;
  handleEdit: (activity?: ActivityDetails) => void;
  handleDelete: (activity: ActivityDetails) => void;
  onDuplicate: (activity: ActivityDetails) => Promise<void>;
  filtersActive?: boolean;
  onAdd?: () => void;
  onClearFilters?: () => void;
}

export const ActivityTableMobile = ({
  activities,
  isCompactView,
  handleEdit,
  handleDelete,
  onDuplicate,
  filtersActive = false,
  onAdd,
  onClearFilters,
}: ActivityTableMobileProps) => {
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  if (activities.length === 0) {
    return (
      <EmptyPlaceholder>
        <EmptyPlaceholder.Icon name="Activity" />
        <EmptyPlaceholder.Title>No activities</EmptyPlaceholder.Title>
        <EmptyPlaceholder.Description>
          {filtersActive
            ? "No activities match your filters."
            : "Add your first activity to get started."}
        </EmptyPlaceholder.Description>
        {filtersActive ? (
          onClearFilters ? (
            <Button variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null
        ) : onAdd ? (
          <Button onClick={onAdd}>
            <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add Activity
          </Button>
        ) : null}
      </EmptyPlaceholder>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto">
      {activities.map((activity) => {
        const symbol = activity.assetSymbol;
        const activityType = activity.activityType;
        const isTransferActivity =
          activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
        const isAssetBackedIncome = isAssetBackedIncomeActivity(
          activityType,
          symbol,
          activity.assetId,
        );
        const isCash = isTransferActivity
          ? isCashTransfer(activityType, symbol, activity.assetId)
          : isCashActivity(activityType) && !isAssetBackedIncome;
        const hasAsset = Boolean(activity.assetId?.trim());
        const isOptionActivity = activity.instrumentType === "OPTION";
        const parsedOption = isOptionActivity ? parseOccSymbol(symbol) : null;
        const displaySymbol = isCash ? "Cash" : parsedOption ? parsedOption.underlying : symbol;
        const avatarSymbol = isCash ? "$CASH" : symbol;
        const optionSubtitle = parsedOption
          ? `${new Date(parsedOption.expiration + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} $${parsedOption.strikePrice} ${parsedOption.optionType}`
          : null;
        const formattedDate = formatDateTime(activity.date, appTimezone);
        const displayValue = calculateActivityValue(activity);

        // Compact View
        if (isCompactView) {
          const activityTypeLabel = ActivityTypeNames[activity.activityType];
          return (
            <Card key={activity.id} className="p-3">
              <div className="flex items-center gap-3">
                {(() => {
                  const inner = (
                    <>
                      <TickerAvatar symbol={avatarSymbol} className="h-10 w-10 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate font-semibold">{displaySymbol}</p>
                          {activity.activityType !== "SPLIT" && (
                            <span className="shrink-0 text-sm font-semibold">
                              {formatAmount(displayValue, activity.currency)}
                            </span>
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
                                  {activity.quantity} {isOptionActivity ? "contracts" : "shares"}
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
                      <TickerAvatar symbol={avatarSymbol} className="h-10 w-10" />
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
                />
              </div>

              <Separator />

              {/* Activity Details Grid */}
              <div className="space-y-1.5 text-sm">
                {/* Date and Type */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Date</span>
                  <div className="text-right">
                    <p>{formattedDate.date}</p>
                    <p className="text-muted-foreground text-xs">{formattedDate.time}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Type</span>
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
                        {isOptionActivity ? "Contracts" : "Shares"}
                      </span>
                      <span className="font-medium">{activity.quantity}</span>
                    </div>
                  )}

                {/* Price/Amount */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {activity.activityType === "SPLIT"
                      ? "Ratio"
                      : (isCashActivity(activity.activityType) &&
                            !isAssetBackedIncome &&
                            !isSecuritiesTransfer(
                              activity.activityType,
                              symbol,
                              activity.assetId,
                            )) ||
                          isCashTransfer(activity.activityType, symbol, activity.assetId) ||
                          (isIncomeActivity(activity.activityType) && !isAssetBackedIncome)
                        ? "Amount"
                        : isOptionActivity
                          ? "Premium"
                          : "Price"}
                  </span>
                  <span className="font-medium">
                    {activity.activityType === "FEE"
                      ? "-"
                      : activity.activityType === "SPLIT"
                        ? formatSplitRatio(Number(activity.amount))
                        : (isCashActivity(activity.activityType) &&
                              !isAssetBackedIncome &&
                              !isSecuritiesTransfer(
                                activity.activityType,
                                symbol,
                                activity.assetId,
                              )) ||
                            isCashTransfer(activity.activityType, symbol, activity.assetId) ||
                            (isIncomeActivity(activity.activityType) && !isAssetBackedIncome)
                          ? formatAmount(Number(activity.amount), activity.currency)
                          : formatAmount(Number(activity.unitPrice), activity.currency)}
                  </span>
                </div>

                {/* Fee (if applicable) */}
                {Number(activity.fee) > 0 && activity.activityType !== "SPLIT" && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Fee</span>
                    <span className="font-medium">
                      {formatAmount(Number(activity.fee), activity.currency)}
                    </span>
                  </div>
                )}

                {/* Total Value */}
                {activity.activityType !== "SPLIT" && (
                  <div className="flex items-center justify-between border-t pt-1.5">
                    <span className="text-muted-foreground font-medium">Total Value</span>
                    <span className="font-semibold">
                      {formatAmount(displayValue, activity.currency)}
                    </span>
                  </div>
                )}

                {/* Account */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Account</span>
                  <div className="text-right">
                    <p>{activity.accountName}</p>
                    <p className="text-muted-foreground text-xs">{activity.accountCurrency}</p>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
};

export default ActivityTableMobile;
