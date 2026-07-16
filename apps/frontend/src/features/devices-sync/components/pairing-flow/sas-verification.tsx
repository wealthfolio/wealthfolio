// SASVerification
// Shows the Short Authentication String for verification (issuer side only)
// ======================================================

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface SASVerificationProps {
  sas: string;
  onConfirm?: () => void;
  onReject?: () => void;
  isLoading?: boolean;
}

export function SASVerification({ sas, onConfirm, onReject, isLoading }: SASVerificationProps) {
  const { t } = useTranslation();
  const formattedSAS = sas.length > 3 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;

  return (
    <div className="flex flex-col items-center gap-5 py-10">
      <div className="bg-muted rounded-xl px-8 py-5">
        <span className="font-mono text-4xl font-bold tracking-widest">{formattedSAS}</span>
      </div>

      <p className="text-muted-foreground text-sm">{t("sync:sas.sameCodeQuestion")}</p>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onReject} disabled={isLoading}>
          {t("common:no")}
        </Button>
        <Button onClick={onConfirm} disabled={isLoading}>
          {isLoading ? <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t("common:yes")}
        </Button>
      </div>
    </div>
  );
}
