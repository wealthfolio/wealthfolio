// WaitingState
// A step that is working and needs nothing from the user yet.
// ============================================================

import { Button } from "@wealthfolio/ui/components/ui/button";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FlowIcon, FlowScreen } from "../flow-layout";
import { StepDetails, type StepDetail } from "../step-details";

interface WaitingStateProps {
  title: string;
  description?: string;
  /** Illustration in place of the spinner badge. */
  visual?: ReactNode;
  /** A quiet line at the bottom, since this step has nothing to click. */
  footnote?: ReactNode;
  /** What this step does. */
  details?: StepDetail[];
  onCancel?: () => void;
}

export function WaitingState({
  title,
  description,
  visual,
  footnote,
  details,
  onCancel,
}: WaitingStateProps) {
  const { t } = useTranslation();
  return (
    <FlowScreen
      icon={<FlowIcon kind="working" />}
      visual={visual}
      working
      footnote={footnote}
      title={title}
      description={description}
      live
      actions={
        onCancel && (
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {t("common:cancel")}
          </Button>
        )
      }
    >
      {details && <StepDetails details={details} />}
    </FlowScreen>
  );
}
