// E2EESetupCard
// Shows setup card for device sync (FRESH or REGISTERED+bootstrap state)
// One button: "Enable Device Sync" - handles enrollment + key init automatically
// ===============================================================================

import { Icons } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { useTranslation } from "react-i18next";
import { useSyncActions, useSyncStatus } from "../hooks";
import { SyncStates } from "../types";
import { logSyncError, userFacingSyncErrorMessage } from "../utils/error-messages";

interface E2EESetupCardProps {
  onPairingNeeded?: () => void;
}

export function E2EESetupCard({ onPairingNeeded }: E2EESetupCardProps) {
  const { t } = useTranslation();
  const { syncState, trustedDevices } = useSyncStatus();
  const { enableSync } = useSyncActions();
  const hasTrustedDevices = trustedDevices.length > 0;
  const trustedDevicePreview = trustedDevices.slice(0, 3);

  const handleEnable = async () => {
    try {
      const result = await enableSync.mutateAsync();
      if (result.needsPairing) {
        onPairingNeeded?.();
      }
    } catch (err) {
      logSyncError("Enable sync failed", err);
    }
  };

  // If in READY state, don't show this card
  if (syncState === SyncStates.READY) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{t("sync:section.deviceSync")}</CardTitle>
        <CardDescription>{t("sync:setup.cardDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="bg-muted/50 mb-4 rounded-full p-3">
            <Icons.CloudSync className="h-6 w-6 opacity-60" />
          </div>
          <p className="text-foreground font-medium">
            {hasTrustedDevices ? t("sync:setup.connectToSync") : t("sync:setup.keepInSync")}
          </p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            {hasTrustedDevices ? t("sync:setup.foundOtherDevices") : t("sync:setup.encryptedInfo")}
          </p>

          {hasTrustedDevices && (
            <div className="bg-muted/40 mt-3 w-full max-w-xs rounded-lg border px-3 py-2 text-left">
              <p className="text-xs font-medium">{t("sync:section.otherConnectedDevices")}</p>
              <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                {trustedDevicePreview.map((device) => (
                  <li key={device.id} className="truncate">
                    {device.name}
                  </li>
                ))}
                {trustedDevices.length > trustedDevicePreview.length && (
                  <li>
                    {t("sync:setup.morePreview", {
                      count: trustedDevices.length - trustedDevicePreview.length,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}

          {enableSync.error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{userFacingSyncErrorMessage(enableSync.error)}</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleEnable}
            disabled={enableSync.isPending}
            className="mt-4 min-w-[200px]"
          >
            {enableSync.isPending ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("sync:setup.settingUp")}
              </>
            ) : (
              <>
                <Icons.Shield className="mr-2 h-4 w-4" />
                {hasTrustedDevices
                  ? t("sync:setup.connectThisDevice")
                  : t("sync:setup.enableDeviceSync")}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
