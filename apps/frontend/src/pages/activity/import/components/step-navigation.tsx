import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StepNavigationProps {
  onNext: () => void;
  onBack: () => void;
  canGoBack: boolean;
  canGoNext: boolean;
  nextLabel?: string;
  backLabel?: string;
  isNextLoading?: boolean;
  showNext?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation Variants
// ─────────────────────────────────────────────────────────────────────────────

const buttonVariants = {
  initial: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.98 },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function StepNavigation({
  onNext,
  onBack,
  canGoBack,
  canGoNext,
  nextLabel,
  backLabel,
  isNextLoading = false,
  showNext = true,
}: StepNavigationProps) {
  const { t } = useTranslation();
  const resolvedNextLabel = nextLabel ?? t("activity:import.toolbar.continue");
  const resolvedBackLabel = backLabel ?? t("activity:import.toolbar.back");
  return (
    <div className="flex flex-col-reverse justify-between gap-3 border-t pt-4 sm:flex-row">
      {/* Back button */}
      <motion.div
        whileHover={canGoBack ? "hover" : undefined}
        whileTap={canGoBack ? "tap" : undefined}
        variants={buttonVariants}
        className="w-full sm:w-auto"
      >
        <Button
          variant="outline"
          onClick={onBack}
          disabled={!canGoBack}
          className="w-full sm:w-auto"
        >
          <Icons.ArrowLeft className="mr-2 h-4 w-4" />
          {resolvedBackLabel}
        </Button>
      </motion.div>

      {/* Next button */}
      {showNext && (
        <motion.div
          whileHover={canGoNext && !isNextLoading ? "hover" : undefined}
          whileTap={canGoNext && !isNextLoading ? "tap" : undefined}
          variants={buttonVariants}
          className="w-full sm:w-auto"
        >
          <Button
            onClick={onNext}
            disabled={!canGoNext || isNextLoading}
            className="w-full sm:w-auto"
          >
            {isNextLoading ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("activity:import.toolbar.processing")}
              </>
            ) : (
              <>
                {resolvedNextLabel}
                <Icons.ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </motion.div>
      )}
    </div>
  );
}

export default StepNavigation;
