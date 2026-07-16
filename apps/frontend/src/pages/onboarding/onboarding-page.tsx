import { ExternalLink } from "@/components/external-link";
import { StartupError } from "@/components/startup-error";
import { usePlatform } from "@/hooks/use-platform";
import { useSettings } from "@/hooks/use-settings";
import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
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
  const maxSteps = isMobile ? MOBILE_MAX_STEPS : DESKTOP_MAX_STEPS;
  const completionRoute = isMobile ? "/settings" : "/settings/accounts";
  const isFinalStep = currentStep === maxSteps;

  if (isSettingsLoading) return null;
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

  const handleNext = () => {
    setCurrentStep((prev) => Math.min(prev + 1, maxSteps));
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
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
    <div
      data-testid="onboarding-page"
      className="bg-background flex h-screen flex-col pt-[env(safe-area-inset-top)]"
    >
      {/* Fixed Header with Logo and Steppers */}
      <header className="flex-none px-4 pt-8 sm:px-6 sm:pt-12">
        <div className="flex flex-col items-center">
          {/* Logo */}
          <img
            alt="Wealthfolio"
            className="mb-3 h-16 w-16 sm:h-20 sm:w-20"
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
      <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 sm:px-6">
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

      {/* Fixed Footer */}
      <footer className="flex-none pb-[env(safe-area-inset-bottom)]">
        <div className="sm:pb-18 mx-auto max-w-4xl px-4 pb-8 pt-6 sm:px-6">
          {isFinalStep ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="order-2 sm:order-1">
                <Button variant="ghost" onClick={handleBack} size="sm">
                  <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
                  {t("common:back")}
                </Button>
              </div>
              <div className="order-1 flex flex-col gap-2 sm:order-2 sm:flex-row sm:gap-3">
                {!isMobile && (
                  <Button asChild variant="outline" className="order-2 sm:order-1">
                    <ExternalLink
                      href={WEALTHFOLIO_CONNECT_PORTAL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("onboarding:buttons.subscribeConnect")}
                      <Icons.ExternalLink className="ml-1.5 h-4 w-4" />
                    </ExternalLink>
                  </Button>
                )}
                <Button
                  data-testid="onboarding-finish-button"
                  className="from-primary to-primary/90 bg-linear-to-r order-1 sm:order-2"
                  onClick={() => updateSettings({ onboardingCompleted: true })}
                >
                  {t("onboarding:buttons.getStarted")}
                  <Icons.ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                {currentStep > 1 && (
                  <Button variant="ghost" onClick={handleBack} size="sm">
                    <Icons.ArrowLeft className="mr-1.5 h-4 w-4" />
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
                <Icons.ArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};

export default OnboardingPage;
