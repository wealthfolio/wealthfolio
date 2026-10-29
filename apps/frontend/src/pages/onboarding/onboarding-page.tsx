import { buttonVariants } from "@wealthfolio/ui";
import { ExternalLink } from "@/components/external-link";
import { StartupError } from "@/components/startup-error";
import { StartupScreen } from "@/components/startup-screen";
import { usePlatform } from "@/hooks/use-platform";
import { useSettings } from "@/hooks/use-settings";
import { useConnectUrl } from "@/features/wealthfolio-connect/hooks/use-connect-url";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { OnboardingAppearance, OnboardingAppearanceHandle } from "./onboarding-appearance";
import { OnboardingConnect } from "./onboarding-connect";
import { OnboardingStep1 } from "./onboarding-step1";
import { OnboardingStep2, OnboardingStep2Handle } from "./onboarding-step2";

const DESKTOP_MAX_STEPS = 4;
const MOBILE_MAX_STEPS = 3;

const OnboardingPage = () => {
  const { t } = useTranslation();
  const connectLink = useConnectUrl("app_onboarding");
  const {
    data: settings,
    error: settingsError,
    isError: isSettingsError,
    isFetching: isSettingsFetching,
    isLoading: isSettingsLoading,
    refetch: refetchSettings,
  } = useSettings();
  const { isMobile } = usePlatform();
  const { updateSettings } = useSettingsContext();
  const [currentStep, setCurrentStep] = useState(1);
  const [isStepValid, setIsStepValid] = useState(true);
  const settingsStepRef = useRef<OnboardingStep2Handle>(null);
  const appearanceStepRef = useRef<OnboardingAppearanceHandle>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const maxSteps = isMobile ? MOBILE_MAX_STEPS : DESKTOP_MAX_STEPS;
  const completionRoute = isMobile ? "/settings" : "/settings/accounts";
  const isFinalStep = currentStep === maxSteps;
  const isAppearanceStep = currentStep === 3;

  if (isSettingsLoading) return <StartupScreen />;
  if (isSettingsError) {
    return (
      <StartupError
        error={settingsError}
        isRetrying={isSettingsFetching}
        onRetry={() => void refetchSettings()}
      />
    );
  }
  if (settings?.onboardingCompleted) {
    return <Navigate to={completionRoute} replace />;
  }

  // Each step opens at its top, not where the last one was scrolled to reach its buttons.
  const scrollToTop = () => pageRef.current?.scrollIntoView({ block: "start" });

  const handleNext = () => {
    setCurrentStep((prev) => Math.min(prev + 1, maxSteps));
    scrollToTop();
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
    scrollToTop();
  };

  const handleContinue = () => {
    if (currentStep === 2 && settingsStepRef.current) {
      settingsStepRef.current.submitForm();
    } else if (currentStep === 3 && appearanceStepRef.current) {
      appearanceStepRef.current.submitForm();
    } else {
      handleNext();
    }
  };

  return (
    // `onboarding-page` keeps globals.css's small-screen rule from making this a scroll
    // container of its own, so the footer sticks to the window's bottom.
    <div
      ref={pageRef}
      data-testid="onboarding-page"
      className="onboarding-page bg-background flex min-h-full flex-col pt-[env(safe-area-inset-top)]"
    >
      {/* Fixed Header with Logo and Steppers */}
      <header className={cn("flex-none px-4 sm:px-6", isAppearanceStep ? "pt-4" : "pt-8 sm:pt-8")}>
        <div className="flex flex-col items-center">
          {/* Logo */}
          <img
            alt="Wealthfolio"
            className={cn(isAppearanceStep ? "mb-2 h-12 w-12" : "mb-3 h-16 w-16 sm:h-16 sm:w-16")}
            src="/logo-vantage.png"
          />

          {/* Progress indicators */}
          <div className="flex gap-2">
            {Array.from({ length: maxSteps }).map((_, index) => (
              <div
                key={index}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  index === currentStep - 1
                    ? "bg-primary w-8"
                    : index < currentStep - 1
                      ? "bg-primary/50 w-1.5"
                      : "bg-muted w-1.5"
                }`}
              />
            ))}
          </div>
        </div>
      </header>

      {/* Main content - centered vertically in remaining space */}
      {/* The bottom padding keeps the last line clear of the footer's fade. */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-6 sm:px-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentStep}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex w-full max-w-4xl justify-center"
          >
            {currentStep === 1 && <OnboardingStep1 />}
            {currentStep === 2 && (
              <OnboardingStep2
                ref={settingsStepRef}
                onNext={handleNext}
                onValidityChange={setIsStepValid}
              />
            )}
            {currentStep === 3 && (
              <OnboardingAppearance
                ref={appearanceStepRef}
                onNext={handleNext}
                onValidityChange={setIsStepValid}
              />
            )}
            {!isMobile && currentStep === 4 && <OnboardingConnect />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* The footer stays in view while a step scrolls; its fade shows only over
          content scrolling under it. */}
      <footer className="bg-background before:from-background sticky bottom-0 z-10 flex-none pb-[env(safe-area-inset-bottom)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-linear-to-t before:to-transparent">
        <div
          className={cn(
            "mx-auto max-w-4xl px-4 sm:px-6",
            isAppearanceStep ? "pb-4 pt-2" : "pb-8 pt-6 sm:pb-8 sm:pt-4",
          )}
        >
          {isFinalStep ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="order-2 sm:order-1">
                <Button variant="ghost" onClick={handleBack} size="sm">
                  <Icons.ArrowLeft className="me-1.5 h-4 w-4 rtl:rotate-180" />
                  {t("common:back")}
                </Button>
              </div>
              <div className="order-1 flex flex-col gap-2 sm:order-2 sm:flex-row sm:gap-3">
                {!isMobile && (
                  <ExternalLink
                    href={connectLink}
                    className={cn(buttonVariants({ variant: "outline" }), "order-2 sm:order-1")}
                  >
                    {t("onboarding:buttons.subscribeConnect")}
                    <Icons.ExternalLink className="ms-1.5 h-4 w-4" />
                  </ExternalLink>
                )}
                <Button
                  data-testid="onboarding-finish-button"
                  className="from-primary to-primary/90 order-1 bg-linear-to-r sm:order-2"
                  onClick={() => updateSettings({ onboardingCompleted: true })}
                >
                  {t("onboarding:buttons.getStarted")}
                  <Icons.ArrowRight className="ms-1.5 h-4 w-4 rtl:rotate-180" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                {currentStep > 1 && (
                  <Button variant="ghost" onClick={handleBack} size="sm">
                    <Icons.ArrowLeft className="me-1.5 h-4 w-4 rtl:rotate-180" />
                    {t("common:back")}
                  </Button>
                )}
              </div>
              <Button
                data-testid="onboarding-continue-button"
                onClick={handleContinue}
                disabled={!isStepValid}
                className="from-primary to-primary/90 bg-linear-to-r"
              >
                {t("onboarding:buttons.continue")}
                <Icons.ArrowRight className="ms-1.5 h-4 w-4 rtl:rotate-180" />
              </Button>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};

export default OnboardingPage;
