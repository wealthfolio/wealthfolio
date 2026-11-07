import { ChevronLeft, ChevronRight } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { useIsMobile } from "@wealthfolio/ui/hooks/use-mobile";
import type { TimePeriod } from "@wealthfolio/ui";
import type { ReportsPeriod } from "../lib/reports-period";

type PeriodNavigationStep = TimePeriod | ReportsPeriod | "month" | "year" | null;

const STEP_UNITS: Record<Exclude<PeriodNavigationStep, null | "ALL">, string> = {
  "1D": "day",
  "1W": "week",
  "1M": "month",
  "3M": "threeMonths",
  "6M": "sixMonths",
  "1Y": "year",
  "5Y": "fiveYears",
  YTD: "year",
  MTD: "month",
  LAST_MONTH: "month",
  month: "month",
  year: "year",
};

export interface PeriodNavigationState {
  label: string;
  step: PeriodNavigationStep;
  onStep: (direction: -1 | 1) => void;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onReset?: () => void;
}

interface PeriodNavigationProps {
  navigation: PeriodNavigationState;
}

export function PeriodNavigation({ navigation }: PeriodNavigationProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const step = navigation.step;
  const unit =
    step && step !== "ALL"
      ? isMobile && !["month", "year", "MTD", "LAST_MONTH"].includes(step)
        ? step
        : t(`spending:period.stepUnits.${STEP_UNITS[step]}`)
      : "";
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {navigation.label}
      </span>
      {step && step !== "ALL" && (
        <div
          className="flex max-w-full flex-wrap items-center gap-2"
          role="group"
          data-testid="period-navigation"
          aria-label={navigation.label}
          data-no-swipe-drag
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={navigation.previousDisabled}
            onClick={() => navigation.onStep(-1)}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
            <span>
              <Trans
                i18nKey="spending:period.previousStep"
                values={{ period: unit }}
                components={{ unit: <bdi /> }}
              />
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={navigation.nextDisabled}
            onClick={() => navigation.onStep(1)}
          >
            <span>
              <Trans
                i18nKey="spending:period.nextStep"
                values={{ period: unit }}
                components={{ unit: <bdi /> }}
              />
            </span>
            <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Button>
          {navigation.onReset && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground px-1"
              onClick={navigation.onReset}
            >
              {t("spending:period.backToLatest")}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
