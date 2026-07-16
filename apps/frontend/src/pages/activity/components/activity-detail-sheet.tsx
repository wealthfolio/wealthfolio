import { localizeActivitySubtypeName, localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { ActivityDetails } from "@/lib/types";
import {
  Badge,
  Button,
  Icons,
  PriceDisplay,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";
import { AmountDisplay } from "@wealthfolio/ui/components/financial/amount-display";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";

interface ActivityDetailSheetProps {
  activity: ActivityDetails | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Status display configuration
const STATUS_CONFIG: Record<
  string,
  { labelKey: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  [ActivityStatus.POSTED]: { labelKey: "activity:detail.status_posted", variant: "default" },
  [ActivityStatus.PENDING]: { labelKey: "activity:detail.status_pending", variant: "secondary" },
  [ActivityStatus.DRAFT]: { labelKey: "activity:detail.status_draft", variant: "outline" },
  [ActivityStatus.VOID]: { labelKey: "activity:detail.status_void", variant: "destructive" },
};

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
}

function DetailRow({ label, value, icon }: DetailRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-right text-sm font-medium">{value}</div>
    </div>
  );
}

interface DetailSectionProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function DetailSection({ title, icon, children }: DetailSectionProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pb-2">
        {icon}
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="bg-muted/30 rounded-lg border p-3">{children}</div>
    </div>
  );
}

