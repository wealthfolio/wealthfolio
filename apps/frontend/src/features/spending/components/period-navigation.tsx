import { ChevronLeft, ChevronRight } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Button } from "@wealthfolio/ui/components/ui/button";
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
  children?: ReactNode;
}

export function PeriodNavigation({ navigation, children }: PeriodNavigationProps) {
  const { t } = useTranslation();
  const step = navigation.step;
  const unit = step && step !== "ALL" ? t(`spending:period.stepUnits.${STEP_UNITS[step]}`) : "";
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {navigation.label}
      </span>
      <div
        className="flex max-w-full flex-wrap items-center gap-2"
        role="group"
        data-testid="period-navigation"
        aria-label={navigation.label}
        data-no-swipe-drag
      >
        {step && step !== "ALL" ? (
          <>
            <div className="border-border/70 bg-background/60 inline-flex max-w-full items-stretch overflow-hidden rounded-full border">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-foreground border-border/60 size-8 rounded-none border-e focus-visible:-outline-offset-2"
                disabled={navigation.previousDisabled}
                onClick={() => navigation.onStep(-1)}
              >
                <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
                <span className="sr-only">
                  <Trans
                    i18nKey="spending:period.previousStep"
                    values={{ period: unit }}
                    components={{ unit: <bdi /> }}
                  />
                </span>
              </Button>
              <div className="text-foreground flex min-w-0 items-center px-3 text-xs font-medium">
                {children ?? navigation.label}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-foreground border-border/60 size-8 rounded-none border-s focus-visible:-outline-offset-2"
                disabled={navigation.nextDisabled}
                onClick={() => navigation.onStep(1)}
              >
                <span className="sr-only">
                  <Trans
                    i18nKey="spending:period.nextStep"
                    values={{ period: unit }}
                    components={{ unit: <bdi /> }}
                  />
                </span>
                <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
              </Button>
            </div>
            {navigation.onReset && (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="text-muted-foreground px-1"
                onClick={navigation.onReset}
              >
                {t("spending:period.backToLatest")}
              </Button>
            )}
          </>
        ) : (
          <div className="text-muted-foreground text-sm">{children ?? navigation.label}</div>
        )}
      </div>
    </>
  );
}
