import { profileAwareErrorMessage } from "@/features/profiles/error-messages";
import { ExternalLink } from "@/components/external-link";
import { Spinner } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@wealthfolio/ui/components/ui/input-otp";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMfaCodeRejected } from "../lib/mfa";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";

const CODE_LENGTH = 6;
const SUPPORT_EMAIL = "support@wealthfolio.app";

/** Authenticator-app code step for sign-in and for resuming a paused sync. */
export function MfaCodeStep() {
  const { t } = useTranslation();
  const { verifyMfaCode, cancelMfaChallenge } = useWealthfolioConnect();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"verify" | "sign-out" | null>(null);
  const pendingRef = useRef(false);

  const run = async (action: "verify" | "sign-out", operation: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    try {
      await operation();
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
      setError(
        action === "verify" && isMfaCodeRejected(err)
          ? t("auth:connect.mfa.invalidCode")
          : profileAwareErrorMessage(message || t("auth:connect.errors.signInFailed"), t),
      );
      setCode("");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const verify = (value: string) => {
    if (value.length !== CODE_LENGTH) return;
    void run("verify", () => verifyMfaCode(value));
  };

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="text-center">
        <p className="text-sm font-medium">{t("auth:connect.mfa.title")}</p>
        <p className="text-muted-foreground text-sm">{t("auth:connect.mfa.description")}</p>
      </div>

      {error && (
        <Alert variant="destructive" className="max-w-sm">
          <Icons.AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <InputOTP
        maxLength={CODE_LENGTH}
        value={code}
        onChange={setCode}
        onComplete={verify}
        pattern="^\d+$"
        // Authenticator apps often copy codes as "123 456".
        pasteTransformer={(pasted) => pasted.replace(/\D/g, "")}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={t("auth:connect.mfa.codeLabel")}
        autoFocus
      >
        <InputOTPGroup>
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>

      <div className="flex w-full flex-col items-center gap-2">
        <Button
          onClick={() => verify(code)}
          disabled={code.length !== CODE_LENGTH || pending !== null}
          className="w-full max-w-sm"
        >
          {pending === "verify" ? (
            <>
              <Spinner className="me-2 h-4 w-4" />
              {t("auth:connect.otp.verifying")}
            </>
          ) : (
            t("auth:connect.otp.verify")
          )}
        </Button>
        <div className="flex flex-wrap items-center justify-center gap-x-2 text-sm">
          <ExternalLink
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            {t("auth:connect.mfa.cantUseAuthenticator")}
          </ExternalLink>
          <span className="text-muted-foreground" aria-hidden="true">
            •
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void run("sign-out", cancelMfaChallenge)}
            disabled={pending !== null}
            className="text-muted-foreground"
          >
            {pending === "sign-out" && <Spinner className="me-2 h-4 w-4" />}
            {t("auth:connect.mfa.signOut")}
          </Button>
        </div>
      </div>
    </div>
  );
}
