import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { Button, formatAmount, Icons } from "@wealthfolio/ui";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface LinkTransferModalProps {
  isOpen: boolean;
  mode: "link" | "unlink";
  isProcessing: boolean;
  activityIn?: ActivityDetails;
  activityOut?: ActivityDetails;
  warnings: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

function ActivityRow({ activity, label }: { activity: ActivityDetails; label: string }) {
  const { t } = useTranslation();
  const date = formatDateTime(activity.date).date;
  const value = activity.amount ?? activity.unitPrice;
  return (
    <div className="bg-muted/30 flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
      <div className="text-muted-foreground flex items-center justify-between text-xs uppercase">
        <span>{label}</span>
        <span>
          {activity.activityType === ActivityType.TRANSFER_IN
            ? t("activity:type_transfer_in")
            : t("activity:type_transfer_out")}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="font-medium">{activity.accountName}</span>
        <span>{date}</span>
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>{activity.assetSymbol || t("activity:date_list.cash")}</span>
        <span>
          {value != null ? formatAmount(Number(value), activity.currency) : activity.currency}
        </span>
      </div>
    </div>
  );
}

export function LinkTransferModal({
  isOpen,
  mode,
  isProcessing,
  activityIn,
  activityOut,
  warnings,
  onConfirm,
  onCancel,
}: LinkTransferModalProps) {
  const { t } = useTranslation();
  const isUnlinkMode = mode === "unlink";

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isUnlinkMode
              ? t("activity:link_transfer.unlink_title")
              : t("activity:link_transfer.link_title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isUnlinkMode
              ? t("activity:link_transfer.unlink_desc")
              : t("activity:link_transfer.link_desc")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {activityIn && activityOut ? (
          <div className="flex flex-col gap-2">
            <ActivityRow activity={activityOut} label={t("activity:link_transfer.source")} />
            <div className="flex justify-center">
              <Icons.ArrowDown className="text-muted-foreground h-4 w-4" />
            </div>
            <ActivityRow activity={activityIn} label={t("activity:link_transfer.destination")} />
          </div>
        ) : null}

        {!isUnlinkMode && warnings.length > 0 ? (
          <div className="border-warning/40 bg-warning/10 text-warning flex gap-2 rounded-md border px-3 py-2 text-xs">
            <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <ul className="space-y-0.5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>{t("common:cancel")}</AlertDialogCancel>
          <Button onClick={onConfirm} disabled={isProcessing}>
            {isProcessing ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : isUnlinkMode ? (
              <Icons.Unlink className="mr-2 h-4 w-4" />
            ) : (
              <Icons.Link className="mr-2 h-4 w-4" />
            )}
            <span>
              {isUnlinkMode
                ? t("activity:link_transfer.unlink_button")
                : t("activity:link_transfer.link_button")}
            </span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
