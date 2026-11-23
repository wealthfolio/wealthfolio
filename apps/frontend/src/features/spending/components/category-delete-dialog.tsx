import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useNumberFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";

import { useDeleteCategory } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { TaxonomyCategory } from "@/lib/types";
import { mergeCategory, reviewCategoryMerge } from "../adapters/category-merge";
import { invalidateSpendingCaches } from "../lib/invalidation";

interface CategoryDeleteDialogProps {
  category: TaxonomyCategory;
  onClose: () => void;
}

export function CategoryDeleteDialog({ category, onClose }: CategoryDeleteDialogProps) {
  const { t } = useTranslation();
  const formatting = useNumberFormatting();
  const dates = useDateFormatting();
  const qc = useQueryClient();
  const [destinationId, setDestinationId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const request = { taxonomyId: category.taxonomyId, categoryId: category.id, destinationId };
  const baseRequest = { taxonomyId: category.taxonomyId, categoryId: category.id };
  const baseReview = useQuery({
    queryKey: ["category-merge-review", baseRequest],
    queryFn: () => reviewCategoryMerge(baseRequest),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = useQuery({
    queryKey: ["category-merge-preview", request],
    queryFn: () => reviewCategoryMerge(request),
    enabled: !!destinationId,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const review = destinationId ? preview : baseReview;
  const remove = useDeleteCategory();
  const merge = useMutation({
    mutationFn: mergeCategory,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QueryKeys.taxonomy(category.taxonomyId) });
      invalidateSpendingCaches(qc);
      for (const key of [
        QueryKeys.SPENDING_SETTINGS,
        QueryKeys.SPENDING_RULES,
        QueryKeys.ACTIVITIES,
        QueryKeys.ACTIVITY_DATA,
      ]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  const pending = remove.isPending || merge.isPending;
  const displayedReview =
    (review.isError || failed ? baseReview.data : review.data) ?? baseReview.data;
  const refs = displayedReview?.references;
  const used =
    refs &&
    Object.entries(refs).some(([key, count]) => key !== "automaticBudgetLinks" && count > 0);
  const destinations = displayedReview?.destinations ?? [];
  const selectedDestination = destinations.find((d) => d.category.id === destinationId);
  const canMerge = !!selectedDestination && !selectedDestination.blocked;
  const label = (c: TaxonomyCategory) => getCategoryLabel(t, c.taxonomyId, c.id, c.name);
  const blockedReasons = [...new Set(destinations.map((d) => d.blocked).filter((r) => r !== null))];
  const eligibleDestinations = destinations.filter((d) => !d.blocked);
  const ready = !review.isFetching && !review.isError && !!review.data && !failed;
  const budgetChanges =
    ready && destinationId
      ? [...(review.data?.budgetChanges ?? [])].sort((a, b) => {
          if (a.periodKey === b.periodKey) return 0;
          if (a.periodKey === "default") return -1;
          if (b.periodKey === "default") return 1;
          return a.periodKey.localeCompare(b.periodKey);
        })
      : [];

  const confirm = async () => {
    if (!ready || pending) return;
    try {
      if (used) {
        if (!canMerge || !destinationId) return;
        await merge.mutateAsync({ ...request, destinationId, revision: review.data!.revision });
      } else {
        await remove.mutateAsync({ taxonomyId: category.taxonomyId, categoryId: category.id });
      }
      toast.success(t("settings:spending.categories.deleted", { name: label(category) }));
      onClose();
    } catch {
      setFailed(true);
      toast.error(
        t(
          used
            ? "settings:spending.categories.merge.error"
            : "settings:spending.categories.delete_error",
        ),
      );
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("spending:category.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {used
              ? t("settings:spending.categories.merge.description", { name: label(category) })
              : t("spending:category.deleteConfirm", { name: label(category) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review.isLoading && <p role="status">{t("common:loading")}</p>}
        {refs && used && (
          <div className="space-y-3 text-sm">
            <Label htmlFor="merge-destination">
              {t("settings:spending.categories.merge.destination")}
            </Label>
            <Select
              value={destinationId ?? ""}
              disabled={pending || review.isFetching}
              onValueChange={(value) => {
                setDestinationId(value ?? undefined);
                setFailed(false);
              }}
            >
              <SelectTrigger id="merge-destination" className="w-full">
                <SelectValue placeholder={t("settings:spending.categories.merge.choose")}>
                  {destinations.find((d) => d.category.id === destinationId) &&
                    label(destinations.find((d) => d.category.id === destinationId)!.category)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligibleDestinations.map(({ category: destination }) => (
                  <SelectItem key={destination.id} value={destination.id}>
                    {destination.parentId &&
                      `${label(destinations.find((d) => d.category.id === destination.parentId)?.category ?? destination)} / `}
                    {label(destination)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {budgetChanges.length > 0 && selectedDestination && (
              <div className="bg-muted/30 overflow-hidden rounded-lg border">
                <p className="px-3 pt-3 font-medium">
                  {t("settings:spending.categories.merge.budgets", {
                    name: label(selectedDestination.category),
                  })}
                </p>
                <div className="max-h-52 overflow-auto px-3 py-2">
                  <table
                    className="w-full text-xs"
                    aria-label={t("settings:spending.categories.merge.budgets", {
                      name: label(selectedDestination.category),
                    })}
                  >
                    <thead className="text-muted-foreground">
                      <tr>
                        <th scope="col" className="pe-2 pb-2 text-start font-normal">
                          {t("settings:spending.categories.merge.period")}
                        </th>
                        <th scope="col" className="px-1 pb-2 text-end font-normal">
                          {t("settings:spending.categories.merge.current")}
                        </th>
                        <th scope="col" className="px-1 pb-2 text-end font-normal">
                          {t("settings:spending.categories.merge.added")}
                        </th>
                        <th scope="col" className="ps-1 pb-2 text-end font-normal">
                          {t("settings:spending.categories.merge.after")}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {budgetChanges.map((change) => (
                        <tr key={change.periodKey} className="border-t">
                          <th scope="row" className="py-2 pe-2 text-start font-normal">
                            {change.periodKey === "default"
                              ? t("settings:spending.categories.merge.monthlyDefault")
                              : dates.formatCalendarDate(`${change.periodKey}-01`, {
                                  month: "short",
                                  year: "numeric",
                                })}
                          </th>
                          <td className="text-muted-foreground px-1 py-2 text-end whitespace-nowrap">
                            {formatting.formatDecimal(change.currentAmount)}
                          </td>
                          <td className="text-muted-foreground px-1 py-2 text-end whitespace-nowrap">
                            {formatting.formatDecimal(change.movedAmount, {
                              signDisplay: "always",
                            })}
                          </td>
                          <td className="py-2 ps-1 text-end font-semibold whitespace-nowrap">
                            {formatting.formatDecimal(change.newAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {budgetChanges.some((change) => change.periodKey === "default") && (
                  <p className="text-muted-foreground border-t px-3 py-2 text-xs">
                    {t("settings:spending.categories.merge.budgetHint")}
                  </p>
                )}
              </div>
            )}
            {!eligibleDestinations.length && (
              <div className="text-muted-foreground space-y-2">
                <p>{t("settings:spending.categories.merge.none")}</p>
                {blockedReasons.map((reason) => (
                  <p key={reason}>{t(`settings:spending.categories.merge.blocked.${reason}`)}</p>
                ))}
              </div>
            )}
          </div>
        )}
        {(failed || review.isError) && (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-destructive">{t("settings:spending.categories.merge.error")}</p>
            <Button
              variant="outline"
              disabled={pending || review.isFetching}
              onClick={async () => {
                if (destinationId) await baseReview.refetch();
                const refreshed = await review.refetch();
                if (!refreshed.isError) setFailed(false);
              }}
            >
              {t("settings:spending.categories.merge.refresh")}
            </Button>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          {used
            ? t("settings:spending.categories.merge.history")
            : t("spending:category.deleteUndoNote")}
        </p>
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !ready || (!!used && !canMerge)}
            onClick={confirm}
          >
            {used ? t("settings:spending.categories.merge.confirm") : t("common:delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
