import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { MfaCodeStep } from "./mfa-code-step";

/** Shown when the cloud API asks this device's session for the authenticator code. */
export function MfaSyncPausedAlert() {
  const { isConnected, isMfaRequired } = useWealthfolioConnect();
  // Unmounting on success resets the dialog for the next time.
  return isConnected && isMfaRequired ? <SyncPausedAlert /> : null;
}

function SyncPausedAlert() {
  const { t } = useTranslation();
  const [isCodeStepOpen, setIsCodeStepOpen] = useState(false);

  return (
    <>
      <Alert role="status" className="bg-muted/30">
        <Icons.PauseCircle className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>{t("connect:mfaSyncPaused.title")}</AlertTitle>
        <AlertDescription>{t("connect:mfaSyncPaused.description")}</AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={() => setIsCodeStepOpen(true)}>
            {t("connect:mfaSyncPaused.enterCode")}
          </Button>
        </AlertAction>
      </Alert>
      <Dialog open={isCodeStepOpen} onOpenChange={setIsCodeStepOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("connect:mfaSyncPaused.title")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("connect:mfaSyncPaused.description")}
            </DialogDescription>
          </DialogHeader>
          <MfaCodeStep />
        </DialogContent>
      </Dialog>
    </>
  );
}
