import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";

export interface PeriodNavigationState {
  label: string;
  onStep: (direction: -1 | 1) => void;
  previousDisabled: boolean;
  nextDisabled: boolean;
}

interface PeriodNavigationProps {
  navigation: PeriodNavigationState;
}

export function PeriodNavigation({ navigation }: PeriodNavigationProps) {
  const { t } = useTranslation();
  return (
    <div
      className="inline-flex shrink-0 items-center"
      role="group"
      aria-label={navigation.label}
      data-no-swipe-drag
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {navigation.label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-full sm:size-6"
        disabled={navigation.previousDisabled}
        onClick={() => navigation.onStep(-1)}
        aria-label={t("spending:period.previousPeriod")}
      >
        <ChevronLeft className="size-3.5 rtl:rotate-180" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-full sm:size-6"
        disabled={navigation.nextDisabled}
        onClick={() => navigation.onStep(1)}
        aria-label={t("spending:period.nextPeriod")}
      >
        <ChevronRight className="size-3.5 rtl:rotate-180" />
      </Button>
    </div>
  );
}
