// SASVerification
// Both devices show the same Short Authentication String. The issuer
// confirms it; the claimer shows it and waits for that confirmation.
// ==================================================================

import { Icons, Skeleton } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { FlowScreen, PairingCodeText } from "../flow-layout";

const shield = <Icons.ShieldCheck className="size-8" aria-hidden />;

function SecurityCode({ sas }: { sas: string | null }) {
  return (
    <div className="bg-muted/50 flex h-20 items-center justify-center rounded-2xl">
      {sas ? (
        <motion.div
          initial={{ opacity: 0, letterSpacing: "0.4em" }}
          animate={{ opacity: 1, letterSpacing: "0em" }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          data-testid="security-code"
        >
          <PairingCodeText code={sas} className="text-3xl" />
        </motion.div>
      ) : (
        <Skeleton className="h-8 w-48 rounded-md" />
      )}
    </div>
  );
}

interface SASVerificationProps {
  /** `null` while the code is being computed. */
  sas: string | null;
  onConfirm: () => void;
  onReject: () => void;
  isLoading?: boolean;
}

/** Issuer: compare the code with the new device before any key is shared. */
export function SASVerification({ sas, onConfirm, onReject, isLoading }: SASVerificationProps) {
  const { t } = useTranslation();
  const disabled = !sas || isLoading;
  return (
    <FlowScreen
      icon={shield}
      title={t("sync:pairing.verifySecurityCode")}
      description={t("sync:sas.description")}
      actions={
        <>
          <Button className="w-full gap-2" onClick={onConfirm} disabled={disabled}>
            {isLoading && <Icons.Spinner className="size-4 animate-spin" aria-hidden />}
            {t("sync:sas.codesMatch")}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onReject} disabled={disabled}>
            {t("sync:sas.codesDontMatch")}
          </Button>
        </>
      }
    >
      <SecurityCode sas={sas} />
    </FlowScreen>
  );
}

/** Claimer: the same code, confirmed on the other device. */
export function SASWaiting({ sas, onCancel }: { sas: string | null; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <FlowScreen
      icon={shield}
      title={t("sync:pairing.verifySecurityCode")}
      description={t("sync:sas.waitingDescription")}
      actions={
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          {t("common:cancel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <SecurityCode sas={sas} />
        <p
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
        >
          <Icons.Spinner className="size-3.5 animate-spin" aria-hidden />
          {t("sync:waiting.waitingForConfirmation")}
        </p>
      </div>
    </FlowScreen>
  );
}
