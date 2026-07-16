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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@wealthfolio/ui/components/ui/input-otp";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";
import { ProviderButton } from "./provider-button";

// OAuth is only available on desktop/mobile (Tauri) where we can handle deep links
// Web (self-hosted) uses email OTP only since we can't register all possible redirect URLs
const isNativeApp = isDesktop;

type Provider = "google" | "email";

// ─────────────────────────────────────────────────────────────────────────────
// Features Section
// ─────────────────────────────────────────────────────────────────────────────

const featureColors = {
  orange: {
    bg: "bg-orange-100 dark:bg-orange-900/30",
    icon: "text-orange-600 dark:text-orange-400",
  },
  green: {
    bg: "bg-green-100 dark:bg-green-900/30",
    icon: "text-green-600 dark:text-green-400",
  },
  blue: {
    bg: "bg-blue-100 dark:bg-blue-900/30",
    icon: "text-blue-600 dark:text-blue-400",
  },
};

function FeaturesSection({ t }: { t: TFunction }) {
  const features = useMemo(
    () => [
      {
        icon: Icons.CloudSync2,
        title: t("auth:connect.features.brokerSync.title"),
        description: t("auth:connect.features.brokerSync.description"),
        color: "orange",
      },
      {
        icon: Icons.Devices,
        title: t("auth:connect.features.deviceSync.title"),
        description: t("auth:connect.features.deviceSync.description"),
        color: "green",
      },
      {
        icon: Icons.Users,
        title: t("auth:connect.features.household.title"),
        description: t("auth:connect.features.household.description"),
        color: "blue",
      },
    ],
    [t],
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
      {features.map((feature) => {
        const colors = featureColors[feature.color as keyof typeof featureColors];
        return (
          <div
            key={feature.title}
            className="bg-muted/30 flex items-center gap-3 rounded-lg border p-3 sm:flex-col sm:gap-2 sm:text-center"
          >
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${colors.bg}`}
            >
              <feature.icon className={`h-4 w-4 ${colors.icon}`} />
            </div>
            <div>
              <p className="text-xs font-medium">{feature.title}</p>
              <p className="text-muted-foreground text-[10px]">{feature.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LoginForm() {
  const { t } = useTranslation();
  const { signInWithOAuth, signInWithMagicLink, verifyOtp, error, clearError, isLoading } =
    useWealthfolioConnect();

  // State management
  const [email, setEmail] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const [preferredProvider, setPreferredProvider] = useState<Provider | null>(null);
  const [isMoreOptionsOpen, setIsMoreOptionsOpen] = useState(false);

  // OTP verification state
  const [showOtpInput, setShowOtpInput] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");

  // Load preferred provider from cookie on mount
  useEffect(() => {
    const savedProvider = getPreferredProvider();
    setPreferredProvider(savedProvider);
  }, []);

  // Determine which providers to show at the top
  const getTopProviders = (): Provider[] => {
    // Web (self-hosted): only email OTP is available
    if (!isNativeApp) {
      return ["email"];
    }

    // Native app: if user has a preference, show it first
    if (preferredProvider) {
      return [preferredProvider];
    }

    // Default: show Google only
    return ["google"];
  };

  // Determine which providers to show in "More options"
  const getMoreOptionsProviders = (): Provider[] => {
    // Web (self-hosted): no additional options
    if (!isNativeApp) {
      return [];
    }

    const topProviders = getTopProviders();
    const allProviders: Provider[] = ["google", "email"];
    return allProviders.filter((p) => !topProviders.includes(p));
  };

  const topProviders = getTopProviders();
  const moreOptionsProviders = getMoreOptionsProviders();

  const handleOAuthSignIn = async (provider: "google") => {
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
      setLoadingProvider(null);
    }
  };

  const handleMagicLinkSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
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

  const displayError = localError ?? error;

  return (
    <div className="space-y-6">
      {/* Features Grid */}
      <FeaturesSection t={t} />

      {/* Sign In Card */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-center text-base font-medium">
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
            <>
              {/* Top Provider Buttons */}
              <div className="flex flex-col items-center space-y-3">
                {topProviders.includes("google") && (
                  <ProviderButton
                    provider="google"
                    onClick={() => handleOAuthSignIn("google")}
                    isLoading={loadingProvider === "google"}
                    isLastUsed={topProviders.length > 1 && preferredProvider === "google"}
                  />
                )}
                {topProviders.includes("email") && (
                  <form onSubmit={handleMagicLinkSignIn} className="w-full max-w-sm space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="email">{t("auth:connect.emailLabel")}</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder={t("auth:connect.emailPlaceholder")}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        className="rounded-full"
                      />
                    </div>
                    <ProviderButton
                      provider="email"
                      type="submit"
                      onClick={() => {}}
                      isLoading={loadingProvider === "email"}
                      isLastUsed={topProviders.length > 1 && preferredProvider === "email"}
                      variant="default"
                    />
                  </form>
                )}
              </div>

              {/* Divider */}
              {moreOptionsProviders.length > 0 && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <Separator className="mx-auto max-w-sm" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background text-muted-foreground px-2">
                      {t("auth:connect.or")}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* More Sign-in Options (Collapsible) - Hidden during OTP */}
          {!showOtpInput && moreOptionsProviders.length > 0 && (
            <Collapsible open={isMoreOptionsOpen} onOpenChange={setIsMoreOptionsOpen}>
              <div className="flex justify-center">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" className="gap-2" disabled={isLoading}>
                    <span className="text-muted-foreground text-sm">
                      {t("auth:connect.moreSignInOptions")}
                    </span>
                    <Icons.ChevronDown
                      className={`h-4 w-4 transition-transform ${
                        isMoreOptionsOpen ? "rotate-180" : ""
                      }`}
                    />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="flex flex-col items-center space-y-3 pt-3">
                {moreOptionsProviders.includes("google") && (
                  <ProviderButton
                    provider="google"
                    onClick={() => handleOAuthSignIn("google")}
                    isLoading={loadingProvider === "google"}
                  />
                )}
                {moreOptionsProviders.includes("email") && (
                  <form
                    onSubmit={handleMagicLinkSignIn}
                    className="flex w-full max-w-sm flex-col items-center space-y-3"
                  >
                    <div className="w-full space-y-2">
                      <Label htmlFor="more-email">{t("auth:connect.emailLabel")}</Label>
                      <Input
                        id="more-email"
                        type="email"
                        placeholder={t("auth:connect.emailPlaceholder")}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        className="rounded-full"
                      />
                    </div>
                    <ProviderButton
                      provider="email"
                      type="submit"
                      onClick={() => {}}
                      isLoading={loadingProvider === "email"}
                    />
                  </form>
                )}
              </CollapsibleContent>
            </Collapsible>
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
