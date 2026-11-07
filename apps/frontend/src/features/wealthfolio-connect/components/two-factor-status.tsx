import { openUrlInBrowser } from "@/adapters";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";
import { useTwoFactorStatus } from "../hooks/use-two-factor-status";
import { MFA_NUDGE_SNOOZE_MS, MFA_SETTINGS_PATH } from "../lib/mfa";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";

const openSecuritySettings = () =>
  openUrlInBrowser(`${WEALTHFOLIO_CONNECT_PORTAL_URL}${MFA_SETTINGS_PATH}`);

export function TwoFactorStatusLine({ isEnabled }: { isEnabled: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icons.Shield className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate text-sm">{t("connect:twoFactor.label")}</span>
        <Badge
          className={`text-2xs h-5 shrink-0 px-2 font-medium ${
            isEnabled
              ? "bg-success-subtle text-success-subtle-foreground"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {isEnabled ? t("connect:twoFactor.on") : t("connect:twoFactor.off")}
        </Badge>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground shrink-0"
        title={t("connect:opensInBrowser")}
        onClick={openSecuritySettings}
      >
        {isEnabled ? t("connect:twoFactor.manage") : t("connect:twoFactor.turnOn")}
        <Icons.ExternalLink className="ms-1 h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

// One key for all users: a key that changes with the user would keep the previous
// user's value while mounted (usePersistentState keeps state for unknown keys).
const NUDGE_HIDDEN_UNTIL_KEY = "connect-two-factor-nudge-hidden-until";

/** Subscribed users with 2FA off see the nudge until "Not now" hides it for a while. */
export function useTwoFactorNudge(hasSubscription: boolean) {
  const { user, isMfaRequired } = useWealthfolioConnect();
  const twoFactor = useTwoFactorStatus();
  const [hiddenUntilByUser, setHiddenUntilByUser] = usePersistentState<Record<string, number>>(
    NUDGE_HIDDEN_UNTIL_KEY,
    {},
  );
  const userId = user?.id;
  return {
    show:
      !!userId &&
      hasSubscription &&
      !isMfaRequired &&
      twoFactor.isKnown &&
      !twoFactor.isEnabled &&
      Date.now() >= (hiddenUntilByUser[userId] ?? 0),
    snooze: () => {
      if (!userId) return;
      setHiddenUntilByUser((previous) => ({
        ...previous,
        [userId]: Date.now() + MFA_NUDGE_SNOOZE_MS,
      }));
    },
  };
}

export function TwoFactorNudge({ onNotNow }: { onNotNow: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t("connect:twoFactorNudge.title")}</h3>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("connect:twoFactorNudge.description")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onNotNow}>
              {t("connect:twoFactorNudge.notNow")}
            </Button>
            <Button size="sm" title={t("connect:opensInBrowser")} onClick={openSecuritySettings}>
              {t("connect:twoFactorNudge.setUp")}
              <Icons.ExternalLink className="ms-1 h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
