import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { resetProviderHistory, resetAllProviderHistory } from "@/adapters";
import type {
  ResetAllProviderHistoryResult,
  ResetProviderHistoryError,
} from "@/adapters/shared/market-data";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { useToast } from "@wealthfolio/ui/components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";

interface ResetProviderHistoryDialogProps {
  allAssets?: boolean;
  assetId?: string;
  assetName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ResetProviderHistoryDialog({
  allAssets = false,
  assetId,
  assetName,
  open,
  onOpenChange,
}: ResetProviderHistoryDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const submitting = useRef(false);
  const reset = useMutation<ResetAllProviderHistoryResult, ResetProviderHistoryError>({
    mutationFn: async () => {
      if (allAssets) return resetAllProviderHistory();
      if (!assetId) throw new Error("No asset selected for reset.");
      const result = await resetProviderHistory(assetId);
      return {
        results: [result],
        failures: [],
        skipped: [],
      };
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.QUOTE_HISTORY] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.LATEST_QUOTES] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_DATA] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HEALTH_STATUS] });
      invalidatePerformanceCaches(queryClient);
      if (allAssets) return;
      toast({
        title: t("asset:resetDialog.success"),
        description: t("asset:resetDialog.complete"),
      });
      onOpenChange(false);
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const errorMessage =
    reset.error instanceof Error ? reset.error.message : String(reset.error ?? "");
  const uncertain = reset.error?.outcomeUnknown === true;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (submitting.current) return;
        reset.reset();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("asset:resetDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              allAssets ? "asset:resetDialog.globalDescription" : "asset:resetDialog.description",
              {
                name: assetName,
              },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {reset.data && allAssets && (
          <div role="status" className="space-y-2 text-sm">
            <p>
              {t("asset:resetDialog.globalResult", {
                succeeded: reset.data.results.length,
                failed: reset.data.failures.length,
                skipped: reset.data.skipped.length,
              })}
            </p>
            {reset.data.results.length > 0 && <p>{t("asset:resetDialog.complete")}</p>}
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {reset.data.failures.map(({ assetId, error }) => (
                <li key={assetId}>
                  {assetId}: {error}
                </li>
              ))}
              {reset.data.skipped.map(({ assetId, reason }) => (
                <li key={assetId}>
                  {assetId}: {reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {reset.isError && (
          <div role="alert" className="text-destructive space-y-2 text-sm">
            <p>{errorMessage}</p>
            {uncertain && <p>{t("asset:resetDialog.uncertain")}</p>}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reset.isPending}>
            {t(allAssets && reset.isSuccess ? "common:close" : "common:cancel")}
          </AlertDialogCancel>
          {!(allAssets && reset.isSuccess) && (
            <AlertDialogAction
              disabled={reset.isPending || (reset.isError && uncertain)}
              onClick={(event) => {
                event.preventBaseUIHandler();
                if (submitting.current) return;
                submitting.current = true;
                reset.mutate();
              }}
            >
              {t(reset.isPending ? "asset:resetDialog.resetting" : "asset:resetDialog.confirm")}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