export function ActivityDetailSheet({ activity, open, onOpenChange }: ActivityDetailSheetProps) {
  const { t } = useTranslation();
  if (!activity) return null;

  const statusConfig = activity.status
    ? STATUS_CONFIG[activity.status] || { labelKey: "", variant: "default" as const }
    : null;
  const statusLabel = statusConfig
    ? statusConfig.labelKey
      ? t(statusConfig.labelKey)
      : (activity.status ?? "")
    : null;

  const subtypeDisplay = activity.subtype ? localizeActivitySubtypeName(t, activity.subtype) : null;

  const formatDate = (date: Date | string | undefined) => {
    if (!date) return "—";
    const d = typeof date === "string" ? new Date(date) : date;
    return format(d, "PPpp");
  };

  const formatShortDate = (date: Date | string | undefined) => {
    if (!date) return "—";
    const d = typeof date === "string" ? new Date(date) : date;
    return format(d, "PP");
  };

  // Parse OCC symbol for option activities
  const isOption = activity.instrumentType === "OPTION";
  const parsedOption = isOption ? parseOccSymbol(activity.assetSymbol ?? "") : null;

  // Format option expiration for display (YYYY-MM-DD → "Mar 29, 2025")
  const optionExpirationDisplay = parsedOption?.expiration
    ? format(new Date(parsedOption.expiration + "T12:00:00"), "PP")
    : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-3">
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
              <Icons.Receipt className="text-primary h-5 w-5" />
            </div>
            <div className="flex flex-col items-start">
              <span>{t("activity:activity_details")}</span>
              <span className="text-muted-foreground text-xs font-normal">
                {parsedOption
                  ? parsedOption.underlying
                  : activity.assetSymbol || t("activity:detail.cash_transaction")}
              </span>
            </div>
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-6 pb-6 md:pb-8">
          {/* Header Summary */}
          <div className="from-primary/5 to-primary/10 rounded-xl border bg-gradient-to-br p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                  {localizeActivityTypeName(t, activity.activityType)}
                </div>
                {parsedOption ? (
                  <>
                    <div className="text-xl font-bold">{parsedOption.underlying}</div>
                    <div className="text-muted-foreground text-sm">
                      {optionExpirationDisplay} ${parsedOption.strikePrice}{" "}
                      {parsedOption.optionType}
                    </div>
                  </>
                ) : (
                  <>
                    {activity.assetSymbol && (
                      <div className="text-xl font-bold">{activity.assetSymbol}</div>
                    )}
                    {activity.assetName && (
                      <div className="text-muted-foreground text-sm">{activity.assetName}</div>
                    )}
                  </>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                {statusConfig && <Badge variant={statusConfig.variant}>{statusLabel}</Badge>}
                {activity.needsReview && (
                  <Badge variant="outline" className="border-amber-500 text-amber-600">
                    <Icons.AlertCircle className="mr-1 h-3 w-3" />
                    {t("activity:detail.needs_review")}
                  </Badge>
                )}
              </div>
            </div>
            <Separator className="my-3" />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-muted-foreground text-xs">{t("activity:field_date")}</div>
                <div className="font-medium">{formatShortDate(activity.date)}</div>
              </div>
              <div className="text-right">
                <div className="text-muted-foreground text-xs">{t("activity:field_amount")}</div>
                <div className="text-lg font-bold">
                  <AmountDisplay value={Number(activity.amount)} currency={activity.currency} />
                </div>
              </div>
            </div>
          </div>

          {/* Transaction Details */}
          <DetailSection
            title={t("activity:detail.transaction")}
            icon={<Icons.ArrowLeftRight className="h-4 w-4" />}
          >
            <DetailRow
              label={t("activity:table_type")}
              value={
                <Badge variant="outline">
                  {localizeActivityTypeName(t, activity.activityType)}
                </Badge>
              }
            />
            {subtypeDisplay && (
              <DetailRow label={t("activity:detail.subtype")} value={subtypeDisplay} />
            )}
            <DetailRow label={t("activity:mobile_date_time")} value={formatDate(activity.date)} />
            <DetailRow label={t("activity:field_account")} value={activity.accountName} />
          </DetailSection>

          {/* Option Contract Details */}
          {parsedOption && (
            <DetailSection
              title={t("activity:detail.option_contract")}
              icon={<Icons.BarChart className="h-4 w-4" />}
            >
              <DetailRow label={t("activity:detail.underlying")} value={parsedOption.underlying} />
              <DetailRow
                label={t("activity:table_type")}
                value={<Badge variant="outline">{parsedOption.optionType}</Badge>}
              />
              <DetailRow
                label={t("activity:detail.strike_price")}
                value={
                  <PriceDisplay value={parsedOption.strikePrice} currency={activity.currency} />
                }
              />
              <DetailRow label={t("activity:detail.expiration")} value={optionExpirationDisplay} />
              <DetailRow label={t("activity:detail.occ_symbol")} value={activity.assetSymbol} />
            </DetailSection>
          )}

          {/* Financial Details */}
          <DetailSection
            title={t("activity:detail.financial_details")}
            icon={<Icons.DollarSign className="h-4 w-4" />}
          >
            {Number(activity.quantity) !== 0 && (
              <DetailRow
                label={isOption ? t("activity:detail.contracts") : t("activity:activity_quantity")}
                value={Number(activity.quantity).toLocaleString(undefined, {
                  maximumFractionDigits: 8,
                })}
              />
            )}
            {Number(activity.unitPrice) !== 0 && (
              <DetailRow
                label={
                  isOption ? t("activity:detail.premium_share") : t("activity:activity_unit_price")
                }
                value={
                  <PriceDisplay value={Number(activity.unitPrice)} currency={activity.currency} />
                }
              />
            )}
            <DetailRow
              label={isOption ? t("activity:detail.total_premium") : t("activity:field_amount")}
              value={<AmountDisplay value={Number(activity.amount)} currency={activity.currency} />}
            />
            {Number(activity.fee) !== 0 && (
              <DetailRow
                label={t("activity:field_fee")}
                value={<AmountDisplay value={Number(activity.fee)} currency={activity.currency} />}
              />
            )}
            {Number(activity.tax ?? 0) !== 0 && (
              <DetailRow
                label={
                  activity.activityType === ActivityType.DIVIDEND
                    ? t("activity:detail.withholding_tax")
                    : t("activity:type_tax")
                }
                value={
                  <AmountDisplay value={Number(activity.tax ?? 0)} currency={activity.currency} />
                }
              />
            )}
            {activity.fxRate && (
              <DetailRow
                label={t("activity:detail.fx_rate")}
                value={Number(activity.fxRate).toLocaleString(undefined, {
                  maximumFractionDigits: 8,
                })}
              />
            )}
            <DetailRow label={t("activity:table_currency")} value={activity.currency} />
            {activity.accountCurrency !== activity.currency && (
              <DetailRow
                label={t("activity:detail.account_currency")}
                value={activity.accountCurrency}
              />
            )}
          </DetailSection>

          {/* Comment */}
          {activity.comment && (
            <DetailSection
              title={t("activity:detail.notes")}
              icon={<Icons.FileText className="h-4 w-4" />}
            >
              <p className="whitespace-pre-wrap text-sm">{activity.comment}</p>
            </DetailSection>
          )}

          {/* Metadata */}
          <DetailSection
            title={t("activity:detail.record_info")}
            icon={<Icons.Info className="h-4 w-4" />}
          >
            <DetailRow
              label={t("activity:detail.created")}
              value={formatDate(activity.createdAt)}
            />
            <DetailRow
              label={t("activity:detail.updated")}
              value={formatDate(activity.updatedAt)}
            />
          </DetailSection>
        </div>

        {/* Mobile close button */}
        <div className="bg-background border-t p-4 md:hidden">
          <Button className="w-full" onClick={() => onOpenChange(false)}>
            {t("common:close")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
