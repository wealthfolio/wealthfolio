// Setup wizard steps
// Which steps each setup mode shows, and where a restore stands in them.
// =======================================================================

import type { RestoreOperation } from "../hooks/use-restore-operation";

export const WIZARD_STEPS = {
  /** This (trusted) device shares its data with a new one. */
  add: ["connect", "transfer", "done"],
  /** This new device connects, then receives the data. */
  join: ["connect", "download", "apply", "done"],
  /** A restore started outside pairing. */
  recover: ["download", "apply", "done"],
} as const;

export type DeviceSetupMode = keyof typeof WIZARD_STEPS;
export type WizardStepId = (typeof WIZARD_STEPS)[DeviceSetupMode][number];

export interface WizardProgress {
  step: WizardStepId;
  failed?: boolean;
}

/** Where a restore stands in the Download → Apply → Done steps. */
export function restoreWizardProgress(operation: RestoreOperation): WizardProgress | null {
  switch (operation.phase) {
    case "transferring":
    case "waiting_for_snapshot":
      return { step: "download" };
    case "awaiting_consent":
    case "backing_up":
    case "replacing":
      return { step: "apply" };
    case "ready":
      return { step: "done" };
    case "failed":
      // A failure after approval belongs to Apply.
      return operation.error?.retry === "consent"
        ? { step: "apply", failed: true }
        : { step: "download", failed: true };
    case "cancelled":
      return null;
  }
}
