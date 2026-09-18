import { getDatabaseEncryptionStatus, isWeb, setDatabaseEncryptionEnabled } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function DatabaseEncryptionSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const { data: status } = useQuery({
    queryKey: [QueryKeys.DATABASE_ENCRYPTION],
    queryFn: getDatabaseEncryptionStatus,
  });

  const changeEncryption = useMutation({
    mutationFn: setDatabaseEncryptionEnabled,
    onSuccess: () => {
      // Desktop restarts before this resolves; mobile continues over the rebuilt
      // runtime, so refetch everything that came from the old database.
      queryClient.invalidateQueries();
    },
    onError: (error) => {
      toast({
        title: t("settings:database_encryption_error_title"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  if (!status) {
    return null;
  }

  const isBusy = changeEncryption.isPending;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("settings:database_encryption_title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="database-encryption" className="text-base">
                {t("settings:database_encryption_enable")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {isWeb
                  ? t("settings:database_encryption_server_managed")
                  : t("settings:database_encryption_description")}
              </p>
            </div>
            <Switch
              id="database-encryption"
              checked={status.enabled}
              onCheckedChange={(next) => setPendingValue(next)}
              disabled={!status.supported || isBusy}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {isWeb
              ? t("settings:database_encryption_server_backup_warning")
              : t("settings:backup_portable_help")}
          </p>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingValue !== null}
        onOpenChange={(open) => {
          if (!open) setPendingValue(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingValue
                ? t("settings:database_encryption_enable_confirm_title")
                : t("settings:database_encryption_disable_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingValue
                ? t("settings:database_encryption_enable_confirm_description")
                : t("settings:database_encryption_disable_confirm_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBusy}
              onClick={() => {
                const next = pendingValue;
                setPendingValue(null);
                if (next !== null) changeEncryption.mutate(next);
              }}
            >
              {t("settings:database_encryption_confirm_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
