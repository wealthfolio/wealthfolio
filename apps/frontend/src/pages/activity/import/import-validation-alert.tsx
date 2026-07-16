import React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

interface ValidationAlertProps {
  success: boolean;
  warnings: number;
  error: string | null;
  isConfirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ValidationAlert: React.FC<ValidationAlertProps> = ({
  success,
  warnings,
  error,
  isConfirming,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  if (warnings > 0) {
    return (
      <Alert className="mb-4 flex flex-col" variant="warning">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center">
            <Icons.AlertCircle className="mr-2 h-4 w-4" />
            <AlertTitle>
              {t("activity:import.validationAlert.issuesTitle", { count: warnings })}
              <p className="pt-1 text-sm font-normal">
                {t("activity:import.validationAlert.issuesDescription")}
              </p>
              <p className="pt-1 text-sm font-normal">
                {t("activity:import.validationAlert.issuesHint")}
              </p>
            </AlertTitle>
          </div>
        </div>
        <div className="mt-2 flex justify-start">
          <Button className="mr-2" onClick={onCancel}>
            {t("activity:import.validationAlert.retry")}
          </Button>
        </div>
      </Alert>
    );
  }
  if (success) {
    return (
      <Alert className="mb-4 flex flex-col" variant="success">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center">
            <Icons.CheckCircle className="mr-2 h-4 w-4" />
            <div>
              <AlertTitle>{t("activity:import.validationAlert.allValidTitle")}</AlertTitle>
              <AlertDescription>
                {t("activity:import.validationAlert.allValidDescriptionPrefix")}
                <b>{t("activity:import.validationAlert.confirmImport")}</b>
                {t("activity:import.validationAlert.allValidDescriptionSuffix")}
              </AlertDescription>
            </div>
          </div>
        </div>
        <div className="mt-2 flex justify-start">
          <Button variant="secondary" className="mr-2" disabled={isConfirming} onClick={onCancel}>
            {t("activity:import.validationAlert.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={isConfirming}>
            {isConfirming ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                <span className="hidden sm:ml-2 sm:inline">
                  {t("activity:import.validationAlert.importing")}
                </span>
              </>
            ) : (
              <>
                <Icons.Import className="mr-2 h-4 w-4" />
                <span className="hidden sm:ml-2 sm:inline">
                  {t("activity:import.validationAlert.confirmImport")}
                </span>
              </>
            )}
          </Button>
        </div>
      </Alert>
    );
  }
  if (error) {
    return (
      <Alert className="mb-4 flex flex-col" variant="destructive">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center">
            <Icons.AlertCircle className="mr-2 h-4 w-4" />
            <AlertTitle>{error}</AlertTitle>
          </div>
        </div>
        <div className="mt-2 flex justify-start">
          <Button className="mr-2" onClick={onCancel}>
            {t("activity:import.validationAlert.retry")}
          </Button>
        </div>
      </Alert>
    );
  }
  return null;
};

export default ValidationAlert;
