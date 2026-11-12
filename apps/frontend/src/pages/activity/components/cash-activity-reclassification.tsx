import { updateActivity } from "@/adapters";
import {
  isActivityEditCancelled,
  useActivitySplitReview,
} from "@/features/spending/components/activity-split-review-provider";
import { isCashSymbol } from "@/lib/activity-utils";
import type { ActivityUpdate } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface CashReclassificationActivity {
  id?: string;
  accountId?: string;
  activityType?: string;
  activityTypeOverride?: string;
  assetId?: string;
  assetSymbol?: string | null;
  sourceGroupId?: string;
  counterpartActivityId?: string;
  currency?: string;
  date?: Date;
  activityDate?: string;
  comment?: string;
  notes?: string;
}

interface CashActivityReclassificationProps {
  activity?: CashReclassificationActivity;
  onSuccess?: () => void;
  disabled?: boolean;
}

const RECLASSIFICATION_TYPES: Record<string, string> = {
  WITHDRAWAL: "TRANSFER_OUT",
  TRANSFER_OUT: "WITHDRAWAL",
  DEPOSIT: "TRANSFER_IN",
  TRANSFER_IN: "DEPOSIT",
};

/** Reclassifies a saved row separately from unsaved edits, without rounding its values. */
export function CashActivityReclassification(props: CashActivityReclassificationProps) {
  const { activity } = props;
  const type = activity?.activityTypeOverride?.trim() || activity?.activityType || "";
  const target = RECLASSIFICATION_TYPES[type];
  const asset = activity?.assetId || activity?.assetSymbol;
  if (
    !target ||
    !activity?.id ||
    !activity.accountId ||
    !(activity.date || activity.activityDate) ||
    (asset && !isCashSymbol(asset))
  ) {
    return null;
  }
  return <ReclassificationAction {...props} activity={activity} target={target} />;
}

function ReclassificationAction({
  activity,
  target,
  onSuccess,
  disabled,
}: CashActivityReclassificationProps & {
  activity: CashReclassificationActivity;
  target: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const reviewEdits = useActivitySplitReview();
  const mutation = useMutation({
    mutationFn: async () => {
      const update: ActivityUpdate = {
        id: activity.id!,
        accountId: activity.accountId!,
        activityType: target,
        activityDate: activity.activityDate ?? activity.date!,
        currency: activity.currency,
        comment: activity.comment ?? activity.notes ?? null,
        ...(target.startsWith("TRANSFER") && { metadata: { flow: { is_external: true } } }),
      };
      const [reviewed] = await reviewEdits([update]);
      return updateActivity(reviewed);
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      setOpen(false);
      onSuccess?.();
    },
  });
  const error = mutation.error && !isActivityEditCancelled(mutation.error);
  const label = t("activity:cash_reclassification.action", {
    type: t(`activity:type_${target.toLowerCase()}`),
  });

  return (
    <div className="space-y-2">
      {activity.sourceGroupId &&
      activity.counterpartActivityId &&
      !target.startsWith("TRANSFER") ? (
        <p className="text-muted-foreground text-sm">
          {t("activity:cash_reclassification.linked")}
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            mutation.reset();
            setOpen(true);
          }}
        >
          {label}
        </Button>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{label}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("activity:cash_reclassification.description")}{" "}
              {target.startsWith("TRANSFER") && t("activity:cash_reclassification.external")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{String(mutation.error)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {t("common:save")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
