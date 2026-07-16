// WaitingState
// Shows a loading state during pairing operations
// ===============================================

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons, Skeleton } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface WaitingStateProps {
  title: string;
  description?: string;
  onCancel?: () => void;
  /** Show a QR code placeholder skeleton */
  showQRSkeleton?: boolean;
  /** Security code to display (for claimer to show while waiting) */
  securityCode?: string | null;
  /** Optional action button rendered below the security code */
  action?: React.ReactNode;
}

export function WaitingState({
  title,
  description,
  onCancel,
  showQRSkeleton,
  securityCode,
  action,
}: WaitingStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center px-4 py-6 text-center">
      {showQRSkeleton ? (
        <div className="mb-6 flex flex-col items-center gap-4">
          {/* QR Code skeleton */}
          <Skeleton className="h-[160px] w-[160px] rounded-xl" />
          {/* Code skeleton */}
          <Skeleton className="h-10 w-[180px] rounded-lg" />
        </div>
      ) : securityCode ? (
        <div className="mb-6 flex flex-col items-center gap-4">
          {/* Security code display - matches SASVerification format */}
          <div className="bg-muted rounded-xl px-8 py-5">
            <span className="font-mono text-4xl font-bold tracking-widest">
              {securityCode.length > 3
                ? `${securityCode.slice(0, 3)} ${securityCode.slice(3)}`
                : securityCode}
            </span>
          </div>
          {/* Spinner or action below code */}
          {action ?? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Icons.Spinner className="h-4 w-4 animate-spin" />
              <span>{t("sync:waiting.waitingForConfirmation")}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="mb-6 flex flex-col items-center gap-5">
          {!action && (
            <div className="bg-primary/10 text-primary flex h-20 w-20 items-center justify-center rounded-full">
              <Icons.Spinner className="h-8 w-8 animate-spin" />
            </div>
          )}
          {action}
        </div>
      )}

      <div className="mb-6 space-y-2">
        <p className="text-foreground text-lg font-semibold leading-none">{title}</p>
        {description ? (
          <p className="text-muted-foreground mx-auto max-w-[260px] text-sm leading-6">
            {description}
          </p>
        ) : securityCode ? (
          <p className="text-muted-foreground mx-auto max-w-[260px] text-sm leading-6">
            {t("sync:waiting.confirmCodeMatches")}
          </p>
        ) : (
          <p className="text-muted-foreground mx-auto max-w-[260px] text-sm leading-6">
            {t("sync:waiting.securelyConnecting")}
          </p>
        )}
      </div>

      {onCancel && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          {t("common:cancel")}
        </Button>
      )}
    </div>
  );
}
