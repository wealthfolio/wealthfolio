import {
  ActivityStatus,
  ActivityType,
  ActivityTypeNames,
  SUBTYPE_DISPLAY_NAMES,
} from "@/lib/constants";
import { useI18n } from "@/i18n/i18n-provider";
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { ActivityDetails } from "@/lib/types";
import {
  Badge,
  Button,
  Icons,
  Separator,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";
import { AmountDisplay } from "@wealthfolio/ui/components/financial/amount-display";
import { format } from "date-fns";

interface ActivityDetailSheetProps {
  activity: ActivityDetails | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Status display configuration
const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  [ActivityStatus.POSTED]: { label: "Posted", variant: "default" },
  [ActivityStatus.PENDING]: { label: "Pending", variant: "secondary" },
  [ActivityStatus.DRAFT]: { label: "Draft", variant: "outline" },
  [ActivityStatus.VOID]: { label: "Void", variant: "destructive" },
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
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  if (!activity) return null;

  const statusConfig = activity.status
    ? STATUS_CONFIG[activity.status] || { label: activity.status, variant: "default" as const }
    : null;

  const subtypeDisplay = activity.subtype
    ? SUBTYPE_DISPLAY_NAMES[activity.subtype] || activity.subtype
    : null;

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
              <span>{isChinese ? "活动详情" : "Activity Details"}</span>
              <span className="text-muted-foreground text-xs font-normal">
                {parsedOption
                  ? parsedOption.underlying
                  : activity.assetSymbol || (isChinese ? "现金交易" : "Cash Transaction")}
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
                  {ActivityTypeNames[activity.activityType] || activity.activityType}
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
                {statusConfig && <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>}
                {activity.needsReview && (
                  <Badge variant="outline" className="border-amber-500 text-amber-600">
                    <Icons.AlertCircle className="mr-1 h-3 w-3" />
                    Needs Review
                  </Badge>
                )}
              </div>
            </div>
            <Separator className="my-3" />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-muted-foreground text-xs">Date</div>
                <div className="font-medium">{formatShortDate(activity.date)}</div>
              </div>
              <div className="text-right">
                <div className="text-muted-foreground text-xs">Amount</div>
                <div className="text-lg font-bold">
                  <AmountDisplay value={Number(activity.amount)} currency={activity.currency} />
                </div>
              </div>
            </div>
          </div>

          {/* Transaction Details */}
          <DetailSection title="Transaction" icon={<Icons.ArrowLeftRight className="h-4 w-4" />}>
            <DetailRow
              label="Type"
              value={
                <Badge variant="outline">
                  {ActivityTypeNames[activity.activityType] || activity.activityType}
                </Badge>
              }
            />
            {subtypeDisplay && <DetailRow label="Subtype" value={subtypeDisplay} />}
            <DetailRow label="Date & Time" value={formatDate(activity.date)} />
            <DetailRow label="Account" value={activity.accountName} />
          </DetailSection>

          {/* Option Contract Details */}
          {parsedOption && (
            <DetailSection title="Option Contract" icon={<Icons.BarChart className="h-4 w-4" />}>
              <DetailRow label="Underlying" value={parsedOption.underlying} />
              <DetailRow
                label="Type"
                value={<Badge variant="outline">{parsedOption.optionType}</Badge>}
              />
              <DetailRow
                label="Strike Price"
                value={
                  <AmountDisplay value={parsedOption.strikePrice} currency={activity.currency} />
                }
              />
              <DetailRow label="Expiration" value={optionExpirationDisplay} />
              <DetailRow label="OCC Symbol" value={activity.assetSymbol} />
            </DetailSection>
          )}

          {/* Financial Details */}
          <DetailSection title="Financial Details" icon={<Icons.DollarSign className="h-4 w-4" />}>
            {Number(activity.quantity) !== 0 && (
              <DetailRow
                label={isOption ? "Contracts" : "Quantity"}
                value={Number(activity.quantity).toLocaleString(undefined, {
                  maximumFractionDigits: 8,
                })}
              />
            )}
            {Number(activity.unitPrice) !== 0 && (
              <DetailRow
                label={isOption ? "Premium/Share" : "Unit Price"}
                value={
                  <AmountDisplay value={Number(activity.unitPrice)} currency={activity.currency} />
                }
              />
            )}
            <DetailRow
              label={isOption ? "Total Premium" : "Amount"}
              value={<AmountDisplay value={Number(activity.amount)} currency={activity.currency} />}
            />
            {Number(activity.fee) !== 0 && (
              <DetailRow
                label="Fee"
                value={<AmountDisplay value={Number(activity.fee)} currency={activity.currency} />}
              />
            )}
            {Number(activity.tax ?? 0) !== 0 && (
              <DetailRow
                label={activity.activityType === ActivityType.DIVIDEND ? "Withholding tax" : "Tax"}
                value={
                  <AmountDisplay value={Number(activity.tax ?? 0)} currency={activity.currency} />
                }
              />
            )}
            {activity.fxRate && (
              <DetailRow
                label="FX Rate"
                value={Number(activity.fxRate).toLocaleString(undefined, {
                  maximumFractionDigits: 8,
                })}
              />
            )}
            <DetailRow label="Currency" value={activity.currency} />
            {activity.accountCurrency !== activity.currency && (
              <DetailRow label="Account Currency" value={activity.accountCurrency} />
            )}
          </DetailSection>

          {/* Comment */}
          {activity.comment && (
            <DetailSection title="Notes" icon={<Icons.FileText className="h-4 w-4" />}>
              <p className="whitespace-pre-wrap text-sm">{activity.comment}</p>
            </DetailSection>
          )}

          {/* Metadata */}
          <DetailSection title="Record Info" icon={<Icons.Info className="h-4 w-4" />}>
            <DetailRow label="Created" value={formatDate(activity.createdAt)} />
            <DetailRow label="Updated" value={formatDate(activity.updatedAt)} />
          </DetailSection>
        </div>

        {/* Mobile close button */}
        <div className="bg-background border-t p-4 md:hidden">
          <Button className="w-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
