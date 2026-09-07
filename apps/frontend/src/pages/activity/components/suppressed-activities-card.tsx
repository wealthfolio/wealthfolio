import { getSuppressedActivities, logger, restoreSuppressedActivities } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { SuppressedActivity } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
  ScrollArea,
  useAmountFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * A deleted broker activity would otherwise come back on the next sync, so the
 * deletion is remembered and the record is suppressed. That has to be visible,
 * and reversible, or it is just a row that vanished for unexplained reasons.
 */
export function SuppressedActivitiesCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const { formatDate } = useDateFormatting();
  const { formatAmount } = useAmountFormatting();

  const { data: suppressed = [] } = useQuery({
    queryKey: [QueryKeys.SUPPRESSED_ACTIVITIES],
    queryFn: () => getSuppressedActivities(),
  });

  const restoreMutation = useMutation({
    mutationFn: (deletionIds: string[]) => restoreSuppressedActivities(deletionIds),
    onSuccess: (restored) => {
      queryClient.invalidateQueries();
      toast.success(t("activity:suppressed.restored", { count: restored.length }));
    },
    onError: (error: unknown) => {
      logger.error(`Error restoring suppressed activities: ${String(error)}`);
      toast.error(t("activity:suppressed.restore_failed"), { description: String(error) });
    },
  });

  if (suppressed.length === 0) {
    return null;
  }

  const describe = (entry: SuppressedActivity) => {
    const { activity } = entry;
    return [
      formatDate(activity.activityDate),
      activity.activityType,
      activity.amount != null ? formatAmount(activity.amount, activity.currency) : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const restoreAll = () => restoreMutation.mutate(suppressed.map((entry) => entry.id));

  return (
    <>
      <Alert variant="default">
        <Icons.Info className="h-4 w-4" />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{t("activity:suppressed.summary", { count: suppressed.length })}</span>
          <Button variant="outline" size="sm" onClick={() => setIsOpen(true)}>
            {t("activity:suppressed.review")}
          </Button>
        </AlertDescription>
      </Alert>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("activity:suppressed.title")}</DialogTitle>
            <DialogDescription>{t("activity:suppressed.description")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80 pr-2">
            <ul className="space-y-2">
              {suppressed.map((entry) => (
                <li
                  key={entry.id}
                  className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{describe(entry)}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {t("activity:suppressed.deleted_on", {
                        date: formatDate(entry.deletedAt),
                      })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={restoreMutation.isPending}
                    onClick={() => restoreMutation.mutate([entry.id])}
                  >
                    {t("activity:suppressed.restore")}
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              {t("common:close")}
            </Button>
            <Button disabled={restoreMutation.isPending} onClick={restoreAll}>
              {restoreMutation.isPending ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t("activity:suppressed.restore_all")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
