// DeviceSetupWizard
// The one dialog that hosts device setup: adding a device, joining from a
// new device, and finishing a restore outside pairing. A step bar spans the
// whole journey and stays put while the step content changes below it.
// ==========================================================================

import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { useIsMobile } from "@wealthfolio/ui/hooks";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FlowFrame } from "./flow-layout";
import {
  WIZARD_STEPS,
  type DeviceSetupMode,
  type WizardProgress,
  type WizardStepId,
} from "./device-setup-steps";

type StepState = "done" | "active" | "failed" | "pending";

function stepState(index: number, currentIndex: number, progress: WizardProgress): StepState {
  if (index < currentIndex) return "done";
  if (index > currentIndex) return "pending";
  return progress.failed ? "failed" : "active";
}

// Finished steps recede; the current one carries the colour.
const TRACK_CLASS: Record<StepState, string> = {
  done: "bg-primary/30",
  active: "bg-primary",
  failed: "bg-destructive",
  pending: "bg-muted",
};

interface WizardStepperProps {
  mode: DeviceSetupMode;
  progress: WizardProgress;
}

export function WizardStepper({ mode, progress }: WizardStepperProps) {
  const { t } = useTranslation();
  const steps = WIZARD_STEPS[mode] as readonly WizardStepId[];
  const currentIndex = steps.indexOf(progress.step);
  return (
    <ol className="flex flex-1 gap-1.5" aria-label={t("sync:wizard.progressLabel")}>
      {steps.map((step, index) => {
        const state = stepState(index, currentIndex, progress);
        return (
          <li
            key={step}
            className="flex min-w-0 flex-1 flex-col gap-1.5"
            aria-current={index === currentIndex ? "step" : undefined}
            data-state={state}
            data-testid={`wizard-step-${step}`}
          >
            <span
              className={cn(
                "h-[3px] rounded-full transition-colors duration-500",
                TRACK_CLASS[state],
              )}
            />
            <span
              className={cn(
                "truncate text-[11px] transition-colors duration-300",
                state === "failed"
                  ? "text-destructive font-medium"
                  : state === "active"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
              )}
            >
              {t(`sync:wizard.steps.${step}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface WizardLayoutProps {
  mode: DeviceSetupMode;
  /** `null` hides the step bar, e.g. once setup was cancelled. */
  progress: WizardProgress | null;
  /** Hides the wizard while its work continues in the background. */
  onHide?: () => void;
  children: ReactNode;
}

/** Step bar above the current step. Keep it mounted across steps so it never re-enters. */
export function WizardLayout({ mode, progress, onHide, children }: WizardLayoutProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col gap-6">
      {(progress || onHide) && (
        <div className="flex items-start gap-3">
          {progress ? (
            <WizardStepper mode={mode} progress={progress} />
          ) : (
            <span className="flex-1" />
          )}
          {onHide && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground -mr-2 -mt-2 size-8 shrink-0"
              aria-label={
                mode === "recover" ? t("sync:restore.hide") : t("sync:restore.continueInBackground")
              }
              onClick={onHide}
            >
              <Icons.Close className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

interface DeviceSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

/**
 * The only device-setup dialog. It closes only through the wizard's own
 * controls; on phones it is a fixed-height sheet with actions at the bottom.
 */
export function DeviceSetupDialog({ open, onOpenChange, title, children }: DeviceSetupDialogProps) {
  const isMobile = useIsMobile();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} useIsMobile={() => isMobile}>
      <DialogContent
        className="sm:max-w-[480px]"
        mobileClassName="flex h-[90vh] flex-col pb-8"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <FlowFrame fill={isMobile}>{children}</FlowFrame>
      </DialogContent>
    </Dialog>
  );
}
