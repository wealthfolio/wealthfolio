import { profileAwareErrorMessage } from "@/features/profiles/error-messages";
import { isDesktop } from "@/adapters";
import { ExternalLink } from "@/components/external-link";
import { getPreferredProvider, savePreferredProvider } from "@/lib/cookie-utils";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@wealthfolio/ui/components/ui/input-otp";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { ProviderButton } from "./provider-button";
import { ConnectFeatures } from "./connect-features";

// OAuth is only available on desktop/mobile (Tauri) where we can handle deep links
// Web (self-hosted) uses email OTP only since we can't register all possible redirect URLs
type Provider = "google" | "email";

export function LoginForm() {
  const { t } = useTranslation();
  const { signInWithOAuth, signInWithMagicLink, verifyOtp, error, clearError, isLoading } =
    useWealthfolioConnect();

  // State management
  const [email, setEmail] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const signInPending = useRef(false);
  const [preferredProvider, setPreferredProvider] = useState<Provider | null>(null);

  // OTP verification state
  const [showOtpInput, setShowOtpInput] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");

  // Load preferred provider from cookie on mount
  useEffect(() => {
    const savedProvider = getPreferredProvider();
    setPreferredProvider(savedProvider);
  }, []);

  // Keep both native sign-in methods visible, with the last-used method first.
  // Self-hosted web continues to offer email only.
  const providers: Provider[] = isDesktop
    ? preferredProvider === "email"
      ? ["email", "google"]
      : ["google", "email"]
    : ["email"];

  const handleOAuthSignIn = async (provider: "google") => {
    if (signInPending.current || isLoading) return;
    signInPending.current = true;
    setLocalError(null);
    setSuccessMessage(null);
    clearError();
    setLoadingProvider(provider);

    try {
      await signInWithOAuth(provider);
      // Save provider preference
      savePreferredProvider(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("auth:connect.errors.signInFailed");
      setLocalError(message);
    } finally {
      signInPending.current = false;
      setLoadingProvider(null);
    }
  };

  const handleMagicLinkSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signInPending.current || isLoading) return;
    setLocalError(null);
    setSuccessMessage(null);
    clearError();

    if (!email) {
      setLocalError(t("auth:connect.errors.enterEmail"));
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setLocalError(t("auth:connect.errors.invalidEmail"));
      return;
    }

    signInPending.current = true;
    setLoadingProvider("email");

    try {
      await signInWithMagicLink(email);
      // Save provider preference
      savePreferredProvider("email");
      // Store email for OTP verification and show OTP input
      setPendingEmail(email);
      setShowOtpInput(true);
      setEmail(""); // Clear email input
    } catch (err) {
      const message = err instanceof Error ? err.message : t("auth:connect.errors.magicLinkFailed");
      setLocalError(message);
    } finally {
      signInPending.current = false;
      setLoadingProvider(null);
    }
  };

  const handleOtpVerify = async () => {
    if (otpCode.length !== 6) {
      setLocalError(t("auth:connect.errors.incompleteCode"));
      return;
    }

    setLocalError(null);
    clearError();
    setLoadingProvider("email");

    try {
      await verifyOtp(pendingEmail, otpCode);
      // Success - context will update isConnected
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "";
      // Check for OTP expired/invalid error and provide a more user-friendly message
      const isOtpExpired =
        errorMessage.toLowerCase().includes("expired") ||
        errorMessage.toLowerCase().includes("invalid");
      const message = isOtpExpired
        ? t("auth:connect.errors.codeExpired")
        : errorMessage || t("auth:connect.errors.invalidCode");
      setLocalError(message);
      setOtpCode(""); // Clear OTP on error
    } finally {
      setLoadingProvider(null);
    }
  };

  const handleResendCode = async () => {
    setLocalError(null);
    clearError();
    setLoadingProvider("email");

    try {
      await signInWithMagicLink(pendingEmail);
      setSuccessMessage(t("auth:connect.codeResent"));
      setOtpCode(""); // Clear OTP input
    } catch (err) {
      const message = err instanceof Error ? err.message : t("auth:connect.errors.resendFailed");
      setLocalError(message);
    } finally {
      setLoadingProvider(null);
    }
  };

  const handleBackToEmail = () => {
    setShowOtpInput(false);
    setPendingEmail("");
    setOtpCode("");
    setLocalError(null);
    setSuccessMessage(null);
    clearError();
  };

  const rawError = localError ?? error;
  const displayError = rawError ? profileAwareErrorMessage(rawError, t) : rawError;

  return (
    <div className="space-y-6">
      {/* Features Grid */}
      <ConnectFeatures />

      {/* Sign In Card */}
      <Card className="rounded-2xl shadow-none">
        <CardHeader className="pb-4">
          <CardTitle className="text-center text-xl font-semibold tracking-tight">
            {t("auth:connect.getStarted")}
          </CardTitle>
          <CardDescription className="text-center">
            {t("auth:connect.getStartedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Error Alert */}
          {displayError && (
            <Alert variant="destructive">
              <Icons.AlertCircle className="h-4 w-4" />
              <AlertDescription>{displayError}</AlertDescription>
            </Alert>
          )}

          {/* Success Alert */}
          {successMessage && (
            <Alert>
              <Icons.CheckCircle className="h-4 w-4" />
              <AlertDescription>{successMessage}</AlertDescription>
            </Alert>
          )}

          {/* OTP Verification UI */}
          {showOtpInput ? (
            <div className="flex flex-col items-center space-y-4">
              <div className="text-center">
                <p className="text-sm font-medium">{t("auth:connect.otp.title")}</p>
                <p className="text-muted-foreground text-sm">
                  <Trans
                    i18nKey="auth:connect.otp.sentTo"
                    values={{ email: pendingEmail }}
                    components={[<span key="email" className="font-medium" />]}
                  />
                </p>
              </div>

              <InputOTP
                maxLength={6}
                value={otpCode}
                onChange={setOtpCode}
                onComplete={handleOtpVerify}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>

              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="default"
                  onClick={handleOtpVerify}
                  disabled={otpCode.length !== 6 || loadingProvider === "email"}
                  className="w-full max-w-sm"
                >
                  {loadingProvider === "email" ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      {t("auth:connect.otp.verifying")}
                    </>
                  ) : (
                    t("auth:connect.otp.verify")
                  )}
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleBackToEmail}
                    className="text-muted-foreground"
                  >
                    <Icons.ArrowLeft className="mr-2 h-4 w-4" />
                    {t("auth:connect.otp.backToSignIn")}
                  </Button>
                  <span className="text-muted-foreground">•</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleResendCode}
                    disabled={loadingProvider === "email"}
                    className="text-muted-foreground"
                  >
                    {t("auth:connect.otp.resendCode")}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-sm space-y-4">
              {providers.map((provider, index) => (
                <div key={provider} className="flex w-full flex-col items-center gap-4">
                  {index > 0 && (
                    <div className="relative w-full">
                      <div className="absolute inset-0 flex items-center">
                        <Separator />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-card text-muted-foreground px-2">
                          {t("auth:connect.or")}
                        </span>
                      </div>
                    </div>
                  )}
                  {provider === "google" ? (
                    <ProviderButton
                      provider="google"
                      onClick={() => handleOAuthSignIn("google")}
                      isLoading={loadingProvider === "google"}
                      disabled={loadingProvider !== null || isLoading}
                      isLastUsed={preferredProvider === "google"}
                    />
                  ) : (
                    <form onSubmit={handleMagicLinkSignIn} className="w-full space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="email">{t("auth:connect.emailLabel")}</Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder={t("auth:connect.emailPlaceholder")}
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          autoComplete="email"
                          disabled={loadingProvider !== null || isLoading}
                          className="rounded-full"
                        />
                      </div>
                      <ProviderButton
                        provider="email"
                        type="submit"
                        isLoading={loadingProvider === "email"}
                        disabled={loadingProvider !== null || isLoading}
                        isLastUsed={providers.length > 1 && preferredProvider === "email"}
                        variant="default"
                      />
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Terms and Privacy Footer - Hidden during OTP */}
          {!showOtpInput && (
            <div className="pt-4">
              <p className="text-muted-foreground text-center text-xs">
                <Trans
                  i18nKey="auth:connect.terms"
                  components={[
                    <ExternalLink
                      key="terms"
                      href="https://wealthfolio.app/connect/legal/terms-of-use"
                      className="hover:text-foreground underline underline-offset-4"
                    />,
                    <ExternalLink
                      key="privacy"
                      href="https://wealthfolio.app/connect/legal/privacy-policy"
                      className="hover:text-foreground underline underline-offset-4"
                    />,
                  ]}
                />
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Privacy Footnote */}
      <p className="text-muted-foreground text-center text-xs">
        {t("auth:connect.privacyFootnote")}
      </p>
    </div>
  );
}
